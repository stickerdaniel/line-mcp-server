// Builds a line-mcp archive from a synthetic world (world-format.ts) through
// the production write paths only: the account binding, session storage,
// chats, participants, and every message, edit, unsend and read position as
// LINE would deliver it (Talk operations, Square events) through
// `normalizeOperations` / `normalizeSquareEvents` and `applyChanges`.
// Nothing is inserted into an archive table by hand.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { BaseClient, InternalError } from '@evex/linejs/base';
import type { BaseStorage } from '@evex/linejs/storage';
import type { Message as LineMessage, Operation, SquareEvent } from '@evex/linejs-types';
import {
	addSquareSelfMember,
	healthKey,
	type HealthRecord,
	type Service,
	squareSyncedAtKey,
	talkSyncedAtKey,
	upsertChat,
	upsertParticipant,
	writeState
} from '../src/archive.ts';
import { bindAccount, openDatabase, transaction } from '../src/db.ts';
import { observeReported } from '../src/read-state.ts';
import { device, linejsVersion } from '../src/session.ts';
import { SqliteStorage } from '../src/storage.ts';
import { type BackfillState, backfillKey } from '../src/sync/backfill.ts';
import {
	applyChanges,
	type Change,
	type NormalizeContext,
	normalizeOperations,
	normalizeSquareEvents,
	squareReadChanges
} from '../src/sync/normalize.ts';
import { squareBackfillKey } from '../src/sync/square.ts';
import type { At, Chat, ChatEventSpec, Message, World } from './world-format.ts';

/** Secrets in session storage; a transcript that shows one shows a leak. */
export const canaryAuthToken = 'canary-auth-7f3a9c';
export const canaryKey = 'canary-key-41d2e8';
/** The generation of the canary key entry; no message names it. */
const canaryKeyId = 41;

/** The zone of a world that names none. */
export const defaultTimeZone = 'Asia/Taipei';

/** The IANA zone `world` lives in. */
export const worldZone = (world: World): string => world.timeZone ?? defaultTimeZone;

/** Where each handle of the world landed in the archive, for oracles. */
export interface LoadedWorld {
	selfMid: string;
	/** Person id -> Talk MID. */
	people: Record<string, string>;
	chats: Record<string, { service: Service; chatId: string }>;
	/** OpenChat id -> person id ('self' included) -> member ID in that OpenChat. */
	members: Record<string, Record<string, string>>;
	messages: Record<
		string,
		{ service: Service; chatId: string; messageId: string; threadId?: string; sentAt: number }
	>;
}

const refuse = (what: string) => new Error(`The SQL eval never contacts LINE (${what})`);

/**
 * A LINEJS client that never reaches the network: its transport throws, and
 * an RPC gets an answer only from `answers`, given locally; any other RPC
 * throws as well.
 */
export function offlineClient(
	storage: BaseStorage,
	answers: Record<string, () => unknown> = {}
): BaseClient {
	const base = new BaseClient({
		device,
		storage,
		fetch: async () => {
			throw refuse('fetch');
		}
	});
	Object.assign(base.request, {
		requestCore: async (_path: string, _value: unknown, method: string) => {
			const answer = answers[method];
			if (!answer) throw refuse(method);
			return { data: { success: answer() } };
		}
	});
	return base;
}

/** LINE's answer to a key lookup for a generation the account does not have. */
const notFound = () => {
	throw new InternalError('RequestError', 'Request internal failed', { code: 'NOT_FOUND' });
};

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const mid = (prefix: string, seed: string) => `${prefix}${hex(seed).slice(0, 32)}`;
/** A stable decimal number from `seed`, for sticker and package IDs. */
const number = (seed: string, digits: number) =>
	String(BigInt(`0x${hex(seed).slice(0, 12)}`) % 10n ** BigInt(digits));

function fail(message: string): never {
	throw new Error(`World: ${message}`);
}

interface LocalDate {
	year: number;
	month: number;
	day: number;
}

function parseDate(value: string, what: string): LocalDate {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) fail(`${what} ${value} is not YYYY-MM-DD`);
	const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
	const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
	if (check.getUTCMonth() !== date.month - 1 || check.getUTCDate() !== date.day) {
		fail(`${what} ${value} is no calendar date`);
	}
	return date;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `zone`'s clock is ahead of UTC at the instant `ms`, in milliseconds. */
function offsetMs(zone: string, ms: number): number {
	let format = zoneFormats.get(zone);
	if (!format) {
		try {
			format = new Intl.DateTimeFormat('en-US', {
				timeZone: zone,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			});
		} catch {
			fail(`unknown time zone ${zone}`);
		}
		zoneFormats.set(zone, format);
	}
	const part = Object.fromEntries(
		format.formatToParts(ms).map((entry) => [entry.type, Number(entry.value)])
	) as Record<Intl.DateTimeFormatPartTypes, number>;
	const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
	return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * UTC milliseconds of the local clock time `time` on `date` in `zone`. A
 * time that the zone skips (spring forward) or passes twice (fall back) is
 * rejected: a world must not depend on how a loader resolves it.
 */
export function localMs(zone: string, date: LocalDate, time: string): number {
	const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
	if (!match) fail(`invalid time ${time}`);
	const [hours, minutes, seconds] = [match[1], match[2], match[3] ?? '0'].map(Number) as [
		number,
		number,
		number
	];
	if (hours > 23 || minutes > 59 || seconds > 59) fail(`invalid time ${time}`);
	const wall = Date.UTC(date.year, date.month - 1, date.day, hours, minutes, seconds);
	// Every instant that reads `wall` in the zone has one of the offsets in
	// force a day around it; no zone changes its offset twice within two days.
	const day = 24 * 60 * 60 * 1000;
	const candidates = new Set(
		[offsetMs(zone, wall - day), offsetMs(zone, wall + day)]
			.map((offset) => wall - offset)
			.filter((ms) => wall - ms === offsetMs(zone, ms))
	);
	const label = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} ${time} in ${zone}`;
	if (candidates.size === 0) fail(`${label} does not exist`);
	if (candidates.size > 1) fail(`${label} occurs twice`);
	return [...candidates][0]!;
}

/** UTC milliseconds of `at`: `daysAgo` days before the anchor date, or on its own `date`, in `zone`. */
export function atMs(zone: string, anchor: LocalDate, at: At): number {
	if ('date' in at) return localMs(zone, parseDate(at.date, 'date'), at.time);
	if (!Number.isInteger(at.daysAgo) || at.daysAgo < 0) fail(`invalid time ${JSON.stringify(at)}`);
	const day = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day - at.daysAgo));
	return localMs(
		zone,
		{ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
		at.time
	);
}

/** The anchor date `YYYY-MM-DD` as its parts; the loader and the count check share it. */
export const parseAnchor = (anchor: string): LocalDate => parseDate(anchor, 'anchor');

/** `LOC_KEY` and `LOC_ARGS`: arguments joined by U+001E. */
const eventArgs = (code: string, values: string[]) => ({
	LOC_KEY: code,
	...(values.length ? { LOC_ARGS: values.join('\u001e') } : {})
});

/** LINE's chat event code and arguments for each event type (architecture, Non-text messages). */
function chatEventMetadata(
	event: ChatEventSpec,
	id: (person: string) => string
): Record<string, string> {
	const list = (people: string[] | undefined, what: string) => {
		if (!people?.length) fail(`a ${event.type} event needs ${what}`);
		return people.map(id).join('\u001f');
	};
	const by = () => (event.by ? id(event.by) : fail(`a ${event.type} event needs by`));
	switch (event.type) {
		case 'joined':
			return eventArgs('C_MJ', [list(event.members, 'members')]);
		case 'left':
			return eventArgs('C_ML', [list(event.members, 'members')]);
		case 'invited':
			return eventArgs('C_MI', [by(), list(event.members, 'members')]);
		case 'invitation_canceled':
			return eventArgs('C_IC', [by(), list(event.members, 'members')]);
		case 'removed':
			return eventArgs('C_MR', [
				...(event.by ? [id(event.by)] : []),
				list(event.members, 'members')
			]);
		case 'renamed':
			return eventArgs('C_PN', [by(), event.name ?? fail('a renamed event needs name')]);
		case 'picture_changed':
			return eventArgs('C_PI', [by()]);
		case 'link_join_allowed':
			return eventArgs('C_SN', event.by ? [id(event.by)] : []);
		case 'link_join_disabled':
			return eventArgs('C_SP', event.by ? [id(event.by)] : []);
	}
}

/** LINE's `MENTION` metadata: each mentioned person's `@name` span in the text, if it is there. */
function mentionMetadata(text: string, mentioned: { id: string; name: string }[]): string {
	return JSON.stringify({
		MENTIONEES: mentioned.map(({ id, name }) => {
			const start = text.indexOf(`@${name}`);
			const end = start < 0 ? 0 : start + name.length + 1;
			return { S: String(Math.max(start, 0)), E: String(end), M: id };
		})
	});
}

interface Placed {
	message: Message;
	chat: Chat;
	sentAt: number;
	messageId: string;
}

/**
 * Loads `world` into a new archive at `root`, with each local time in the
 * world's zone, `daysAgo` days before `anchor` (YYYY-MM-DD) or on its date.
 * The archive reads as a fresh, online daemon left it: health online, both
 * services synced now, no gaps and every backfill complete.
 */
export async function loadWorld(world: World, anchor: string, root: string): Promise<LoadedWorld> {
	const day = parseAnchor(anchor);
	const zone = worldZone(world);
	const now = Date.now();
	const selfMid = mid('u', 'self');
	const people = new Map(world.people.map((person) => [person.id, person]));
	if (people.size !== world.people.length || people.has('self')) {
		fail('person ids must be unique and not "self"');
	}
	const nameOf = (person: string) =>
		person === 'self' ? world.self.name : (people.get(person)?.name ?? fail(`no person ${person}`));
	const talkMid = (person: string) => (person === 'self' ? selfMid : mid('u', `person:${person}`));

	const chats = new Map(world.chats.map((chat) => [chat.id, chat]));
	if (chats.size !== world.chats.length) fail('chat ids must be unique');
	const loaded: LoadedWorld = {
		selfMid,
		people: Object.fromEntries(world.people.map((person) => [person.id, talkMid(person.id)])),
		chats: {},
		members: {},
		messages: {}
	};
	const memberId = (chat: Chat, person: string) => mid('p', `member:${chat.id}:${person}`);
	for (const chat of chats.values()) {
		for (const member of chat.members) if (member !== 'self') nameOf(member);
		if (!chat.members.includes('self')) fail(`chat ${chat.id} must include self`);
		if (chat.nicknames && chat.kind !== 'openchat') fail(`only an OpenChat has nicknames`);
		let chatId: string;
		if (chat.kind === 'direct') {
			const peers = chat.members.filter((member) => member !== 'self');
			if (chat.members.length !== 2 || peers.length !== 1) {
				fail(`direct chat ${chat.id} needs exactly self and one peer`);
			}
			chatId = talkMid(peers[0]!);
		} else {
			chatId = mid({ group: 'c', room: 'r', openchat: 'm' }[chat.kind], `chat:${chat.id}`);
		}
		loaded.chats[chat.id] = { service: chat.kind === 'openchat' ? 'square' : 'talk', chatId };
		if (chat.kind === 'openchat') {
			loaded.members[chat.id] = Object.fromEntries(
				chat.members.map((member) => [member, memberId(chat, member)])
			);
		}
	}
	const chatOf = (key: string) => loaded.chats[key] ?? fail(`no chat ${key}`);
	/** The ID a person has in a chat: the Talk MID, or the member ID in an OpenChat. */
	const senderIn = (chat: Chat, person: string) => {
		if (!chat.members.includes(person)) fail(`${person} is not a member of chat ${chat.id}`);
		return chat.kind === 'openchat' ? memberId(chat, person) : talkMid(person);
	};
	const displayIn = (chat: Chat, person: string) => chat.nicknames?.[person] ?? nameOf(person);

	// Message IDs follow send time, as LINE's do: 18 digits, the send time
	// in milliseconds, then the order within that millisecond and three digits
	// from the key.
	if (new Set(world.messages.map((message) => message.key)).size !== world.messages.length) {
		fail('message keys must be unique');
	}
	const placed = world.messages
		.map((message, order) => ({
			message,
			order,
			chat: chats.get(message.chat) ?? fail(`message ${message.key}: no chat ${message.chat}`),
			sentAt: atMs(zone, day, message.at)
		}))
		.toSorted((a, b) => a.sentAt - b.sentAt || a.order - b.order);
	const byId = new Map<string, Placed>();
	let previous = { sentAt: -1, index: 0 };
	for (const entry of placed) {
		const index = entry.sentAt === previous.sentAt ? previous.index + 1 : 0;
		if (index >= 100) fail('more than 100 messages in one millisecond');
		previous = { sentAt: entry.sentAt, index };
		const low = index * 1000 + Number(number(`id:${entry.message.key}`, 3));
		const messageId = (BigInt(entry.sentAt) * 100_000n + BigInt(low)).toString();
		byId.set(entry.message.key, { ...entry, messageId });
	}
	const placedOf = (key: string, chat: Chat, what: string) => {
		const found = byId.get(key) ?? fail(`${what} ${key} does not exist`);
		if (found.chat.id !== chat.id) fail(`${what} ${key} is in another chat`);
		return found;
	};

	const threadId = (rootKey: string) => mid('t', `thread:${rootKey}`);
	const threadRoots = new Set<string>();
	for (const { message, chat } of byId.values()) {
		if (message.thread === undefined) continue;
		if (chat.kind !== 'openchat') fail(`message ${message.key}: threads exist only in OpenChat`);
		const rootMessage = placedOf(message.thread, chat, 'thread root').message;
		if (rootMessage.thread !== undefined) fail(`thread root ${message.thread} is in a thread`);
		threadRoots.add(message.thread);
	}

	const db = openDatabase(root);
	try {
		const storage = new SqliteStorage(db);
		// Undecryptable messages take the production E2EE path: a DM names a
		// self key generation that is not stored, a group a shared key LINE
		// does not have for the account.
		const context: NormalizeContext = {
			base: offlineClient(storage, {
				getE2EEGroupSharedKey: notFound,
				getE2EEPublicKey: notFound
			}),
			selfMid,
			log: () => {}
		};

		/** One message as LINE delivers it, with `text` as its current text. */
		const lineMessage = (entry: Placed, text: string | undefined): LineMessage => {
			const { message, chat } = entry;
			const { chatId, service } = chatOf(chat.id);
			const square = service === 'square';
			const fromSelf = message.from === 'self';
			const to = square || chat.kind !== 'direct' || fromSelf ? chatId : selfMid;
			const body = content(message, text, {
				eventId: (person) => {
					nameOf(person);
					return square ? memberId(chat, person) : talkMid(person);
				},
				contactMid: (name) => {
					const known = world.people.find((person) => person.name === name);
					return known ? talkMid(known.id) : mid('u', `contact:${name}`);
				},
				// Own key generation 9 is not stored (the canary is 41); peer 7 and
				// group key 3 are unknown to LINE.
				e2ee: (plain) => {
					const [senderKeyId, receiverKeyId] =
						chat.kind === 'direct' ? (fromSelf ? [9, 7] : [7, 9]) : [7, 3];
					return context.base.e2ee.encryptE2EETextMessage(
						senderKeyId,
						receiverKeyId,
						randomBytes(32),
						2,
						plain,
						to,
						senderIn(chat, message.from)
					);
				}
			});
			const mentions = message.mentions?.length
				? {
						MENTION: mentionMetadata(
							text ?? '',
							message.mentions.map((person) => ({
								id: senderIn(chat, person),
								name: displayIn(chat, person)
							}))
						)
					}
				: {};
			const reply = message.replyTo
				? {
						relatedMessageId: placedOf(message.replyTo, chat, 'reply target').messageId,
						messageRelationType: 'REPLY',
						relatedMessageServiceCode: square ? 'SQUARE' : 'TALK'
					}
				: {};
			return {
				from: senderIn(chat, message.from),
				to,
				toType: { direct: 'USER', group: 'GROUP', room: 'ROOM', openchat: 'SQUARE_CHAT' }[
					chat.kind
				],
				id: entry.messageId,
				createdTime: entry.sentAt,
				...(square ? {} : { deliveredTime: entry.sentAt }),
				...body,
				contentMetadata: { ...body.contentMetadata, ...mentions },
				...reply
			} as unknown as LineMessage;
		};

		// Every change in the order LINE would deliver it: messages and edits at
		// their times, an unsend right after the message (or its edit).
		const timeline: { at: number; changes: () => Promise<Change[]> }[] = [];
		const talk = async (operation: Record<string, unknown>) =>
			(await normalizeOperations(context, [operation as unknown as Operation])).changes;
		const square = async (event: Record<string, unknown>) =>
			(await normalizeSquareEvents(context, [event as unknown as SquareEvent])).changes;
		let revision = 0;
		for (const entry of byId.values()) {
			const { message, chat } = entry;
			const { chatId, service } = chatOf(chat.id);
			const fromSelf = message.from === 'self';
			const thread = message.thread === undefined ? undefined : threadId(message.thread);
			loaded.messages[message.key] = {
				service,
				chatId,
				messageId: entry.messageId,
				...(thread ? { threadId: thread } : {}),
				sentAt: entry.sentAt
			};
			if (message.undecryptable && (service === 'square' || message.kind !== 'text')) {
				fail(`message ${message.key}: only Talk text messages are end-to-end encrypted here`);
			}
			const squarePayload = (text: string | undefined) => ({
				squareChatMid: chatId,
				senderDisplayName: displayIn(chat, message.from),
				...(thread ? { threadMid: thread } : {}),
				squareMessage: {
					message: lineMessage(entry, text),
					fromType: 'SQUARE_MEMBER',
					state: 'SENT',
					...(threadRoots.has(message.key)
						? { threadInfo: { chatThreadMid: threadId(message.key), threadRoot: true } }
						: thread
							? { threadInfo: { chatThreadMid: thread, threadRoot: false } }
							: {})
				}
			});
			timeline.push({
				at: entry.sentAt,
				changes: () =>
					service === 'talk'
						? talk({
								revision: ++revision,
								type: fromSelf ? 'SEND_MESSAGE' : 'RECEIVE_MESSAGE',
								message: lineMessage(entry, message.text),
								createdTime: entry.sentAt
							})
						: square({
								type: fromSelf ? 'SEND_MESSAGE' : 'RECEIVE_MESSAGE',
								createdTime: entry.sentAt,
								payload: {
									[fromSelf ? 'sendMessage' : 'receiveMessage']: squarePayload(message.text)
								}
							})
			});
			let last = entry.sentAt;
			if (message.edited) {
				const edit = message.edited;
				const editedAt = atMs(zone, day, edit.at);
				if (message.kind !== 'text' || message.undecryptable) {
					fail(`message ${message.key}: LINE edits plain text messages only`);
				}
				if (editedAt < entry.sentAt) fail(`message ${message.key}: edited before it was sent`);
				last = editedAt;
				timeline.push({
					at: editedAt,
					changes: () => {
						if (service === 'square') {
							return square({
								type: 'MUTATE_MESSAGE',
								createdTime: editedAt,
								payload: { mutateMessage: squarePayload(edit.text) }
							});
						}
						const edited = lineMessage(entry, edit.text);
						edited.contentMetadata = { ...edited.contentMetadata, UPDATED_TIME: String(editedAt) };
						return talk({
							revision: ++revision,
							type: fromSelf ? 'EDIT_MESSAGE' : 'NOTIFIED_EDIT_MESSAGE',
							message: edited,
							createdTime: editedAt
						});
					}
				});
			}
			if (message.unsent) {
				timeline.push({
					at: last,
					changes: () =>
						service === 'talk'
							? talk({
									revision: ++revision,
									type: fromSelf ? 'DESTROY_MESSAGE' : 'NOTIFIED_DESTROY_MESSAGE',
									param1: chatId,
									param2: entry.messageId,
									createdTime: last
								})
							: square({
									type: 'NOTIFIED_DESTROY_MESSAGE',
									createdTime: last,
									payload: {
										notifiedDestroyMessage: {
											squareChatMid: chatId,
											messageId: entry.messageId,
											...(thread ? { threadMid: thread } : {})
										}
									}
								})
				});
			}
		}
		const changes: Change[] = [];
		for (const step of timeline.toSorted((a, b) => a.at - b.at)) {
			changes.push(...(await step.changes()));
		}

		// Read positions, as Talk's SEND_CHAT_CHECKED and Square's chat status
		// events report them, and LINE's count as a snapshot reports it.
		const snapshots: Parameters<typeof observeReported>[2][] = [];
		for (const chat of chats.values()) {
			const { chatId, service } = chatOf(chat.id);
			const inChat = [...byId.values()].filter((entry) => entry.chat.id === chat.id);
			const marker =
				chat.readThrough === null
					? null
					: chat.readThrough !== undefined
						? placedOf(chat.readThrough, chat, 'readThrough').messageId
						: (inChat.at(-1)?.messageId ?? null);
			if (marker !== null) {
				changes.push(
					...(service === 'talk'
						? await talk({
								revision: ++revision,
								type: 'SEND_CHAT_CHECKED',
								param1: chatId,
								param2: marker,
								createdTime: now
							})
						: squareReadChanges(context, [
								{
									type: 'NOTIFIED_UPDATE_SQUARE_CHAT_STATUS',
									createdTime: now,
									payload: {
										notifiedUpdateSquareChatStatus: {
											squareChatMid: chatId,
											statusWithoutMessage: { markedAsReadMessageId: marker }
										}
									}
								} as unknown as SquareEvent
							]))
				);
			}
			if (chat.lineUnread !== undefined) {
				snapshots.push({ service, chatId, marker, count: chat.lineUnread, at: now });
			}
		}

		const talkPeople = new Set(
			world.chats.filter((chat) => chat.kind !== 'openchat').flatMap((chat) => chat.members)
		);
		const done: BackfillState = { pages: 1, stopReason: 'complete' };
		transaction(db, () => {
			bindAccount(db, { mid: selfMid, device, linejsVersion }, new Date(now).toISOString());
			storage.setAllSync([
				['authToken', canaryAuthToken],
				[
					`e2eeKeys:${canaryKeyId}`,
					JSON.stringify({
						keyId: canaryKeyId,
						privKey: Buffer.from(canaryKey).toString('base64'),
						pubKey: Buffer.from(`${canaryKey}-public`).toString('base64'),
						e2eeVersion: '1',
						note: canaryKey
					})
				]
			]);
			for (const person of talkPeople) {
				upsertParticipant(db, 'talk', talkMid(person), nameOf(person), now);
			}
			for (const chat of chats.values()) {
				const { chatId, service } = chatOf(chat.id);
				const peer = chat.members.find((member) => member !== 'self');
				upsertChat(
					db,
					{
						service,
						chatId,
						type: { direct: 'user', group: 'group', room: 'room', openchat: 'square' }[chat.kind],
						...(chat.kind === 'direct'
							? { name: nameOf(peer!) }
							: chat.name
								? { name: chat.name }
								: {}),
						...(chat.kind === 'group' || chat.kind === 'room'
							? { memberCount: chat.members.length }
							: {})
					},
					now
				);
				if (service === 'talk') {
					writeState(db, backfillKey('talk', chatId), done, now);
				} else {
					addSquareSelfMember(db, chatId, memberId(chat, 'self'), now);
					writeState(db, squareBackfillKey({ chat: chatId }), done, now);
				}
			}
			for (const rootKey of threadRoots) {
				const { chatId } = loaded.messages[rootKey]!;
				writeState(db, squareBackfillKey({ chat: chatId, thread: threadId(rootKey) }), done, now);
			}
			applyChanges(db, changes, { now });
			for (const snapshot of snapshots) observeReported(db, () => {}, snapshot);
			writeState(db, healthKey, { state: 'online', since: now } satisfies HealthRecord, now);
			writeState(db, talkSyncedAtKey, now, now);
			writeState(db, squareSyncedAtKey, now, now);
		});
		return loaded;
	} finally {
		db.close();
	}
}

interface ContentHelpers {
	/** The ID a chat event names a person by. */
	eventId: (person: string) => string;
	/** The MID a contact card names. */
	contactMid: (name: string) => string;
	/** E2EE chunks of a text no stored key opens. */
	e2ee: (text: string) => Buffer[];
}

/**
 * The content fields of a message as LINE sends them: its content type, the
 * plaintext `contentMetadata` that tools describe non-text messages by, and
 * the text, location or E2EE chunks.
 */
function content(
	message: Message,
	text: string | undefined,
	helpers: ContentHelpers
): Pick<LineMessage, 'contentMetadata'> &
	Partial<Pick<LineMessage, 'text' | 'location' | 'chunks'>> & { contentType: string } {
	const need = <T>(value: T | undefined, what: string): T =>
		value ?? fail(`message ${message.key}: a ${message.kind} message needs ${what}`);
	const media = (sid: string): Record<string, string> => ({
		SID: sid,
		OID: hex(`oid:${message.key}`)
	});
	const size: Record<string, string> = message.file ? { FILE_SIZE: String(message.file.size) } : {};
	const duration: Record<string, string> =
		message.durationMs === undefined ? {} : { DURATION: String(message.durationMs) };
	if (message.kind === 'chat_event' && text !== undefined) {
		fail(`message ${message.key}: a chat_event has no text; event describes it`);
	}
	switch (message.kind) {
		case 'text':
			if (message.undecryptable) {
				return {
					contentType: 'NONE',
					contentMetadata: { e2eeVersion: '2' },
					chunks: helpers.e2ee(text ?? '')
				};
			}
			return { contentType: 'NONE', contentMetadata: {}, text: need(text, 'text') };
		case 'sticker':
			return {
				contentType: 'STICKER',
				contentMetadata: {
					STKID: number(`sticker:${message.key}`, 8),
					STKPKGID: number(`package:${message.key}`, 5),
					STKVER: '1',
					...(text ? { STKTXT: text } : {})
				}
			};
		case 'image':
			return { contentType: 'IMAGE', contentMetadata: { ...media('emi'), ...size } };
		case 'video':
			return { contentType: 'VIDEO', contentMetadata: { ...media('emv'), ...duration, ...size } };
		case 'audio':
			return { contentType: 'AUDIO', contentMetadata: { ...media('ema'), ...duration, ...size } };
		case 'file': {
			const file = need(message.file, 'file');
			return {
				contentType: 'FILE',
				contentMetadata: {
					...media('emf'),
					FILE_NAME: file.name,
					FILE_SIZE: String(file.size)
				}
			};
		}
		case 'location': {
			const location = need(message.location, 'location');
			return {
				contentType: 'LOCATION',
				contentMetadata: {},
				location: { address: '', ...location } as LineMessage['location'],
				...(text ? { text } : {})
			};
		}
		case 'contact': {
			const contact = need(message.contact, 'contact');
			return {
				contentType: 'CONTACT',
				contentMetadata: { mid: helpers.contactMid(contact.name), displayName: contact.name }
			};
		}
		case 'call': {
			const call = need(message.call, 'call');
			return {
				contentType: 'CALL',
				contentMetadata: {
					TYPE: call.type === 'video' ? 'V' : 'A',
					RESULT: call.result.toUpperCase(),
					DURATION: String(message.durationMs ?? 0)
				}
			};
		}
		case 'flex':
			return {
				contentType: 'FLEX',
				contentMetadata: {
					ALT_TEXT: need(text, 'text (its alt text)'),
					FLEX_JSON: JSON.stringify({
						type: 'bubble',
						body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text }] }
					})
				}
			};
		case 'chat_event':
			return {
				contentType: 'CHATEVENT',
				contentMetadata: chatEventMetadata(need(message.event, 'event'), helpers.eventId)
			};
	}
}
