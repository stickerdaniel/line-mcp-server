import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { readState, talkSyncedAtKey } from '../src/archive.ts';
import { backoffMs, runLoop, type Sleep } from '../src/sync/loop.ts';
import { openDatabase } from '../src/db.ts';
import { createClient } from '../src/session.ts';
import { SqliteStorage } from '../src/storage.ts';
import { readTalkCursor, runTalkLoop, syncTalkOnce, talkDelay } from '../src/sync/talk.ts';
import { otherMid, tempRoot } from './fake-line.ts';
import { changedSince, chatMessages, indexed } from './stored.ts';
import { field, receive, syncFixture, textMessage } from './sync-fixture.ts';

const first = textMessage('100000000000000001', 'first');
const second = textMessage('100000000000000002', 'second');
const third = textMessage('100000000000000003', 'third');

/**
 * LINE delivers every operation after the requested revision; `resend` also
 * repeats the operation at that revision, as a server may after a crash.
 */
function server(operations: ReturnType<typeof receive>[], resend = false) {
	return (value: NestedArray) => {
		const after = BigInt(field(value, 1, 1) as number | bigint);
		return {
			operationResponse: {
				operations: operations.filter((op) =>
					resend ? BigInt(op.revision) >= after : BigInt(op.revision) > after
				),
				hasMoreOps: false
			}
		};
	};
}

describe('Talk sync commit', () => {
	it('keeps the cursor when the messages of a batch cannot be written', async () => {
		const { context, session } = await syncFixture({
			sync: server([receive(11, first), receive(12, second)])
		});
		session.db.exec(`CREATE TRIGGER fail BEFORE INSERT ON message
			BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

		await expect(syncTalkOnce(context)).rejects.toThrow();

		expect(readTalkCursor(session.db).revision).toBe('0');
		session.db.exec('DROP TRIGGER fail');
		await syncTalkOnce(context);
		expect(readTalkCursor(session.db).revision).toBe('12');
		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toEqual([
			'second',
			'first'
		]);
	});

	it('neither duplicates nor loses messages when a commit dies after the messages', async () => {
		const operations = [receive(11, first), receive(12, second)];
		const { context, session } = await syncFixture({ sync: server(operations, true) });
		// The cursor write is the last statement of the transaction.
		session.db.exec(`CREATE TRIGGER crash BEFORE INSERT ON sync_state WHEN new.key = 'talk:cursor'
			BEGIN SELECT RAISE(ABORT, 'crash'); END`);

		await expect(syncTalkOnce(context)).rejects.toThrow();
		expect(changedSince(session.db)).toEqual([]);

		session.db.exec('DROP TRIGGER crash');
		await syncTalkOnce(context);
		operations.push(receive(13, third));
		await syncTalkOnce(context);
		await syncTalkOnce(context);

		const changes = changedSince(session.db);
		expect(changes.map((m) => m.text)).toEqual(['first', 'second', 'third']);
		expect(changes.map((m) => m.seq)).toEqual([1, 2, 3]);
		expect(readTalkCursor(session.db).revision).toBe('13');
	});

	it('carries 64-bit revisions from a response into the next request unchanged', async () => {
		const requests: NestedArray[] = [];
		const { context, session } = await syncFixture({
			sync: (value) => {
				requests.push(value);
				return {
					operationResponse: {
						operations: [
							receive(9_007_199_254_740_993n, first),
							{ revision: 9_007_199_254_740_995n, type: 'END_OF_OPERATION' }
						],
						globalEvents: { lastRevision: 9_223_372_036_854_775_807n },
						individualEvents: { lastRevision: 9_223_372_036_854_775_806n }
					}
				};
			}
		});

		await syncTalkOnce(context);
		await syncTalkOnce(context);

		expect(readTalkCursor(session.db)).toMatchObject({
			revision: '9007199254740995',
			globalRev: '9223372036854775807',
			individualRev: '9223372036854775806'
		});
		expect([1, 3, 4].map((id) => field(requests[1]!, 1, id))).toEqual([
			9_007_199_254_740_995n,
			9_223_372_036_854_775_807n,
			9_223_372_036_854_775_806n
		]);
	});

	it('applies edits and unsends from operations', async () => {
		const edited = {
			...first,
			text: 'first, edited',
			contentMetadata: { UPDATED_TIME: '1800000000000' }
		};
		const { context, session } = await syncFixture({
			sync: server([
				receive(11, first),
				{ ...receive(12, edited), type: 'NOTIFIED_EDIT_MESSAGE' },
				receive(13, second),
				{
					revision: 14,
					type: 'NOTIFIED_DESTROY_MESSAGE',
					param1: otherMid,
					param2: second.id,
					createdTime: 1
				} as unknown as ReturnType<typeof receive>
			])
		});

		await syncTalkOnce(context);

		const messages = chatMessages(session.db, 'talk', otherMid);
		expect(messages.map((m) => [m.messageId, m.text, m.unsent])).toEqual([
			[second.id, null, true],
			[first.id, 'first, edited', false]
		]);
		expect(indexed(session.db, 'second')).toEqual([]);
	});
});

/** Records every requested wait and resolves at once; aborts the loop after `limit` waits. */
function recordingSleep(
	limit: number,
	controller: AbortController
): { waits: number[]; sleep: Sleep } {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms) => {
			waits.push(ms);
			if (waits.length >= limit) controller.abort();
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
}

describe('Talk sync cadence', () => {
	it('waits at least a second after a sync that returns at once with nothing', async () => {
		const controller = new AbortController();
		let syncs = 0;
		// The fake ends the loop after six calls, so a loop that never waits still stops.
		const { context } = await syncFixture({
			sync: () => {
				if (++syncs === 6) controller.abort();
				return {};
			}
		});
		const { waits, sleep } = recordingSleep(Number.POSITIVE_INFINITY, controller);

		await runTalkLoop(context, {
			name: 'talk',
			signal: controller.signal,
			sleep,
			random: Math.random,
			canRun: () => true,
			log: () => {}
		});

		expect(syncs).toBe(6);
		expect(waits).toHaveLength(5);
		for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(1000);
	});

	it('fetches at once only while LINE reports more operations', async () => {
		let revision = 0;
		const { context, upstream } = await syncFixture({
			sync: () => {
				revision++;
				return {
					operationResponse: {
						operations: [receive(revision, textMessage(String(200 + revision), 'x'))],
						hasMoreOps: revision < 3
					}
				};
			}
		});
		const controller = new AbortController();
		const { waits, sleep } = recordingSleep(1, controller);

		await runTalkLoop(context, {
			name: 'talk',
			signal: controller.signal,
			sleep,
			random: Math.random,
			canRun: () => true,
			log: () => {}
		});

		expect(upstream.calls.filter((method) => method === 'sync')).toHaveLength(3);
		expect(waits[0]).toBeGreaterThan(900);
	});

	it('never reports a sync as held once it has answered', async () => {
		let revision = 0;
		const { context } = await syncFixture({
			sync: () => {
				revision++;
				return {
					operationResponse: {
						operations: [receive(revision, textMessage(String(300 + revision), 'x'))],
						hasMoreOps: false
					}
				};
			}
		});
		const controller = new AbortController();
		let sleeping = false;
		let heldWhileSleeping = 0;
		let sleeps = 0;

		await runTalkLoop(
			context,
			{
				name: 'talk',
				signal: controller.signal,
				// No sync is in flight between polls; a held report now comes from a finished one.
				sleep: async () => {
					sleeping = true;
					await new Promise((resolve) => setTimeout(resolve, 60));
					sleeping = false;
					if (++sleeps === 3) controller.abort();
				},
				random: Math.random,
				canRun: () => true,
				log: () => {}
			},
			{ heldMs: 20, onHeld: () => void (sleeping && heldWhileSleeping++) }
		);

		expect(sleeps).toBe(3);
		expect(heldWhileSleeping).toBe(0);
	});

	it('backs off exponentially with jitter between 1 s and 5 min and resets after success', async () => {
		expect([0, 1, 2].map((failures) => backoffMs(failures, () => 0))).toEqual([1000, 1000, 2000]);
		expect(backoffMs(30, () => 1)).toBe(300_000);
		expect(backoffMs(30, () => 0)).toBe(150_000);

		let calls = 0;
		const controller = new AbortController();
		const { waits, sleep } = recordingSleep(14, controller);
		await runLoop(
			async () => {
				calls++;
				if (calls <= 12) throw new TypeError('fetch failed');
				return 1000;
			},
			{
				name: 'talk',
				signal: controller.signal,
				sleep,
				random: () => 1,
				canRun: () => true,
				log: () => {}
			}
		);

		expect(waits).toEqual([
			1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
			1000, 1000
		]);
	});
});

// What LINEJS throws when an idle long poll ends with HTTP 410 (base/request/mod.ts:183-190).
function longPollEnded(): never {
	throw new Error('Request internal failed: status=410 headers=[] body=<>');
}

describe('Talk long poll', () => {
	it('treats a 410 from sync as an empty batch and polls again at once', async () => {
		let clock = 1_800_000_000_000;
		let syncs = 0;
		const { context, session } = await syncFixture({
			sync: () => {
				if (++syncs === 1) return { operationResponse: { operations: [receive(11, first)] } };
				// The first idle poll is held for 110 s, the second ends at once.
				if (syncs === 2) clock += 110_000;
				return longPollEnded();
			}
		});
		const timed = { ...context, now: () => clock };
		await syncTalkOnce(timed);
		const cursor = readTalkCursor(session.db);

		const held = await syncTalkOnce(timed);
		// The held poll proves the archive current at the time it ended.
		expect(readState(session.db, talkSyncedAtKey)).toBe(clock);
		const quick = await syncTalkOnce(timed);

		expect(held).toMatchObject({ operations: 0, hasMore: false, reset: false });
		expect(talkDelay(held)).toBe(0);
		expect(talkDelay(quick)).toBeGreaterThanOrEqual(1000);
		expect(readTalkCursor(session.db)).toEqual(cursor);
	});

	it('gives sync a request timeout longer than the 110 s LINE holds an idle poll', () => {
		const base = createClient(new SqliteStorage(openDatabase(tempRoot())));

		expect(base.config.longTimeout).toBeGreaterThan(110_000);
	});
});
