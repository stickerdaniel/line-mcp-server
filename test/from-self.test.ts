import type { SquareEvent } from '@evex/linejs-types';
import { describe, expect, it } from 'vitest';
import { upsertChat } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { sweepSquareChats } from '../src/sync/square.ts';
import { applyChanges, type MessageRow } from '../src/sync/normalize.ts';
import { otherMid, seedLive, selfMid, tempRoot } from './fake-line.ts';
import { callTool, type Served, serve } from './mcp-client.ts';
import { field } from './sync-fixture.ts';

const mid = (prefix: string, digit: string) => `${prefix}${digit.repeat(32)}`;
/** Two joined squares, each with one chat and its own member for the account. */
const squares = [
	{ square: mid('s', '2'), chat: mid('m', '2'), self: mid('p', '2') },
	{ square: mid('s', '3'), chat: mid('m', '3'), self: mid('p', '3') }
];
/** A chat the archive holds messages of but discovery never confirmed. */
const unconfirmedChat = mid('m', '4');
const otherMember = mid('p', '5');

type Joined = (typeof squares)[number];

/**
 * Square discovery as LINE answers it. `getSquareChat` reports the account's
 * member in each chat as `member` returns it, or none.
 */
function discovery(member: (entry: Joined) => string | undefined) {
	const byChat = new Map(squares.map((entry) => [entry.chat, entry]));
	return {
		getJoinedSquares: () => ({
			squares: squares.map(({ square }) => ({ mid: square, name: 'Square' })),
			members: Object.fromEntries(
				squares.map(({ square, self }) => [square, { squareMemberMid: self }])
			)
		}),
		fetchMyEvents: () => ({
			events: squares.map(
				({ square, chat, self }, index) =>
					({
						type: 'NOTIFIED_JOIN_SQUARE_CHAT',
						createdTime: 1_700_000_000_000 + index,
						payload: {
							notifiedJoinSquareChat: {
								squareChatMid: chat,
								joinedMember: { squareMemberMid: self, squareMid: square }
							}
						}
					}) as unknown as SquareEvent
			),
			syncToken: 'my-1'
		}),
		getSquareChat: (value: Parameters<typeof field>[0]) => {
			const entry = byChat.get(field(value, 1, 1) as string)!;
			const squareMemberMid = member(entry);
			return {
				squareChat: { squareChatMid: entry.chat, squareMid: entry.square, name: 'Chat' },
				squareChatMember: {
					membershipState: 'JOINED',
					...(squareMemberMid ? { squareMemberMid, squareChatMid: entry.chat } : {})
				}
			};
		}
	};
}

let nextId = 5000;

function row(service: 'talk' | 'square', chatId: string, sender: string | null): MessageRow {
	const messageId = String(nextId++);
	return {
		service,
		chatId,
		chatType: service,
		messageId,
		threadId: null,
		sender,
		sentAt: Date.UTC(2026, 9, 12) + nextId,
		editedAt: null,
		contentType: 'NONE',
		text: `from self check ${messageId}`,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id: messageId }),
		decryptState: 'ok',
		missingKey: null
	};
}

/** Archives messages as live sync would, which also upserts each chat. */
function archive(served: Served, ...rows: MessageRow[]) {
	const { db } = served.session;
	transaction(db, () =>
		applyChanges(
			db,
			rows.map((entry) => ({ kind: 'message', row: entry }))
		)
	);
	return rows.map((entry) => entry.messageId);
}

type Item = { message_id: string; from_self?: boolean };

/**
 * `from_self` per message ID as read_messages, search_messages and list_changes
 * each show it; `absent` where the item leaves it out.
 */
async function shownFromSelf(served: Served, chats: [string, string][]) {
	const { port } = served.server;
	const byId = (items: Item[]) =>
		Object.fromEntries(
			items.map((item) => [item.message_id, 'from_self' in item ? item.from_self : 'absent'])
		);
	const read: Item[] = [];
	for (const [service, chatId] of chats) {
		const page = await callTool(port, 'read_messages', { service, chat_id: chatId });
		read.push(...(page.data.messages as Item[]));
	}
	const search = await callTool(port, 'search_messages', { query: 'from self check' });
	const changes = await callTool(port, 'list_changes', { limit: 200 });
	return [byId(read), byId(search.data.messages as Item[]), byId(changes.data.changes as Item[])];
}

/** Runs one Square discovery sweep over the served session. */
const sweep = ({ session }: Served) =>
	sweepSquareChats({ db: session.db, base: session.base, selfMid, log: () => {}, now: Date.now });

describe('own OpenChat messages', () => {
	it('marks own messages by the account member of each chat, and leaves unknown ones unmarked', async () => {
		let withMember = true;
		const served = await serve(discovery((entry) => (withMember ? entry.self : undefined)));
		await sweep(served);
		// A later sweep whose answer lacks the member keeps the stored one.
		withMember = false;
		await sweep(served);

		const [a, b] = squares;
		const [ownA, otherA, ownB, otherB, unconfirmed, ownTalk, otherTalk, noSenderTalk] = archive(
			served,
			row('square', a!.chat, a!.self),
			row('square', a!.chat, b!.self),
			row('square', b!.chat, b!.self),
			row('square', b!.chat, otherMember),
			row('square', unconfirmedChat, a!.self),
			row('talk', otherMid, selfMid),
			row('talk', otherMid, otherMid),
			row('talk', otherMid, null)
		);

		const expected = {
			[ownA!]: true,
			[otherA!]: false,
			[ownB!]: true,
			[otherB!]: false,
			[unconfirmed!]: 'absent',
			[ownTalk!]: true,
			[otherTalk!]: false,
			[noSenderTalk!]: 'absent'
		};
		expect(
			await shownFromSelf(served, [
				['square', a!.chat],
				['square', b!.chat],
				['square', unconfirmedChat],
				['talk', otherMid]
			])
		).toEqual([expected, expected, expected]);
	});

	it('keeps marking messages of an earlier own member after LINE confirms another one', async () => {
		const [a] = squares;
		const rejoined = mid('p', '6');
		let current = a!.self;
		const served = await serve(discovery((entry) => (entry === a ? current : entry.self)));
		await sweep(served);
		const [ownBefore, otherBefore] = archive(
			served,
			row('square', a!.chat, a!.self),
			row('square', a!.chat, otherMember)
		);
		current = rejoined;
		await sweep(served);
		const [ownAfter, otherAfter] = archive(
			served,
			row('square', a!.chat, rejoined),
			row('square', a!.chat, otherMember)
		);

		const expected = {
			[ownBefore!]: true,
			[otherBefore!]: false,
			[ownAfter!]: true,
			[otherAfter!]: false
		};
		expect(await shownFromSelf(served, [['square', a!.chat]])).toEqual([
			expected,
			expected,
			expected
		]);
	});

	it('keeps archived chats and messages when it migrates a database of schema 5', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const message = row('square', squares[0]!.chat, squares[0]!.self);
		const db = openDatabase(root);
		upsertChat(db, { service: 'square', chatId: message.chatId, type: 'square', name: 'Kept' });
		transaction(db, () => applyChanges(db, [{ kind: 'message', row: message }]));
		// Schema 6 adds only the own member table, schema 7 only an index and
		// schema 8 only the read state table and an index; without them this is schema 5.
		db.exec(
			'DROP TABLE square_self_member; DROP INDEX message_thread_order; DROP TABLE read_state; DROP INDEX message_numeric_order; PRAGMA user_version = 5'
		);
		db.close();

		const served = await serve({}, undefined, { root });
		const page = await callTool(served.server.port, 'read_messages', {
			service: 'square',
			chat_id: message.chatId
		});

		expect(page.data.chat).toMatchObject({ name: 'Kept' });
		expect(page.data.messages).toMatchObject([
			{ message_id: message.messageId, text: message.text }
		]);
		expect((page.data.messages as object[])[0]).not.toHaveProperty('from_self');
	});
});
