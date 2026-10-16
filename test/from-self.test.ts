import type { SquareEvent } from '@evex/linejs-types';
import { describe, expect, it } from 'vitest';
import { upsertChat } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { sweepSquareChats } from '../src/sync/square.ts';
import { applyChanges, type MessageRow } from '../src/sync/normalize.ts';
import {
	dropNonTextColumns,
	otherMid,
	restoreReadOrderIndexes,
	seedLive,
	selfMid,
	tempRoot
} from './fake-line.ts';
import { query, type Served, serve } from './mcp-client.ts';
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

/**
 * Whether each message is the user's own, by message ID, as an agent tells it
 * with `query` and the rule its description gives: 1 or 0, null where it
 * cannot be told (no sender, or an OpenChat without a confirmed own member).
 */
async function own(served: Served): Promise<Record<string, unknown>> {
	const rows = await query(
		served.server.port,
		`SELECT m.message_id, CASE
			WHEN m.sender IS NULL THEN NULL
			WHEN m.service = 'talk' THEN m.sender = (SELECT mid FROM account)
			WHEN NOT EXISTS (SELECT 1 FROM square_self_member s WHERE s.chat_id = m.chat_id) THEN NULL
			ELSE EXISTS (
				SELECT 1 FROM square_self_member s WHERE s.chat_id = m.chat_id AND s.member_id = m.sender
			)
		END AS own FROM message m`
	);
	return Object.fromEntries(rows.map((entry) => [entry.message_id, entry.own]));
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

		expect(await own(served)).toEqual({
			[ownA!]: 1,
			[otherA!]: 0,
			[ownB!]: 1,
			[otherB!]: 0,
			[unconfirmed!]: null,
			[ownTalk!]: 1,
			[otherTalk!]: 0,
			[noSenderTalk!]: null
		});
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

		expect(await own(served)).toEqual({
			[ownBefore!]: 1,
			[otherBefore!]: 0,
			[ownAfter!]: 1,
			[otherAfter!]: 0
		});
	});

	it('keeps archived chats and messages when it migrates a database of schema 5', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const message = row('square', squares[0]!.chat, squares[0]!.self);
		const db = openDatabase(root);
		upsertChat(db, { service: 'square', chatId: message.chatId, type: 'square', name: 'Kept' });
		transaction(db, () => applyChanges(db, [{ kind: 'message', row: message }]));
		// Schema 6 adds only the own member table, schema 7 only an index,
		// schema 8 only the read state table and an index, schema 9 only the
		// non-text columns and schema 10 only drops two indexes; with all of
		// them undone this is schema 5.
		db.exec(
			`${restoreReadOrderIndexes} DROP TABLE square_self_member; DROP INDEX message_thread_order; DROP TABLE read_state; DROP INDEX message_numeric_order; ${dropNonTextColumns} PRAGMA user_version = 5`
		);
		db.close();

		const served = await serve({}, undefined, { root });
		const rows = await query(
			served.server.port,
			`SELECT c.name, m.message_id, m.text FROM chat c
			JOIN message m ON m.service = c.service AND m.chat_id = c.chat_id`
		);

		expect(rows).toEqual([{ name: 'Kept', message_id: message.messageId, text: message.text }]);
		expect(await own(served)).toEqual({ [message.messageId]: null });
	});
});
