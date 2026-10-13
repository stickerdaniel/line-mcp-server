import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseClient } from '@evex/linejs/base';
import type { FetchSquareChatEventsResponse, SquareEvent } from '@evex/linejs-types';
import {
	addSquareSelfMember,
	closeGap,
	deleteState,
	listGaps,
	openGap,
	readState,
	squareSyncedAtKey,
	stateKeys,
	upsertChat,
	writeState
} from '../archive.ts';
import { transaction } from '../db.ts';
import { mapError } from '../errors.ts';
import { decimal } from '../probe.ts';
import { fetchMyEvents, fetchSquareChatEvents, listJoinedSquareChats } from '../square.ts';
import type { BackfillState } from './backfill.ts';
import {
	backoffMs,
	historyStepMs,
	isTransient,
	type LoopOptions,
	minIdleMs,
	runLoop,
	type SyncContext
} from './loop.ts';
import {
	applyChanges,
	int64,
	messageBoundary,
	normalizeSquareEvents,
	type SquareTarget
} from './normalize.ts';

/**
 * What a chain of pages remembers to tell progress from a repeat: Brent's
 * cycle state over the tokens it follows and over its page hashes.
 */
export interface ChainMemory {
	cycle?: TokenCycle;
	content?: TokenCycle;
}

/**
 * Every paging field LINE returns, persisted in the same transaction as the
 * events of the page. `subscriptionId` is a decimal string.
 */
export interface SquarePaging extends ChainMemory {
	syncToken?: string;
	continuationToken?: string;
	subscriptionId?: string;
	/** An open coverage gap this chat's next initial fetch reconciles. */
	gapId?: number;
	/**
	 * Trusted boundary (see `messageBoundary`) of the committed `syncToken`, or
	 * of the open gap while `gapId` is set. Absent means unknown: nothing is
	 * trusted.
	 */
	boundary?: number;
	/**
	 * While a chain pages on: the boundary taken before its first page. A
	 * finished chain gives its `syncToken` this boundary, since what LINE's
	 * token covers beyond the chain's start is not established.
	 */
	chainStart?: number;
}

/**
 * Brent's cycle detection over one sequence of a chain: the tokens it follows
 * (continuation tokens forward, `syncToken`s backward) or its page hashes. A
 * value equal to the checkpoint closes a cycle; the checkpoint moves to the
 * newest value after `power` steps and `power` doubles. Constant memory finds
 * a cycle of any length within a small multiple of its length plus its lead-in.
 */
export interface TokenCycle {
	checkpoint: string;
	power: number;
	steps: number;
}

/** `fetchMyEvents` paging, plus what it needs to notice a token cycle. */
export interface MyEventsPaging extends SquarePaging {
	/** Pages followed at once since the last wait. */
	followed?: number;
	/** Stalls in a row; each one waits longer. */
	stalls?: number;
}

/** The next cycle state for `token`, or `'cycle'` when `token` repeats the chain. */
export function advanceCycle(cycle: TokenCycle | undefined, token: string): TokenCycle | 'cycle' {
	if (!cycle) return { checkpoint: token, power: 1, steps: 0 };
	if (token === cycle.checkpoint) return 'cycle';
	const steps = cycle.steps + 1;
	return steps >= cycle.power
		? { checkpoint: token, power: cycle.power * 2, steps: 0 }
		: { ...cycle, steps };
}

/** Object keys in sorted order, so a Thrift map's wire order does not count. */
function canonical(_: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	);
}

/**
 * A stable hash over everything a page's events carry: types, times, request
 * sequences and payloads, so two edits of one message, or two read marks at
 * different stream positions, differ. The same page served again hashes the
 * same, whatever token came with it and in whatever order its maps arrive.
 */
export function pageHash(events: SquareEvent[]): string {
	const content = JSON.stringify(events, canonical);
	return createHash('sha256').update(content).digest('base64url').slice(0, 22);
}

/**
 * One page of a chain that `token` leads on from. `'stalled'` when the tokens
 * or the page hashes close a cycle: LINE embeds a timestamp in its tokens, so
 * a page, or a rotation of pages, served again under fresh tokens only shows
 * in the content. An empty page has no content to compare: only its token
 * counts. Otherwise the chain's memory after the page.
 */
export function advanceChain(
	memory: ChainMemory | undefined,
	token: string,
	events: SquareEvent[]
): ChainMemory | 'stalled' {
	const cycle = advanceCycle(memory?.cycle, token);
	if (cycle === 'cycle') return 'stalled';
	if (events.length === 0) {
		return { cycle, ...(memory?.content ? { content: memory.content } : {}) };
	}
	const content = advanceCycle(memory?.content, pageHash(events));
	if (content === 'cycle') return 'stalled';
	return { cycle, content };
}

/**
 * Older pages a reset chat or thread still has to fetch, paged backward from
 * `syncToken` until a page holds a message archived before the gap, an empty
 * page marks the start of history, the chain stops progressing, or the page
 * budget ends.
 */
export interface SquareReconcile extends ChainMemory {
	gapId: number;
	boundary: number;
	syncToken: string;
	pages: number;
}

export const myEventsKey = 'square:my';
const pendingKey = 'square:pending';
const historyAtPrefix = 'square:historyAt:';
const sweptAtKey = 'square:sweptAt';
const reconcilePrefix = 'reconcile:square:';
/** Older pages one reset chat may fetch before its gap is closed as incomplete. */
export const reconcilePageLimit = 10;
/**
 * Pages followed without a wait; then the loop waits `minIdleMs` and goes on
 * with the same continuation token.
 */
export const followLimit = 20;

export function targetKey(target: SquareTarget): string {
	return target.thread
		? `square:thread:${target.chat}:${target.thread}`
		: `square:chat:${target.chat}`;
}

/** A chat or thread as one key segment: `<chat>` or `<chat>:<thread>`. */
function targetPath(target: SquareTarget): string {
	return target.thread ? `${target.chat}:${target.thread}` : target.chat;
}

/** The target a `targetPath` segment names. */
export function parseTargetPath(path: string): SquareTarget {
	const [chat = '', thread] = path.split(':');
	return thread ? { chat, thread } : { chat };
}

export function reconcileKey(target: SquareTarget): string {
	return `${reconcilePrefix}${targetPath(target)}`;
}

export function squareBackfillKey(target: SquareTarget): string {
	return `backfill:square:${targetPath(target)}`;
}

/** Whether a chat's or thread's next history request may start now. */
export function historySlotFree(db: DatabaseSync, target: SquareTarget, now: number): boolean {
	const due = readState<number>(db, `${historyAtPrefix}${targetPath(target)}`);
	return due === undefined || now >= due;
}

/**
 * Takes a chat's or thread's next history request (backfill or
 * reconciliation): false while the last one, failed or not, is less than
 * `historyStepMs` ago. Taking it moves the next one on before the request is
 * sent, so neither the other job nor a retry after a failure comes sooner.
 */
export function takeHistorySlot(db: DatabaseSync, target: SquareTarget, now: number): boolean {
	if (!historySlotFree(db, target, now)) return false;
	writeState(db, `${historyAtPrefix}${targetPath(target)}`, now + historyStepMs, now);
	return true;
}

function gapScope(target: SquareTarget): string {
	return target.thread ? `thread:${target.chat}:${target.thread}` : `chat:${target.chat}`;
}

/**
 * One older page of a chat or thread. LINE pages history backward only from
 * a `syncToken` with `direction: BACKWARD`; each response's `syncToken` leads
 * to the next older page, and an empty page marks the start of history.
 * Without the direction, a continuation token serves the newest page again
 * under a fresh token; with it, a continuation token returns nothing.
 */
export async function fetchOlderPage(
	base: BaseClient,
	target: SquareTarget,
	syncToken: string
): Promise<FetchSquareChatEventsResponse> {
	return await fetchSquareChatEvents(base, {
		squareChatMid: target.chat,
		...(target.thread ? { threadMid: target.thread } : {}),
		direction: 'BACKWARD',
		syncToken
	});
}

/**
 * A history chain (backfill) that stopped short of the start of history: a
 * gap closed as incomplete, so it stays visible without holding health back.
 */
export function recordStalledHistory(
	db: DatabaseSync,
	target: SquareTarget,
	detail: Record<string, unknown>,
	now: number
): void {
	const id = openGap(
		db,
		{ service: 'square', scope: gapScope(target), reason: 'history_stalled', detail },
		{ now }
	);
	closeGap(db, id, 'incomplete', {}, now);
}

/** The boundary a gap recorded when it opened; an open gap that is reused keeps its own. */
function gapBoundary(db: DatabaseSync, gapId: number): number {
	const row = db
		.prepare(`SELECT json_extract(detail, '$.boundary') AS boundary FROM coverage_gap WHERE id = ?`)
		.get(gapId);
	return typeof row?.boundary === 'number' ? row.boundary : 0;
}

export function readPending(db: DatabaseSync): SquareTarget[] {
	return readState<SquareTarget[]>(db, pendingKey) ?? [];
}

/** Targets to fetch completely; kept in the archive so a restart still fetches them. */
export function addPending(db: DatabaseSync, targets: SquareTarget[]): void {
	if (targets.length === 0) return;
	const pending = readPending(db);
	const known = new Set(pending.map(targetKey));
	for (const target of targets) {
		if (!known.has(targetKey(target))) {
			pending.push(target);
			known.add(targetKey(target));
		}
	}
	writeState(db, pendingKey, pending);
}

function removePending(db: DatabaseSync, target: SquareTarget): void {
	const key = targetKey(target);
	writeState(
		db,
		pendingKey,
		readPending(db).filter((entry) => targetKey(entry) !== key)
	);
}

function nonEmpty(value: string | undefined | null): string | undefined {
	return value ? value : undefined;
}

function subscriptionOf(response: { subscription?: { subscriptionId?: unknown } }) {
	const id = response.subscription?.subscriptionId;
	return typeof id === 'number' || typeof id === 'bigint' ? decimal(id) : undefined;
}

export interface SquareOptions {
	/** Wait after a page with nothing more to fetch. */
	idleMs?: number;
	/** How often every joined chat is fetched, notified or not. */
	sweepIntervalMs?: number;
	/** Pages per chat or thread in one step; the rest continues in the next step. */
	maxPages?: number;
	/** Chats or threads drained per step, so `fetchMyEvents` stays responsive. */
	maxTargets?: number;
}

const defaults: Required<SquareOptions> = {
	idleMs: 3000,
	sweepIntervalMs: 10 * 60 * 1000,
	maxPages: 20,
	maxTargets: 5
};

/**
 * Lists joined chats (Square discovery) and queues every one for a full fetch.
 * Never `SquareChat.listen()`: it drops the initial pages
 * (client/features/square/mod.ts:213-226).
 */
export async function sweepSquareChats(context: SyncContext): Promise<void> {
	const joined = await listJoinedSquareChats(context.base);
	transaction(context.db, () => {
		const now = context.now();
		for (const { chat, selfMemberId } of joined.chats) {
			upsertChat(
				context.db,
				{
					service: 'square',
					chatId: chat.squareChatMid,
					type: 'square',
					name: chat.name || undefined
				},
				now
			);
			if (selfMemberId) addSquareSelfMember(context.db, chat.squareChatMid, selfMemberId, now);
		}
		addPending(
			context.db,
			joined.chats.map(({ chat }) => ({ chat: chat.squareChatMid }))
		);
		if (joined.stalled) {
			openGap(
				context.db,
				{ service: 'square', scope: 'joined_chats', reason: 'token_stalled', detail: {} },
				{ dedupe: true, now }
			);
		}
		// A joined square with no confirmed chat is not mirrored. Its gap stays
		// open until a complete sweep confirms a chat in it or no longer lists it.
		const uncovered = new Set(joined.uncoveredSquares.map((square) => `square:${square.mid}`));
		for (const square of uncovered) {
			openGap(
				context.db,
				{ service: 'square', scope: square, reason: 'uncovered_square', detail: {} },
				{ dedupe: true, now }
			);
		}
		for (const gap of listGaps(context.db, { service: 'square', status: 'open' })) {
			if (gap.reason === 'uncovered_square' && !joined.stalled && !uncovered.has(gap.scope)) {
				closeGap(context.db, gap.id, 'reconciled', {}, now);
			}
		}
		writeState(context.db, sweptAtKey, now, now);
	});
}

/**
 * Fetches one chat or thread forward, page by page. Each page's events and
 * paging state commit together. A first fetch keeps its events (the newest
 * page is never dropped) and hands its `syncToken` to the target's backfill,
 * which pages older history backward. Later fetches page forward from the
 * stored `syncToken`, passing each response's tokens on, until an empty page
 * or one without a continuation token. A page that repeats its chain (a cycle
 * of tokens or of page contents) ends the drain with a coverage
 * gap instead of looping; the target then starts over from a first fetch, and
 * the gap stays open until that fetch, or the older pages it leads to, meets
 * history archived before the gap. Returns whether the target is drained.
 */
export async function drainTarget(
	context: SyncContext,
	target: SquareTarget,
	maxPages = defaults.maxPages
): Promise<boolean> {
	const { db } = context;
	const key = targetKey(target);
	let state = readState<SquarePaging>(db, key) ?? {};
	for (let page = 0; page < maxPages; page++) {
		const initial = !state.syncToken;
		const reconciling = state.gapId !== undefined;
		// What anchors here: the boundary of the position this chain started
		// from, or of the open gap; nothing when it is unknown. Earlier pages of
		// this chain never count.
		const trusted = state.boundary ?? 0;
		// Fixed before a chain's first request: rows other workers commit later are not covered by it.
		const chainStart = state.continuationToken ? (state.chainStart ?? 0) : messageBoundary(db);
		const response = await fetchSquareChatEvents(context.base, {
			squareChatMid: target.chat,
			...(target.thread ? { threadMid: target.thread } : {}),
			...(state.syncToken ? { syncToken: state.syncToken } : {}),
			...(state.continuationToken ? { continuationToken: state.continuationToken } : {}),
			...(state.subscriptionId ? { subscriptionId: int64(state.subscriptionId) } : {})
		});
		const events = response.events ?? [];
		const syncToken = nonEmpty(response.syncToken);
		// A first page is the newest one; its continuation token only serves that
		// page again. Forward, an empty page means caught up.
		const token = initial || events.length === 0 ? undefined : nonEmpty(response.continuationToken);
		const chain =
			token === undefined
				? undefined
				: advanceChain(state.continuationToken ? state : undefined, token, events);
		const stalled = chain === 'stalled';
		const batch = await normalizeSquareEvents(context, events, target.thread);
		const next: SquarePaging = {
			syncToken: syncToken ?? state.syncToken,
			subscriptionId: subscriptionOf(response) ?? state.subscriptionId
		};
		if (chain && chain !== 'stalled') {
			Object.assign(next, { continuationToken: token, ...chain, chainStart });
		}
		const done = next.continuationToken === undefined;
		// A finished chain covers at least what existed when it started.
		next.boundary = done ? chainStart : trusted;
		transaction(db, () => {
			const now = context.now();
			const { known } = applyChanges(db, batch.changes, { now, boundary: trusted });
			addPending(
				db,
				batch.targets.filter((found) => targetKey(found) !== key)
			);
			if (initial) {
				const backfill = squareBackfillKey(target);
				if (!readState(db, backfill)) {
					writeState(
						db,
						backfill,
						(events.length > 0 && syncToken
							? { pages: 0, syncToken }
							: { pages: 0, stopReason: 'complete' }) satisfies BackfillState,
						now
					);
				}
			}
			if (reconciling && !stalled) {
				if (known > 0 || (initial && events.length === 0)) {
					// Met pre-gap history, or the target has no events at all.
					closeGap(db, state.gapId!, 'reconciled', { known }, now);
				} else if (syncToken) {
					// Older pages are reconciliation work of their own, whatever the
					// target's backfill already did.
					writeState(
						db,
						reconcileKey(target),
						{
							gapId: state.gapId!,
							boundary: trusted,
							syncToken,
							pages: 0
						} satisfies SquareReconcile,
						now
					);
				} else {
					closeGap(db, state.gapId!, 'incomplete', { stop: 'no_token' }, now);
				}
			}
			if (stalled) {
				// Start this target over from a fresh first fetch. The gap takes the
				// chain's trusted boundary; a stall during reconciliation reuses the gap's.
				const gapId = openGap(
					db,
					{
						service: 'square',
						scope: gapScope(target),
						reason: 'token_stalled',
						detail: { page, boundary: trusted }
					},
					{ dedupe: true, now }
				);
				writeState(
					db,
					key,
					{ subscriptionId: next.subscriptionId, gapId, boundary: gapBoundary(db, gapId) },
					now
				);
			} else {
				writeState(db, key, next, now);
			}
			if (done) removePending(db, target);
		});
		if (done) return true;
		state = next;
	}
	return false;
}

/**
 * One older page of a reset chat's or thread's reconciliation, committed with
 * its events, once the target's history slot is free (`takeHistorySlot`).
 * Returns whether work remains.
 */
export async function reconcileSquareStep(context: SyncContext, key: string): Promise<boolean> {
	const { db } = context;
	const work = readState<SquareReconcile>(db, key);
	if (!work) return false;
	const target = parseTargetPath(key.slice(reconcilePrefix.length));
	if (!takeHistorySlot(db, target, context.now())) return true;
	const finish = (status: 'reconciled' | 'incomplete', detail: Record<string, unknown>) => {
		closeGap(db, work.gapId, status, detail, context.now());
		deleteState(db, key);
	};
	let response;
	try {
		response = await fetchOlderPage(context.base, target, work.syncToken);
	} catch (error) {
		if (isTransient(error, 'reconcile')) throw error;
		transaction(db, () =>
			finish('incomplete', {
				pages: work.pages,
				stop: `upstream:${mapError(error, 'reconcile').code}`
			})
		);
		return false;
	}
	const events = response.events ?? [];
	const syncToken = nonEmpty(response.syncToken);
	const chain =
		events.length === 0 || !syncToken ? undefined : advanceChain(work, syncToken, events);
	const batch = await normalizeSquareEvents(context, events, target.thread);
	return transaction(db, () => {
		const now = context.now();
		const { known } = applyChanges(db, batch.changes, { now, boundary: work.boundary });
		addPending(
			db,
			batch.targets.filter((found) => found.thread && targetKey(found) !== targetKey(target))
		);
		const pages = work.pages + 1;
		if (known > 0 || events.length === 0) {
			// Met pre-gap history, or reached the start of history.
			finish('reconciled', { known, pages });
			return false;
		}
		if (!chain || chain === 'stalled' || pages >= reconcilePageLimit) {
			const stop = !chain ? 'no_token' : chain === 'stalled' ? 'no_progress' : 'page_limit';
			finish('incomplete', { pages, stop });
			return false;
		}
		writeState(
			db,
			key,
			{ ...work, ...chain, syncToken: syncToken!, pages } satisfies SquareReconcile,
			now
		);
		return true;
	});
}

/**
 * One Square step: a periodic sweep of joined chats, one `fetchMyEvents` page
 * (its tokens and subscription persisted with its events), then complete
 * fetches of up to `maxTargets` chats or threads that had activity, then one
 * older page each for up to `maxTargets` reset chats or threads. Returns the
 * wait before the next step.
 */
export async function syncSquareOnce(
	context: SyncContext,
	options: SquareOptions = {}
): Promise<number> {
	const settings = { ...defaults, ...options };
	const { db } = context;
	const sweptAt = readState<number>(db, sweptAtKey) ?? 0;
	if (context.now() - sweptAt >= settings.sweepIntervalMs) await sweepSquareChats(context);

	const state = readState<MyEventsPaging>(db, myEventsKey) ?? {};
	const response = await fetchMyEvents(context.base, {
		...(state.syncToken ? { syncToken: state.syncToken } : {}),
		...(state.continuationToken ? { continuationToken: state.continuationToken } : {}),
		...(state.subscriptionId ? { subscriptionId: int64(state.subscriptionId) } : {})
	});
	const events = response.events ?? [];
	const token = nonEmpty(response.continuationToken);
	// A page that promises more but closes a cycle of tokens or of page
	// contents (A, B, A, or A, A) is no progress; a chain that keeps moving is
	// followed to its end.
	const chain =
		token === undefined
			? undefined
			: advanceChain(state.continuationToken ? state : undefined, token, events);
	const stalled = chain === 'stalled';
	const batch = await normalizeSquareEvents(context, events);
	// Only a page that delivered events and promises more is followed at once,
	// and only `followLimit` times in a row; then the chain yields for a wait.
	const follow = chain !== undefined && !stalled && events.length > 0;
	const followed = follow ? (state.followed ?? 0) + 1 : 0;
	const stalls = stalled ? (state.stalls ?? 0) + 1 : token ? (state.stalls ?? 0) : 0;
	const next: MyEventsPaging = {
		syncToken: nonEmpty(response.syncToken) ?? state.syncToken,
		subscriptionId: subscriptionOf(response) ?? state.subscriptionId,
		...(chain && chain !== 'stalled' ? { continuationToken: token, ...chain } : {}),
		...(followed > 0 && followed < followLimit ? { followed } : {}),
		...(stalls > 0 ? { stalls } : {})
	};
	transaction(db, () => {
		const now = context.now();
		applyChanges(db, batch.changes, { now });
		addPending(db, batch.targets);
		if (stalled) {
			// The rest of the chain is lost. Per-chat sync tokens do not depend on
			// this stream, so every known chat and thread is fetched again; a
			// thread announced only on the lost pages stays unknown, so the gap
			// ends `incomplete`, never `reconciled`.
			openGap(
				db,
				{ service: 'square', scope: 'my_events', reason: 'token_stalled', detail: {} },
				{ dedupe: true, now }
			);
			const known = db
				.prepare(
					`SELECT chat_id, NULL AS thread_id FROM chat WHERE service = 'square'
					UNION SELECT DISTINCT chat_id, thread_id FROM message
					WHERE service = 'square' AND thread_id IS NOT NULL`
				)
				.all();
			addPending(
				db,
				known.map((row) =>
					row.thread_id === null
						? { chat: String(row.chat_id) }
						: { chat: String(row.chat_id), thread: String(row.thread_id) }
				)
			);
		}
		writeState(db, myEventsKey, next, now);
		writeState(db, squareSyncedAtKey, now, now);
	});

	// Re-read each time: a drained chat can queue the threads it announced.
	const drained = new Set<string>();
	for (let count = 0; count < settings.maxTargets; count++) {
		const target = readPending(db).find((entry) => !drained.has(targetKey(entry)));
		if (!target) break;
		drained.add(targetKey(target));
		try {
			await drainTarget(context, target, settings.maxPages);
		} catch (error) {
			if (isTransient(error, 'fetchSquareChatEvents')) throw error;
			// A chat that LINE refuses (left, deleted, forbidden) must not hold
			// up the others: it leaves the queue with a visible gap.
			const { code } = mapError(error, 'fetchSquareChatEvents');
			transaction(db, () => {
				openGap(
					db,
					{ service: 'square', scope: gapScope(target), reason: `upstream:${code}`, detail: {} },
					{ dedupe: true, now: context.now() }
				);
				removePending(db, target);
			});
		}
	}
	// At most one older page per reset target and step, within its history slot.
	for (const key of stateKeys(db, reconcilePrefix).slice(0, settings.maxTargets)) {
		await reconcileSquareStep(context, key);
	}
	const pending = readPending(db).length;
	if (pending === 0) {
		transaction(db, () => {
			for (const gap of listGaps(db, { service: 'square', status: 'open' })) {
				if (gap.scope === 'my_events') {
					closeGap(
						db,
						gap.id,
						'incomplete',
						{ refetched: 'known chats and threads' },
						context.now()
					);
				}
			}
		});
	}
	if (stalled) return Math.max(settings.idleMs, backoffMs(stalls));
	if (follow && followed < followLimit) return 0;
	const waiting = pending > 0 || stateKeys(db, reconcilePrefix).length > 0;
	return waiting || next.continuationToken ? minIdleMs : settings.idleMs;
}

export async function runSquareLoop(
	context: SyncContext,
	options: LoopOptions,
	square: SquareOptions = {}
): Promise<void> {
	await runLoop(() => syncSquareOnce(context, square), options);
}
