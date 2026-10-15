import { InternalError } from '@evex/linejs/base';
import type { SquareEvent } from '@evex/linejs-types';
import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { listGaps, openGap, readState, writeState } from '../src/archive.ts';
import { transaction } from '../src/db.ts';
import { type BackfillState, backfillRound, backfillStep } from '../src/sync/backfill.ts';
import { historyStepMs, Pool } from '../src/sync/loop.ts';
import { applyChanges, messageBoundary, normalizeSquareEvents } from '../src/sync/normalize.ts';
import {
	drainTarget,
	myEventsKey,
	readPending,
	reconcileKey,
	reconcilePageLimit,
	reconcileSquareStep,
	type SquarePaging,
	syncSquareOnce,
	takeHistorySlot,
	targetKey
} from '../src/sync/square.ts';
import { type Handler, talkError } from './fake-line.ts';
import { chatMessages } from './stored.ts';
import { field, squareChat, squareDiscovery, squareEvent, syncFixture } from './sync-fixture.ts';

// FetchSquareChatEventsRequest fields: subscriptionId 1, squareChatMid 2,
// syncToken 3, direction 5 (BACKWARD is 2), continuationToken 7, threadMid 9.
const request = (value: NestedArray) => ({
	subscriptionId: field(value, 1, 1),
	syncToken: field(value, 1, 3),
	continuationToken: field(value, 1, 7),
	threadMid: field(value, 1, 9),
	...(field(value, 1, 5) === 2 ? { backward: true } : {})
});

const texts = (fixture: Awaited<ReturnType<typeof syncFixture>>, threadId?: string) =>
	chatMessages(fixture.session.db, 'square', squareChat)
		.filter((m) => threadId === undefined || m.threadId === threadId)
		.map((m) => m.text)
		.toSorted();

const discovery = squareDiscovery([squareChat]);

/** Discovery finds `squareChat`; the account's own event stream has nothing new. */
const noMyEvents: Record<string, Handler> = {
	...discovery.handlers,
	fetchMyEvents: () => ({ events: discovery.events, syncToken: 'my-1' })
};

let tick = 1_900_000_000_000;
/** A context whose clock moves on by `historyStepMs` on every read: each history slot is free. */
const later = (fixture: Awaited<ReturnType<typeof syncFixture>>) => ({
	...fixture.context,
	now: () => (tick += historyStepMs)
});

/** Without the periodic discovery sweep, which pages `fetchMyEvents` on its own. */
const noSweep = { sweepIntervalMs: Number.POSITIVE_INFINITY };

/** Archives Square events the way another writer (backfill, an earlier fetch) would. */
async function archiveSquare(
	fixture: Awaited<ReturnType<typeof syncFixture>>,
	...events: SquareEvent[]
) {
	const batch = await normalizeSquareEvents(fixture.context, events);
	transaction(fixture.session.db, () => applyChanges(fixture.session.db, batch.changes));
}

/** A reply in `thread` as `fetchMyEvents` announces it. */
function threadMessage(thread: string, text: string): SquareEvent {
	const reply = squareEvent('tail', text, { threadMid: thread });
	const { receiveMessage } = reply.payload as unknown as {
		receiveMessage: { squareMessage: unknown };
	};
	return {
		type: 'NOTIFICATION_THREAD_MESSAGE',
		createdTime: 1_800_000_002_000,
		payload: {
			notificationThreadMessage: {
				chatMid: squareChat,
				threadMid: thread,
				squareMessage: receiveMessage.squareMessage
			}
		}
	} as unknown as SquareEvent;
}

/** An edit of message `edited`: each one has its own time and request sequence. */
function edit(time: number, text: string): SquareEvent {
	const event = squareEvent('edited', text);
	const { receiveMessage } = event.payload as unknown as { receiveMessage: object };
	return {
		type: 'MUTATE_MESSAGE',
		createdTime: time,
		payload: { mutateMessage: { ...receiveMessage, reqSeq: time - 1_800_000_000_000 } }
	} as unknown as SquareEvent;
}

/** A page of read marks with time 0 and one payload, told apart only by their stream position. */
function readMarks(page: number): SquareEvent[] {
	return Array.from(
		{ length: 100 },
		(_, index) =>
			({
				type: 'NOTIFIED_MARK_AS_READ',
				createdTime: 0,
				syncToken: `event-${page}-${index}`,
				payload: {
					notifiedMarkAsRead: { squareChatMid: squareChat, sMemberMid: 'p1', messageId: '100' }
				}
			}) as unknown as SquareEvent
	);
}

/** Three sticker messages; `reversed` sends each one's metadata map in the other order. */
function stickerPage(reversed: boolean): SquareEvent[] {
	return Array.from({ length: 3 }, (_, index) => {
		const event = squareEvent(`k${index}`, 'sticker');
		const { receiveMessage } = event.payload as unknown as {
			receiveMessage: { squareMessage: { message: { contentMetadata: object } } };
		};
		receiveMessage.squareMessage.message.contentMetadata = reversed
			? { STKPKGID: '2', STKID: '1' }
			: { STKID: '1', STKPKGID: '2' };
		return event;
	});
}

/** A chat whose forward chain stalls once; `older` answers each BACKWARD page. */
async function stalledChat(
	older: (syncToken: string) => { events: SquareEvent[]; syncToken: string }
) {
	let repeats = 0;
	const requests: ReturnType<typeof request>[] = [];
	const fixture = await syncFixture({
		...noMyEvents,
		fetchSquareChatEvents: (value) => {
			const sent = request(value);
			requests.push(sent);
			if (sent.backward) return older(String(sent.syncToken));
			if (sent.syncToken === 'sync-0') {
				return {
					events: [squareEvent('s0', 'repeated')],
					syncToken: 'sync-0',
					continuationToken: `again-${++repeats}`
				};
			}
			if (sent.syncToken) return { events: [], syncToken: sent.syncToken };
			return { events: [squareEvent('n0', 'newest')], syncToken: 'b0' };
		}
	});
	writeState(fixture.session.db, targetKey({ chat: squareChat }), { syncToken: 'sync-0' });
	await drainTarget(fixture.context, { chat: squareChat });
	return { fixture, requests };
}

describe('Square chat events', () => {
	it('keeps the events of the first page of a chat', async () => {
		const fixture = await syncFixture({
			...noMyEvents,
			fetchSquareChatEvents: () => ({
				events: [squareEvent('s1', 'first page one'), squareEvent('s2', 'first page two')],
				syncToken: 'sync-1'
			})
		});

		await syncSquareOnce(fixture.context);

		expect(texts(fixture)).toEqual(['first page one', 'first page two']);
		expect(readPending(fixture.session.db)).toEqual([]);
	});

	it('persists the continuation token with its page so a restart continues from it', async () => {
		const seen: ReturnType<typeof request>[] = [];
		let pages = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				seen.push(request(value));
				pages++;
				if (pages === 2) throw new TypeError('fetch failed');
				return {
					events: [squareEvent(`p${pages}`, `page ${pages}`)],
					syncToken: `sync-${pages}`,
					continuationToken: pages === 1 ? 'continue-1' : undefined,
					subscription: { subscriptionId: 1_234_567_890_123_456_789n }
				};
			}
		});
		const { db } = fixture.session;
		writeState(db, targetKey({ chat: squareChat }), { syncToken: 'sync-0' });

		await expect(drainTarget(fixture.context, { chat: squareChat })).rejects.toThrow();

		expect(readState<SquarePaging>(db, targetKey({ chat: squareChat }))).toMatchObject({
			syncToken: 'sync-1',
			continuationToken: 'continue-1',
			subscriptionId: '1234567890123456789'
		});
		expect(texts(fixture)).toEqual(['page 1']);

		await drainTarget(fixture.context, { chat: squareChat });

		expect(seen.at(-1)).toEqual({
			subscriptionId: 1_234_567_890_123_456_789n,
			syncToken: 'sync-1',
			continuationToken: 'continue-1',
			threadMid: undefined
		});
		expect(texts(fixture)).toEqual(['page 1', 'page 3']);
	});

	it('stops a forward chain that serves the same page under a fresh token and records a gap', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				if (++calls > 20) throw new Error('kept paging a repeating page');
				// LINE embeds a timestamp in its tokens: the bytes differ on every call.
				return {
					events: [squareEvent('s1', 'the same page')],
					syncToken: 'sync-1',
					continuationToken: `token-${calls}`
				};
			}
		});
		writeState(fixture.session.db, targetKey({ chat: squareChat }), { syncToken: 'sync-0' });

		await drainTarget(fixture.context, { chat: squareChat });

		expect(calls).toBe(2);
		expect(listGaps(fixture.session.db)).toMatchObject([
			{ service: 'square', scope: `chat:${squareChat}`, reason: 'token_stalled', status: 'open' }
		]);
	});

	it('stops a forward chain whose continuation token repeats and records a gap', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				if (++calls > 20) throw new Error('kept paging a stalled token');
				return {
					events: [squareEvent(`s${calls}`, 'new each time')],
					syncToken: 'sync-1',
					continuationToken: 'stuck'
				};
			}
		});
		writeState(fixture.session.db, targetKey({ chat: squareChat }), { syncToken: 'sync-0' });

		await drainTarget(fixture.context, { chat: squareChat });

		expect(calls).toBe(2);
		expect(listGaps(fixture.session.db)).toMatchObject([
			{ reason: 'token_stalled', status: 'open' }
		]);
	});

	it('ends a forward chain at the empty page that follows the newest events', async () => {
		const seen: ReturnType<typeof request>[] = [];
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				seen.push(request(value));
				if (seen.length > 5) throw new Error('kept paging after catching up');
				return seen.length === 1
					? {
							events: [squareEvent('s1', 'read marks and messages')],
							syncToken: 'sync-1',
							continuationToken: 'more-1'
						}
					: { events: [], syncToken: 'sync-2', continuationToken: `more-${seen.length}` };
			}
		});
		const { db } = fixture.session;
		writeState(db, targetKey({ chat: squareChat }), { syncToken: 'sync-0' });

		await drainTarget(fixture.context, { chat: squareChat });

		expect(seen.map(({ syncToken, continuationToken }) => [syncToken, continuationToken])).toEqual([
			['sync-0', undefined],
			['sync-1', 'more-1']
		]);
		expect(readState<SquarePaging>(db, targetKey({ chat: squareChat }))?.syncToken).toBe('sync-2');
		expect(listGaps(db)).toEqual([]);
	});

	it('pages history backward from the first page and archives every message once', async () => {
		// Live shape: the first page holds the newest events; its continuation
		// token serves that page again under a fresh token. BACKWARD pages chain
		// through each response's syncToken and overlap the first page.
		const history = Array.from({ length: 35 }, (_, index) =>
			squareEvent(`h${String(index + 1).padStart(2, '0')}`, `message ${index + 1}`)
		);
		const readMark = {
			type: 'NOTIFIED_MARK_AS_READ',
			createdTime: 0,
			payload: { notifiedMarkAsRead: { squareChatMid: squareChat, messageId: 'h35' } }
		} as unknown as SquareEvent;
		const pages: Record<string, { events: SquareEvent[]; syncToken: string }> = {
			S0: { events: history.slice(11, 34), syncToken: 'S1' },
			S1: { events: history.slice(0, 11), syncToken: 'S2' },
			S2: { events: [], syncToken: 'S3' }
		};
		const seen: ReturnType<typeof request>[] = [];
		let calls = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				const sent = request(value);
				seen.push(sent);
				calls++;
				if (sent.backward) return pages[String(sent.syncToken)] ?? { events: [] };
				return {
					events: [...history.slice(15), readMark],
					syncToken: 'S0',
					continuationToken: `newest-again-${calls}`
				};
			}
		});
		const { db } = fixture.session;
		const key = `backfill:square:${squareChat}`;

		await drainTarget(fixture.context, { chat: squareChat });
		for (let step = 0; step < 10 && !readState<BackfillState>(db, key)?.stopReason; step++) {
			await backfillStep(later(fixture), new Pool(2), key);
		}

		expect(readState<BackfillState>(db, key)?.stopReason).toBe('complete');
		expect(
			chatMessages(db, 'square', squareChat)
				.map((m) => m.messageId)
				.toSorted()
		).toEqual(history.map((_, index) => `h${String(index + 1).padStart(2, '0')}`));
		expect(seen.filter((sent) => sent.backward).map((sent) => sent.syncToken)).toEqual([
			'S0',
			'S1',
			'S2'
		]);
		expect(seen.every((sent) => sent.continuationToken === undefined)).toBe(true);
		expect(listGaps(db)).toEqual([]);
	});

	it('stops a backfill whose older pages repeat under fresh tokens and records why', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				calls++;
				return { events: [squareEvent('h1', 'the same old page')], syncToken: `S${calls}` };
			}
		});
		const { db } = fixture.session;
		const key = `backfill:square:${squareChat}`;
		writeState(db, key, { pages: 0, syncToken: 'S0' });

		for (let step = 0; step < 10 && !readState<BackfillState>(db, key)?.stopReason; step++) {
			await backfillStep(later(fixture), new Pool(2), key);
		}

		expect(calls).toBe(2);
		expect(readState<BackfillState>(db, key)).toMatchObject({ stopReason: 'no_progress' });
		expect(listGaps(db)).toMatchObject([
			{ scope: `chat:${squareChat}`, reason: 'history_stalled', status: 'incomplete' }
		]);
	});

	for (const shape of ['the review probe', 'cycling sync tokens'] as const) {
		it(`stops a backfill whose pages cycle through 17 tokens (${shape})`, async () => {
			let calls = 0;
			const fixture = await syncFixture({
				fetchSquareChatEvents: () => {
					const index = calls++ % 17;
					return {
						events: [squareEvent(`c${100 + index}`, 'cycling')],
						syncToken: shape === 'the review probe' ? 'live' : `sync-${index}`,
						continuationToken: `token${index}`
					};
				}
			});
			const { db } = fixture.session;
			const key = `backfill:square:${squareChat}`;

			await drainTarget(fixture.context, { chat: squareChat });
			for (let step = 0; step < 100; step++) {
				await backfillStep(later(fixture), new Pool(2), key);
			}

			expect(readState<BackfillState>(db, key)?.stopReason).toBe('no_progress');
			expect(calls).toBeLessThan(4 * 17);
			expect(listGaps(db)).toMatchObject([{ reason: 'history_stalled', status: 'incomplete' }]);
		});
	}

	it('reconciles a stalled chat through its older pages even when its backfill has finished', async () => {
		const backwardFrom: unknown[] = [];
		let repeats = 0;
		const fixture = await syncFixture({
			...noMyEvents,
			fetchSquareChatEvents: (value) => {
				const sent = request(value);
				if (sent.backward) {
					backwardFrom.push(sent.syncToken);
					if (sent.syncToken === 'S-new') {
						return {
							events: [squareEvent('s2', 'missed during the stall'), squareEvent('s1', 'before')],
							syncToken: 'S-older'
						};
					}
					throw new Error('paged past archived history');
				}
				if (sent.syncToken === 'sync-0' || sent.continuationToken) {
					return {
						events: [squareEvent('s0', 'repeated')],
						syncToken: 'sync-0',
						continuationToken: `again-${++repeats}`
					};
				}
				if (sent.syncToken) return { events: [], syncToken: sent.syncToken };
				return { events: [squareEvent('s3', 'after the stall')], syncToken: 'S-new' };
			}
		});
		const { db } = fixture.session;
		await archiveSquare(fixture, squareEvent('s1', 'before'));
		const backfill = { pages: 4, stopReason: 'complete' };
		writeState(db, `backfill:square:${squareChat}`, backfill);
		// A completed chain that started after 'before' was archived.
		writeState(db, targetKey({ chat: squareChat }), {
			syncToken: 'sync-0',
			boundary: messageBoundary(db)
		});

		await drainTarget(fixture.context, { chat: squareChat });
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'open' }]);
		// The newest message reaches the archive after the gap opened (e.g. from another page).
		await archiveSquare(fixture, squareEvent('s3', 'after the stall'));

		await syncSquareOnce(fixture.context);

		expect(backwardFrom).toEqual(['S-new']);
		expect(texts(fixture)).toEqual([
			'after the stall',
			'before',
			'missed during the stall',
			'repeated'
		]);
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'reconciled' }]);
		expect(readState(db, `backfill:square:${squareChat}`)).toEqual(backfill);
	});

	it('does not anchor a stall on a page of the stalled chain itself, across steps', async () => {
		const backwardFrom: unknown[] = [];
		const fixture = await syncFixture({
			...noMyEvents,
			fetchSquareChatEvents: (value) => {
				const sent = request(value);
				if (sent.backward) {
					backwardFrom.push(sent.syncToken);
					if (sent.syncToken === 'S-new') {
						return {
							events: [squareEvent('s2', 'missed'), squareEvent('s1', 'trusted')],
							syncToken: 'S-older'
						};
					}
					throw new Error('paged past archived history');
				}
				if (sent.syncToken === 'sync-0') {
					return {
						events: [squareEvent('s3', 'captured by the chain')],
						syncToken: 'sync-0',
						continuationToken: sent.continuationToken === 'c1' ? 'c2' : 'c1'
					};
				}
				if (sent.syncToken) return { events: [], syncToken: sent.syncToken };
				return { events: [squareEvent('s3', 'captured by the chain')], syncToken: 'S-new' };
			}
		});
		const { db } = fixture.session;
		await archiveSquare(fixture, squareEvent('s1', 'trusted'));
		writeState(db, `backfill:square:${squareChat}`, { pages: 4, stopReason: 'complete' });
		writeState(db, targetKey({ chat: squareChat }), {
			syncToken: 'sync-0',
			boundary: messageBoundary(db)
		});

		// One page per step: the chain's boundary has to survive between them.
		for (let step = 0; step < 3; step++) {
			await drainTarget(fixture.context, { chat: squareChat }, 1);
		}
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'open' }]);
		await syncSquareOnce(fixture.context);

		expect(backwardFrom).toEqual(['S-new']);
		expect(texts(fixture)).toEqual(['captured by the chain', 'missed', 'trusted']);
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'reconciled' }]);
	});

	it('trusts no archived row when a chat position has no boundary', async () => {
		const backwardFrom: unknown[] = [];
		let repeats = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				const sent = request(value);
				if (sent.backward) {
					backwardFrom.push(sent.syncToken);
					return sent.syncToken === 'fresh'
						? {
								events: [squareEvent('s2', 'missed'), squareEvent('s1', 'old')],
								syncToken: 'older'
							}
						: { events: [], syncToken: 'oldest' };
				}
				if (sent.syncToken) {
					return {
						events: [squareEvent('s50', 'repeated')],
						syncToken: sent.syncToken,
						continuationToken: `again-${++repeats}`
					};
				}
				return { events: [squareEvent('s100', 'newest')], syncToken: 'fresh' };
			}
		});
		const { db } = fixture.session;
		// Backfill archived these before any chain of this chat finished.
		await archiveSquare(fixture, squareEvent('s1', 'old'), squareEvent('s100', 'newest'));
		writeState(db, `backfill:square:${squareChat}`, { pages: 4, stopReason: 'complete' });
		writeState(db, targetKey({ chat: squareChat }), { syncToken: 'old-position' });

		await drainTarget(fixture.context, { chat: squareChat });
		await drainTarget(fixture.context, { chat: squareChat });
		await reconcileSquareStep(fixture.context, reconcileKey({ chat: squareChat }));

		expect(backwardFrom).toEqual(['fresh']);
		expect(texts(fixture)).toEqual(['missed', 'newest', 'old', 'repeated']);
	});

	it('gives a finished chain the boundary from its start, not from its last page', async () => {
		let phase = 0;
		let older = 0;
		let repeats = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				const sent = request(value);
				if (sent.backward) {
					if (sent.syncToken !== 'S100') throw new Error('paged past archived history');
					older++;
					return {
						events: [squareEvent('s50', 'missed'), squareEvent('s1', 'old')],
						syncToken: 'S-older'
					};
				}
				if (phase === 0) {
					return { events: [squareEvent('s2', 'two')], syncToken: 'S3', continuationToken: 'c1' };
				}
				if (phase === 1) return { events: [squareEvent('s3', 'three')], syncToken: 'S3' };
				if (phase === 2) {
					return {
						events: [squareEvent('s4', 'repeated')],
						syncToken: 'S4',
						continuationToken: `again-${++repeats}`
					};
				}
				return { events: [squareEvent('s100', 'newest')], syncToken: 'S100' };
			}
		});
		const { db } = fixture.session;
		await archiveSquare(fixture, squareEvent('s1', 'old'));
		writeState(db, `backfill:square:${squareChat}`, { pages: 4, stopReason: 'complete' });
		writeState(db, targetKey({ chat: squareChat }), {
			syncToken: 'S1',
			boundary: messageBoundary(db)
		});

		await drainTarget(fixture.context, { chat: squareChat }, 1);
		// Another stream archives a newer message while the chain is still paging.
		await archiveSquare(fixture, squareEvent('s100', 'newest'));
		phase = 1;
		await drainTarget(fixture.context, { chat: squareChat }, 1);
		phase = 2;
		await drainTarget(fixture.context, { chat: squareChat });
		phase = 3;
		await drainTarget(fixture.context, { chat: squareChat });
		await reconcileSquareStep(fixture.context, reconcileKey({ chat: squareChat }));

		expect(older).toBe(1);
		expect(texts(fixture)).toContain('missed');
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'reconciled' }]);
	});

	it('keeps reconciliation and backfill work when the session is lost', async () => {
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				throw new InternalError('RequestError', 'auth lost', {
					errorCode: 'AUTHENTICATION_FAILURE'
				});
			}
		});
		const { db } = fixture.session;
		const gapId = openGap(db, {
			service: 'square',
			scope: `chat:${squareChat}`,
			reason: 'token_stalled',
			detail: { boundary: 0 }
		});
		const work = { gapId, boundary: 0, syncToken: 'older', pages: 2 };
		writeState(db, reconcileKey({ chat: squareChat }), work);
		const backfill = { pages: 3, syncToken: 'older-backfill' };
		writeState(db, `backfill:square:${squareChat}`, backfill);

		await expect(
			reconcileSquareStep(fixture.context, reconcileKey({ chat: squareChat }))
		).rejects.toThrow();
		await expect(
			backfillStep(later(fixture), new Pool(2), `backfill:square:${squareChat}`)
		).rejects.toThrow();

		expect(fixture.session.state()).toBe('needs_login');
		expect(readState(db, reconcileKey({ chat: squareChat }))).toEqual(work);
		expect(readState(db, `backfill:square:${squareChat}`)).toEqual(backfill);
		expect(listGaps(db)).toMatchObject([{ id: gapId, status: 'open' }]);
	});

	it('closes a stalled chat as incomplete when its older pages never reach archived history', async () => {
		let older = 0;
		const { fixture } = await stalledChat(() => {
			older++;
			return { events: [squareEvent(`o${older}`, 'older')], syncToken: `b${older}` };
		});
		const { db } = fixture.session;
		let clock = 1_800_000_000_000;
		const context = { ...fixture.context, now: () => clock };

		for (let step = 0; step < 40 && listGaps(db, { status: 'open' }).length > 0; step++) {
			await syncSquareOnce(context);
			clock += historyStepMs;
		}

		expect(older).toBe(reconcilePageLimit);
		expect(listGaps(db)).toMatchObject([
			{ reason: 'token_stalled', status: 'incomplete', detail: { stop: 'page_limit' } }
		]);
	});

	it('reconciles a stalled chat once its older pages reach the start of history', async () => {
		let older = 0;
		const { fixture } = await stalledChat(() => {
			older++;
			return older === 1
				? { events: [squareEvent('o1', 'first message of the chat')], syncToken: 'b1' }
				: { events: [], syncToken: 'b2' };
		});
		const { db } = fixture.session;
		let clock = 1_800_000_000_000;
		const context = { ...fixture.context, now: () => clock };

		for (let step = 0; step < 10 && listGaps(db, { status: 'open' }).length > 0; step++) {
			await syncSquareOnce(context);
			clock += historyStepMs;
		}

		expect(older).toBe(2);
		expect(texts(fixture)).toContain('first message of the chat');
		expect(listGaps(db)).toMatchObject([{ reason: 'token_stalled', status: 'reconciled' }]);
	});

	it('closes a stalled chat as incomplete when its older pages repeat under fresh tokens', async () => {
		let older = 0;
		const { fixture } = await stalledChat(() => {
			older++;
			return { events: [squareEvent('o1', 'the same older page')], syncToken: `b${older}` };
		});
		const { db } = fixture.session;
		let clock = 1_800_000_000_000;
		const context = { ...fixture.context, now: () => clock };

		for (let step = 0; step < 40 && listGaps(db, { status: 'open' }).length > 0; step++) {
			await syncSquareOnce(context);
			clock += historyStepMs;
		}

		expect(older).toBe(2);
		expect(listGaps(db)).toMatchObject([
			{ reason: 'token_stalled', status: 'incomplete', detail: { stop: 'no_progress' } }
		]);
	});

	it('keeps reconciliation pages of one chat at least historyStepMs apart', async () => {
		let older = 0;
		const { fixture } = await stalledChat(() => {
			older++;
			return { events: [squareEvent(`o${older}`, 'older')], syncToken: `b${older}` };
		});
		let clock = 1_800_000_000_000;
		const context = { ...fixture.context, now: () => clock };

		const waits = [];
		for (let step = 0; step < 6; step++) {
			waits.push(await syncSquareOnce(context));
			clock += 1000;
		}

		// Six steps over six seconds: pages at 0 s and 3 s only.
		expect(older).toBe(2);
		for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(1000);
	});

	it('stops a backfill that rotates through eleven full pages under fresh tokens', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				// Three real older pages, then eleven pages served round and round.
				const call = calls++;
				const page = call < 3 ? 100 + call : (call - 3) % 11;
				return {
					events: Array.from({ length: 100 }, (_, index) =>
						squareEvent(`r${page * 100 + index}`, 'rotating')
					),
					syncToken: `timestamp-bearing-${calls}`
				};
			}
		});
		const { db } = fixture.session;
		const key = `backfill:square:${squareChat}`;
		writeState(db, key, { pages: 0, syncToken: 'begin' });

		for (let step = 0; step < 120 && !readState<BackfillState>(db, key)?.stopReason; step++) {
			await backfillStep(later(fixture), new Pool(2), key);
		}

		expect(readState<BackfillState>(db, key)?.stopReason).toBe('no_progress');
		expect(calls).toBeLessThan(3 + 4 * 11);
		expect(listGaps(db)).toMatchObject([{ reason: 'history_stalled', status: 'incomplete' }]);
	});

	it('gives reconciliation and backfill of one chat a shared history slot', async () => {
		const requests: { from: unknown; at: number }[] = [];
		let clock = 1_800_000_000_000;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				const from = request(value).syncToken;
				requests.push({ from, at: clock });
				return {
					events: [squareEvent(`${String(from)}-1`, 'older')],
					syncToken: `${String(from)}-next`
				};
			}
		});
		const { db } = fixture.session;
		const context = { ...fixture.context, now: () => clock };
		const gapId = openGap(db, {
			service: 'square',
			scope: `chat:${squareChat}`,
			reason: 'token_stalled',
			detail: { boundary: 0 }
		});
		writeState(db, reconcileKey({ chat: squareChat }), {
			gapId,
			boundary: 0,
			syncToken: 'reconcile',
			pages: 0
		});
		const backfill = `backfill:square:${squareChat}`;
		writeState(db, backfill, { pages: 0, syncToken: 'backfill' });

		await reconcileSquareStep(context, reconcileKey({ chat: squareChat }));
		await backfillStep(context, new Pool(2), backfill);
		clock += historyStepMs - 1;
		await backfillStep(context, new Pool(2), backfill);
		clock += 1;
		await backfillStep(context, new Pool(2), backfill);

		expect(requests).toEqual([
			{ from: 'reconcile', at: 1_800_000_000_000 },
			{ from: 'backfill', at: 1_800_000_000_000 + historyStepMs }
		]);
	});

	it('keeps a failed history request inside the floor when it is retried', async () => {
		const requests: number[] = [];
		let clock = 1_800_000_000_000;
		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				requests.push(clock);
				if (requests.length === 1) throw new TypeError('fetch failed');
				return { events: [squareEvent('o1', 'older')], syncToken: 'next' };
			}
		});
		const { db } = fixture.session;
		const context = { ...fixture.context, now: () => clock };
		const gapId = openGap(db, {
			service: 'square',
			scope: `chat:${squareChat}`,
			reason: 'token_stalled',
			detail: { boundary: 0 }
		});
		const key = reconcileKey({ chat: squareChat });
		writeState(db, key, { gapId, boundary: 0, syncToken: 'start', pages: 0 });

		await expect(reconcileSquareStep(context, key)).rejects.toThrow();
		// The loop's own retry comes after one second.
		clock += 1000;
		await reconcileSquareStep(context, key);
		clock += historyStepMs - 1000;
		await reconcileSquareStep(context, key);

		expect(requests).toEqual([1_800_000_000_000, 1_800_000_000_000 + historyStepMs]);
		expect(listGaps(db)).toMatchObject([{ id: gapId, status: 'open' }]);
	});

	it('follows fetchMyEvents pages that edit one message twice to a thread announced after them', async () => {
		const thread = `t${'8'.repeat(32)}`;

		let threadFetches = 0;
		const fixture = await syncFixture({
			fetchMyEvents: (value) => {
				const continuation = field(value, 1, 4);
				if (!continuation) {
					return {
						events: [edit(1_800_000_001_001, 'edit 1')],
						syncToken: 'my-1',
						continuationToken: 'c1'
					};
				}
				if (continuation === 'c1') {
					return {
						events: [edit(1_800_000_001_002, 'edit 2')],
						syncToken: 'my-1',
						continuationToken: 'c2'
					};
				}
				return { events: [threadMessage(thread, 'announced after the edits')], syncToken: 'my-2' };
			},
			fetchSquareChatEvents: (value) => {
				if (request(value).threadMid === thread) threadFetches++;
				return { events: [], syncToken: 'sync-1' };
			}
		});

		for (let step = 0; step < 4; step++) await syncSquareOnce(fixture.context, noSweep);

		expect(threadFetches).toBeGreaterThan(0);
		expect(texts(fixture, thread)).toEqual(['announced after the edits']);
		expect(listGaps(fixture.session.db)).toEqual([]);
	});

	it('follows fetchMyEvents pages of read marks that differ only in their stream position', async () => {
		const thread = `t${'9'.repeat(32)}`;

		const fixture = await syncFixture({
			fetchMyEvents: (value) => {
				const continuation = field(value, 1, 4);
				if (continuation === 'read-2') {
					return { events: [threadMessage(thread, 'after the read marks')], syncToken: 'my-2' };
				}
				const page = continuation === 'read-1' ? 2 : 1;
				return { events: readMarks(page), syncToken: 'my-1', continuationToken: `read-${page}` };
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});

		for (let step = 0; step < 4; step++) await syncSquareOnce(fixture.context, noSweep);

		expect(texts(fixture, thread)).toEqual(['after the read marks']);
		expect(listGaps(fixture.session.db)).toEqual([]);
	});
	it('follows two empty fetchMyEvents pages that promise more to a thread after them', async () => {
		const thread = `t${'a'.repeat(32)}`;
		const sent: unknown[] = [];
		const fixture = await syncFixture({
			fetchMyEvents: (value) => {
				const continuation = field(value, 1, 4);
				sent.push(continuation);
				if (continuation === 'C2') {
					return { events: [threadMessage(thread, 'after two empty pages')], syncToken: 'my-2' };
				}
				return {
					events: [],
					syncToken: 'my-1',
					continuationToken: continuation === 'C1' ? 'C2' : 'C1'
				};
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});

		for (let step = 0; step < 3; step++) await syncSquareOnce(fixture.context, noSweep);

		expect(sent).toEqual([undefined, 'C1', 'C2']);
		expect(texts(fixture, thread)).toEqual(['after two empty pages']);
		expect(listGaps(fixture.session.db)).toEqual([]);
	});

	it('stops a backfill that repeats one page with its maps in another order', async () => {
		let calls = 0;

		const fixture = await syncFixture({
			fetchSquareChatEvents: () => {
				calls++;
				return { events: stickerPage(calls % 2 === 0), syncToken: `timestamp-${calls}` };
			}
		});
		const { db } = fixture.session;
		const key = `backfill:square:${squareChat}`;
		writeState(db, key, { pages: 0, syncToken: 'start' });

		for (let step = 0; step < 20 && !readState<BackfillState>(db, key)?.stopReason; step++) {
			await backfillStep(later(fixture), new Pool(2), key);
		}

		expect(calls).toBe(2);
		expect(readState<BackfillState>(db, key)?.stopReason).toBe('no_progress');
	});

	it('gives a backfill round to an eligible chat behind two whose history slot is busy', async () => {
		const chats = ['1', '2', '3'].map((digit) => `m${digit.repeat(32)}`);
		const fetched: unknown[] = [];
		const clock = 1_800_000_000_000;
		const fixture = await syncFixture({
			fetchSquareChatEvents: (value) => {
				const chat = field(value, 1, 2);
				fetched.push(chat);
				return {
					events: [squareEvent(`b${fetched.length}`, 'older', { chat: String(chat) })],
					syncToken: 'next'
				};
			}
		});
		const { db } = fixture.session;
		const context = { ...fixture.context, now: () => clock };
		for (const [index, chat] of chats.entries()) {
			// The busy chats are the least advanced, so they come first.
			writeState(db, `backfill:square:${chat}`, { pages: index < 2 ? 0 : 5, syncToken: 'start' });
		}
		takeHistorySlot(db, { chat: chats[0]! }, clock);
		takeHistorySlot(db, { chat: chats[1]! }, clock);

		const advanced = await backfillRound(context, new Pool(2));

		expect(fetched).toEqual([chats[2]]);
		expect(advanced).toBe(1);
		expect(await backfillRound(context, new Pool(2))).toBe(0);
	});
	it('detects a fetchMyEvents token cycle and waits instead of following it', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchMyEvents: () => {
				calls++;
				return {
					events: [squareEvent(`c${calls}`, 'cycling')],
					syncToken: 'my-1',
					continuationToken: calls % 2 ? 'A' : 'B'
				};
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});

		const waits = [];
		for (let step = 0; step < 4; step++) waits.push(await syncSquareOnce(fixture.context, noSweep));

		expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
		expect(waits[3]).toBeGreaterThanOrEqual(1000);
		expect(listGaps(fixture.session.db).map((gap) => [gap.scope, gap.reason])).toEqual([
			['my_events', 'token_stalled']
		]);
	});

	it('records a gap for a fetchMyEvents cycle of 17 tokens', async () => {
		const thread = `t${'6'.repeat(32)}`;
		let calls = 0;
		let threadFetches = 0;
		const fixture = await syncFixture({
			fetchMyEvents: () => {
				const call = calls++;
				return {
					// New events on every page: only the tokens reveal the cycle.
					events: [squareEvent(`e${call}`, 'cycling')],
					syncToken: 'my-1',
					// Five fresh tokens, then a cycle the chain never leaves.
					continuationToken: call < 5 ? `head${call}` : `t${(call - 5) % 17}`
				};
			},
			fetchSquareChatEvents: (value) => {
				if (request(value).threadMid === thread) threadFetches++;
				return { events: [], syncToken: 'sync-1' };
			}
		});
		const { db } = fixture.session;
		await archiveSquare(fixture, squareEvent('th', 'known thread', { threadMid: thread }));

		let wait = 0;
		for (let step = 0; step < 200 && listGaps(db).length === 0; step++) {
			wait = await syncSquareOnce(fixture.context, noSweep);
		}

		// The lost pages cannot be proven covered: known chats and threads are
		// fetched again, and the gap stays visible as incomplete.
		expect(listGaps(db).map((gap) => [gap.scope, gap.reason, gap.status])).toEqual([
			['my_events', 'token_stalled', 'incomplete']
		]);
		expect(threadFetches).toBeGreaterThan(0);
		// Bounded memory still finds it within a few rounds of the cycle.
		expect(calls).toBeLessThan(4 * 17);
		expect(wait).toBeGreaterThanOrEqual(1000);
		expect(readState<SquarePaging>(db, myEventsKey)?.continuationToken).toBe(undefined);
	});

	it('follows a long fetchMyEvents chain to its end and fetches a thread its last page announces', async () => {
		const thread = `t${'7'.repeat(32)}`;
		const pagesInChain = 102;
		let pages = 0;
		let threadFetches = 0;
		const fixture = await syncFixture({
			fetchMyEvents: (value) => {
				const continuation = field(value, 1, 4) as string | undefined;
				const page = continuation ? Number(continuation.slice(1)) + 1 : 1;
				pages = Math.max(pages, page);
				if (page < pagesInChain) {
					return {
						events: [squareEvent(`e${page}`, `page ${page}`)],
						syncToken: 'my-1',
						continuationToken: `c${page}`
					};
				}
				const reply = squareEvent('tail', 'only on the last page', { threadMid: thread });
				const { receiveMessage } = reply.payload as { receiveMessage: { squareMessage: unknown } };
				return {
					events: [
						{
							type: 'NOTIFICATION_THREAD_MESSAGE',
							payload: {
								notificationThreadMessage: {
									chatMid: squareChat,
									threadMid: thread,
									squareMessage: receiveMessage.squareMessage
								}
							}
						}
					],
					syncToken: 'my-2'
				};
			},
			fetchSquareChatEvents: (value) => {
				if (request(value).threadMid === thread) threadFetches++;
				return { events: [], syncToken: 'sync-1' };
			}
		});
		const { db } = fixture.session;

		const waits = [];
		for (let step = 0; step < pagesInChain + 3; step++) {
			waits.push(await syncSquareOnce(fixture.context, noSweep));
		}

		expect(pages).toBe(pagesInChain);
		expect(threadFetches).toBeGreaterThan(0);
		expect(texts(fixture, thread)).toEqual(['only on the last page']);
		expect(listGaps(db)).toEqual([]);
		// The long chain yielded for waits but never lost its place.
		expect(waits.filter((wait) => wait >= 1000).length).toBeGreaterThan(0);
	});

	it('waits after a bounded run of fetchMyEvents pages that keep promising more', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchMyEvents: () => {
				calls++;
				return {
					events: [squareEvent(`e${calls}`, 'more')],
					syncToken: 'my-1',
					continuationToken: `token-${calls}`
				};
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});

		const waits = [];
		for (let step = 0; step < 25; step++)
			waits.push(await syncSquareOnce(fixture.context, noSweep));

		expect(waits.filter((wait) => wait >= 1000).length).toBeGreaterThan(0);
		// Yielding keeps the chain's place and records no gap.
		expect(readState<SquarePaging>(fixture.session.db, myEventsKey)?.continuationToken).toBe(
			`token-${calls}`
		);
		expect(listGaps(fixture.session.db)).toEqual([]);
	});

	it('stops following fetchMyEvents pages that repeat under fresh tokens', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchMyEvents: () => {
				calls++;
				return {
					events: [squareEvent('same', 'the same page')],
					syncToken: 'my-1',
					continuationToken: `fresh-${calls}`
				};
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});

		const waits = [
			await syncSquareOnce(fixture.context, noSweep),
			await syncSquareOnce(fixture.context, noSweep)
		];

		expect(waits[0]).toBe(0);
		expect(waits[1]).toBeGreaterThanOrEqual(1000);
		expect(listGaps(fixture.session.db).map((gap) => [gap.scope, gap.reason])).toEqual([
			['my_events', 'token_stalled']
		]);
		expect(readState<SquarePaging>(fixture.session.db, myEventsKey)?.continuationToken).toBe(
			undefined
		);
	});

	it('detects a stalled fetchMyEvents continuation token without spinning', async () => {
		let calls = 0;
		const fixture = await syncFixture({
			fetchMyEvents: () => {
				calls++;
				return { events: [], syncToken: 'my-1', continuationToken: 'stuck' };
			}
		});

		const waits = [
			await syncSquareOnce(fixture.context, noSweep),
			await syncSquareOnce(fixture.context, noSweep)
		];

		expect(calls).toBe(2);
		for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(1000);
		expect(listGaps(fixture.session.db).map((gap) => [gap.scope, gap.reason])).toEqual([
			['my_events', 'token_stalled']
		]);
		expect(readState<SquarePaging>(fixture.session.db, myEventsKey)?.continuationToken).toBe(
			undefined
		);
	});

	it('fetches a thread announced by its root and stores its messages with thread_id', async () => {
		const thread = `t${'f'.repeat(32)}`;
		const fixture = await syncFixture({
			...noMyEvents,
			fetchSquareChatEvents: (value) =>
				request(value).threadMid === thread
					? { events: [squareEvent('r1', 'reply in thread')], syncToken: 'thread-1' }
					: {
							events: [squareEvent('root', 'thread root', { threadRoot: thread })],
							syncToken: 'sync-1'
						}
		});

		await syncSquareOnce(fixture.context);

		expect(texts(fixture, thread)).toEqual(['reply in thread']);
		// The thread's older replies page backward like a chat's history.
		expect(readState(fixture.session.db, `backfill:square:${squareChat}:${thread}`)).toEqual({
			pages: 0,
			syncToken: 'thread-1'
		});
		expect(
			chatMessages(fixture.session.db, 'square', squareChat).map((m) => [m.text, m.threadId])
		).toEqual(
			expect.arrayContaining([
				['thread root', null],
				['reply in thread', thread]
			])
		);
	});

	it('turns an unsent Square message into a tombstone', async () => {
		const fixture = await syncFixture({
			...noMyEvents,
			fetchSquareChatEvents: () => ({
				events: [squareEvent('s1', 'gone'), squareEvent('s1', 'gone', { state: 'UNSENT' })],
				syncToken: 'sync-1'
			})
		});

		await syncSquareOnce(fixture.context);

		expect(chatMessages(fixture.session.db, 'square', squareChat)).toMatchObject([
			{ messageId: 's1', text: null, unsent: true }
		]);
	});

	it('keeps a joined square without a confirmed chat as an open gap until it is covered', async () => {
		const lonely = `s${'4'.repeat(32)}`;
		let listed = true;
		const found = squareDiscovery([squareChat], () => (listed ? [lonely] : []));
		const syncTokens: unknown[] = [];
		const fixture = await syncFixture({
			...found.handlers,
			fetchMyEvents: (value) => {
				const token = field(value, 1, 2);
				syncTokens.push(token);
				return { events: found.events, syncToken: token ? 'loop-2' : 'from-discovery' };
			},
			fetchSquareChatEvents: () => ({ events: [], syncToken: 'sync-1' })
		});
		const { db } = fixture.session;
		writeState(db, myEventsKey, { syncToken: 'loop-1' });
		const uncovered = () =>
			listGaps(db)
				.filter((gap) => gap.reason === 'uncovered_square')
				.map((gap) => [gap.scope, gap.status]);

		await syncSquareOnce(fixture.context);
		await syncSquareOnce(fixture.context, { sweepIntervalMs: 0 });

		expect(uncovered()).toEqual([[`square:${lonely}`, 'open']]);
		// Discovery pages fetchMyEvents from the start; the loop keeps its own token.
		expect(syncTokens.filter((token) => token !== undefined)).toEqual(['loop-1', 'loop-2']);

		listed = false;
		await syncSquareOnce(fixture.context, { sweepIntervalMs: 0 });

		expect(uncovered()).toEqual([[`square:${lonely}`, 'reconciled']]);
	});

	it('records a chat LINE refuses as a gap and still fetches the others', async () => {
		const refused = `m${'0'.repeat(32)}`;
		const fixture = await syncFixture({
			...squareDiscovery([refused, squareChat]).handlers,
			fetchMyEvents: () => ({
				events: squareDiscovery([refused, squareChat]).events,
				syncToken: 'my-1'
			}),
			fetchSquareChatEvents: (value) => {
				if (field(value, 1, 2) === refused) throw talkError('NOT_FOUND');
				return { events: [squareEvent('s1', 'still fetched')], syncToken: 'sync-1' };
			}
		});

		await syncSquareOnce(fixture.context);

		expect(texts(fixture)).toEqual(['still fetched']);
		expect(readPending(fixture.session.db)).toEqual([]);
		expect(listGaps(fixture.session.db)).toMatchObject([
			{ scope: `chat:${refused}`, reason: 'upstream:NOT_FOUND', status: 'open' }
		]);
	});
});
