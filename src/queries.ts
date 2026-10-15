import type { DatabaseSync } from 'node:sqlite';
import type { ArchiveStatus, MessageView, Service } from './archive.ts';
import { renderTime } from './time.ts';

// How tools show the archive outside `query`: the freshness every result
// reports, chats and messages with display names, and times with the daemon's
// offset.

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

/** What every result reports about freshness (architecture, Freshness). */
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

/**
 * A message as tools show it, with its chat and sender names. A field without
 * a value is left out: `unsent` appears only when true and `decrypt_state`
 * only when not `ok`.
 */
interface MessageItem {
	service: Service;
	chat_id: string;
	chat_name?: string;
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
	/** LINE's content type in lower case: `image`, `video`, `audio` or `file`. */
	content_type?: string;
	// What a media message holds, from its stored fields (see `details`).
	file_name?: string;
	duration_ms?: number;
	image_set?: { index: number; total: number };
	text?: string;
	reply_to?: string;
	mentions?: string[];
	decrypt_state?: string;
	unsent?: true;
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
 * archive, each once per result.
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

/**
 * What a media message holds, from the fields the archive stored when it was
 * written (architecture, Non-text messages). Each is null when LINE gave no
 * valid value for it.
 */
function details(message: MessageView) {
	const fields = message.nonText;
	return {
		file_name: fields.file_name,
		duration_ms: fields.duration_ms,
		image_set:
			fields.image_index !== null && fields.image_total !== null
				? { index: fields.image_index, total: fields.image_total }
				: null
	};
}

/** A media message as `get_attachment` shows it, with its chat and sender names. */
export function describeMessage(
	db: DatabaseSync,
	selfMid: string,
	message: MessageView
): MessageItem {
	const names = new Names(db);
	return {
		service: message.service,
		chat_id: message.chatId,
		...present({ chat_name: names.chat(message.service, message.chatId) }),
		message_id: message.messageId,
		...present({
			thread_id: message.threadId,
			sender_id: message.sender,
			sender_name: names.person(message.service, message.sender),
			from_self: fromSelf(names, selfMid, message),
			sent_at: renderTime(message.sentAt),
			edited_at: renderTime(message.editedAt),
			content_type: message.contentType?.toLowerCase() ?? null,
			...details(message),
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

/** A participant's archived display name. */
export function personName(db: DatabaseSync, service: Service, id: string | null): string | null {
	return new Names(db).person(service, id);
}
