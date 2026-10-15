import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { type NonTextFields, nonTextColumns } from './non-text.ts';

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
	/** What a non-text message holds, stored when it was written; all null for text and tombstones. */
	nonText: NonTextFields;
	/** Archive row id, which `readEnvelope` takes; never a LINE ID. */
	rowId: number;
}

// The envelope is never part of a view: tool results carry no raw envelopes.
const viewColumns = `m.service, m.chat_id, m.message_id, m.thread_id, m.sender, m.sent_at,
	m.edited_at, m.content_type, m.text, m.reply_to, m.mentions, m.decrypt_state, m.unsent, m.seq,
	m.id, ${nonTextColumns.map((column) => `m.${column}`).join(', ')}`;

const nullable = (value: unknown) => (value === null ? null : String(value));
const numeric = (value: unknown) => (value === null ? null : Number(value));
const callType = (value: unknown) => (value === 'audio' || value === 'video' ? value : null);

function view(row: Record<string, unknown>): MessageView {
	return {
		service: row.service as Service,
		chatId: String(row.chat_id),
		messageId: String(row.message_id),
		threadId: nullable(row.thread_id),
		sender: nullable(row.sender),
		sentAt: numeric(row.sent_at),
		editedAt: numeric(row.edited_at),
		contentType: nullable(row.content_type),
		text: nullable(row.text),
		replyTo: nullable(row.reply_to),
		mentions: nullable(row.mentions),
		decryptState: String(row.decrypt_state),
		unsent: row.unsent === 1,
		seq: Number(row.seq),
		nonText: {
			alt_text: nullable(row.alt_text),
			file_name: nullable(row.file_name),
			duration_ms: numeric(row.duration_ms),
			image_index: numeric(row.image_index),
			image_total: numeric(row.image_total),
			call_type: callType(row.call_type),
			call_result: nullable(row.call_result),
			event: nullable(row.event),
			event_by: nullable(row.event_by),
			event_members: nullable(row.event_members),
			event_name: nullable(row.event_name)
		},
		rowId: Number(row.id)
	};
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
