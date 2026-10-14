import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseClient } from '@evex/linejs/base';
import { enums, type Message, type Operation, type SquareEvent } from '@evex/linejs-types';
import { readState, type Service, upsertChat, upsertParticipant, writeState } from '../archive.ts';
import { mapError } from '../errors.ts';
import { decryptMessage } from '../keys.ts';
import { envelopeFields, type NonTextFields, noFields, nonTextColumns } from '../non-text.ts';
import { decimal } from '../probe.ts';
import { advanceMarker, readMarker } from '../read-state.ts';
import type { Log } from '../session.ts';

export type DecryptState = 'ok' | 'missing_key' | 'invalid';

export interface MessageRow {
	service: Service;
	chatId: string;
	chatType: string;
	messageId: string;
	threadId: string | null;
	sender: string | null;
	sentAt: number | null;
	editedAt: number | null;
	contentType: string | null;
	text: string | null;
	replyTo: string | null;
	mentions: string | null;
	envelope: string;
	decryptState: DecryptState;
	missingKey: string | null;
}

export type Change =
	| { kind: 'message'; row: MessageRow }
	| { kind: 'unsend'; service: Service; chatId: string; messageId: string }
	| { kind: 'participant'; service: Service; id: string; displayName: string }
	/** The account read the chat up to `marker`, a canonical decimal message ID. */
	| { kind: 'read'; service: Service; chatId: string; marker: string };

export interface NormalizeContext {
	base: BaseClient;
	selfMid: string;
	log?: Log;
}

/** Enum values arrive as names when LINEJS knows them and as numbers otherwise. */
export function enumName(table: Record<string, number>, value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value !== 'number') return undefined;
	return Object.keys(table).find((name) => table[name] === value) ?? String(value);
}

/** LINE times are UTC milliseconds, always inside the safe integer range. */
export function millis(value: unknown): number | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
		return Number(value);
	}
	if (typeof value === 'string' && /^\d{1,15}$/.test(value) && value !== '0') return Number(value);
	return null;
}

function nonEmpty(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Lossless JSON of the message as LINE sent it. Chunks become base64 of their
 * exact bytes (LINEJS hands out valid UTF-8 byte strings as `string`), other
 * binary fields are tagged base64 and 64-bit integers become decimal strings.
 */
export function encodeEnvelope(message: Message): string {
	const chunks = message.chunks?.map((chunk) =>
		(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk)).toString(
			'base64'
		)
	);
	return JSON.stringify({ ...message, chunks }, (_key, value: unknown) => {
		if (typeof value === 'bigint') return value.toString();
		if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString('base64') };
		if (
			typeof value === 'object' &&
			value !== null &&
			(value as { type?: unknown }).type === 'Buffer' &&
			Array.isArray((value as { data?: unknown }).data)
		) {
			return { $base64: Buffer.from((value as { data: number[] }).data).toString('base64') };
		}
		return value;
	});
}

export function decodeEnvelope(envelope: string): Message {
	const message = JSON.parse(envelope, (_key, value: unknown) =>
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { $base64?: unknown }).$base64 === 'string'
			? Buffer.from((value as { $base64: string }).$base64, 'base64')
			: value
	) as Omit<Message, 'chunks'> & { chunks?: string[] };
	return {
		...message,
		chunks: message.chunks?.map((chunk) => Buffer.from(chunk, 'base64'))
	} as Message;
}

const tombstoneFields = [
	'from',
	'to',
	'toType',
	'id',
	'createdTime',
	'deliveredTime',
	'contentType'
];

/** What an unsent message keeps: ids, sender, times and content type, no plaintext or ciphertext. */
export function tombstoneEnvelope(
	envelope: string | null,
	fallback: Record<string, unknown>
): string {
	const parsed = envelope ? (JSON.parse(envelope) as Record<string, unknown>) : {};
	const kept: Record<string, unknown> = { ...fallback };
	for (const field of tombstoneFields) {
		if (parsed[field] !== undefined) kept[field] = parsed[field];
	}
	return JSON.stringify(kept);
}

function chatTypeOf(toType: unknown): string {
	switch (enumName(enums.MIDType, toType)) {
		case 'USER':
			return 'user';
		case 'ROOM':
			return 'room';
		case 'GROUP':
			return 'group';
		default:
			return String(enumName(enums.MIDType, toType) ?? 'unknown').toLowerCase();
	}
}

/** Talk chat of a message: the peer for one-to-one chats, otherwise the group or room. */
export function talkChatId(message: Message, selfMid: string): string {
	if (chatTypeOf(message.toType) === 'user') {
		return message.from === selfMid ? message.to : message.from;
	}
	return message.to;
}

function editedAt(message: Message, edited: boolean, fallback: unknown): number | null {
	const metadata = message.contentMetadata ?? {};
	const at = millis(metadata.UPDATED_TIME) ?? millis(message.updatedTime);
	if (at !== null) return at;
	return edited || metadata.EDITED === 'true' ? millis(fallback) : null;
}

// Failures that should retry the whole batch rather than mark one message.
const transientCodes = new Set([
	'network_error',
	'upstream_timeout',
	'upstream_parse_error',
	'needs_login',
	'storage_error'
]);

export interface MessageExtra {
	service: Service;
	chatId?: string;
	threadId?: string | null;
	/** True for edit operations and mutate events, which may lack an edit time. */
	edited?: boolean;
	eventTime?: unknown;
}

/** One message to a row; E2EE payloads are decrypted only with the generations they name. */
export async function normalizeMessage(
	context: NormalizeContext,
	message: Message,
	extra: MessageExtra
): Promise<MessageRow> {
	let text = nonEmpty(message.text);
	let decryptState: DecryptState = 'ok';
	let missingKey: string | null = null;
	if (extra.service === 'talk' && message.chunks?.length) {
		text = null;
		try {
			const result = await decryptMessage(context.base, context.selfMid, message);
			if (result.state === 'ok') {
				text = nonEmpty(result.payload?.text);
			} else {
				decryptState = result.state;
				if (result.state === 'missing_key') missingKey = result.missing;
			}
		} catch (error) {
			if (transientCodes.has(mapError(error, 'decrypt').code)) throw error;
			// A lookup that failed for another reason is retried with the other
			// missing_key rows instead of blocking the batch.
			decryptState = 'missing_key';
			missingKey = 'lookup_failed';
		}
	}
	const metadata = message.contentMetadata ?? {};
	const relation = enumName(enums.Pb1_EnumC13015h6, message.messageRelationType);
	return {
		service: extra.service,
		chatId: extra.chatId ?? talkChatId(message, context.selfMid),
		chatType: extra.service === 'square' ? 'square' : chatTypeOf(message.toType),
		messageId: String(message.id),
		threadId: extra.threadId ?? null,
		sender: nonEmpty(message.from),
		sentAt: millis(message.createdTime),
		editedAt: editedAt(message, extra.edited ?? false, extra.eventTime),
		contentType: enumName(enums.ContentType, message.contentType) ?? null,
		text,
		replyTo: relation === 'REPLY' ? nonEmpty(message.relatedMessageId) : null,
		mentions: nonEmpty(metadata.MENTION),
		envelope: encodeEnvelope(message),
		decryptState,
		missingKey
	};
}

const talkMessageOps = new Set(['SEND_MESSAGE', 'RECEIVE_MESSAGE']);
const talkEditOps = new Set(['EDIT_MESSAGE', 'NOTIFIED_EDIT_MESSAGE']);
const talkUnsendOps = new Set(['DESTROY_MESSAGE', 'NOTIFIED_DESTROY_MESSAGE']);
const talkKeyOps = new Set([
	'UPDATE_PUBLICKEYCHAIN',
	'NOTIFIED_UPDATE_PUBLICKEYCHAIN',
	'REGISTER_E2EE_PUBLICKEY',
	'NOTIFIED_E2EE_KEY_EXCHANGE_REQ',
	'NOTIFIED_E2EE_KEY_EXCHANGE_RESP',
	'NOTIFIED_E2EE_KEY_UPDATE'
]);
// Membership and name changes only; read receipts and chat-bar updates do not rename chats.
const talkChatOps = new Set([
	'CREATE_GROUP',
	'UPDATE_GROUP',
	'NOTIFIED_UPDATE_GROUP',
	'LEAVE_GROUP',
	'ACCEPT_GROUP_INVITATION',
	'KICKOUT_FROM_GROUP',
	'CREATE_ROOM',
	'UPDATE_ROOM',
	'LEAVE_ROOM',
	'NOTIFIED_JOIN_CHAT',
	'NOTIFIED_LEAVE_CHAT',
	'CREATE_CHAT',
	'UPDATE_CHAT',
	'NOTIFIED_UPDATE_CHAT',
	'DELETE_SELF_FROM_CHAT',
	'ACCEPT_CHAT_INVITATION',
	'NOTIFIED_ACCEPT_CHAT_INVITATION',
	'DELETE_OTHER_FROM_CHAT',
	'NOTIFIED_DELETE_OTHER_FROM_CHAT'
]);

export interface TalkBatch {
	changes: Change[];
	/** Chats whose name or membership changed; refreshed by discovery. */
	chats: Set<string>;
	keysChanged: boolean;
}

export function opName(type: unknown): string | undefined {
	return enumName(enums.OpType, type);
}

export async function normalizeOperations(
	context: NormalizeContext,
	operations: Operation[]
): Promise<TalkBatch> {
	const batch: TalkBatch = { changes: [], chats: new Set(), keysChanged: false };
	for (const operation of operations) {
		const name = opName(operation.type) ?? '';
		if ((talkMessageOps.has(name) || talkEditOps.has(name)) && operation.message?.id) {
			batch.changes.push({
				kind: 'message',
				row: await normalizeMessage(context, operation.message, {
					service: 'talk',
					edited: talkEditOps.has(name),
					eventTime: operation.createdTime
				})
			});
		} else if (talkUnsendOps.has(name) && /^\d+$/.test(String(operation.param2 ?? ''))) {
			// param1 is the chat, param2 the message ID (verified against a live account).
			batch.changes.push({
				kind: 'unsend',
				service: 'talk',
				chatId: String(operation.param1 ?? ''),
				messageId: String(operation.param2)
			});
		} else if (name === 'SEND_CHAT_CHECKED' && nonEmpty(operation.param1)) {
			// The account read the chat (param1) up to message param2 on another
			// device (verified against a live account).
			const marker = readMarker(context.log, 'talk', operation.param2);
			if (marker !== null) {
				batch.changes.push({ kind: 'read', service: 'talk', chatId: operation.param1, marker });
			}
		} else if (talkKeyOps.has(name)) {
			batch.keysChanged = true;
		} else if (talkChatOps.has(name) && nonEmpty(operation.param1)) {
			batch.chats.add(String(operation.param1));
		}
	}
	return batch;
}

export interface SquareTarget {
	chat: string;
	thread?: string;
}

export interface SquareBatch {
	changes: Change[];
	/** Chats and threads with message activity, to be fetched completely. */
	targets: SquareTarget[];
}

const removedStates = new Set(['UNSENT', 'DELETED']);

interface SquareMessageLike {
	message?: Message;
	state?: unknown;
	threadInfo?: { chatThreadMid?: string; threadRoot?: boolean };
}

/**
 * Square events to changes. `threadMid` is set when the events come from a
 * thread fetch. A thread root stays in its chat and announces the thread.
 */
export async function normalizeSquareEvents(
	context: NormalizeContext,
	events: SquareEvent[],
	threadMid?: string
): Promise<SquareBatch> {
	const batch: SquareBatch = { changes: [], targets: [] };
	const targets = new Map<string, SquareTarget>();
	const target = (chat: string, thread?: string) => {
		targets.set(thread ? `${chat}\n${thread}` : chat, thread ? { chat, thread } : { chat });
	};
	for (const event of events) {
		const payload = event.payload ?? {};
		const name = enumName(enums.SquareEventType, event.type);
		const carrier =
			payload.receiveMessage ??
			payload.sendMessage ??
			payload.notificationMessage ??
			payload.mutateMessage;
		const threadEvent = payload.notificationThreadMessage;
		const chat = nonEmpty(
			(carrier as { squareChatMid?: string } | undefined)?.squareChatMid ?? threadEvent?.chatMid
		);
		if (name === 'NOTIFIED_DESTROY_MESSAGE' && payload.notifiedDestroyMessage) {
			const destroy = payload.notifiedDestroyMessage;
			if (nonEmpty(destroy.squareChatMid) && nonEmpty(destroy.messageId)) {
				batch.changes.push({
					kind: 'unsend',
					service: 'square',
					chatId: destroy.squareChatMid,
					messageId: String(destroy.messageId)
				});
			}
			continue;
		}
		const squareMessage = (carrier?.squareMessage ?? threadEvent?.squareMessage) as
			SquareMessageLike | undefined;
		const message = squareMessage?.message;
		if (!chat || !message?.id) continue;
		const info = squareMessage?.threadInfo;
		const rootOf = info?.threadRoot ? nonEmpty(info.chatThreadMid) : null;
		const thread =
			threadMid ??
			nonEmpty((carrier as { threadMid?: string } | undefined)?.threadMid) ??
			nonEmpty(threadEvent?.threadMid) ??
			(info && !info.threadRoot ? nonEmpty(info.chatThreadMid) : null);
		const thisThread = thread && thread !== rootOf ? thread : null;
		if (rootOf) target(chat, rootOf);
		if (thisThread) target(chat, thisThread);
		else target(chat);
		if (removedStates.has(enumName(enums.SquareMessageState, squareMessage?.state) ?? '')) {
			batch.changes.push({
				kind: 'unsend',
				service: 'square',
				chatId: chat,
				messageId: String(message.id)
			});
			continue;
		}
		const displayName = nonEmpty(
			(carrier as { senderDisplayName?: string } | undefined)?.senderDisplayName ??
				threadEvent?.senderDisplayName
		);
		if (displayName && nonEmpty(message.from)) {
			batch.changes.push({
				kind: 'participant',
				service: 'square',
				id: message.from,
				displayName
			});
		}
		batch.changes.push({
			kind: 'message',
			row: await normalizeMessage(context, message, {
				service: 'square',
				chatId: chat,
				threadId: thisThread,
				edited: name === 'MUTATE_MESSAGE',
				eventTime: event.createdTime
			})
		});
	}
	batch.targets = [...targets.values()];
	return batch;
}

/**
 * The account's read positions in `fetchMyEvents` events. Only that stream
 * carries them in its own order; a chat's history replays old status events,
 * so `normalizeSquareEvents` never produces `read` changes. The event's
 * unread count is left out: a replay must not overwrite a newer snapshot.
 */
export function squareReadChanges(context: NormalizeContext, events: SquareEvent[]): Change[] {
	const changes: Change[] = [];
	for (const event of events) {
		if (enumName(enums.SquareEventType, event.type) !== 'NOTIFIED_UPDATE_SQUARE_CHAT_STATUS') {
			continue;
		}
		const status = event.payload?.notifiedUpdateSquareChatStatus;
		const chatId = nonEmpty(status?.squareChatMid);
		const marker = readMarker(
			context.log,
			'square',
			status?.statusWithoutMessage?.markedAsReadMessageId
		);
		if (chatId && marker !== null) {
			changes.push({ kind: 'read', service: 'square', chatId, marker });
		}
	}
	return changes;
}

export interface ApplyResult {
	/** Rows inserted or changed, each with a fresh `seq`. */
	changed: number;
	/** Message changes whose row existed at or below the `known` row-id boundary. */
	known: number;
}

/**
 * The highest message row id. Rows are never deleted, so a row id is the
 * order in which a message was first committed, and a boundary taken before
 * an upstream request names exactly the rows committed before that request.
 *
 * Invariant for every gap: a row anchors reconciliation (proves overlap with
 * pre-gap history) only if its id is at or below the trusted boundary of the
 * stream position the gap opened from. That boundary is taken synchronously
 * before a request the position covers (Talk: the request of a sync response
 * without more operations; Square: the first page of a chain that ran to its
 * end) and is persisted with the cursor or token, so rows that concurrent
 * writers (backfill, the other service, other chats) or pages of an unfinished
 * chain committed later never count, across steps and restarts. A position
 * without a stored boundary is unknown and trusts no row (boundary 0).
 */
export function messageBoundary(db: DatabaseSync): number {
	const row = db.prepare('SELECT coalesce(max(id), 0) AS id FROM message').get() as { id: number };
	return row.id;
}

/** Applies changes; the caller wraps this in the same transaction as its cursor. */
export function applyChanges(
	db: DatabaseSync,
	changes: Change[],
	options: { now?: number; boundary?: number } = {}
): ApplyResult {
	const now = options.now ?? Date.now();
	const boundary = options.boundary ?? Number.MAX_SAFE_INTEGER;
	const result: ApplyResult = { changed: 0, known: 0 };
	for (const change of changes) {
		if (change.kind === 'participant') {
			upsertParticipant(db, change.service, change.id, change.displayName, now);
		} else if (change.kind === 'unsend') {
			result.changed += applyUnsend(db, change.service, change.chatId, change.messageId);
		} else if (change.kind === 'read') {
			advanceMarker(db, change.service, change.chatId, change.marker);
		} else {
			const { row } = change;
			upsertChat(
				db,
				{
					service: row.service,
					chatId: row.chatId,
					type: row.chatType,
					lastActivityAt: row.sentAt ?? undefined
				},
				now
			);
			const { outcome, id } = applyMessage(db, row);
			if (id !== undefined && id <= boundary) result.known++;
			if (outcome === 'inserted' || outcome === 'updated') result.changed++;
		}
	}
	return result;
}

function nextSeq(db: DatabaseSync): number {
	const row = db
		.prepare('UPDATE change_counter SET value = value + 1 WHERE id = 1 RETURNING value')
		.get() as { value: number };
	return row.value;
}

interface StoredRow {
	id: number;
	thread_id: string | null;
	sender: string | null;
	sent_at: number | null;
	edited_at: number | null;
	content_type: string | null;
	text: string | null;
	reply_to: string | null;
	mentions: string | null;
	decrypt_state: DecryptState;
	missing_key: string | null;
	unsent: number;
}

/** A Talk message ID is global, so a tombstone in any chat covers it. */
function tombstone(db: DatabaseSync, row: MessageRow): number | undefined {
	const found = (
		row.service === 'talk'
			? db
					.prepare(
						`SELECT id FROM message WHERE service = 'talk' AND message_id = ? AND unsent = 1 LIMIT 1`
					)
					.get(row.messageId)
			: db
					.prepare(
						`SELECT id FROM message WHERE service = ? AND chat_id = ? AND message_id = ? AND unsent = 1`
					)
					.get(row.service, row.chatId, row.messageId)
	) as { id: number } | undefined;
	return found?.id;
}

// Every write of `envelope` also writes the readable fields derived from it
// (architecture, Non-text messages), so they always describe the stored envelope.
const fieldColumns = nonTextColumns.join(', ');
const fieldSlots = nonTextColumns.map(() => '?').join(', ');
const fieldSets = nonTextColumns.map((column) => `${column} = ?`).join(', ');
const fieldValues = (fields: Readonly<NonTextFields>) =>
	nonTextColumns.map((column) => fields[column]);

type Outcome = { outcome: 'inserted' | 'updated' | 'unchanged' | 'tombstoned'; id?: number };

/**
 * Merge precedence: a tombstone beats any later content; a newer edit beats
 * older content; at the same edit, a decrypted row is never downgraded.
 */
function applyMessage(db: DatabaseSync, row: MessageRow): Outcome {
	const tombstoneId = tombstone(db, row);
	if (tombstoneId !== undefined) return { outcome: 'tombstoned', id: tombstoneId };
	const stored = db
		.prepare(
			`SELECT id, thread_id, sender, sent_at, edited_at, content_type, text, reply_to, mentions,
				decrypt_state, missing_key, unsent
			FROM message WHERE service = ? AND chat_id = ? AND message_id = ?`
		)
		.get(row.service, row.chatId, row.messageId) as StoredRow | undefined;
	if (!stored) {
		db.prepare(
			`INSERT INTO message (service, chat_id, message_id, thread_id, sender, sent_at, edited_at,
				content_type, text, reply_to, mentions, envelope, decrypt_state, missing_key, seq,
				${fieldColumns})
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${fieldSlots})`
		).run(
			row.service,
			row.chatId,
			row.messageId,
			row.threadId,
			row.sender,
			row.sentAt,
			row.editedAt,
			row.contentType,
			row.text,
			row.replyTo,
			row.mentions,
			row.envelope,
			row.decryptState,
			row.missingKey,
			nextSeq(db),
			...fieldValues(envelopeFields(row.contentType, row.envelope))
		);
		return { outcome: 'inserted' };
	}
	const unchanged: Outcome = { outcome: 'unchanged', id: stored.id };
	if (!supersedes(stored, row)) return unchanged;
	const merged = { ...row, threadId: row.threadId ?? stored.thread_id };
	if (sameContent(stored, merged)) return unchanged;
	db.prepare(
		`UPDATE message SET thread_id = ?, sender = ?, sent_at = ?, edited_at = ?, content_type = ?,
			text = ?, reply_to = ?, mentions = ?, envelope = ?, decrypt_state = ?, missing_key = ?, seq = ?,
			${fieldSets}
		WHERE id = ?`
	).run(
		merged.threadId,
		merged.sender,
		merged.sentAt,
		merged.editedAt,
		merged.contentType,
		merged.text,
		merged.replyTo,
		merged.mentions,
		merged.envelope,
		merged.decryptState,
		merged.missingKey,
		nextSeq(db),
		...fieldValues(envelopeFields(merged.contentType, merged.envelope)),
		stored.id
	);
	return { outcome: 'updated', id: stored.id };
}

function supersedes(stored: StoredRow, row: MessageRow): boolean {
	const before = stored.edited_at;
	const after = row.editedAt;
	if (before !== null && (after === null || after < before)) return false;
	if (after !== null && (before === null || after > before)) return true;
	return !(stored.decrypt_state === 'ok' && row.decryptState !== 'ok');
}

function sameContent(stored: StoredRow, row: MessageRow): boolean {
	return (
		stored.thread_id === row.threadId &&
		stored.sender === row.sender &&
		stored.sent_at === row.sentAt &&
		stored.edited_at === row.editedAt &&
		stored.content_type === row.contentType &&
		stored.text === row.text &&
		stored.reply_to === row.replyTo &&
		stored.mentions === row.mentions &&
		stored.decrypt_state === row.decryptState &&
		stored.missing_key === row.missingKey
	);
}

/**
 * Clears text, mentions (and so the FTS entry), the readable fields and every
 * plaintext or ciphertext field of the envelope. An unknown message gets a
 * tombstone row so that history or decryption arriving later cannot bring it back.
 */
function applyUnsend(
	db: DatabaseSync,
	service: Service,
	chatId: string,
	messageId: string
): number {
	const rows = (
		service === 'talk'
			? db
					.prepare(
						`SELECT id, unsent, envelope FROM message WHERE service = 'talk' AND message_id = ?`
					)
					.all(messageId)
			: db
					.prepare(
						'SELECT id, unsent, envelope FROM message WHERE service = ? AND chat_id = ? AND message_id = ?'
					)
					.all(service, chatId, messageId)
	) as { id: number; unsent: number; envelope: string }[];
	if (rows.length === 0) {
		db.prepare(
			`INSERT INTO message (service, chat_id, message_id, envelope, decrypt_state, unsent, seq,
				${fieldColumns})
			VALUES (?, ?, ?, ?, 'ok', 1, ?, ${fieldSlots})`
		).run(
			service,
			chatId,
			messageId,
			tombstoneEnvelope(null, { id: messageId }),
			nextSeq(db),
			...fieldValues(noFields)
		);
		return 1;
	}
	let changed = 0;
	for (const row of rows) {
		if (row.unsent === 1) continue;
		db.prepare(
			`UPDATE message SET text = NULL, mentions = NULL, envelope = ?, unsent = 1, missing_key = NULL,
				seq = ?, ${fieldSets} WHERE id = ?`
		).run(
			tombstoneEnvelope(row.envelope, { id: messageId }),
			nextSeq(db),
			...fieldValues(noFields),
			row.id
		);
		changed++;
	}
	return changed;
}

/** Row id after which the next missing-key retry continues. */
const retryCursorKey = 'keys:retryAfter';

interface MissingKeyRow {
	id: number;
	chat_id: string;
	thread_id: string | null;
	edited_at: number | null;
	envelope: string;
}

/**
 * Retries `missing_key` rows from their retained envelopes, `limit` at a
 * time. A persisted cursor moves through the rows and wraps at the end, so
 * rows that stay undecryptable cannot keep later ones from ever being tried.
 * The merge rules still apply, so a message unsent meanwhile stays a tombstone.
 */
export async function retryMissingKeys(
	db: DatabaseSync,
	context: NormalizeContext,
	transaction: <T>(body: () => T) => T,
	limit = 200
): Promise<number> {
	const select = db.prepare(
		`SELECT id, chat_id, thread_id, edited_at, envelope FROM message
		WHERE decrypt_state = 'missing_key' AND unsent = 0 AND service = 'talk' AND id > ?
		ORDER BY id LIMIT ?`
	);
	const after = readState<number>(db, retryCursorKey) ?? 0;
	let rows = select.all(after, limit) as unknown as MissingKeyRow[];
	// The cursor passed the last row: start over from the first.
	if (rows.length === 0 && after > 0) rows = select.all(0, limit) as unknown as MissingKeyRow[];
	let recovered = 0;
	for (const stored of rows) {
		const row = await normalizeMessage(context, decodeEnvelope(stored.envelope), {
			service: 'talk',
			chatId: stored.chat_id,
			threadId: stored.thread_id
		});
		if (row.decryptState === 'missing_key') continue;
		// The same envelope, so the same edit; an edit op's own time is not in it.
		row.editedAt = stored.edited_at;
		recovered += transaction(() => applyChanges(db, [{ kind: 'message', row }]).changed);
	}
	const next = rows.length < limit ? 0 : rows.at(-1)!.id;
	transaction(() => writeState(db, retryCursorKey, next));
	return recovered;
}

/** Decimal-string form of an integer ID for request structs that need a 64-bit value. */
export function int64(value: string): bigint {
	return BigInt(decimal(value));
}
