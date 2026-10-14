import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
	type ArchiveStatus,
	canonicalId,
	findMessage,
	latestMessages,
	listChanges,
	type MessageView,
	type Position,
	positionOf,
	readMessages,
	searchMessages,
	searchTerms,
	type Service,
	unreadCount,
	unreadMessages,
	unreadWhere
} from './archive.ts';
import { LineMcpError } from './errors.ts';
import { idOrder } from './read-state.ts';

// The read side of the MCP tools: pages over the archive with display names,
// opaque keyset cursors, times with the daemon's offset and a size cap per result.

export const defaultLimit = 50;
export const maxLimit = 200;
/** Item bytes one result carries; a fuller page ends early with a continuation. */
export const sizeCap = 64 * 1024;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * UTC milliseconds as ISO 8601 at millisecond precision in the daemon's system
 * time zone with its numeric offset, for example `2026-10-12T10:15:00.000+05:45`,
 * so the string names one instant. The zone is read on every call, so a changed
 * `TZ` applies without a restart.
 */
export function renderTime(ms: number | null | undefined): string | null {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
	const date = new Date(ms);
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? '-' : '+';
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`.${pad(date.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
	);
}

/** The IANA time zone that times are rendered in right now. */
export function timeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The fields of `T` that may be null become optional and never null. */
type Present<T> = { [K in keyof T as null extends T[K] ? never : K]: T[K] } & {
	[K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

/**
 * `fields` without the ones whose value is null. Items leave an empty field
 * out rather than repeat null on every message; key order stays.
 */
function present<T extends object>(fields: T): Present<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== null)
	) as Present<T>;
}

/** What every result reports about freshness (architecture, Freshness and paging). */
export interface Freshness {
	health: string;
	stale: boolean;
	/** Left out for a service that never synced. */
	synced_at: { talk?: string; square?: string };
}

export function freshness(status: ArchiveStatus): Freshness {
	return {
		health: status.health,
		stale: status.stale,
		synced_at: present({
			talk: renderTime(status.talkSyncedAt),
			square: renderTime(status.squareSyncedAt)
		})
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

/** A chat as tools show it; a field the archive has no value for is left out. */
export interface ChatItem {
	service: Service;
	chat_id: string;
	type: string;
	name?: string;
	member_count?: number;
	last_activity_at?: string;
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
		...present({
			name: row.name === null ? null : String(row.name),
			member_count: row.member_count === null ? null : Number(row.member_count),
			last_activity_at: renderTime(
				row.last_activity_at === null ? null : Number(row.last_activity_at)
			)
		})
	};
}

export function findChat(db: DatabaseSync, service: Service, chatId: string): ChatItem | null {
	const row = db
		.prepare(`SELECT ${chatColumns} FROM ${chatJoin} WHERE c.service = ? AND c.chat_id = ?`)
		.get(service, chatId);
	return row ? chatItem(row) : null;
}

/** Code points of text a chat's latest message shows in `list_chats`. */
const previewLength = 200;

/** A chat's newest message as `read_messages` shows it, its text cut to `previewLength`. */
export interface LatestMessage extends MessageItem {
	/** Set when `text` was cut and ends in `…`. */
	text_truncated?: true;
}

/** A chat in `list_chats`, with its newest message; left out for a chat without messages. */
export interface ChatListItem extends ChatItem {
	last_message?: LatestMessage;
}

export interface ChatPage {
	chats: ChatListItem[];
	next_cursor: string | null;
	size_capped: boolean;
}

/**
 * Chats by last activity, newest first; `name` matches a part of the display
 * name. Each chat carries its newest message in the `read_messages` order,
 * threads included (see `latestMessages`).
 */
export function listChatsPage(
	db: DatabaseSync,
	selfMid: string,
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
	const chats = rows.slice(0, limit).map(chatItem);
	const names = new Names(db);
	const latest = new Map(
		latestMessages(
			db,
			chats.map((chat) => ({ service: chat.service, chatId: chat.chat_id }))
		).map((message) => [`${message.service}\n${message.chatId}`, message])
	);
	const items = chats.map((chat): ChatListItem => {
		const message = latest.get(`${chat.service}\n${chat.chat_id}`);
		return message ? { ...chat, last_message: latestMessage(names, selfMid, message) } : chat;
	});
	// The size cap counts each chat's latest message.
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

/**
 * A message as `read_messages` shows it within its chat. A field without a
 * value is left out: `unsent` appears only when true and `decrypt_state` only
 * when not `ok`.
 */
export interface MessageItem {
	message_id: string;
	thread_id?: string;
	sender_id?: string;
	sender_name?: string;
	/**
	 * Left out when unknown: no sender, or an OpenChat chat whose own member
	 * discovery has not confirmed yet.
	 */
	from_self?: boolean;
	sent_at?: string;
	edited_at?: string;
	/**
	 * `text` for LINE's `NONE`, otherwise LINE's content type in lower case,
	 * such as `image` or `chatevent`; left out only for a tombstone of a
	 * message never archived.
	 */
	content_type?: string;
	// What a non-text message holds, from its envelope's plaintext metadata (see `details`).
	alt_text?: string;
	file_name?: string;
	duration_ms?: number;
	image_set?: { index: number; total: number };
	call?: { type?: 'audio' | 'video'; result?: string };
	event?: ChatEvent;
	text?: string;
	reply_to?: string;
	mentions?: string[];
	decrypt_state?: string;
	unsent?: true;
	seq: number;
}

/** A message outside a page of its own chat, so it names the chat. */
export interface ChatMessageItem extends MessageItem {
	service: Service;
	chat_id: string;
	chat_name?: string;
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
 * The plaintext `contentMetadata` keys non-text messages are described by.
 * Only these leave the envelope; chunks, URLs, OID, SID, FLEX_JSON and the
 * rest stay in SQLite.
 */
const metadataKeys = [
	'ALT_TEXT',
	'STKTXT',
	'FILE_NAME',
	'DURATION',
	'GSEQ',
	'GTOTAL',
	'TYPE',
	'RESULT',
	'LOC_KEY',
	'LOC_ARGS'
] as const;
type Metadata = Partial<Record<(typeof metadataKeys)[number], string>>;

/**
 * Resolves display names, the account's own OpenChat members and the
 * metadata of non-text messages from the archive, once per page.
 */
class Names {
	readonly #db: DatabaseSync;
	readonly #chats = new Map<string, string | null>();
	readonly #people = new Map<string, string | null>();
	readonly #selfMembers = new Map<string, Set<string>>();
	readonly #metadata = new Map<number, Metadata>();
	#metadataQuery: StatementSync | undefined;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	/**
	 * The allowlisted metadata of one archive row. Read from the envelope only
	 * when a message is rendered, so rows outside a page are never parsed.
	 */
	metadata(rowId: number): Metadata {
		if (!this.#metadata.has(rowId)) {
			this.#metadataQuery ??= this.#db.prepare(
				`SELECT json_extract(envelope, ${metadataKeys.map((key) => `'$.contentMetadata.${key}'`).join(', ')})
					AS metadata FROM message WHERE id = ?`
			);
			// One value per key, in order; null where the envelope has none.
			const values: unknown[] = JSON.parse(
				String(this.#metadataQuery.get(rowId)?.metadata ?? '[]')
			);
			const metadata: Metadata = {};
			metadataKeys.forEach((key, index) => {
				const value = values[index];
				if (typeof value === 'string') metadata[key] = value;
			});
			this.#metadata.set(rowId, metadata);
		}
		return this.#metadata.get(rowId)!;
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

/**
 * The account has one MID in Talk and its own member MIDs in each Square chat.
 * Null when that cannot be told: no sender, or no own member confirmed yet.
 */
function fromSelf(names: Names, selfMid: string, message: MessageView): boolean | null {
	if (message.sender === null) return null;
	if (message.service === 'talk') return message.sender === selfMid;
	const own = names.selfMembers(message.chatId);
	return own.size === 0 ? null : own.has(message.sender);
}

/** A person a chat event names, with the archived display name when there is one. */
export interface EventPerson {
	id: string;
	name?: string;
}

/** A membership or settings change LINE reports as a CHATEVENT message. */
export interface ChatEvent {
	type: string;
	by?: EventPerson;
	members?: EventPerson[];
	/** The new chat name of a `renamed` event. */
	name?: string;
}

const isMid = (value: string) => /^[a-z][0-9a-f]{32}$/.test(value);

/** LINE's content type as tools show it: `text` for `NONE`, otherwise the name in lower case. */
const contentTypeName = (contentType: string | null) =>
	contentType === null ? null : contentType === 'NONE' ? 'text' : contentType.toLowerCase();

/** A count from a metadata value: a non-negative safe integer written in decimal digits. */
function count(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

// Maps, so a metadata value such as `__proto__` finds nothing rather than an inherited property.
const callTypes = new Map<string, 'audio' | 'video'>([
	['A', 'audio'],
	['V', 'video']
]);

const optionalActor = ([first]: string[]) =>
	first !== undefined && isMid(first) ? first : undefined;

/**
 * Chat events by `LOC_KEY`, only codes whose arguments are verified against
 * LINE's own client: the event type, the arity it accepts and which argument
 * names whom. Every MID argument holds one MID or several separated by U+001F.
 */
const chatEvents = new Map<
	string,
	{
		type: string;
		arity: number[];
		by?: (args: string[]) => string | undefined;
		members?: (args: string[]) => string | undefined;
		name?: (args: string[]) => string | undefined;
	}
>([
	['C_MJ', { type: 'joined', arity: [1], members: (args) => args[0] }],
	['C_ML', { type: 'left', arity: [1], members: (args) => args[0] }],
	['C_GI', { type: 'invited', arity: [2], by: (args) => args[0], members: (args) => args[1] }],
	['C_MI', { type: 'invited', arity: [2], by: (args) => args[0], members: (args) => args[1] }],
	[
		'C_IC',
		{
			type: 'invitation_canceled',
			arity: [2],
			by: (args) => args[0],
			members: (args) => args[1]
		}
	],
	[
		'C_MR',
		{
			type: 'removed',
			arity: [1, 2],
			by: (args) => (args.length === 2 ? args[0] : undefined),
			members: (args) => args.at(-1)
		}
	],
	['C_PN', { type: 'renamed', arity: [2], by: (args) => args[0], name: (args) => args[1] }],
	['C_PI', { type: 'picture_changed', arity: [1], by: (args) => args[0] }],
	// The actor is optional here: an argument that is not a MID is left out, not refused.
	['C_SN', { type: 'link_join_allowed', arity: [0, 1], by: optionalActor }],
	['C_SP', { type: 'link_join_disabled', arity: [0, 1], by: optionalActor }]
]);

/** The event a CHATEVENT's `LOC_KEY` and `LOC_ARGS` describe; null for anything unverified or malformed. */
function chatEvent(names: Names, service: Service, metadata: Metadata): ChatEvent | null {
	const shape = metadata.LOC_KEY === undefined ? undefined : chatEvents.get(metadata.LOC_KEY);
	if (!shape) return null;
	const args = metadata.LOC_ARGS ? metadata.LOC_ARGS.split('\u001e') : [];
	if (!shape.arity.includes(args.length)) return null;
	const person = (id: string): EventPerson => ({
		id,
		...present({ name: names.person(service, id) })
	});
	const people = (arg: string | undefined) => {
		const mids = arg?.split('\u001f') ?? [];
		return mids.length > 0 && mids.every(isMid) ? mids.map(person) : null;
	};
	const event: ChatEvent = { type: shape.type };
	if (shape.by) {
		const by = shape.by(args);
		if (by !== undefined) {
			if (!isMid(by)) return null;
			event.by = person(by);
		}
	}
	if (shape.members) {
		const members = people(shape.members(args));
		if (!members) return null;
		event.members = members;
	}
	if (shape.name) {
		const name = shape.name(args);
		if (!name) return null;
		event.name = name;
	}
	return event;
}

/**
 * What a non-text message holds, from the plaintext metadata LINE sends with
 * it (architecture, Non-text messages). Each field is null when LINE gave no
 * valid value for it.
 */
function details(names: Names, message: MessageView) {
	const none = {
		alt_text: null,
		file_name: null,
		duration_ms: null,
		image_set: null,
		call: null,
		event: null
	};
	// Text rows are never parsed, and an unsend cleared the metadata.
	if (message.unsent || message.contentType === null || message.contentType === 'NONE') return none;
	const metadata = names.metadata(message.rowId);
	const type = message.contentType;
	const index = count(metadata.GSEQ);
	const total = count(metadata.GTOTAL);
	const call = present({
		type: callTypes.get(metadata.TYPE ?? '') ?? null,
		result: metadata.RESULT ? metadata.RESULT.toLowerCase() : null
	});
	return {
		alt_text:
			(type === 'FLEX' ? metadata.ALT_TEXT : type === 'STICKER' ? metadata.STKTXT : undefined) ||
			null,
		file_name: (type === 'FILE' && metadata.FILE_NAME) || null,
		duration_ms: ['VIDEO', 'AUDIO', 'CALL'].includes(type) ? count(metadata.DURATION) : null,
		image_set:
			type === 'IMAGE' && index !== null && total !== null && index >= 1 && index <= total
				? { index, total }
				: null,
		call: type === 'CALL' && Object.keys(call).length > 0 ? call : null,
		event: type === 'CHATEVENT' ? chatEvent(names, message.service, metadata) : null
	};
}

function messageItem(names: Names, selfMid: string, message: MessageView): MessageItem {
	return {
		message_id: message.messageId,
		...present({
			thread_id: message.threadId,
			sender_id: message.sender,
			sender_name: names.person(message.service, message.sender),
			from_self: fromSelf(names, selfMid, message),
			sent_at: renderTime(message.sentAt),
			edited_at: renderTime(message.editedAt),
			content_type: contentTypeName(message.contentType),
			...details(names, message),
			// The archive clears an unsent message's text; a tombstone never shows any.
			text: message.unsent ? null : message.text,
			reply_to: message.replyTo,
			mentions: message.unsent ? null : mentioned(message.mentions),
			decrypt_state: message.decryptState === 'ok' ? null : message.decryptState,
			unsent: message.unsent || null
		}),
		seq: message.seq
	};
}

/** A message item that also names its service, chat and the chat's display name. */
function chatMessageItem(names: Names, selfMid: string, message: MessageView): ChatMessageItem {
	return {
		service: message.service,
		chat_id: message.chatId,
		...present({ chat_name: names.chat(message.service, message.chatId) }),
		...messageItem(names, selfMid, message)
	};
}

/**
 * A message item whose text is cut to `previewLength` code points plus `…`,
 * so a surrogate pair is never split.
 */
function latestMessage(names: Names, selfMid: string, message: MessageView): LatestMessage {
	const item = messageItem(names, selfMid, message);
	// At most that many UTF-16 units is at most that many code points.
	if (item.text === undefined || item.text.length <= previewLength) return item;
	const points = [...item.text];
	if (points.length <= previewLength) return item;
	return { ...item, text: `${points.slice(0, previewLength).join('')}…`, text_truncated: true };
}

/** One message as tools show it, with its chat and sender names. */
export function describeMessage(
	db: DatabaseSync,
	selfMid: string,
	message: MessageView
): ChatMessageItem {
	return chatMessageItem(new Names(db), selfMid, message);
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
	const item = (message: MessageView) => messageItem(names, selfMid, message);
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

/** A search hit; with context, the messages around it as `read_messages` shows them. */
export interface SearchHit extends ChatMessageItem {
	/** Up to `context` messages just before the hit in its chat or thread, oldest first. */
	context_before?: MessageItem[];
	/** Up to `context` messages just after the hit in its chat or thread, oldest first. */
	context_after?: MessageItem[];
	/** Set when the size cap left out the context messages farthest from the hit. */
	context_truncated?: true;
}

export interface SearchPage {
	query: string;
	mode: 'fts' | 'scan';
	/** Scan only: the send time this page searched back to, while next_cursor continues further. */
	scanned_through: string | null;
	/** Newest first. */
	messages: SearchHit[];
	next_cursor: string | null;
	size_capped: boolean;
}

export interface SearchOptions {
	query: string;
	service?: Service;
	chatId?: string;
	senderId?: string;
	/** Inclusive lower bound on the send time, UTC milliseconds. */
	since?: number;
	/** Exclusive upper bound on the send time, UTC milliseconds. */
	until?: number;
	/** Messages before and after each hit; 0 (the default) leaves the context fields out. */
	context?: number;
	limit?: number;
	cursor?: string;
}

/**
 * One page of `searchMessages`. A scan page can hold fewer hits than `limit`,
 * or none, and still continue: its cursor resumes after the last row read.
 * A hit's size counts its context. A hit that does not fit the rest of a page
 * starts the next one; a hit too large for a page alone sheds context
 * messages, farthest first, and goes out with whatever still fits.
 */
export function searchMessagesPage(
	db: DatabaseSync,
	selfMid: string,
	options: SearchOptions
): SearchPage {
	const limit = pageLimit(options.limit);
	const context = options.context ?? 0;
	const { since, until } = options;
	if (since !== undefined && until !== undefined && since >= until) {
		throw new LineMcpError('invalid_argument', 'since must be earlier than until');
	}
	const scope = {
		terms: searchTerms(options.query),
		service: options.service ?? null,
		chat: options.chatId ?? null,
		sender: options.senderId ?? null,
		since: since ?? null,
		until: until ?? null,
		context
	};
	const before = options.cursor
		? decodePosition(decodeCursor(options.cursor, 'search_messages', scope))
		: undefined;
	const result = searchMessages(db, {
		query: options.query,
		...(options.service ? { service: options.service } : {}),
		...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
		...(options.senderId !== undefined ? { sender: options.senderId } : {}),
		sent: { since, until },
		...(before ? { before } : {}),
		limit: limit + 1
	});
	const names = new Names(db);
	const hits: SearchHit[] = [];
	let budget = sizeCap;
	let capped = false;
	for (const message of result.messages.slice(0, limit)) {
		const hit = searchHit(db, names, selfMid, message, context);
		let size = byteSize(hit);
		if (size > budget && hits.length > 0) {
			capped = true;
			break;
		}
		if (size > budget) size = shedContext(hit, budget);
		hits.push(hit);
		budget -= size;
	}
	const last = result.messages[hits.length - 1];
	const more = capped || result.messages.length > limit;
	const next = more && last ? positionOf(last) : result.scannedTo;
	return {
		query: options.query,
		mode: result.mode,
		scanned_through: result.mode === 'scan' && next ? renderTime(next.sentAt) : null,
		messages: hits,
		next_cursor: next ? encodeCursor('search_messages', scope, encodePosition(next)) : null,
		size_capped: capped
	};
}

/**
 * A hit with up to `context` messages on each side from its own chat and
 * thread (the main chat alone for a hit outside threads), in the read order.
 */
function searchHit(
	db: DatabaseSync,
	names: Names,
	selfMid: string,
	message: MessageView,
	context: number
): SearchHit {
	const hit = chatMessageItem(names, selfMid, message);
	if (context === 0) return hit;
	const around = {
		service: message.service,
		chatId: message.chatId,
		threadId: message.threadId,
		limit: context
	};
	const at = positionOf(message);
	const item = (entry: MessageView) => messageItem(names, selfMid, entry);
	return {
		...hit,
		context_before: readMessages(db, { ...around, before: at })
			.toReversed()
			.map(item),
		context_after: readMessages(db, { ...around, after: at }).map(item)
	};
}

/**
 * Drops the context messages farthest from the hit, the earlier one on a tie,
 * until the hit takes at most `budget` bytes or has no context left. Returns
 * the hit's size.
 */
function shedContext(hit: SearchHit, budget: number): number {
	const before = hit.context_before ?? [];
	const after = hit.context_after ?? [];
	let size = byteSize(hit);
	while (size > budget && before.length + after.length > 0) {
		if (before.length >= after.length) before.shift();
		else after.pop();
		hit.context_truncated = true;
		size = byteSize(hit);
	}
	return size;
}

/**
 * A chat in `list_unread`: its read position is known, with `unread_count`
 * and the unread `messages` (or this page's part of them), or unknown, with
 * `messages_unknown`. LINE's own count appears while it belongs to the
 * current read position.
 */
export type UnreadChat = ChatItem & {
	line_unread_count?: number;
	line_unread_as_of?: string;
	/** Set when the item continues a chat from the previous page. */
	continued?: true;
} & ({ messages_unknown: true } | { unread_count: number; messages: MessageItem[] });

export interface UnreadPage {
	chats: UnreadChat[];
	next_cursor: string | null;
	size_capped: boolean;
}

/** A chat's place in the `list_unread` order, and the message a page ended after inside it. */
interface UnreadPosition {
	boundary: number;
	chatKey: string;
	service: Service;
	chatId: string;
	lastId: string | null;
}

const isDecimal = (value: unknown): value is string =>
	typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);

/** Compares canonical decimal strings numerically: by length, then text. */
const compareDecimal = (a: string, b: string) =>
	a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** The `list_unread` order: highest chat key first, then service, then chat ID. */
function compareChats(
	a: { chatKey: string; service: string; chatId: string },
	b: { chatKey: string; service: string; chatId: string }
): number {
	return (
		compareDecimal(b.chatKey, a.chatKey) ||
		(a.service < b.service ? -1 : a.service > b.service ? 1 : 0) ||
		(a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0)
	);
}

function decodeUnreadPosition(value: unknown): UnreadPosition {
	const [boundary, chatKey, service, chatId, lastId] = Array.isArray(value)
		? (value as unknown[])
		: [];
	if (
		!isCount(boundary) ||
		!isDecimal(chatKey) ||
		(service !== 'talk' && service !== 'square') ||
		typeof chatId !== 'string' ||
		(lastId !== null && !isDecimal(lastId))
	) {
		throw invalidCursor();
	}
	return { boundary, chatKey, service, chatId, lastId };
}

/** Unread messages one query reads at a time while a page fills. */
const unreadBatch = 100;

/**
 * Every unread message of the account in one result while it fits the size
 * cap (architecture, Read state). The first page fixes a row boundary; rows
 * added later never enter the traversal. Chats order by `chat_key`, the
 * highest message ID among their rows at or below the boundary, which no
 * later change moves, so reads, unsends and edits between pages only remove
 * messages. Messages follow in numeric ID order. The cap counts each chat
 * header and each message; a page may end inside a chat and the next one
 * repeats its header with `continued`. A page's first chat with its first
 * message is emitted even over the cap, so every page moves on.
 */
export function listUnreadPage(
	db: DatabaseSync,
	selfMid: string,
	options: { service?: Service; cursor?: string }
): UnreadPage {
	const scope = { service: options.service ?? null };
	const from = options.cursor
		? decodeUnreadPosition(decodeCursor(options.cursor, 'list_unread', scope))
		: undefined;
	const latest = db.prepare('SELECT coalesce(max(id), 0) AS id FROM message').get() as {
		id: number;
	};
	const boundary = from?.boundary ?? latest.id;
	// Only chats that can be listed: an unknown read position, LINE's count for
	// the current one, or an unread message. Each key and test is an index probe.
	const rows = db
		.prepare(
			`SELECT ${chatColumns}, r.marker, r.line_count, r.count_marker, r.count_at,
				coalesce((
					SELECT m.message_id FROM message m
					WHERE m.service = c.service AND m.chat_id = c.chat_id AND m.id <= :boundary
						AND ${canonicalId('m.message_id')}
					ORDER BY ${idOrder('m.message_id')} DESC LIMIT 1
				), '0') AS chat_key
			FROM ${chatJoin}
			LEFT JOIN read_state r ON r.service = c.service AND r.chat_id = c.chat_id
			WHERE (:service IS NULL OR c.service = :service)
				AND (r.marker IS NULL OR (r.line_count > 0 AND r.count_marker = r.marker)
					OR EXISTS (SELECT 1 FROM message m WHERE ${unreadWhere('c.service', 'c.chat_id', 'r.marker')}))`
		)
		.all({ boundary, service: scope.service, self: selfMid })
		.map((row) => ({
			row,
			chatKey: String(row.chat_key),
			service: row.service as Service,
			chatId: String(row.chat_id)
		}))
		.filter((chat) => !from || compareChats(chat, from) >= 0)
		.toSorted(compareChats);
	const names = new Names(db);
	/** Unread messages of a chat after the message ID `after`, read in batches as the page needs them. */
	function* unreadIn(chat: { service: Service; chatId: string }, after: string) {
		for (;;) {
			const batch = unreadMessages(db, { ...chat, after, boundary, selfMid, limit: unreadBatch });
			yield* batch;
			if (batch.length < unreadBatch) return;
			after = batch.at(-1)!.messageId;
		}
	}

	const chats: UnreadChat[] = [];
	let used = 0;
	let next: UnreadPosition | null = null;
	/** The last chat this page emitted; a page that ends between chats continues after it. */
	let previous: UnreadPosition | undefined;
	/** Whether `bytes` more fit; the first unit of a page always does. */
	const fits = (bytes: number) => chats.length === 0 || used + bytes <= sizeCap;

	chats: for (const chat of rows) {
		const continuing = from !== undefined && compareChats(chat, from) === 0;
		const shownUpTo = continuing ? from.lastId : null;
		if (continuing && shownUpTo === null) continue;
		const { row } = chat;
		const marker = row.marker === null ? null : String(row.marker);
		const reportable = row.line_count !== null && row.count_marker === row.marker;
		const position = (lastId: string | null): UnreadPosition => ({
			boundary,
			chatKey: chat.chatKey,
			service: chat.service,
			chatId: chat.chatId,
			lastId
		});
		const line = present({
			line_unread_count: reportable ? Number(row.line_count) : null,
			line_unread_as_of: reportable ? renderTime(Number(row.count_at)) : null,
			continued: continuing || null
		});
		// A continued chat resumes after its last shown message or a read position past it.
		const after =
			marker !== null && shownUpTo !== null && compareDecimal(shownUpTo, marker) > 0
				? shownUpTo
				: marker;
		const views = after === null ? undefined : unreadIn(chat, after);
		const head = views?.next();
		// A continued chat whose remaining messages were read meanwhile has nothing more to show.
		if (continuing && head?.done) continue;
		const messages: MessageItem[] = [];
		const header: UnreadChat =
			marker === null
				? { ...chatItem(row), messages_unknown: true, ...line }
				: {
						...chatItem(row),
						unread_count: unreadCount(db, { ...chat, after: marker, boundary, selfMid }),
						...line,
						messages
					};
		const first = head && !head.done ? head.value : undefined;
		const firstItem = first ? messageItem(names, selfMid, first) : undefined;
		// A chat header travels with its first message, or alone when it has none.
		const unit = byteSize(header) + (firstItem ? byteSize(firstItem) : 0);
		if (!fits(unit)) {
			next = previous!;
			break;
		}
		chats.push(header);
		used += unit;
		previous = position(null);
		if (!views || !first || !firstItem) continue;
		messages.push(firstItem);
		let lastId = first.messageId;
		for (const view of views) {
			const item = messageItem(names, selfMid, view);
			const bytes = byteSize(item);
			if (!fits(bytes)) {
				next = position(lastId);
				break chats;
			}
			messages.push(item);
			used += bytes;
			lastId = view.messageId;
		}
	}
	return {
		chats,
		next_cursor: next
			? encodeCursor('list_unread', scope, [
					next.boundary,
					next.chatKey,
					next.service,
					next.chatId,
					next.lastId
				])
			: null,
		size_capped: next !== null
	};
}

export interface ChangePage {
	/** In `seq` order; a message changed again later reappears with its new `seq`. */
	changes: ChatMessageItem[];
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
		rows.slice(0, limit).map((message) => chatMessageItem(names, selfMid, message))
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
