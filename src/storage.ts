import type { DatabaseSync } from 'node:sqlite';
import { BaseStorage, type Storage } from '@evex/linejs/storage';
import { transaction } from './db.ts';
import { LineMcpError } from './errors.ts';

export type Value = Storage['Value'] | bigint;

export interface KvRow {
	key: string;
	kind: string;
	value: string;
}

/**
 * LINEJS key/value storage in the `line_kv` table. Every write is a synchronous
 * SQLite statement, so a caller that does not await (the token event handler)
 * still gets a durable boundary. A failed write throws and reports the failure.
 */
export class SqliteStorage extends BaseStorage {
	readonly #db: DatabaseSync;
	readonly #onWriteError: (error: unknown) => void;

	constructor(db: DatabaseSync, onWriteError: (error: unknown) => void = () => {}) {
		super();
		this.#db = db;
		this.#onWriteError = onWriteError;
	}

	setSync(key: string, value: Value): void {
		this.setAllSync([[key, value]]);
	}

	/** Writes every entry in one transaction: all of them persist or none. */
	setAllSync(entries: [string, Value][]): void {
		this.#write(() =>
			transaction(this.#db, () => {
				const upsert = this.#db.prepare(
					`INSERT INTO line_kv (key, kind, value) VALUES (?, ?, ?)
					ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, value = excluded.value`
				);
				for (const [key, value] of entries) upsert.run(key, ...encode(value));
			})
		);
	}

	getSync(key: string): Value | undefined {
		const row = this.#db.prepare('SELECT kind, value FROM line_kv WHERE key = ?').get(key) as
			KvRow | undefined;
		return row ? decode(row) : undefined;
	}

	override async set(key: string, value: Storage['Value']): Promise<void> {
		this.setSync(key, value);
	}

	override async get(key: string): Promise<Storage['Value'] | undefined> {
		return this.getSync(key) as Storage['Value'] | undefined;
	}

	override async delete(key: string): Promise<void> {
		this.#write(() => this.#db.prepare('DELETE FROM line_kv WHERE key = ?').run(key));
	}

	override async clear(): Promise<void> {
		this.#write(() => this.#db.exec('DELETE FROM line_kv'));
	}

	override async migrate(storage: BaseStorage): Promise<void> {
		for (const row of this.#db
			.prepare('SELECT key, kind, value FROM line_kv')
			.all() as unknown as KvRow[]) {
			await storage.set(row.key, decode(row) as Storage['Value']);
		}
	}

	#write(statement: () => void): void {
		try {
			statement();
		} catch (error) {
			this.#onWriteError(error);
			throw new LineMcpError('storage_error', 'Writing session storage failed', { cause: error });
		}
	}
}

function encode(value: Value): [string, string] {
	if (value === null) return ['null', ''];
	switch (typeof value) {
		case 'string':
			return ['string', value];
		case 'number':
			return ['number', String(value)];
		case 'bigint':
			return ['bigint', value.toString()];
		case 'boolean':
			return ['boolean', String(value)];
		default:
			return ['json', JSON.stringify(value)];
	}
}

function decode(row: KvRow): Value {
	switch (row.kind) {
		case 'string':
			return row.value;
		case 'number':
			return Number(row.value);
		case 'bigint':
			return BigInt(row.value);
		case 'boolean':
			return row.value === 'true';
		case 'null':
			return null;
		case 'json':
			return JSON.parse(row.value) as Value;
		default:
			throw new Error(`Unknown storage kind ${row.kind}`);
	}
}
