import type { Message } from '@evex/linejs-types';
import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { archiveStatus, listGaps, writeState } from '../src/archive.ts';
import { transaction } from '../src/db.ts';
import { Pool, type SyncContext } from '../src/sync/loop.ts';
import { applyChanges, messageBoundary, normalizeMessage } from '../src/sync/normalize.ts';
import { reconcileTalkGaps } from '../src/sync/reset.ts';
import { readTalkCursor, syncTalkOnce } from '../src/sync/talk.ts';
import { groupMid, type Handler, otherMid } from './fake-line.ts';
import { chatMessages } from './stored.ts';
import { field, receive, syncFixture, textMessage } from './sync-fixture.ts';

const archived = textMessage('600000000000000001', 'before the reset');
const missed = textMessage('600000000000000002', 'during the reset');
const missedGroup = textMessage('600000000000000003', 'group message during the reset', {
	to: groupMid,
	toType: 'GROUP'
});

/** A message box whose last message arrived after the last good sync. */
const box = (id: string, midType: string) => ({
	id,
	midType,
	lastDeliveredMessageId: { deliveredTime: 1_900_000_000_000 }
});

/** Chat discovery and history as LINE answers them after a reset. */
function history(): Record<string, Handler> {
	const pages: Record<string, Message[]> = {
		[otherMid]: [missed, archived],
		[groupMid]: [missedGroup]
	};
	return {
		getMessageBoxes: () => ({
			messageBoxes: [box(otherMid, 'USER'), box(groupMid, 'GROUP')],
			hasNext: false
		}),
		getAllChatMids: () => ({ memberChatMids: [groupMid] }),
		getChats: () => ({
			chats: [
				{ chatMid: groupMid, chatName: 'Group', extra: { groupExtra: { memberMids: { a: 1 } } } }
			]
		}),
		getContactsV2: () => ({ contacts: { [otherMid]: { contact: { displayName: 'Other' } } } }),
		getRecentMessagesV2: (value: NestedArray) => pages[field(value, 2) as string] ?? [],
		getPreviousMessagesV2WithRequest: () => []
	};
}

async function store(context: SyncContext, message: Message): Promise<void> {
	const row = await normalizeMessage(context, message, { service: 'talk' });
	transaction(context.db, () => applyChanges(context.db, [{ kind: 'message', row }]));
}

/**
 * A store that holds `archived` and then completed a sync up to revision 500,
 * so its cursor trusts `archived`.
 */
async function resetFixture(handlers: Record<string, Handler>) {
	const fixture = await syncFixture({ ...history(), ...handlers });
	const { db } = fixture.session;
	await store(fixture.context, archived);
	writeState(db, 'talk:cursor', {
		revision: '500',
		globalRev: '7',
		individualRev: '8',
		boundary: messageBoundary(db)
	});
	writeState(db, 'talk:syncedAt', 1_800_000_000_000);
	return fixture;
}

describe('sync resets', () => {
	for (const withOperations of [true, false]) {
		it(`records a full sync ${withOperations ? 'with' : 'without'} operations as a gap and reconciles it`, async () => {
			const operations = withOperations
				? [receive(901, textMessage('600000000000000009', 'op'))]
				: [];
			const { context, session } = await resetFixture({
				sync: () => ({
					operationResponse: { operations },
					fullSyncResponse: { reasons: [3], nextRevision: 900 }
				})
			});

			await syncTalkOnce(context);

			expect(readTalkCursor(session.db).revision).toBe(withOperations ? '901' : '900');
			expect(listGaps(session.db)).toMatchObject([
				{ service: 'talk', scope: 'all', reason: 'full_sync', status: 'open' }
			]);
			expect(archiveStatus(session.db).unreconciledGaps).toBe(1);

			await reconcileTalkGaps(context, new Pool(2));

			expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
			expect(archiveStatus(session.db).unreconciledGaps).toBe(0);
			expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toContain(
				'during the reset'
			);
			expect(chatMessages(session.db, 'talk', groupMid)[0]?.text).toBe(
				'group message during the reset'
			);
		});
	}

	it('records each partial-full-sync category, unknown ones included, without operations', async () => {
		const { context, session } = await resetFixture({
			sync: () => ({ partialFullSyncResponse: { targetCategories: { 2: 950, 6: 12, 99: 3 } } })
		});

		await syncTalkOnce(context);

		expect(readTalkCursor(session.db).revision).toBe('950');
		expect(
			listGaps(session.db).map((gap) => [gap.scope, gap.reason, gap.detail.known, gap.status])
		).toEqual([
			['category:OPS', 'partial_full_sync', true, 'open'],
			['category:GROUP', 'partial_full_sync', true, 'open'],
			['category:99', 'partial_full_sync', false, 'open']
		]);

		await reconcileTalkGaps(context, new Pool(2));

		expect(listGaps(session.db).map((gap) => gap.status)).toEqual([
			'reconciled',
			'reconciled',
			'reconciled'
		]);
		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toEqual([
			'during the reset',
			'before the reset'
		]);
	});

	it('pages past a message the reset itself delivered to reach history archived before it', async () => {
		const fresh = textMessage('600000000000000020', 'after the reset');
		let previous = 0;
		const { context, session } = await resetFixture({
			sync: () => ({
				operationResponse: { operations: [receive(901, fresh)] },
				fullSyncResponse: { reasons: [3], nextRevision: 900 }
			}),
			getRecentMessagesV2: (value: NestedArray) => (field(value, 2) === otherMid ? [fresh] : []),
			getPreviousMessagesV2WithRequest: () => {
				previous++;
				return [missed, archived];
			}
		});

		await syncTalkOnce(context);
		await reconcileTalkGaps(context, new Pool(2));

		expect(previous).toBe(1);
		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toEqual([
			'after the reset',
			'during the reset',
			'before the reset'
		]);
		expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
	});

	it('does not anchor a retried reconciliation on pages an earlier attempt stored', async () => {
		const fresh = textMessage('600000000000000021', 'newest after the reset');
		let failing = true;
		const { context, session } = await resetFixture({
			sync: () => ({ fullSyncResponse: { reasons: [3], nextRevision: 900 } }),
			getRecentMessagesV2: (value: NestedArray) => (field(value, 2) === otherMid ? [fresh] : []),
			getPreviousMessagesV2WithRequest: () => {
				if (failing) throw new TypeError('fetch failed');
				return [missed, archived];
			}
		});

		await syncTalkOnce(context);
		await expect(reconcileTalkGaps(context, new Pool(2))).rejects.toThrow();
		expect(listGaps(session.db)).toMatchObject([{ status: 'open' }]);

		failing = false;
		await reconcileTalkGaps(context, new Pool(2));

		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toContain(
			'during the reset'
		);
		expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
	});

	it('does not trust a message another worker archives while the sync request is pending', async () => {
		const fresh = textMessage('600000000000000022', 'archived by backfill meanwhile');
		const { promise: pending, resolve: release } = Promise.withResolvers<void>();
		let previous = 0;
		const { context, session } = await resetFixture({
			sync: async () => {
				await pending;
				return { fullSyncResponse: { reasons: [3], nextRevision: 900 } };
			},
			getRecentMessagesV2: (value: NestedArray) => (field(value, 2) === otherMid ? [fresh] : []),
			getPreviousMessagesV2WithRequest: () => {
				previous++;
				return [missed, archived];
			}
		});

		const sync = syncTalkOnce(context);
		await store(context, fresh);
		release();
		await sync;
		await reconcileTalkGaps(context, new Pool(2));

		expect(previous).toBe(1);
		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toEqual([
			'archived by backfill meanwhile',
			'during the reset',
			'before the reset'
		]);
		expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
	});

	it('keeps the trusted boundary of the last complete batch through a truncated one', async () => {
		const fresh = textMessage('600000000000000023', 'archived between batches');
		let syncs = 0;
		let previous = 0;
		const { context, session } = await resetFixture({
			sync: () => {
				syncs++;
				if (syncs === 1) return {};
				if (syncs === 2) {
					const op = textMessage('600000000000000024', 'batch', { to: groupMid, toType: 'GROUP' });
					return { operationResponse: { operations: [receive(501, op)], hasMoreOps: true } };
				}
				return { fullSyncResponse: { reasons: [3], nextRevision: 900 } };
			},
			getRecentMessagesV2: (value: NestedArray) => (field(value, 2) === otherMid ? [fresh] : []),
			getPreviousMessagesV2WithRequest: () => {
				previous++;
				return [missed, archived];
			}
		});

		await syncTalkOnce(context);
		// Committed before the truncated request, but its operation may lie past that batch.
		await store(context, fresh);
		await syncTalkOnce(context);
		await syncTalkOnce(context);
		await reconcileTalkGaps(context, new Pool(2));

		expect(previous).toBe(1);
		expect(chatMessages(session.db, 'talk', otherMid).map((m) => m.text)).toContain(
			'during the reset'
		);
		expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
	});

	for (const cursor of ['none', 'without a boundary'] as const) {
		it(`trusts no archived row when the cursor is ${cursor === 'none' ? 'missing' : cursor}`, async () => {
			// Backfill archived the oldest and the newest message; the first sync then resets.
			const chat = Array.from({ length: 100 }, (_, index) =>
				textMessage(String(610_000_000_000_000_001n + BigInt(index)), `message ${index + 1}`)
			);
			const newestFirst = chat.toReversed();
			let previous = 0;
			const fixture = await syncFixture({
				...history(),
				sync: () => ({ fullSyncResponse: { reasons: [3], nextRevision: 900 } }),
				getRecentMessagesV2: (value: NestedArray) =>
					field(value, 2) === otherMid ? newestFirst.slice(0, 50) : [],
				getPreviousMessagesV2WithRequest: (value: NestedArray) => {
					previous++;
					const before = String(field(value, 2, 2, 2));
					return before === chat[50]!.id ? newestFirst.slice(50) : [];
				}
			});
			const { context, session } = fixture;
			await store(context, chat[0]!);
			await store(context, chat[99]!);
			if (cursor !== 'none') {
				writeState(session.db, 'talk:cursor', {
					revision: '2',
					globalRev: '0',
					individualRev: '0'
				});
			}

			await syncTalkOnce(context);
			await reconcileTalkGaps(context, new Pool(2));

			expect(previous).toBeGreaterThan(0);
			expect(chatMessages(session.db, 'talk', otherMid)).toHaveLength(100);
		});
	}

	it('reconciles a chat whose oldest page holds only the message it pages before', async () => {
		// LINE answers getPreviousMessagesV2WithRequest inclusive of endMessageId.
		const first = textMessage('600000000000000031', 'first in chat');
		const second = textMessage('600000000000000032', 'second in chat');
		let previous = 0;
		const { context, session } = await resetFixture({
			sync: () => ({ fullSyncResponse: { reasons: [3], nextRevision: 900 } }),
			getRecentMessagesV2: (value: NestedArray) =>
				field(value, 2) === otherMid ? [second, first] : [],
			getPreviousMessagesV2WithRequest: (value: NestedArray) => {
				previous++;
				return String(field(value, 2, 2, 2)) === first.id ? [first] : [];
			}
		});

		await syncTalkOnce(context);
		await reconcileTalkGaps(context, new Pool(2));

		expect(previous).toBe(1);
		expect(listGaps(session.db)).toMatchObject([{ status: 'reconciled' }]);
	});

	it('keeps a gap open as incomplete when history never meets the archive within the bound', async () => {
		let next = 700_000_000_000_000_000n;
		let time = 1_650_000_000_000;
		const endless = () => [
			textMessage(String(next--), 'old', { createdTime: (time -= 1000) }),
			textMessage(String(next--), 'older', { createdTime: (time -= 1000) })
		];
		const { context, session } = await resetFixture({
			getRecentMessagesV2: endless,
			getPreviousMessagesV2WithRequest: endless,
			sync: () => ({ fullSyncResponse: { reasons: [], nextRevision: 1 } })
		});

		await syncTalkOnce(context);
		await reconcileTalkGaps(context, new Pool(2), { maxPages: 3 });

		expect(listGaps(session.db)).toMatchObject([{ status: 'incomplete' }]);
		expect(archiveStatus(session.db).unreconciledGaps).toBe(1);
	});
});
