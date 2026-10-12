import type { Message } from '@evex/linejs-types';
import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { readMessages, readState, stateKeys } from '../src/archive.ts';
import {
	backfillKey,
	backfillRound,
	type BackfillState,
	discoverChats
} from '../src/sync/backfill.ts';
import { Pool } from '../src/sync/loop.ts';
import { groupMid, otherMid, talkError } from './fake-line.ts';
import { field, syncFixture, textMessage } from './sync-fixture.ts';

const roomMid = `r${'9'.repeat(32)}`;
// IDs above 2^53: a cursor through `Number` would ask for the wrong message.
const newest = textMessage('9223372036854775806', 'newest');
const oldest = textMessage('9223372036854775805', 'oldest', {
	createdTime: (newest.createdTime as number) - 1
});

async function drain(fixture: Awaited<ReturnType<typeof syncFixture>>, pool: Pool) {
	for (let round = 0; round < 10; round++) {
		if ((await backfillRound(fixture.context, pool)) === 0) return;
	}
}

describe('backfill', () => {
	it('pages each chat back with its own cursor and records why it stopped', async () => {
		const endIds: unknown[] = [];
		const fixture = await syncFixture({
			getMessageBoxes: () => ({
				messageBoxes: [
					{ id: otherMid, midType: 'USER' },
					{ id: groupMid, midType: 'GROUP' }
				],
				hasNext: false
			}),
			getAllChatMids: () => ({ memberChatMids: [groupMid, roomMid] }),
			getChats: () => ({ chats: [] }),
			getContactsV2: () => ({ contacts: {} }),
			getRecentMessagesV2: (value) => {
				const chat = field(value, 2);
				if (chat === otherMid) return [newest];
				if (chat === groupMid) return [textMessage('5', 'same', { to: groupMid, toType: 'GROUP' })];
				throw talkError('NOT_A_MEMBER');
			},
			getPreviousMessagesV2WithRequest: (value: NestedArray) => {
				const chat = field(value, 2, 1);
				const endId = field(value, 2, 2, 2);
				// LINE answers inclusive of endMessageId: the page starts with that message.
				if (chat === otherMid) {
					endIds.push(endId);
					return endId === 9_223_372_036_854_775_806n ? [newest, oldest] : [oldest];
				}
				// The group's only message: nothing older exists.
				return [textMessage('5', 'same', { to: groupMid, toType: 'GROUP' })];
			}
		});

		await discoverChats(fixture.context, new Pool(2));
		await drain(fixture, new Pool(2));

		const stop = (chat: string) =>
			readState<BackfillState>(fixture.session.db, backfillKey('talk', chat))?.stopReason;
		expect([stop(otherMid), stop(groupMid), stop(roomMid)]).toEqual([
			'complete',
			'complete',
			'upstream:NOT_A_MEMBER'
		]);
		expect(endIds).toEqual([9_223_372_036_854_775_806n, 9_223_372_036_854_775_805n]);
		expect(
			readMessages(fixture.session.db, { service: 'talk', chatId: otherMid }).map(
				(m) => m.messageId
			)
		).toEqual(['9223372036854775806', '9223372036854775805']);
	});

	it('completes a chat whose older page holds only the cursor message and newer ones', async () => {
		const endIds: unknown[] = [];
		const fixture = await syncFixture({
			getMessageBoxes: () => ({
				messageBoxes: [{ id: otherMid, midType: 'USER' }],
				hasNext: false
			}),
			getAllChatMids: () => ({}),
			getContactsV2: () => ({ contacts: {} }),
			getRecentMessagesV2: () => [newest, oldest],
			getPreviousMessagesV2WithRequest: (value: NestedArray) => {
				endIds.push(field(value, 2, 2, 2));
				return [newest, oldest];
			}
		});

		await discoverChats(fixture.context, new Pool(2));
		await drain(fixture, new Pool(2));

		expect(endIds).toEqual([9_223_372_036_854_775_805n]);
		expect(
			readState<BackfillState>(fixture.session.db, backfillKey('talk', otherMid))?.stopReason
		).toBe('complete');
	});

	it('keeps at most two history requests in flight', async () => {
		let inFlight = 0;
		let peak = 0;
		const chats = Array.from({ length: 6 }, (_, index) => `u${String(index).repeat(32)}`);
		const slow = async (): Promise<Message[]> => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return [];
		};
		const fixture = await syncFixture({
			getMessageBoxes: () => ({
				messageBoxes: chats.map((id) => ({ id, midType: 'USER' })),
				hasNext: false
			}),
			getAllChatMids: () => ({}),
			getContactsV2: () => ({ contacts: {} }),
			getRecentMessagesV2: slow
		});
		const pool = new Pool(2);
		await discoverChats(fixture.context, pool);

		await Promise.all([backfillRound(fixture.context, pool), backfillRound(fixture.context, pool)]);
		await drain(fixture, pool);

		expect(peak).toBe(2);
		expect(stateKeys(fixture.session.db, 'backfill:')).toHaveLength(6);
	});
});
