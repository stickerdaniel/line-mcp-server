import type { BaseClient } from '@evex/linejs/base';
import { enums, type Message } from '@evex/linejs-types';
import {
	type Service,
	readState,
	stateKeys,
	upsertChat,
	upsertParticipant,
	writeState
} from '../archive.ts';
import { transaction } from '../db.ts';
import { mapError } from '../errors.ts';
import { isTransient, type Pool, type SyncContext } from './loop.ts';
import {
	applyChanges,
	enumName,
	int64,
	millis,
	normalizeMessage,
	normalizeSquareEvents
} from './normalize.ts';
import {
	addPending,
	advanceChain,
	type ChainMemory,
	fetchOlderPage,
	historySlotFree,
	parseTargetPath,
	recordStalledHistory,
	takeHistorySlot,
	targetKey
} from './square.ts';

export const pageSize = 50;

/** Position of the oldest message fetched so far, as decimal strings. */
export interface MessagePosition {
	deliveredTime: string;
	messageId: string;
}

export interface BackfillState extends ChainMemory {
	/** Talk: fetch messages before this one next. */
	before?: MessagePosition;
	/** Square: the `syncToken` the next older page is fetched backward from. */
	syncToken?: string;
	pages: number;
	/**
	 * Set once the backfill ended: `complete`, `no_progress`, `no_token` or
	 * `upstream:<CODE>`.
	 */
	stopReason?: string;
}

export function backfillKey(service: Service, chatId: string): string {
	return `backfill:${service}:${chatId}`;
}

/** A message's place in history: delivery time, then ID, as integers, never through `Number`. */
function placeOf(message: Message): { time: bigint; id: bigint } {
	return {
		time: BigInt(String(message.deliveredTime || message.createdTime || 0)),
		id: BigInt(String(message.id))
	};
}

/**
 * Newest page when `before` is absent, otherwise the messages older than
 * `before`. LINE returns `endMessageId` itself with the older messages, so a
 * page holding only that message means nothing older exists.
 */
export async function fetchTalkPage(
	base: BaseClient,
	chatId: string,
	before: MessagePosition | undefined
): Promise<Message[]> {
	const messages = before
		? await base.talk.getPreviousMessagesV2WithRequest({
				request: {
					messageBoxId: chatId,
					endMessageId: {
						deliveredTime: int64(before.deliveredTime),
						messageId: int64(before.messageId)
					},
					messagesCount: pageSize,
					withReadCount: false,
					receivedOnly: false
				},
				syncReason: 'INTERNAL'
			})
		: await base.talk.getRecentMessagesV2({ messageBoxId: chatId, messagesCount: pageSize });
	const page = (messages ?? []).filter((message) => /^\d+$/.test(String(message?.id ?? '')));
	if (!before) return page;
	const end = { time: BigInt(before.deliveredTime), id: BigInt(before.messageId) };
	return page.filter((message) => {
		const { time, id } = placeOf(message);
		return time < end.time || (time === end.time && id < end.id);
	});
}

/** The oldest message of a page. */
export function oldestPosition(messages: Message[]): MessagePosition | undefined {
	let oldest: { time: bigint; id: bigint } | undefined;
	for (const message of messages) {
		const place = placeOf(message);
		if (
			!oldest ||
			place.time < oldest.time ||
			(place.time === oldest.time && place.id < oldest.id)
		) {
			oldest = place;
		}
	}
	return oldest && { deliveredTime: oldest.time.toString(), messageId: oldest.id.toString() };
}

async function talkChanges(context: SyncContext, messages: Message[]) {
	const changes = [];
	for (const message of messages) {
		changes.push({
			kind: 'message' as const,
			row: await normalizeMessage(context, message, { service: 'talk' })
		});
	}
	return changes;
}

/**
 * Pages a Talk chat back from its newest message until a page contains a
 * message archived before the gap opened (row id at or below `boundary`).
 * Returns whether it met that history (or the start of the chat) within
 * `maxPages`.
 */
export async function reconcileTalkChat(
	context: SyncContext,
	pool: Pool,
	chatId: string,
	boundary: number,
	maxPages = 5
): Promise<boolean> {
	let before: MessagePosition | undefined;
	try {
		for (let page = 0; page < maxPages; page++) {
			const messages = await pool.run(() => fetchTalkPage(context.base, chatId, before));
			if (messages.length === 0) return true;
			const changes = await talkChanges(context, messages);
			const { known } = transaction(context.db, () =>
				applyChanges(context.db, changes, { now: context.now(), boundary })
			);
			if (known > 0) return true;
			// Every message on a page is older than `before`, so each page moves back.
			before = oldestPosition(messages);
		}
	} catch (error) {
		if (isTransient(error, 'reconcile')) throw error;
		context.log({ event: 'reconcile_chat_failed', ...mapError(error, 'reconcile') });
		return false;
	}
	return false;
}

/**
 * One backfill page for one chat. The page's messages and the new cursor are
 * committed together; a stop reason ends the chat's backfill.
 */
export async function backfillStep(context: SyncContext, pool: Pool, key: string): Promise<void> {
	const { db } = context;
	const match = /^backfill:(talk|square):(.+)$/s.exec(key);
	if (!match) return;
	const [, service, chatId] = match as unknown as [string, Service, string];
	const state = readState<BackfillState>(db, key) ?? { pages: 0 };
	if (state.stopReason) return;
	const stop = (stopReason: string) =>
		writeState(db, key, { ...state, stopReason } satisfies BackfillState, context.now());
	try {
		if (service === 'talk') {
			const messages = await pool.run(() => fetchTalkPage(context.base, chatId, state.before));
			if (messages.length === 0) return stop('complete');
			const changes = await talkChanges(context, messages);
			transaction(db, () => {
				applyChanges(db, changes, { now: context.now() });
				writeState(
					db,
					key,
					{ before: oldestPosition(messages), pages: state.pages + 1 },
					context.now()
				);
			});
			return;
		}
		const target = parseTargetPath(chatId);
		const token = state.syncToken;
		if (!token) return stop('no_token');
		// Reconciliation of the same target shares the slot; a busy one waits a round.
		if (!takeHistorySlot(db, target, context.now())) return;
		const response = await pool.run(() => fetchOlderPage(context.base, target, token));
		const events = response.events ?? [];
		const next = response.syncToken || undefined;
		const chain = events.length === 0 || !next ? undefined : advanceChain(state, next, events);
		const nextState: BackfillState = { pages: state.pages + 1 };
		if (events.length === 0) nextState.stopReason = 'complete';
		else if (!chain) nextState.stopReason = 'no_token';
		else if (chain === 'stalled') nextState.stopReason = 'no_progress';
		else Object.assign(nextState, { syncToken: next, ...chain });
		const batch = await normalizeSquareEvents(context, events, target.thread);
		transaction(db, () => {
			const now = context.now();
			applyChanges(db, batch.changes, { now });
			addPending(
				db,
				batch.targets.filter((found) => found.thread && targetKey(found) !== targetKey(target))
			);
			if (nextState.stopReason && nextState.stopReason !== 'complete') {
				recordStalledHistory(
					db,
					target,
					{ pages: nextState.pages, stop: nextState.stopReason },
					now
				);
			}
			writeState(db, key, nextState, now);
		});
	} catch (error) {
		if (isTransient(error, 'backfill')) throw error;
		stop(`upstream:${mapError(error, 'backfill').code}`);
	}
}

/** Chats whose backfill has not stopped, least advanced first. */
export function pendingBackfill(context: SyncContext): string[] {
	return stateKeys(context.db, 'backfill:')
		.map((key) => ({ key, state: readState<BackfillState>(context.db, key) }))
		.filter(({ state }) => !state?.stopReason)
		.toSorted((a, b) => (a.state?.pages ?? 0) - (b.state?.pages ?? 0))
		.map(({ key }) => key);
}

/**
 * Runs one page for up to `pool.size` chats at once, passing over Square
 * targets whose history slot is busy; returns how many chats it advanced.
 * Each chosen step takes its slot before its first await, so no other job
 * can take it in between.
 */
export async function backfillRound(context: SyncContext, pool: Pool): Promise<number> {
	const now = context.now();
	const keys = pendingBackfill(context)
		.filter((key) => {
			const square = /^backfill:square:(.+)$/s.exec(key);
			return !square || historySlotFree(context.db, parseTargetPath(square[1]!), now);
		})
		.slice(0, pool.size);
	await Promise.all(keys.map((key) => backfillStep(context, pool, key)));
	return keys.length;
}

export interface DiscoveredChat {
	service: Service;
	chatId: string;
	lastActivityAt?: number;
}

function chatType(midType: unknown, chatId: string): string {
	const name = enumName(enums.MIDType, midType);
	if (name) return name.toLowerCase();
	return chatId.startsWith('c') ? 'group' : chatId.startsWith('r') ? 'room' : 'user';
}

/**
 * Talk discovery: `getMessageBoxes` (every page) unioned with the member
 * chats of `getAllChatMids`, named through `getChats` and `getContactsV2`.
 * New chats get a backfill cursor. Square discovery is the Square loop's sweep.
 */
export async function discoverChats(context: SyncContext, pool: Pool): Promise<DiscoveredChat[]> {
	const { base, db } = context;
	const chats = new Map<string, { type: string; lastActivityAt?: number }>();
	let minChatId: string | undefined;
	for (let page = 0; page < 100; page++) {
		const list = await pool.run(() =>
			base.talk.getMessageBoxes({
				messageBoxListRequest: {
					minChatId,
					messageBoxCountLimit: 100,
					lastMessagesPerMessageBoxCount: 0,
					withUnreadCount: false,
					activeOnly: false,
					unreadOnly: false
				},
				syncReason: 'INTERNAL'
			})
		);
		const fresh = (list?.messageBoxes ?? []).filter((box) => box?.id && !chats.has(box.id));
		for (const box of fresh) {
			chats.set(box.id, {
				type: chatType(box.midType, box.id),
				lastActivityAt: millis(box.lastDeliveredMessageId?.deliveredTime) ?? undefined
			});
		}
		if (!list?.hasNext || fresh.length === 0) break;
		minChatId = fresh.at(-1)!.id;
	}
	const mids = await pool.run(() =>
		base.talk.getAllChatMids({
			request: { withMemberChats: true, withInvitedChats: false },
			syncReason: 'INTERNAL'
		})
	);
	for (const mid of mids?.memberChatMids ?? []) {
		if (!chats.has(mid)) chats.set(mid, { type: chatType(undefined, mid) });
	}

	// Names are optional: a chunk LINE refuses keeps its chats unnamed.
	const optional = async <T>(operation: string, request: () => Promise<T>) => {
		try {
			return await pool.run(request);
		} catch (error) {
			if (isTransient(error, operation)) throw error;
			context.log({ event: 'discovery_names_skipped', ...mapError(error, operation) });
			return undefined;
		}
	};
	const names = new Map<string, { name?: string; memberCount?: number }>();
	const groups = [...chats].filter(([, chat]) => chat.type !== 'user').map(([id]) => id);
	for (let index = 0; index < groups.length; index += 50) {
		const chunk = groups.slice(index, index + 50);
		const response = await optional('getChats', () =>
			base.talk.getChats({ chatMids: chunk, withMembers: true, withInvitees: false })
		);
		for (const chat of response?.chats ?? []) {
			const members = chat.extra?.groupExtra?.memberMids;
			names.set(chat.chatMid, {
				name: chat.chatName || undefined,
				memberCount: members ? Object.keys(members).length : undefined
			});
		}
	}
	const users = [...chats].filter(([, chat]) => chat.type === 'user').map(([id]) => id);
	const contacts = new Map<string, string>();
	for (let index = 0; index < users.length; index += 100) {
		const chunk = users.slice(index, index + 100);
		const response = await optional('getContactsV2', () =>
			base.talk.getContactsV2({ mids: chunk })
		);
		for (const [mid, entry] of Object.entries(response?.contacts ?? {})) {
			const name = entry?.contact?.displayNameOverridden || entry?.contact?.displayName;
			if (name) contacts.set(mid, name);
		}
	}

	transaction(db, () => {
		const now = context.now();
		for (const [chatId, chat] of chats) {
			const named = names.get(chatId);
			upsertChat(
				db,
				{
					service: 'talk',
					chatId,
					type: chat.type,
					name: named?.name ?? contacts.get(chatId),
					memberCount: named?.memberCount,
					lastActivityAt: chat.lastActivityAt
				},
				now
			);
			const key = backfillKey('talk', chatId);
			if (!readState(db, key)) writeState(db, key, { pages: 0 } satisfies BackfillState, now);
		}
		for (const [mid, name] of contacts) upsertParticipant(db, 'talk', mid, name, now);
	});
	return [...chats].map(([chatId, chat]) => ({
		service: 'talk' as const,
		chatId,
		lastActivityAt: chat.lastActivityAt
	}));
}
