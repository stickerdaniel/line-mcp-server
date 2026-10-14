import { Buffer } from 'node:buffer';
import { constants, type DatabaseSync, type StatementSync } from 'node:sqlite';
import { openReadOnly } from '../db.ts';
import { renderTime } from '../time.ts';
import {
	deniedFunctions,
	ftsShadowTables,
	maxColumns,
	maxErrorBytes,
	maxResultBytes,
	maxRows,
	relations,
	tableFunctions,
	unlistedTables
} from './surface.ts';

// The guard of the `query` tool: one read-only connection to the archive
// behind an SQLite authorizer built from the surface (`surface.ts`). It runs
// in the query runner's worker thread (`src/query-runner.ts`), whose process
// is killed at the time limit, since node:sqlite cannot interrupt a statement.

export type QueryOutcome =
	| { ok: true; columns: string[]; rows: unknown[][]; truncated?: true }
	/** `object` is what SQLite named (a table, function or pragma), uncut. */
	| { ok: false; code: 'query_denied'; action: string; object: string; message: string }
	| { ok: false; code: 'query_failed'; message: string };

/** Longest SQL in bytes SQLite compiles on the guarded connection. */
export const maxSqlBytes = 20_000;
/** Longest string or blob in bytes a query may build. */
const maxValueBytes = 1024 * 1024;

/**
 * Compiled before every agent statement in the trusted phase. Its zero rows
 * cost about 9 µs, and it reconnects `message_fts` after a schema change by
 * another connection, which reads FTS5's shadow tables.
 */
const warmup = `SELECT rowid FROM main.message_fts WHERE message_fts MATCH 'warmup' LIMIT 0`;

/**
 * What the authorizer is judging: agent SQL being compiled, the statement
 * being stepped (FTS5 compiles its own statements then), or the warm-up.
 */
type Phase = 'compile' | 'step' | 'trusted';

const actionNames = new Map<number, string>(
	Object.entries(constants)
		.filter(
			([name]) =>
				name.startsWith('SQLITE_') &&
				!name.startsWith('SQLITE_CHANGESET') &&
				!['SQLITE_OK', 'SQLITE_DENY', 'SQLITE_IGNORE'].includes(name)
		)
		.map(([name, value]) => [value, name.slice('SQLITE_'.length)])
);

/** Every readable column of each relation, FTS5's hidden ones included. */
const readable: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	relations.map((relation) => [
		relation.name,
		new Set([...relation.columns, ...(relation.hidden ?? [])])
	])
);

/**
 * SQL comments, whitespace and semicolons: what may follow the one statement
 * of a query, and all an empty one holds.
 */
const trailing = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/;

/** The guarded archive of the state root `root`, opened read-only. */
export class Guard {
	readonly #db: DatabaseSync;
	/**
	 * Every name a FROM item can have but a CTE's: the archive's tables and
	 * views, SQLite's schema tables and the virtual table modules, as the
	 * archive had them when the guard opened it.
	 */
	readonly #stored: ReadonlySet<string>;
	#phase: Phase = 'compile';
	#denial: { action: string; object: string } | undefined;

	/**
	 * `heapLimitBytes` sets SQLite's hard heap limit, which holds for the whole
	 * process: only the query runner passes it.
	 */
	constructor(root: string, options: { heapLimitBytes?: number } = {}) {
		const db = openReadOnly(root);
		try {
			db.limits.sqlLength = maxSqlBytes;
			db.limits.length = maxValueBytes;
			if (options.heapLimitBytes) {
				db.exec(`PRAGMA hard_heap_limit = ${Math.trunc(options.heapLimitBytes)}`);
			}
			// The same rendering as every tool's times; not deterministic, since it
			// reads the time zone. Integers come as BigInt, since a number argument
			// beyond 2^53 would fail the whole query.
			db.function('local_time', { deterministic: false, useBigIntArguments: true }, (ms) =>
				renderTime(typeof ms === 'number' || typeof ms === 'bigint' ? Number(ms) : null)
			);
			const stored = db
				.prepare(
					`SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')
					UNION SELECT name FROM pragma_module_list`
				)
				.all()
				.map((row) => String(row.name).toLowerCase());
			this.#stored = new Set([...stored, ...unlistedTables]);
			db.setAuthorizer((action, arg1, arg2, database) =>
				this.#authorize(action, arg1, arg2, database)
			);
		} catch (error) {
			db.close();
			throw error;
		}
		this.#db = db;
	}

	/**
	 * Allows SELECT, recursive CTEs, functions but `deniedFunctions`, and the
	 * `PRAGMA data_version` FTS5 issues. Reads follow the surface: an unlisted
	 * column of a listed relation reads as NULL (SQLITE_IGNORE), any other
	 * table is denied. FTS5's shadow tables are readable only outside the
	 * compile phase, where the authorizer sees FTS5's own statements alone (or
	 * a re-prepare of the agent statement that already compiled without them).
	 * Everything else (writes, ATTACH, TEMP objects, transactions, other
	 * pragmas) is denied, and the first denial is recorded for the result.
	 */
	#authorize(action: number, arg1: string | null, arg2: string | null, database: string | null) {
		switch (action) {
			case constants.SQLITE_SELECT:
			case constants.SQLITE_RECURSIVE:
				return constants.SQLITE_OK;
			case constants.SQLITE_FUNCTION:
				return deniedFunctions.has((arg2 ?? '').toLowerCase())
					? this.#deny(action, arg2)
					: constants.SQLITE_OK;
			case constants.SQLITE_PRAGMA:
				return arg1 === 'data_version' && arg2 === null
					? constants.SQLITE_OK
					: this.#deny(action, arg1);
			case constants.SQLITE_READ:
				return this.#read((arg1 ?? '').toLowerCase(), (arg2 ?? '').toLowerCase(), database);
			default:
				return this.#deny(action, arg1);
		}
	}

	/**
	 * A FROM item none of whose columns a query uses (`SELECT count(*) FROM t`)
	 * is read with the column `''`, and without a database unless the query
	 * named one. Then `table` may also be a CTE's name; SQLite asks before it
	 * looks into the CTE, so such a read passes when the name is not one of
	 * `#stored`. A CTE named like a stored table that is not readable is
	 * denied with it.
	 */
	#read(table: string, column: string, database: string | null): number {
		if (database !== null && database !== 'main') return this.#deny(constants.SQLITE_READ, table);
		if (ftsShadowTables.has(table)) {
			return this.#phase === 'compile'
				? this.#deny(constants.SQLITE_READ, table)
				: constants.SQLITE_OK;
		}
		if (tableFunctions.has(table)) return constants.SQLITE_OK;
		const columns = readable.get(table);
		if (columns) {
			return column === '' || columns.has(column) ? constants.SQLITE_OK : constants.SQLITE_IGNORE;
		}
		if (column === '' && database === null && !this.#isStored(table)) return constants.SQLITE_OK;
		return this.#deny(constants.SQLITE_READ, table);
	}

	/** Table-valued pragmas register only once used, so their prefix stands for them. */
	#isStored(table: string): boolean {
		return this.#stored.has(table) || table.startsWith('pragma_');
	}

	#deny(action: number, object: string | null): number {
		this.#denial ??= { action: actionNames.get(action) ?? String(action), object: object ?? '' };
		return constants.SQLITE_DENY;
	}

	/**
	 * Runs one statement under the guard and returns at most `maxRows` rows
	 * whose result object serializes to at most `maxResultBytes`. A failure
	 * after a recorded denial is `query_denied`, whatever SQLite's error code
	 * (a denied function gives error 1, not 23); any other is `query_failed`
	 * with SQLite's message, cut to fit `maxErrorBytes`.
	 */
	run(sql: string): QueryOutcome {
		try {
			this.#phase = 'trusted';
			this.#db.prepare(warmup).all();
		} catch {
			return failed('The full-text index could not be opened');
		} finally {
			this.#phase = 'compile';
		}
		this.#denial = undefined;
		// Only comments and semicolons: no statement, which node:sqlite reports
		// in words that differ between Node versions.
		if (trailing.test(sql)) return failed('A query is one SQL statement');
		let statement: StatementSync;
		try {
			statement = this.#db.prepare(sql);
		} catch (error) {
			return this.#failure(error);
		}
		const source = statement.sourceSQL;
		const rest = sql.slice(sql.indexOf(source) + source.length);
		if (!trailing.test(rest)) return failed('A query is one SQL statement');
		statement.setReturnArrays(true);
		statement.setReadBigInts(true);
		const columns = statement.columns().map((column) => column.name);
		if (columns.length > maxColumns) {
			return failed(`A result has at most ${maxColumns} columns`);
		}
		// The result object with no rows, as large as it gets: `truncated` included.
		let bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [], truncated: true }));
		if (bytes > maxResultBytes) {
			return failed(`The result columns exceed ${maxResultBytes / 1024} KiB`);
		}
		const rows: unknown[][] = [];
		try {
			this.#phase = 'step';
			for (const raw of statement.iterate() as Iterable<unknown[]>) {
				if (rows.length === maxRows) return { ok: true, columns, rows, truncated: true };
				// Each value counts as it is converted, so a wide row stops at the first
				// value past the budget instead of being serialized whole.
				const row: unknown[] = [];
				let rowBytes = rows.length > 0 ? 3 : 2;
				for (const value of raw) {
					const converted = jsonValue(value);
					rowBytes += Buffer.byteLength(JSON.stringify(converted)) + (row.length > 0 ? 1 : 0);
					if (bytes + rowBytes > maxResultBytes) {
						return { ok: true, columns, rows, truncated: true };
					}
					row.push(converted);
				}
				bytes += rowBytes;
				rows.push(row);
			}
		} catch (error) {
			return this.#failure(error);
		} finally {
			this.#phase = 'compile';
		}
		return { ok: true, columns, rows };
	}

	#failure(error: unknown): QueryOutcome {
		const denial = this.#denial;
		if (denial) {
			return {
				ok: false,
				code: 'query_denied',
				...denial,
				message: cutForJson(`Denied: ${denial.action} ${denial.object}`.trimEnd())
			};
		}
		return failed(error instanceof Error ? error.message : 'The query failed');
	}

	close(): void {
		this.#db.close();
	}
}

const failed = (message: string): QueryOutcome => ({
	ok: false,
	code: 'query_failed',
	message: cutForJson(message)
});

const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value));

/** Room in an error result for everything but the message: code, operation, keys. */
const errorOverheadBytes = 128;

/**
 * `text` cut at a code point boundary, with `…`, so its JSON string fits an
 * error result under `maxErrorBytes`; SQLite's diagnostics can quote a whole
 * value of up to 1 MiB.
 */
function cutForJson(text: string): string {
	const budget = maxErrorBytes - errorOverheadBytes;
	if (jsonBytes(text) <= budget) return text;
	let end = Math.min(text.length, budget);
	for (;;) {
		// Never split a surrogate pair.
		if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
		const cut = `${text.slice(0, end)}…`;
		const length = jsonBytes(cut);
		if (length <= budget) return cut;
		end = Math.min(end - 1, Math.floor((end * budget) / length));
	}
}

/** A column value as JSON: integers beyond the safe range as decimal strings, blobs as base64. */
function jsonValue(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	}
	if (value instanceof Uint8Array) return { blob_base64: Buffer.from(value).toString('base64') };
	return value;
}
