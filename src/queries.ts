import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
	type ArchiveStatus,
	findMessage,
	listChanges,
	type MessageView,
	type Position,
	positionOf,
	readMessages,
	searchMessages,
	type Service,
	shortQueryWindow
} from './archive.ts';
import { LineMcpError } from './errors.ts';

// The read side of the MCP tools: pages over the archive with display names,
// opaque keyset cursors, UTC and local times and a size cap per result.

export const defaultLimit = 50;
export const maxLimit = 200;
/** Item bytes one result carries; a fuller page ends early with a continuation. */
export const sizeCap = 64 * 1024;

export interface Time {
	utc: string;
	local: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * UTC milliseconds as ISO 8601 in UTC and in the daemon's system time zone with
 * its numeric offset, for example `2026-10-12T10:15:00.000+05:45`. The zone is
 * read on every call, so a changed `TZ` applies without a restart.
 */
export function renderTime(ms: number | null | undefined): Time | null {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
	const date = new Date(ms);
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? '-' : '+';
	const local =
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`.${pad(date.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return { utc: date.toISOString(), local };
}

/** The IANA time zone that `local` times are rendered in right now. */
export function timeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** What every result reports about freshness (architecture, Freshness and paging). */
export interface Freshness {
	health: string;
	stale: boolean;
	synced_at: { talk: Time | null; square: Time | null };
}

export function freshness(status: ArchiveStatus): Freshness {
	return {
		health: status.health,
		stale: status.stale,
		synced_at: {
			talk: renderTime(status.talkSyncedAt),
			square: renderTime(status.squareSyncedAt)
		}
	};
}

export function pageLimit(limit: number | undefined): number {
	return Math.min(maxLimit, Math.max(1, limit ?? defaultLimit));
}

/**
 * Opaque continuation: the tool, a fingerprint of the filters it was issued
 * for, and a position. A cursor replayed with other filters is refused rather
 * than silently paging a different result.
 */
function fingerprint(scope: unknown): string {
	return createHash('sha256').update(JSON.stringify(scope)).digest('base64url').slice(0, 12);
}

export function encodeCursor(kind: string, scope: unknown, position: unknown): string {
	return Buffer.from(JSON.stringify({ k: kind, s: fingerprint(scope), p: position })).toString(
		'base64url'
	);
}

export function decodeCursor(cursor: string, kind: string, scope: unknown): unknown {
	let parsed: { k?: unknown; s?: unknown; p?: unknown };
	try {
		parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as typeof parsed;
	} catch {
		throw invalidCursor();
	}
	if (parsed?.k !== kind || parsed.s !== fingerprint(scope)) throw invalidCursor();
	return parsed.p;
}

function invalidCursor(): LineMcpError {
	return new LineMcpError(
		'invalid_cursor',
		'The cursor does not belong to this tool and these filters; start again without it'
	);
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function decodePosition(value: unknown): Position {
	const [sentAt, rowId] = Array.isArray(value) ? (value as unknown[]) : [];
	if (!isCount(sentAt) || !isCount(rowId)) throw invalidCursor();
	return { sentAt, rowId };
}

const encodePosition = (position: Position) => [position.sentAt, position.rowId];

/**
 * The longest prefix of `items` within `cap` bytes of JSON, never fewer than
 * one item, so a single oversized item still makes progress.
 */
export function withinCap<T>(items: T[], cap = sizeCap): { kept: T[]; capped: boolean } {
	let bytes = 0;
	for (let index = 0; index < items.length; index++) {
		bytes += Buffer.byteLength(JSON.stringify(items[index]));
		if (bytes > cap && index > 0) return { kept: items.slice(0, index), capped: true };
	}
	return { kept: items, capped: false };
}

const byteSize = (item: unknown) => Buffer.byteLength(JSON.stringify(item));

export interface ChatItem {
	service: Service;
	chat_id: string;
	type: string;
	name: string | null;
	member_count: number | null;
	last_activity_at: Time | null;
}

// A one-to-one chat has no name of its own; the peer's display name stands in.
// The own chat (Keep Memo) has the own profile name the daemon stores at
// startup, or LINE's label for it.
const chatName = `coalesce(c.name, p.display_name, CASE WHEN c.service = 'talk'
	AND c.chat_id = (SELECT mid FROM account WHERE id = 1) THEN 'Keep Memo' END)`;
const chatColumns = `c.service, c.chat_id, c.type, ${chatName} AS name,
	c.member_count, c.last_activity_at`;
const chatJoin = `chat c LEFT JOIN participant p
	ON p.service = c.service AND p.participant_id = c.chat_id`;

function chatItem(row: Record<string, unknown>): ChatItem {
	return {
		service: row.service as Service,
		chat_id: String(row.chat_id),
		type: String(row.type),
		name: row.name === null ? null : String(row.name),
		member_count: row.member_count === null ? null : Number(row.member_count),
		last_activity_at: renderTime(
			row.last_activity_at === null ? null : Number(row.last_activity_at)
		)
	};
}

export function findChat(db: DatabaseSync, service: Service, chatId: string): ChatItem | null {
	const row = db
		.prepare(`SELECT ${chatColumns} FROM ${chatJoin} WHERE c.service = ? AND c.chat_id = ?`)
		.get(service, chatId);
	return row ? chatItem(row) : null;
}

export interface ChatPage {
	chats: ChatItem[];
	next_cursor: string | null;
	size_capped: boolean;
}

/** Chats by last activity, newest first; `name` matches a part of the display name. */
export function listChatsPage(
	db: DatabaseSync,
	options: { service?: Service; name?: string; limit?: number; cursor?: string }
): ChatPage {
	const limit = pageLimit(options.limit);
	const scope = { service: options.service ?? null, name: options.name ?? null };
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	if (options.service) {
		where.push('c.service = ?');
		params.push(options.service);
	}
	if (options.name) {
		where.push(`instr(lower(coalesce(${chatName}, '')), lower(?)) > 0`);
		params.push(options.name);
	}
	if (options.cursor) {
		const [activity, service, chatId] = (decodeCursor(options.cursor, 'list_chats', scope) ??
			[]) as unknown[];
		if (!isCount(activity) || typeof service !== 'string' || typeof chatId !== 'string') {
			throw invalidCursor();
		}
		where.push(`(coalesce(c.last_activity_at, 0) < ? OR (coalesce(c.last_activity_at, 0) = ?
			AND (c.service > ? OR (c.service = ? AND c.chat_id > ?))))`);
		params.push(activity, activity, service, service, chatId);
	}
	const rows = db
		.prepare(
			`SELECT ${chatColumns}, coalesce(c.last_activity_at, 0) AS activity FROM ${chatJoin}
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			ORDER BY activity DESC, c.service, c.chat_id LIMIT ?`
		)
		.all(...params, limit + 1);
	const items = rows.slice(0, limit).map(chatItem);
	const { kept, capped } = withinCap(items);
	const last = rows[kept.length - 1];
	const more = capped || rows.length > limit;
	return {
		chats: kept,
		next_cursor:
			more && last
				? encodeCursor('list_chats', scope, [
						Number(last.activity),
						String(last.service),
						String(last.chat_id)
					])
				: null,
		size_capped: capped
	};
}

export interface MessageItem {
	service: Service;
	chat_id: string;
	chat_name?: string | null;
	message_id: string;
	thread_id: string | null;
	sender_id: string | null;
	sender_name: string | null;
	/** Null for an OpenChat chat whose own member discovery has not confirmed yet. */
	from_self: boolean | null;
	sent_at: Time | null;
	edited_at: Time | null;
	content_type: string | null;
	text: string | null;
	reply_to: string | null;
	mentions: string[] | null;
	decrypt_state: string;
	unsent: boolean;
	seq: number;
}

/** MIDs a LINE `MENTION` metadata value names; `all` for a mention of everyone. */
function mentioned(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { MENTIONEES?: { M?: unknown; A?: unknown }[] };
		const mids = (parsed.MENTIONEES ?? [])
			.map((entry) => (typeof entry.M === 'string' ? entry.M : entry.A === '1' ? 'all' : null))
			.filter((mid): mid is string => mid !== null);
		return mids.length ? mids : null;
	} catch {
		return null;
	}
}

/**
 * Resolves display names and the account's own OpenChat members from the
 * archive's chat and participant tables, once per page.
 */
class Names {
	readonly #db: DatabaseSync;
	readonly #chats = new Map<string, string | null>();
	readonly #people = new Map<string, string | null>();
	readonly #selfMembers = new Map<string, Set<string>>();

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	chat(service: Service, chatId: string): string | null {
		const key = `${service}\n${chatId}`;
		if (!this.#chats.has(key))
			this.#chats.set(key, findChat(this.#db, service, chatId)?.name ?? null);
		return this.#chats.get(key)!;
	}

	person(service: Service, id: string | null): string | null {
		if (id === null) return null;
		const key = `${service}\n${id}`;
		if (!this.#people.has(key)) {
			const row = this.#db
				.prepare('SELECT display_name FROM participant WHERE service = ? AND participant_id = ?')
				.get(service, id) as { display_name: string | null } | undefined;
			this.#people.set(key, row?.display_name ?? null);
		}
		return this.#people.get(key)!;
	}

	/** Every own member MID discovery confirmed in a Square chat; empty until it confirms one. */
	selfMembers(chatId: string): Set<string> {
		if (!this.#selfMembers.has(chatId)) {
			const rows = this.#db
				.prepare('SELECT member_id FROM square_self_member WHERE chat_id = ?')
				.all(chatId);
			this.#selfMembers.set(chatId, new Set(rows.map((row) => String(row.member_id))));
		}
		return this.#selfMembers.get(chatId)!;
	}
}

/** The account has one MID in Talk and its own member MIDs in each Square chat. */
function fromSelf(names: Names, selfMid: string, message: MessageView): boolean | null {
	if (message.service === 'talk') return message.sender === selfMid;
	const own = names.selfMembers(message.chatId);
	return own.size === 0 || message.sender === null ? null : own.has(message.sender);
}

function messageItem(
	names: Names,
	selfMid: string,
	message: MessageView,
	withChat: boolean
): MessageItem {
	return {
		service: message.service,
		chat_id: message.chatId,
		...(withChat ? { chat_name: names.chat(message.service, message.chatId) } : {}),
		message_id: message.messageId,
		thread_id: message.threadId,
		sender_id: message.sender,
		sender_name: names.person(message.service, message.sender),
		from_self: fromSelf(names, selfMid, message),
		sent_at: renderTime(message.sentAt),
		edited_at: renderTime(message.editedAt),
		content_type: message.contentType,
		// The archive clears an unsent message's text; a tombstone never shows any.
		text: message.unsent ? null : message.text,
		reply_to: message.replyTo,
		mentions: message.unsent ? null : mentioned(message.mentions),
		decrypt_state: message.decryptState,
		unsent: message.unsent,
		seq: message.seq
	};
}

/** One message as tools show it, with its chat and sender names. */
export function describeMessage(
	db: DatabaseSync,
	selfMid: string,
	message: MessageView
): MessageItem {
	return messageItem(new Names(db), selfMid, message, true);
}

/** A participant's archived display name. */
export function personName(db: DatabaseSync, service: Service, id: string | null): string | null {
	return new Names(db).person(service, id);
}

export interface MessagePage {
	chat: ChatItem | null;
	thread_id: string | null;
	/** Oldest first. */
	messages: MessageItem[];
	/** Continues strictly before the oldest message shown; null at the start of the chat. */
	older_cursor: string | null;
	/** Continues strictly after the newest message shown; an empty page means nothing newer yet. */
	newer_cursor: string | null;
	/** Whether newer messages than the newest shown exist now. */
	has_newer: boolean;
	size_capped: boolean;
}

export interface ReadOptions {
	service: Service;
	chatId: string;
	threadId?: string;
	aroundMessageId?: string;
	limit?: number;
	cursor?: string;
}

/**
 * Keyset pages over one chat or thread. Without a cursor: the newest page.
 * `older_cursor` continues strictly before the oldest message shown and
 * `newer_cursor` strictly after the newest, so paging in either direction
 * returns every message exactly once. `around_message_id` centres a page on
 * one message.
 */
export function readMessagesPage(
	db: DatabaseSync,
	selfMid: string,
	options: ReadOptions
): MessagePage {
	const limit = pageLimit(options.limit);
	const scope = {
		service: options.service,
		chat: options.chatId,
		thread: options.threadId ?? null
	};
	const base = {
		service: options.service,
		chatId: options.chatId,
		...(options.threadId !== undefined ? { threadId: options.threadId } : {})
	};
	const names = new Names(db);
	const item = (message: MessageView) => messageItem(names, selfMid, message, false);
	const cursor = (direction: 'older' | 'newer', message: MessageView | undefined) =>
		message
			? encodeCursor('read_messages', scope, [direction, ...encodePosition(positionOf(message))])
			: null;
	/** True when the page continues after a newer cursor, which an empty page hands back. */
	let newerFrom = false;
	const page = (
		messages: MessageView[],
		older: boolean,
		newer: boolean,
		capped: boolean
	): MessagePage => ({
		chat: findChat(db, options.service, options.chatId),
		thread_id: options.threadId ?? null,
		messages: messages.map(item),
		older_cursor: older ? cursor('older', messages[0]) : null,
		// Kept even at the newest message, so a caller can later ask what arrived since.
		newer_cursor: cursor('newer', messages.at(-1)) ?? (newerFrom ? options.cursor! : null),
		has_newer: newer,
		size_capped: capped
	});

	if (options.aroundMessageId !== undefined) {
		if (options.cursor) {
			throw new LineMcpError('invalid_argument', 'Pass either cursor or around_message_id');
		}
		const anchor = findMessage(db, { ...base, messageId: options.aroundMessageId });
		if (!anchor || (options.threadId !== undefined && anchor.threadId !== options.threadId)) {
			throw new LineMcpError('not_found', 'No such message in this chat or thread');
		}
		const olderCount = Math.floor((limit - 1) / 2);
		const newerCount = limit - 1 - olderCount;
		const before = readMessages(db, { ...base, before: positionOf(anchor), limit: olderCount + 1 });
		const after = readMessages(db, { ...base, after: positionOf(anchor), limit: newerCount + 1 });
		const messages = [
			...before.slice(0, olderCount).toReversed(),
			anchor,
			...after.slice(0, newerCount)
		];
		let olderMore = before.length > olderCount;
		let newerMore = after.length > newerCount;
		// Over the cap, the end farther from the anchor gives way first.
		const sizes = messages.map((message) => byteSize(item(message)));
		let bytes = sizes.reduce((sum, size) => sum + size, 0);
		let anchorAt = olderCount < before.length ? olderCount : before.length;
		let capped = false;
		while (bytes > sizeCap && messages.length > 1) {
			capped = true;
			if (anchorAt >= messages.length - 1 - anchorAt) {
				messages.shift();
				bytes -= sizes.shift()!;
				anchorAt--;
				olderMore = true;
			} else {
				messages.pop();
				bytes -= sizes.pop()!;
				newerMore = true;
			}
		}
		return page(messages, olderMore, newerMore, capped);
	}

	let direction: 'older' | 'newer' = 'older';
	let from: Position | undefined;
	if (options.cursor) {
		const [kind, ...position] = (decodeCursor(options.cursor, 'read_messages', scope) ??
			[]) as unknown[];
		if (kind !== 'older' && kind !== 'newer') throw invalidCursor();
		direction = kind;
		from = decodePosition(position);
		newerFrom = direction === 'newer';
	}
	const rows = readMessages(db, {
		...base,
		...(direction === 'older' ? { before: from } : { after: from }),
		limit: limit + 1
	});
	const { kept, capped } = withinCap(rows.slice(0, limit).map(item));
	const shown = rows.slice(0, kept.length);
	const more = capped || rows.length > limit;
	if (direction === 'older') {
		// Newest first from the query; a page reads oldest first. Anything newer
		// exists only when this page started from a cursor.
		return page(shown.toReversed(), more, from !== undefined, capped);
	}
	return page(shown, shown.length > 0 || from !== undefined, more, capped);
}

export interface SearchPage {
	query: string;
	mode: 'fts' | 'scan';
	/** Recent messages a short query scanned when no chat narrowed it. */
	scanned_window: number | null;
	/** Newest first. */
	messages: MessageItem[];
	next_cursor: string | null;
	size_capped: boolean;
}

export function searchMessagesPage(
	db: DatabaseSync,
	selfMid: string,
	options: { query: string; service?: Service; chatId?: string; limit?: number; cursor?: string }
): SearchPage {
	const limit = pageLimit(options.limit);
	const scope = {
		query: options.query,
		service: options.service ?? null,
		chat: options.chatId ?? null
	};
	const before = options.cursor
		? decodePosition(decodeCursor(options.cursor, 'search_messages', scope))
		: undefined;
	const result = searchMessages(db, {
		query: options.query,
		...(options.service ? { service: options.service } : {}),
		...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
		...(before ? { before } : {}),
		limit: limit + 1
	});
	const names = new Names(db);
	const { kept, capped } = withinCap(
		result.messages.slice(0, limit).map((message) => messageItem(names, selfMid, message, true))
	);
	const last = result.messages[kept.length - 1];
	const more = capped || result.messages.length > limit;
	return {
		query: options.query,
		mode: result.mode,
		scanned_window:
			result.mode === 'scan' && options.chatId === undefined ? shortQueryWindow : null,
		messages: kept,
		next_cursor:
			more && last
				? encodeCursor('search_messages', scope, encodePosition(positionOf(last)))
				: null,
		size_capped: capped
	};
}

export interface ChangePage {
	/** In `seq` order; a message changed again later reappears with its new `seq`. */
	changes: MessageItem[];
	/** Pass as `after_seq` to continue; unchanged when nothing new arrived. */
	next_after_seq: number;
	has_more: boolean;
	latest_seq: number;
	size_capped: boolean;
}

/**
 * Every insert or change after `afterSeq`, in `seq` order (architecture, Tombstones and changes):
 * at least once and without gaps, since each change takes a fresh `seq` from
 * one counter inside its transaction.
 */
export function listChangesPage(
	db: DatabaseSync,
	selfMid: string,
	options: { afterSeq: number; limit?: number }
): ChangePage {
	const limit = pageLimit(options.limit);
	const rows = listChanges(db, { afterSeq: options.afterSeq, limit: limit + 1 });
	const names = new Names(db);
	const { kept, capped } = withinCap(
		rows.slice(0, limit).map((message) => messageItem(names, selfMid, message, true))
	);
	const { value: latest } = db.prepare('SELECT value FROM change_counter WHERE id = 1').get() as {
		value: number;
	};
	return {
		changes: kept,
		next_after_seq: kept.at(-1)?.seq ?? options.afterSeq,
		has_more: capped || rows.length > limit,
		latest_seq: latest,
		size_capped: capped
	};
}
