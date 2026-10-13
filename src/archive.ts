import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { LineMcpError } from './errors.ts';

export type Service = 'talk' | 'square';
export type Health = 'online' | 'catching_up' | 'offline' | 'needs_login' | 'storage_error';

/** `sync_state` holds JSON values; integer IDs inside them stay decimal strings. */
export function readState<T>(db: DatabaseSync, key: string): T | undefined {
	const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
		{ value: string } | undefined;
	return row ? (JSON.parse(row.value) as T) : undefined;
}

export function writeState(db: DatabaseSync, key: string, value: unknown, now = Date.now()): void {
	db.prepare(
		`INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	).run(key, JSON.stringify(value), now);
}

export function deleteState(db: DatabaseSync, key: string): void {
	db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
}

export function stateKeys(db: DatabaseSync, prefix: string): string[] {
	return db
		.prepare('SELECT key FROM sync_state WHERE substr(key, 1, ?) = ? ORDER BY key')
		.all(prefix.length, prefix)
		.map((row) => String(row.key));
}

export interface ChatInfo {
	service: Service;
	chatId: string;
	type: string;
	name?: string;
	memberCount?: number;
	lastActivityAt?: number;
}

/** Inserts or refreshes a chat; unknown fields keep their stored value. */
export function upsertChat(db: DatabaseSync, chat: ChatInfo, now = Date.now()): void {
	db.prepare(
		`INSERT INTO chat (service, chat_id, type, name, member_count, last_activity_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (service, chat_id) DO UPDATE SET
			type = excluded.type,
			name = coalesce(excluded.name, chat.name),
			member_count = coalesce(excluded.member_count, chat.member_count),
			last_activity_at = max(coalesce(excluded.last_activity_at, 0), coalesce(chat.last_activity_at, 0)),
			updated_at = excluded.updated_at`
	).run(
		chat.service,
		chat.chatId,
		chat.type,
		chat.name ?? null,
		chat.memberCount ?? null,
		chat.lastActivityAt ?? null,
		now
	);
}

/**
 * Records an own member MID `getSquareChat` confirmed in a Square chat. Earlier
 * members stay, so the account's older messages keep counting as its own.
 */
export function addSquareSelfMember(
	db: DatabaseSync,
	chatId: string,
	memberId: string,
	now = Date.now()
): void {
	db.prepare(
		`INSERT INTO square_self_member (chat_id, member_id, confirmed_at) VALUES (?, ?, ?)
		ON CONFLICT (chat_id, member_id) DO UPDATE SET confirmed_at = excluded.confirmed_at`
	).run(chatId, memberId, now);
}

/**
 * Inserts or renames a participant. With `onlyUnnamed`, a stored name wins, so
 * a fallback lookup never replaces a name an event delivered meanwhile.
 */
export function upsertParticipant(
	db: DatabaseSync,
	service: Service,
	id: string,
	displayName: string,
	now = Date.now(),
	options: { onlyUnnamed?: boolean } = {}
): void {
	db.prepare(
		`INSERT INTO participant (service, participant_id, display_name, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (service, participant_id) DO UPDATE SET
			display_name = excluded.display_name, updated_at = excluded.updated_at
		${options.onlyUnnamed ? 'WHERE participant.display_name IS NULL' : ''}`
	).run(service, id, displayName, now);
}

export type GapStatus = 'open' | 'reconciled' | 'incomplete';

export interface Gap {
	id: number;
	service: Service;
	scope: string;
	reason: string;
	detail: Record<string, unknown>;
	status: GapStatus;
	openedAt: number;
	closedAt: number | null;
}

/**
 * Records a coverage gap. With `dedupe`, an open gap of the same scope and
 * reason is reused, so a repeating condition does not add a row per attempt.
 */
export function openGap(
	db: DatabaseSync,
	gap: { service: Service; scope: string; reason: string; detail: Record<string, unknown> },
	options: { dedupe?: boolean; now?: number } = {}
): number {
	if (options.dedupe) {
		const open = db
			.prepare(
				`SELECT id FROM coverage_gap
				WHERE service = ? AND scope = ? AND reason = ? AND status = 'open'`
			)
			.get(gap.service, gap.scope, gap.reason) as { id: number } | undefined;
		if (open) return open.id;
	}
	const { lastInsertRowid } = db
		.prepare(
			`INSERT INTO coverage_gap (service, scope, reason, detail, status, opened_at)
			VALUES (?, ?, ?, ?, 'open', ?)`
		)
		.run(gap.service, gap.scope, gap.reason, JSON.stringify(gap.detail), options.now ?? Date.now());
	return Number(lastInsertRowid);
}

export function closeGap(
	db: DatabaseSync,
	id: number,
	status: Exclude<GapStatus, 'open'>,
	detail: Record<string, unknown> = {},
	now = Date.now()
): void {
	db.prepare(
		`UPDATE coverage_gap SET status = ?, closed_at = ?, detail = json_patch(detail, ?)
		WHERE id = ? AND status = 'open'`
	).run(status, now, JSON.stringify(detail), id);
}

export function listGaps(
	db: DatabaseSync,
	filter: { service?: Service; status?: GapStatus | 'unreconciled' } = {}
): Gap[] {
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	if (filter.service) {
		where.push('service = ?');
		params.push(filter.service);
	}
	if (filter.status === 'unreconciled') {
		where.push(`status != 'reconciled'`);
	} else if (filter.status) {
		where.push('status = ?');
		params.push(filter.status);
	}
	const rows = db
		.prepare(
			`SELECT * FROM coverage_gap ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`
		)
		.all(...params);
	return rows.map((row) => ({
		id: Number(row.id),
		service: row.service as Service,
		scope: String(row.scope),
		reason: String(row.reason),
		detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
		status: row.status as GapStatus,
		openedAt: Number(row.opened_at),
		closedAt: row.closed_at === null ? null : Number(row.closed_at)
	}));
}

export const healthKey = 'daemon:health';

export interface HealthRecord {
	state: Health;
	since: number;
}

export function readHealth(db: DatabaseSync): HealthRecord | undefined {
	return readState<HealthRecord>(db, healthKey);
}

export const talkSyncedAtKey = 'talk:syncedAt';
export const squareSyncedAtKey = 'square:syncedAt';

export interface ArchiveStatus {
	health: Health | 'unknown';
	stale: boolean;
	talkSyncedAt: number | null;
	squareSyncedAt: number | null;
	unreconciledGaps: number;
	backfill: Record<string, number>;
}

/**
 * What every read envelope reports about freshness. A caller that knows the
 * current health (the daemon) passes it: the persisted record lags behind
 * when the archive cannot be written.
 */
export function archiveStatus(db: DatabaseSync, current?: Health): ArchiveStatus {
	const health = current ?? readHealth(db)?.state ?? 'unknown';
	const backfill: Record<string, number> = {};
	for (const key of stateKeys(db, 'backfill:')) {
		const reason = readState<{ stopReason?: string }>(db, key)?.stopReason ?? 'running';
		backfill[reason] = (backfill[reason] ?? 0) + 1;
	}
	return {
		health,
		stale: health !== 'online' && health !== 'catching_up',
		talkSyncedAt: readState<number>(db, talkSyncedAtKey) ?? null,
		squareSyncedAt: readState<number>(db, squareSyncedAtKey) ?? null,
		unreconciledGaps: listGaps(db, { status: 'unreconciled' }).length,
		backfill
	};
}

export interface MessageView {
	service: Service;
	chatId: string;
	messageId: string;
	threadId: string | null;
	sender: string | null;
	sentAt: number | null;
	editedAt: number | null;
	contentType: string | null;
	text: string | null;
	replyTo: string | null;
	mentions: string | null;
	decryptState: string;
	unsent: boolean;
	seq: number;
	/** Archive row id: the tiebreak of the read order, never a LINE ID. */
	rowId: number;
}

// The envelope is never part of a view: tool results carry no raw envelopes.
const viewColumns = `m.service, m.chat_id, m.message_id, m.thread_id, m.sender, m.sent_at,
	m.edited_at, m.content_type, m.text, m.reply_to, m.mentions, m.decrypt_state, m.unsent, m.seq,
	m.id`;

const nullable = (value: unknown) => (value === null ? null : String(value));
const time = (value: unknown) => (value === null ? null : Number(value));

function view(row: Record<string, unknown>): MessageView {
	return {
		service: row.service as Service,
		chatId: String(row.chat_id),
		messageId: String(row.message_id),
		threadId: nullable(row.thread_id),
		sender: nullable(row.sender),
		sentAt: time(row.sent_at),
		editedAt: time(row.edited_at),
		contentType: nullable(row.content_type),
		text: nullable(row.text),
		replyTo: nullable(row.reply_to),
		mentions: nullable(row.mentions),
		decryptState: String(row.decrypt_state),
		unsent: row.unsent === 1,
		seq: Number(row.seq),
		rowId: Number(row.id)
	};
}

/**
 * A message's place in the read order: send time (0 when unknown), then row
 * id. Keyset pages continue strictly before or after one.
 */
export interface Position {
	sentAt: number;
	rowId: number;
}

export function positionOf(message: MessageView): Position {
	return { sentAt: message.sentAt ?? 0, rowId: message.rowId };
}

const orderKey = 'coalesce(m.sent_at, 0)';

// Written as a bound on the order key plus a tiebreak, so an index on it serves a range.
function keyset(position: Position | undefined, direction: '<' | '>', params: SQLInputValue[]) {
	if (!position) return '';
	params.push(position.sentAt, position.sentAt, position.rowId);
	return `AND ${orderKey} ${direction}= ? AND (${orderKey} ${direction} ? OR m.id ${direction} ?)`;
}

/**
 * One chat (or one thread of it; `threadId: null` for the main chat without
 * its threads). Newest first, continuing before `before`; with `after`, oldest
 * first from just after it. Tombstones appear with their metadata only.
 */
export function readMessages(
	db: DatabaseSync,
	options: {
		service: Service;
		chatId: string;
		threadId?: string | null;
		limit?: number;
		before?: Position;
		after?: Position;
	}
): MessageView[] {
	const params: SQLInputValue[] = [options.service, options.chatId];
	let thread = '';
	if (options.threadId === null) thread = 'AND m.thread_id IS NULL';
	else if (options.threadId !== undefined) {
		thread = 'AND m.thread_id = ?';
		params.push(options.threadId);
	}
	const newer = options.after !== undefined;
	const page = newer ? keyset(options.after, '>', params) : keyset(options.before, '<', params);
	const order = newer ? 'ASC' : 'DESC';
	return db
		.prepare(
			`SELECT ${viewColumns} FROM message m
			WHERE m.service = ? AND m.chat_id = ? ${thread} ${page}
			ORDER BY ${orderKey} ${order}, m.id ${order} LIMIT ?`
		)
		.all(...params, options.limit ?? 50)
		.map(view);
}

/** One message by its LINE ID in a chat, tombstones included. */
export function findMessage(
	db: DatabaseSync,
	key: { service: Service; chatId: string; messageId: string }
): MessageView | undefined {
	const row = db
		.prepare(
			`SELECT ${viewColumns} FROM message m
			WHERE m.service = ? AND m.chat_id = ? AND m.message_id = ?`
		)
		.get(key.service, key.chatId, key.messageId);
	return row ? view(row) : undefined;
}

/** The retained envelope of one row, for media download; never part of a tool result. */
export function readEnvelope(db: DatabaseSync, rowId: number): string | undefined {
	const row = db.prepare('SELECT envelope FROM message WHERE id = ?').get(rowId) as
		{ envelope: string } | undefined;
	return row?.envelope;
}

const maxSearchTerms = 10;

/**
 * Splits a search query into terms: words separated by whitespace, and phrases
 * in double quotes, kept whole with their spaces. A double quote itself cannot
 * be searched. Every term must occur in a match.
 */
export function searchTerms(query: string): string[] {
	const parts = query.split('"');
	if (parts.length % 2 === 0) {
		throw new LineMcpError('invalid_argument', 'A quoted phrase in the query is not closed');
	}
	// Odd parts are inside quotes.
	const terms = parts.flatMap((part, index) =>
		index % 2 === 1 ? (part.trim() ? [part] : []) : part.split(/\s+/u).filter(Boolean)
	);
	if (terms.length === 0) throw new LineMcpError('invalid_argument', 'The query has no words');
	if (terms.length > maxSearchTerms) {
		throw new LineMcpError(
			'invalid_argument',
			`A query has at most ${maxSearchTerms} words or quoted phrases`
		);
	}
	return terms;
}

/** Rows one scan page reads at most; the next page continues after the last one read. */
const scanLimit = 50_000;

export interface SearchResult {
	mode: 'fts' | 'scan';
	messages: MessageView[];
	/**
	 * Scan only: the last row read when the scan stopped at `scanLimit` rows with
	 * fewer than `limit` hits while older rows remain to read. The next page continues after it.
	 */
	scannedTo: Position | null;
}

/**
 * Send times a search keeps: from `since` (inclusive) to `until` (exclusive),
 * in UTC milliseconds. A message without a send time is outside any range.
 */
export interface SentRange {
	since?: number;
	until?: number;
}

/**
 * Messages whose text contains every term of `query` (see `searchTerms`),
 * newest first, continuing before `before`. Terms of three or more characters
 * use the FTS5 trigram index, which folds case; shorter ones filter with
 * `instr` over `lower`, which folds ASCII letters only. A query of only short
 * terms reads at most `scanLimit` rows a call (see `scanRows`).
 */
export function searchMessages(
	db: DatabaseSync,
	options: {
		query: string;
		service?: Service;
		chatId?: string;
		sender?: string;
		sent?: SentRange;
		limit?: number;
		before?: Position;
	}
): SearchResult {
	const limit = options.limit ?? 50;
	const terms = searchTerms(options.query);
	const long = terms.filter((term) => [...term].length >= 3);
	const short = terms.filter((term) => [...term].length < 3);
	const sent = sentBounds(options.sent);
	const scope: string[] = ['m.unsent = 0'];
	const params: SQLInputValue[] = [];
	if (options.service) {
		scope.push('m.service = ?');
		params.push(options.service);
	}
	if (options.chatId !== undefined) {
		scope.push('m.chat_id = ?');
		params.push(options.chatId);
	}
	if (options.sender !== undefined) {
		scope.push('m.sender = ?');
		params.push(options.sender);
	}
	if (sent) {
		scope.push('m.sent_at >= ?', 'm.sent_at < ?');
		params.push(sent.from, sent.until);
	}
	// `instr` keeps text after an embedded NUL, where `LIKE` would stop.
	scope.push(...short.map(() => 'instr(lower(m.text), lower(?)) > 0'));
	params.push(...short);
	if (long.length > 0) {
		// Quoted phrases: `AND`, `NEAR` or `*` inside a term are text, not operators.
		const match = long.map((term) => `"${term}"`).join(' AND ');
		const pageParams: SQLInputValue[] = [];
		const page = keyset(options.before, '<', pageParams);
		const rows = db
			.prepare(
				`SELECT ${viewColumns} FROM message_fts f JOIN message m ON m.id = f.rowid
				WHERE message_fts MATCH ? AND ${scope.join(' AND ')} ${page}
				ORDER BY ${orderKey} DESC, m.id DESC LIMIT ?`
			)
			.all(match, ...params, ...pageParams, limit);
		return { mode: 'fts', messages: rows.map(view), scannedTo: null };
	}

	// `until` is where the scan starts, `since` where it ends: rows outside the range are never read.
	const from = options.before ?? {
		sentAt: sent?.until ?? Number.MAX_SAFE_INTEGER,
		rowId: sent ? 0 : Number.MAX_SAFE_INTEGER
	};
	const chat =
		options.service && options.chatId !== undefined
			? { service: options.service, chatId: options.chatId }
			: undefined;
	const read = scanRows(from, chat, sent?.from);
	// The rows read come first, so the hits keep their order and the page stops early once full.
	const rows = db
		.prepare(
			`SELECT ${viewColumns} FROM (${read.sql} LIMIT ?) w CROSS JOIN message m ON m.id = w.id
			WHERE ${scope.join(' AND ')}
			ORDER BY w.k DESC, w.id DESC LIMIT ?`
		)
		.all(...read.params, scanLimit, ...params, limit);
	if (rows.length >= limit) return { mode: 'scan', messages: rows.map(view), scannedTo: null };
	const [last, beyond] = db
		.prepare(`${read.sql} LIMIT 2 OFFSET ?`)
		.all(...read.params, scanLimit - 1);
	return {
		mode: 'scan',
		messages: rows.map(view),
		scannedTo: last && beyond ? { sentAt: Number(last.k ?? 0), rowId: Number(last.id) } : null
	};
}

/**
 * A `SentRange` as SQL bounds. Send times are positive, so a lower bound of at
 * least 1 also leaves out the messages without one.
 */
function sentBounds(range: SentRange | undefined): { from: number; until: number } | undefined {
	if (range?.since === undefined && range?.until === undefined) return undefined;
	return {
		from: Math.max(1, range.since ?? 1),
		until: range.until ?? Number.MAX_SAFE_INTEGER
	};
}

/**
 * The rows a scan reads, newest first strictly after `from` in the read order,
 * as `id` and the order key `k`, from an index alone; with `lowest`, only rows
 * sent at or after it. In one chat `message_chat_order` serves that order.
 * Across chats `message_recent (sent_at, id)` does: a send time is positive or
 * unknown (ordered as 0), so the rows with one come first and the rest follow.
 * The unknown ones keep `k` NULL, which sorts last like 0, so the index order
 * needs no sort.
 */
function scanRows(
	from: Position,
	chat: { service: Service; chatId: string } | undefined,
	lowest?: number
): { sql: string; params: SQLInputValue[] } {
	if (chat) {
		const params: SQLInputValue[] = [chat.service, chat.chatId];
		const page = keyset(from, '<', params);
		if (lowest !== undefined) params.push(lowest);
		return {
			sql: `SELECT m.id AS id, ${orderKey} AS k FROM message m
				WHERE m.service = ? AND m.chat_id = ? ${page}
				${lowest === undefined ? '' : `AND ${orderKey} >= ?`}
				ORDER BY ${orderKey} DESC, m.id DESC`,
			params
		};
	}
	if (lowest !== undefined) {
		return {
			sql: `SELECT m.id AS id, m.sent_at AS k FROM message m
				WHERE m.sent_at <= ? AND (m.sent_at < ? OR m.id < ?) AND m.sent_at >= ?
				ORDER BY 2 DESC, 1 DESC`,
			params: [from.sentAt, from.sentAt, from.rowId, lowest]
		};
	}
	return {
		sql: `SELECT m.id AS id, m.sent_at AS k FROM message m
			WHERE m.sent_at <= ? AND (m.sent_at < ? OR m.id < ?)
			UNION ALL
			SELECT m.id, m.sent_at FROM message m WHERE m.sent_at IS NULL AND (? > 0 OR m.id < ?)
			ORDER BY 2 DESC, 1 DESC`,
		params: [from.sentAt, from.sentAt, from.rowId, from.sentAt, from.rowId]
	};
}

/** Rows whose last insert or change has `seq > afterSeq`, in `seq` order. */
export function listChanges(
	db: DatabaseSync,
	options: { afterSeq: number; limit?: number }
): MessageView[] {
	return db
		.prepare(`SELECT ${viewColumns} FROM message m WHERE m.seq > ? ORDER BY m.seq LIMIT ?`)
		.all(options.afterSeq, options.limit ?? 50)
		.map(view);
}
