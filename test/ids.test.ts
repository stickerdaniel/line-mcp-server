import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.ts';
import { talkSync } from '../src/probe.ts';
import { openSession } from '../src/session.ts';
import { SqliteStorage } from '../src/storage.ts';
import { fakeUpstream, freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

describe('IDs', () => {
	it('round-trips 64-bit revisions from a sync response into the next sync request', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const requests: NestedArray[] = [];
		const upstream = fakeUpstream({
			getProfile: () => ({ mid: selfMid }),
			sync: (value) => {
				requests.push(value);
				return {
					operationResponse: {
						operations: [{ revision: 9_007_199_254_740_993n }],
						globalEvents: { lastRevision: 9_223_372_036_854_775_807n },
						individualEvents: { lastRevision: 9_223_372_036_854_775_806n }
					}
				};
			}
		});
		const session = await openSession({
			root,
			lockPort: await freePort(),
			createClient: upstream.createClient,
			log: () => {}
		});

		try {
			const result = await talkSync(session.base);
			expect(result.calls[0]!.to).toBe('9007199254740993');
		} finally {
			await session.close();
		}

		// SyncRequest: lastRevision (1), lastGlobalRevision (3), lastIndividualRevision (4).
		const second = (requests[1]![0] as [12, number, NestedArray])[2];
		const field = (id: number) => second.find((entry) => entry?.[1] === id)?.[2];
		expect([field(1), field(3), field(4)]).toEqual([
			9_007_199_254_740_993n,
			9_223_372_036_854_775_807n,
			9_223_372_036_854_775_806n
		]);
	});

	it('stores prefixed MIDs and 64-bit integers unchanged', () => {
		const storage = new SqliteStorage(openDatabase(tempRoot()));
		const values = {
			user: `u${'0123456789abcdef'.repeat(2)}`,
			group: `c${'fedcba9876543210'.repeat(2)}`,
			room: `r${'0'.repeat(32)}`,
			square: `p${'9'.repeat(32)}`,
			messageId: '612345678901234567',
			bigint: 9_223_372_036_854_775_807n,
			number: 1_700_000_000
		};
		for (const [key, value] of Object.entries(values)) storage.setSync(key, value);

		for (const [key, value] of Object.entries(values)) expect(storage.getSync(key)).toBe(value);
	});
});
