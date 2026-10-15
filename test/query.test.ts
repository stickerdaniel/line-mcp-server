import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSquareSelfMember, upsertChat, writeState } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { QueryRunner } from '../src/mcp/tools/query.ts';
import type { StatePrivacy } from '../src/privacy.ts';
import { relations } from '../src/query/surface.ts';
import type { LogEntry } from '../src/session.ts';
import { applyChanges, type MessageRow } from '../src/sync/normalize.ts';
import { renderTime } from '../src/time.ts';
import { modePrivacy, otherMid, seedLive, selfMid, tempRoot, within } from './fake-line.ts';
import { callTool, listTools, serve, type ServeOptions } from './mcp-client.ts';

// The `query` tool as an agent calls it over MCP, on an archive written
// through the sync write path, with secrets planted everywhere a query must
// not reach. `served().query` checks every result for them, and each test's
// logs are checked after it.

const secrets = {
	lineKv: 'canary-line-kv-7d1e',
	outbox: 'canary-outbox-41c2',
	syncState: 'canary-sync-state-9a0b',
	envelope: 'canary-envelope-77ab',
	missingKey: 'canary-missing-key-5e3f',
	account: 'canary-account-c4d8',
	gap: 'canary-gap-08f1',
	unsent: 'canary unsent pineapple 2f6a'
};

const squareChat = `m${'d'.repeat(32)}`;
const squareMember = `p${'e'.repeat(32)}`;
const dinner = '100000000000000001';

function row(
	messageId: string,
	minute: number,
	text: string | null,
	extra: Partial<MessageRow> = {}
) {
	return {
		service: 'talk',
		chatId: otherMid,
		chatType: 'user',
		messageId,
		threadId: null,
		sender: otherMid,
		sentAt: 1_800_000_000_000 + minute * 60_000,
		editedAt: null,
		contentType: 'NONE',
		text,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ text, note: secrets.envelope }),
		decryptState: 'ok',
		missingKey: null,
		...extra
	} satisfies MessageRow;
}

/** Writes every table of the archive, secrets included, as the daemon would. */
function seed(db: DatabaseSync): void {
	const now = 1_800_000_000_000;
	transaction(db, () => {
		applyChanges(
			db,
			[
				{ kind: 'message', row: row(dinner, 1, 'see you at dinner') },
				{
					kind: 'message',
					row: row('100000000000000002', 2, null, {
						contentType: 'STICKER',
						envelope: JSON.stringify({
							contentType: 'STICKER',
							contentMetadata: { STKID: '52002734', STKTXT: '[OK]' },
							note: secrets.envelope
						})
					})
				},
				{
					kind: 'message',
					row: row('100000000000000003', 3, null, {
						decryptState: 'missing_key',
						missingKey: secrets.missingKey
					})
				},
				{ kind: 'message', row: row('100000000000000004', 4, secrets.unsent) },
				{ kind: 'message', row: row('100000000000000005', 5, 'on my way', { sender: selfMid }) },
				{ kind: 'participant', service: 'talk', id: otherMid, displayName: 'Mei' },
				{ kind: 'read', service: 'talk', chatId: otherMid, marker: dinner }
			],
			{ now }
		);
		applyChanges(db, [
			{ kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '100000000000000004' }
		]);
		upsertChat(db, { service: 'square', chatId: squareChat, type: 'square', name: 'Hikers' }, now);
		addSquareSelfMember(db, squareChat, squareMember, now);
		db.prepare(`INSERT INTO line_kv (key, kind, value) VALUES ('planted', 'string', ?)`).run(
			secrets.lineKv
		);
		db.prepare(
			`INSERT INTO outbox (idempotency_key, operation, service, chat_id, payload, payload_hash,
				state, error, created_at, updated_at)
			VALUES (?, 'send_message', 'talk', ?, ?, 'hash', 'sent', ?, 1, 1)`
		).run(secrets.outbox, otherMid, secrets.outbox, secrets.outbox);
		writeState(db, 'talk:planted', { secret: secrets.syncState });
		db.prepare('UPDATE account SET device = ?, linejs_version = ?, bound_at = ?').run(
			secrets.account,
			secrets.account,
			secrets.account
		);
		db.prepare(
			`INSERT INTO coverage_gap (service, scope, reason, detail, status, opened_at)
			VALUES ('talk', ?, ?, ?, 'open', 1)`
		).run(secrets.gap, secrets.gap, JSON.stringify({ note: secrets.gap }));
	});
}

const watched: LogEntry[][] = [];
afterEach(() => {
	for (const logs of watched.splice(0)) {
		const text = JSON.stringify(logs);
		for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
	}
});

/** A server over a seeded archive; `query` asserts that no secret comes back. */
async function served(options: ServeOptions = {}) {
	const fixture = await serve({}, undefined, options);
	seed(fixture.session.db);
	watched.push(fixture.logs);
	const query = async (sql: string) => {
		const call = await callTool(fixture.server.port, 'query', { sql });
		for (const secret of Object.values(secrets)) expect(call.text).not.toContain(secret);
		return call;
	};
	return { ...fixture, port: fixture.server.port, query };
}

const errorOf = (call: { data: Record<string, unknown> }) =>
	call.data.error as { code: string; message: string };

/** Sends one `query` call and keeps its connection open; destroying the socket cancels it. */
function openCall(port: number, sql: string): Promise<Socket> {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'query', arguments: { sql } }
	});
	const raw = [
		'POST /mcp HTTP/1.1',
		`Host: 127.0.0.1:${port}`,
		'Content-Type: application/json',
		'Accept: application/json, text/event-stream',
		`Content-Length: ${Buffer.byteLength(body)}`,
		'',
		body
	].join('\r\n');
	return new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		socket.on('error', () => {});
		socket.on('connect', () => {
			socket.write(raw);
			resolve(socket);
		});
	});
}

/** A privacy guard whose database check waits while held, so a runner start can be held. */
function heldPrivacy() {
	let gate: PromiseWithResolvers<void> | undefined;
	let waiting = 0;
	const privacy: StatePrivacy = {
		...modePrivacy,
		database: async (root, options) => {
			waiting++;
			await gate?.promise;
			waiting--;
			await modePrivacy.database(root, options);
		}
	};
	return {
		privacy,
		hold: () => void (gate = Promise.withResolvers()),
		release: () => gate?.resolve(),
		waiting: () => waiting
	};
}

const runaway =
	'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c';

/** The numbers 1 to `limit`, one row each. */
const counting = (limit: number) =>
	`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ${limit}) SELECT x FROM c`;

/** One row of `count` constant columns. */
const constants = (count: number) =>
	`SELECT ${Array.from({ length: count }, (_, index) => `${index} AS c${index}`).join(', ')}`;

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('query', () => {
	it('returns rows with the freshness envelope', async () => {
		const { query } = await served();

		const result = await query(
			`SELECT m.message_id, m.text, p.display_name
			FROM message m JOIN participant p ON p.service = m.service AND p.participant_id = m.sender
			WHERE m.text IS NOT NULL ORDER BY m.id`
		);

		expect(result.isError).toBe(false);
		expect(result.data).toMatchObject({
			health: expect.any(String),
			stale: expect.any(Boolean),
			synced_at: expect.any(Object),
			columns: ['message_id', 'text', 'display_name'],
			rows: [[dinner, 'see you at dinner', 'Mei']]
		});
		expect(result.data).not.toHaveProperty('truncated');
	});

	it('reads non-text fields, own members and read state, with large integers as text', async () => {
		const { query } = await served();

		const result = await query(
			`SELECT
				(SELECT alt_text FROM message WHERE content_type = 'STICKER'),
				(SELECT member_id FROM square_self_member),
				(SELECT marker FROM read_state),
				(SELECT mid FROM account),
				9007199254740993`
		);

		expect(result.data.rows).toEqual([['[OK]', squareMember, dinner, selfMid, '9007199254740993']]);
	});

	it.each([
		'line_kv',
		'outbox',
		'sync_state',
		'change_counter',
		'coverage_gap',
		'dbstat',
		'main.line_kv'
	])('denies reading %s', async (table) => {
		const { query, logs } = await served();
		const name = table.replace('main.', '');

		for (const sql of [`SELECT * FROM ${table}`, `SELECT count(*) FROM ${table}`]) {
			const result = await query(sql);
			expect(errorOf(result)).toMatchObject({
				code: 'query_denied',
				message: `Denied: READ ${name}`
			});
		}
		expect(logs).toContainEqual({ event: 'query_denied', action: 'READ', object: name });
		expect(logs).toContainEqual({ event: 'tool_failed', code: 'query_denied', operation: 'query' });
	});

	it('denies reading the stored schema under each of its names', async () => {
		const { query } = await served();

		for (const table of [
			'sqlite_master',
			'sqlite_schema',
			'main.sqlite_schema',
			'sqlite_temp_master',
			'sqlite_temp_schema',
			'temp.sqlite_schema'
		]) {
			expect(errorOf(await query(`SELECT name, sql FROM ${table}`)).code).toBe('query_denied');
			expect(errorOf(await query(`SELECT count(*) FROM ${table}`)).code).toBe('query_denied');
		}
		// Not part of this SQLite build: no such table.
		expect((await query('SELECT * FROM sqlite_dbpage')).isError).toBe(true);
	});

	it('denies table-valued pragmas, a denied function and TEMP objects', async () => {
		const { query } = await served();

		for (const [sql, message] of [
			[`SELECT * FROM pragma_table_info('message')`, 'Denied: READ pragma_table_info'],
			[`SELECT count(*) FROM pragma_table_info('line_kv')`, 'Denied: READ pragma_table_info'],
			['SELECT name FROM pragma_database_list', 'Denied: READ pragma_database_list'],
			[`SELECT load_extension('x')`, 'Denied: FUNCTION load_extension']
		] as const) {
			expect(errorOf(await query(sql))).toEqual({
				code: 'query_denied',
				operation: 'query',
				message
			});
		}
		for (const sql of [
			'CREATE VIRTUAL TABLE temp.copy USING fts5(text)',
			'CREATE TEMP VIEW copy AS SELECT envelope FROM message',
			'CREATE TEMP TABLE copy AS SELECT 1'
		]) {
			expect(errorOf(await query(sql)).code).toBe('query_denied');
		}
		expect((await query(`SELECT count(*) FROM temp.sqlite_master`)).isError).toBe(true);
	});

	it('refuses writes, ATTACH, PRAGMA, transactions and copies of the archive', async () => {
		const { query, root, logs } = await served();
		const copy = join(root, 'copy.db');

		for (const sql of [
			`INSERT INTO message (service, chat_id, message_id, envelope, decrypt_state, seq)
				VALUES ('talk', 'x', '9', '{}', 'ok', 99)`,
			`UPDATE chat SET name = 'x'`,
			'DELETE FROM message',
			`ATTACH '${copy}' AS other`,
			'PRAGMA user_version',
			'PRAGMA journal_mode = DELETE',
			'BEGIN',
			'SAVEPOINT here',
			'ANALYZE',
			'REINDEX',
			'VACUUM',
			`VACUUM INTO '${copy}'`
		]) {
			expect(errorOf(await query(sql)).code).toBe('query_denied');
		}
		expect(existsSync(copy)).toBe(false);
		expect((await query('SELECT count(*) FROM message')).data.rows).toEqual([[5]]);
		// The path came from the SQL: the log names no object it did not know.
		expect(logs).toContainEqual({ event: 'query_denied', action: 'ATTACH', object: 'other' });
		expect(JSON.stringify(logs)).not.toContain('copy.db');
	});

	it('refuses more than one statement', async () => {
		const { query } = await served();

		for (const sql of ['SELECT 1; SELECT 2', '-- nothing', ';']) {
			expect(errorOf(await query(sql))).toMatchObject({
				code: 'query_failed',
				message: 'A query is one SQL statement'
			});
		}
		// node:sqlite finalizes it; the answer is an SQL error, not a stopped runner.
		const unterminated = errorOf(await query('; /* unterminated'));
		expect(unterminated.code).toBe('query_failed');
		expect(unterminated.message).not.toContain('runner');
		expect((await query('SELECT 1; -- done\n')).data.rows).toEqual([[1]]);
	});

	it('reads every unlisted column as NULL, wherever the query uses it', async () => {
		const { query } = await served();

		const all = await query('SELECT * FROM message ORDER BY id');
		const columns = all.data.columns as string[];
		const rows = all.data.rows as unknown[][];
		expect(rows).toHaveLength(5);
		for (const entry of rows) {
			expect(entry[columns.indexOf('envelope')]).toBeNull();
			expect(entry[columns.indexOf('missing_key')]).toBeNull();
		}
		expect(rows[2]![columns.indexOf('decrypt_state')]).toBe('missing_key');

		for (const sql of [
			'SELECT id FROM message WHERE envelope IS NOT NULL OR missing_key IS NOT NULL',
			`SELECT id FROM message WHERE instr(envelope, 'canary') > 0`,
			`SELECT json_extract(envelope, '$.note') AS note FROM message WHERE note IS NOT NULL`,
			'SELECT max(length(envelope)), group_concat(missing_key) FROM message HAVING max(length(envelope)) > 0',
			`SELECT e FROM (SELECT first_value(envelope) OVER (ORDER BY id) AS e FROM message)
				WHERE e IS NOT NULL`,
			'SELECT id FROM message WHERE id = (SELECT id FROM message WHERE missing_key IS NOT NULL)',
			'SELECT device, linejs_version, bound_at FROM account WHERE device IS NOT NULL'
		]) {
			expect((await query(sql)).data.rows).toEqual([]);
		}
		// Ordering on a masked column keeps every row in table order.
		expect(
			(await query('SELECT message_id FROM message ORDER BY envelope DESC, id')).data.rows
		).toHaveLength(5);
	});

	it('searches text with FTS5: MATCH, highlight, snippet, bm25 and rank', async () => {
		const { query } = await served();

		const result = await query(
			`SELECT m.message_id, highlight(message_fts, 0, '[', ']'),
				snippet(message_fts, 0, '[', ']', '…', 64), bm25(message_fts) < 0
			FROM message_fts JOIN message m ON m.id = message_fts.rowid
			WHERE message_fts MATCH '"DINNER"' AND rank MATCH 'bm25(10.0)' ORDER BY rank`
		);

		expect(result.data.rows).toEqual([[dinner, 'see you at [dinner]', 'see you at [dinner]', 1]]);
		expect((await query(`SELECT count(*) FROM message_fts('"way"')`)).data.rows).toEqual([[1]]);
	});

	it('keeps unsent text out of reach of every FTS path', async () => {
		const { query } = await served();

		const unsent = await query(
			`SELECT id, text, unsent FROM message WHERE message_id = '100000000000000004'`
		);
		expect((unsent.data.rows as unknown[][])[0]!.slice(1)).toEqual([null, 1]);
		for (const term of ['pineapple', 'canary', 'nsent']) {
			expect(
				(await query(`SELECT rowid FROM message_fts WHERE message_fts MATCH '"${term}"'`)).data.rows
			).toEqual([]);
		}
		// FTS5 keeps trigrams of deleted text in its shadow tables.
		for (const sql of [
			'SELECT * FROM message_fts_data',
			'SELECT term FROM message_fts_idx',
			'SELECT * FROM message_fts_config',
			'SELECT * FROM message_fts_docsize',
			'SELECT (SELECT group_concat(term) FROM message_fts_idx)',
			'WITH x AS MATERIALIZED (SELECT block FROM message_fts_data) SELECT * FROM x',
			`SELECT rowid FROM message_fts WHERE message_fts MATCH 'dinner'
				AND rowid IN (SELECT segid FROM message_fts_idx)`
		]) {
			expect(errorOf(await query(sql))).toMatchObject({
				code: 'query_denied',
				message: expect.stringMatching(/^Denied: READ message_fts_/)
			});
		}
		// FTS5 compiles a rank string while the query steps, with the shadow tables
		// readable: it takes only literal arguments and drops anything after them.
		const ranked = (rank: string) =>
			query(
				`SELECT rowid, rank FROM message_fts WHERE message_fts MATCH 'dinner' AND rank MATCH '${rank}'`
			);
		expect(errorOf(await ranked('bm25((SELECT count(*) FROM message_fts_idx))'))).toMatchObject({
			code: 'query_failed',
			message: expect.stringContaining('parse error in rank function')
		});
		const plain = (await ranked('bm25(1.0)')).data.rows;
		expect(plain).toEqual([[expect.any(Number), expect.any(Number)]]);
		for (const rank of [
			'bm25(1.0) FROM message_fts_idx; SELECT term',
			'bm25(1.0); SELECT term FROM message_fts_idx'
		]) {
			expect((await ranked(rank)).data.rows).toEqual(plain);
		}
	});

	it('finds what the daemon writes later, also after a schema change', async () => {
		const { query, session } = await served();
		const search = (term: string) =>
			query(`SELECT count(*) FROM message_fts WHERE message_fts MATCH '"${term}"'`);
		expect((await search('dinner')).data.rows).toEqual([[1]]);

		applyChanges(session.db, [
			{ kind: 'message', row: row('100000000000000006', 6, 'lunch tomorrow') }
		]);
		expect((await search('lunch')).data.rows).toEqual([[1]]);

		// Another connection changes the schema and FTS5's config while the runner is up.
		session.db.exec(`ALTER TABLE message ADD COLUMN later TEXT;
			CREATE INDEX message_later ON message (later);
			INSERT INTO message_fts (message_fts, rank) VALUES ('automerge', 8);`);
		session.db.exec(`UPDATE message SET later = 'x'`);
		expect((await query('SELECT count(*), count(later) FROM message')).data.rows).toEqual([[6, 0]]);
		expect((await search('tomorrow')).data.rows).toEqual([[1]]);
		applyChanges(session.db, [
			{ kind: 'message', row: row('100000000000000007', 7, 'dinner again') }
		]);
		expect((await search('dinner')).data.rows).toEqual([[2]]);
	});

	it('reads a CTE without columns, but not a stored table it is named after', async () => {
		const { query } = await served();

		expect((await query('WITH c AS (SELECT 1 AS a) SELECT count(*) FROM c')).data.rows).toEqual([
			[1]
		]);
		expect(
			(await query('SELECT EXISTS (WITH recent AS (SELECT id FROM message) SELECT 1 FROM recent)'))
				.data.rows
		).toEqual([[1]]);
		expect(
			errorOf(await query('WITH line_kv AS (SELECT 1 AS a) SELECT count(*) FROM line_kv')).code
		).toBe('query_denied');
	});

	it('keeps an SQLite message that quotes archive text out of the logs', async () => {
		const { query, logs } = await served();
		const sql = `SELECT json_extract('{}', text) FROM message WHERE message_id = '${dinner}'`;

		const result = await query(sql);

		expect(errorOf(result)).toMatchObject({
			code: 'query_failed',
			message: expect.stringContaining('see you at dinner')
		});
		expect(logs).toContainEqual({ event: 'tool_failed', code: 'query_failed', operation: 'query' });
		const logged = JSON.stringify(logs);
		expect(logged).not.toContain('dinner');
		expect(logged).not.toContain('json_extract');
	});

	it('caps rows at 200 and the result object at 64 KiB', async () => {
		const { query } = await served();

		const all = await query(counting(200));
		const many = await query(counting(500));
		const large = await query(
			`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 100)
			SELECT x, printf('%.2000c', 'y') FROM c`
		);

		expect(all.data.rows).toHaveLength(200);
		expect(all.data).not.toHaveProperty('truncated');
		expect(many.data.rows).toHaveLength(200);
		expect(many.data.truncated).toBe(true);
		const { columns, rows, truncated } = large.data as { rows: unknown[][] } & Record<
			string,
			unknown
		>;
		expect(truncated).toBe(true);
		expect(rows.length).toBeGreaterThan(20);
		const bytes = Buffer.byteLength(JSON.stringify({ columns, rows, truncated }));
		expect(bytes).toBeLessThanOrEqual(64 * 1024);
		expect(bytes).toBeGreaterThan(62 * 1024);
	});

	it('refuses columns whose names alone exceed 64 KiB', async () => {
		const { query } = await served();
		const name = 'n'.repeat(1200);
		const joined = Array.from({ length: 60 }, (_, index) => `a AS a${index}`).join(', ');

		const result = await query(`WITH a AS (SELECT 1 AS "${name}") SELECT * FROM ${joined}`);

		expect(errorOf(result)).toMatchObject({
			code: 'query_failed',
			message: 'The result columns exceed 64 KiB'
		});
	});

	it('refuses a result of more than 64 columns', async () => {
		const { query } = await served();

		const widest = await query(constants(64));
		const wider = await query(constants(65));

		expect(widest.data.columns).toHaveLength(64);
		expect(errorOf(wider)).toMatchObject({
			code: 'query_failed',
			message: 'A result has at most 64 columns'
		});
	});

	it('cuts an error message so the error result stays under 4 KiB', async () => {
		const { query } = await served();

		const result = await query(`SELECT json_extract('{}', printf('%.70000c', '"'))`);

		expect(errorOf(result)).toMatchObject({
			code: 'query_failed',
			message: expect.stringMatching(/^bad JSON path: '""+…$/)
		});
		expect(Buffer.byteLength(result.text)).toBeLessThan(4096);
		expect(Buffer.byteLength(result.text)).toBeGreaterThan(3500);
	});

	it('stops a runaway query at the time limit and answers the next one', async () => {
		const { query } = await served({ queryTimeoutMs: 300 });
		expect((await query('SELECT 1')).data.rows).toEqual([[1]]);

		const started = Date.now();
		const stopped = await query(runaway);

		expect(errorOf(stopped).code).toBe('query_timeout');
		expect(Date.now() - started).toBeLessThan(1300);
		expect((await query('SELECT 2')).data.rows).toEqual([[2]]);
	});

	it('ends the runner when its caller goes away, so the next query runs at once', async () => {
		const { query, port, logs } = await served({ queryTimeoutMs: 20_000 });
		expect((await query('SELECT 1')).data.rows).toEqual([[1]]);

		const socket = await openCall(port, runaway);
		await new Promise((resolve) => setTimeout(resolve, 100));
		socket.destroy();
		await vi.waitFor(() =>
			expect(logs).toContainEqual({ event: 'tool_failed', code: 'cancelled', operation: 'query' })
		);

		const started = Date.now();
		expect((await query('SELECT 2')).data.rows).toEqual([[2]]);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it('cancels a query while its runner is still starting', async () => {
		const held = heldPrivacy();
		const { query, port, logs } = await served({ privacy: held.privacy });
		held.hold();

		const socket = await openCall(port, 'SELECT 1');
		await vi.waitFor(() => expect(held.waiting()).toBe(1));
		socket.destroy();

		await vi.waitFor(() =>
			expect(logs).toContainEqual({ event: 'tool_failed', code: 'cancelled', operation: 'query' })
		);
		expect(held.waiting()).toBe(1);
		held.release();
		expect((await query('SELECT 2')).data.rows).toEqual([[2]]);
	});

	it('runs one query, queues four and refuses the rest with query_busy', async () => {
		const held = heldPrivacy();
		const { query } = await served({ privacy: held.privacy });
		held.hold();

		const outcomes = Array.from({ length: 8 }, () => ({ code: '' }));
		const calls = outcomes.map(async (outcome, index) => {
			const result = await query(`SELECT ${index}`);
			outcome.code = result.isError ? errorOf(result).code : 'ok';
		});
		await vi.waitFor(() =>
			expect(outcomes.filter((outcome) => outcome.code === 'query_busy')).toHaveLength(3)
		);
		expect(outcomes.filter((outcome) => outcome.code === '')).toHaveLength(5);

		held.release();
		await Promise.all(calls);
		expect(outcomes.filter((outcome) => outcome.code === 'ok')).toHaveLength(5);
	});

	it('answers with an error when the runner cannot start, and keeps serving', async () => {
		// The session opens first; only the runner's check fails.
		let refuse = false;
		const privacy: StatePrivacy = {
			...modePrivacy,
			database: (root, options) =>
				refuse ? Promise.reject(new Error('not private')) : modePrivacy.database(root, options)
		};
		const { query } = await served({ privacy });
		refuse = true;

		// An unhandled rejection of the failed start would fail this file and end a daemon.
		const first = await query('SELECT 1');
		const second = await query('SELECT 1');

		expect(first.isError).toBe(true);
		expect(second.isError).toBe(true);
	});

	it('starts a new runner after the old one was killed', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const runner = new QueryRunner({ root, privacy: modePrivacy });
		const signal = new AbortController().signal;
		try {
			await runner.query('SELECT 1', signal);
			const first = runner.pid!;

			process.kill(first, 'SIGKILL');
			await vi.waitFor(() => expect(runner.pid).toBeUndefined());

			expect(await runner.query('SELECT 2', signal)).toMatchObject({ ok: true, rows: [[2]] });
			expect(runner.pid).not.toBe(first);
		} finally {
			await runner.close();
		}
	});

	it('ends the runner when its parent dies during a runaway query', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const fixture = fileURLToPath(new URL('./fixtures/query-parent.ts', import.meta.url));
		const parent = spawn(process.execPath, [fixture, root], {
			stdio: ['ignore', 'pipe', 'ignore']
		});
		let output = '';
		parent.stdout.setEncoding('utf-8').on('data', (chunk: string) => (output += chunk));
		let pid: number | undefined;
		try {
			await within(
				10_000,
				vi.waitFor(() => expect(output).toMatch(/runner \d+/), { timeout: 10_000 }),
				'the runner to start'
			);
			pid = Number(/runner (\d+)/.exec(output)![1]);
			expect(alive(pid)).toBe(true);

			parent.kill('SIGKILL');

			await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 5000, interval: 20 });
		} finally {
			parent.kill('SIGKILL');
			if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
		}
	}, 20_000);
});

describe('local_time', () => {
	const zone = process.env.TZ;
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it("renders like every tool's times, in the zone the daemon has now", async () => {
		const { query } = await served();
		const instants = [
			'2026-01-15T04:30:00.123Z',
			'2026-07-15T04:30:00.123Z',
			'2026-11-01T05:30:00.000Z',
			'2026-11-01T06:30:00.000Z',
			'2026-10-12T04:30:00.123Z'
		].map((utc) => Date.parse(utc));
		const sql = `SELECT ${instants.map((ms) => `local_time(${ms})`).join(', ')}, local_time(NULL), local_time('x')`;

		for (const name of ['UTC', 'America/New_York', 'Asia/Kathmandu', 'Europe/Berlin', 'GMT+3']) {
			process.env.TZ = name;
			const rendered = (await query(sql)).data.rows as unknown[][];
			expect(rendered).toEqual([[...instants.map((ms) => renderTime(ms)), null, null]]);
		}
	});
});

describe('surface', () => {
	/** The columns of each table that are unreadable on purpose; the rest are listed. */
	const unreadable: Record<string, string[]> = {
		chat: ['updated_at'],
		participant: ['updated_at'],
		message: ['envelope', 'missing_key'],
		account: ['id', 'device', 'linejs_version', 'auth_state', 'auth_changed_at', 'bound_at'],
		square_self_member: ['confirmed_at'],
		read_state: [],
		message_fts: []
	};

	it('describes the schema in one block an agent host shows whole', async () => {
		const { port } = await served();

		const tool = (await listTools(port)).find((entry) => entry.name === 'query')!;
		const text = tool.description!;

		expect(text).not.toMatch(/\n\s*\n/);
		expect(text.length).toBeLessThan(4000);
		expect(Buffer.byteLength(text)).toBeLessThan(4000);
		expect(text).toContain('valid while `count_marker IS marker`.');
		for (const relation of relations) {
			expect(text).toContain(`\`${relation.name}(${relation.columns.join(', ')})\``);
		}
	});

	it('lists only columns a migrated archive has, and classifies every other one', () => {
		const db = openDatabase(tempRoot());
		const columnsOf = (table: string) =>
			db
				.prepare(`SELECT name FROM pragma_table_xinfo(?)`)
				.all(table)
				.map((entry) => String(entry.name));
		try {
			for (const relation of relations) {
				const columns = columnsOf(relation.name);
				expect(columns).toEqual(expect.arrayContaining([...relation.columns]));
				expect(columns.toSorted()).toEqual(
					[
						...relation.columns,
						...(relation.hidden ?? []).filter((name) => name !== 'rowid'),
						...unreadable[relation.name]!
					].toSorted()
				);
			}
		} finally {
			db.close();
		}
	});

	it('reads every unlisted column of every table as NULL or denies it', async () => {
		const { query, session } = await served();
		const tables = session.db
			.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
			.all()
			.map((entry) => String(entry.name));
		const listed = new Map(relations.map((relation) => [relation.name, relation]));
		expect(tables).toEqual(expect.arrayContaining([...listed.keys()]));

		for (const table of tables) {
			const columns = session.db
				.prepare('SELECT name FROM pragma_table_xinfo(?)')
				.all(table)
				.map((entry) => String(entry.name));
			const relation = listed.get(table);
			for (const column of columns) {
				if (relation?.columns.includes(column) || relation?.hidden?.includes(column)) continue;
				const result = await query(`SELECT count(*), count("${column}") FROM "${table}"`);
				if (relation) {
					// Rows are there, and the column reads NULL in each.
					expect([table, column, result.data.rows]).toEqual([
						table,
						column,
						[[expect.any(Number), 0]]
					]);
					expect((result.data.rows as number[][])[0]![0]).toBeGreaterThan(0);
				} else {
					expect([table, column, errorOf(result).code]).toEqual([table, column, 'query_denied']);
				}
			}
		}
	});
});
