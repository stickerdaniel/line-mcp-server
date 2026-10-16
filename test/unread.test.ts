import type { SquareEvent } from '@evex/linejs-types';
import { describe, expect, it, vi } from 'vitest';
import { addSquareSelfMember, upsertChat } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { observeSnapshot } from '../src/read-state.ts';
import type { LogEntry } from '../src/session.ts';
import { snapshotTalkReadState } from '../src/sync/backfill.ts';
import type { SyncContext } from '../src/sync/loop.ts';
import { Pool } from '../src/sync/loop.ts';
import { applyChanges, type Change, type MessageRow } from '../src/sync/normalize.ts';
import { drainTarget, sweepSquareChats, syncSquareOnce } from '../src/sync/square.ts';
import { syncTalkOnce } from '../src/sync/talk.ts';
import {
	dropNonTextColumns,
	type Handler,
	otherMid,
	restoreReadOrderIndexes,
	seedLive,
	selfMid,
	tempRoot
} from './fake-line.ts';
import { query, type Served, serve } from './mcp-client.ts';
import {
	field,
	receive,
	squareChat,
	squareDiscovery,
	squareMember,
	textMessage
} from './sync-fixture.ts';

const mid = (prefix: string, digit: string) => `${prefix}${digit.repeat(32)}`;
const clock = 1_800_000_000_000;

let sentAt = clock;
/** A message from the chat's other side: the peer in Talk, `squareMember` in OpenChat. */
function row(
	service: 'talk' | 'square',
	chatId: string,
	messageId: string,
	extra: Partial<MessageRow> = {}
): MessageRow {
	return {
		service,
		chatId,
		chatType: service === 'talk' ? (chatId.startsWith('c') ? 'group' : 'user') : 'square',
		messageId,
		threadId: null,
		sender: service === 'talk' ? (chatId.startsWith('u') ? chatId : otherMid) : squareMember,
		sentAt: (sentAt += 1000),
		editedAt: null,
		contentType: 'NONE',
		text: `message ${messageId}`,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id: messageId }),
		decryptState: 'ok',
		missingKey: null,
		...extra
	};
}

function apply(served: Served, ...changes: Change[]): void {
	const { db } = served.session;
	transaction(db, () => applyChanges(db, changes));
}

const store = (served: Served, ...rows: MessageRow[]) =>
	apply(served, ...rows.map((entry) => ({ kind: 'message' as const, row: entry })));

/** A sync context over the served session, with its log and a clock that stands still unless moved. */
function contextOf(served: Served, now = () => clock): SyncContext & { logs: LogEntry[] } {
	const logs: LogEntry[] = [];
	const { db, base } = served.session;
	return { db, base, selfMid, now, logs, log: (entry) => void logs.push(entry) };
}

/**
 * What an agent finds unread with `query` and the rule its description gives:
 * each chat with unread messages as `chat:id,id` in numeric ID order, or
 * `chat:?` when its read position is unknown, chats by service and ID.
 */
async function unread(served: Served): Promise<string[]> {
	const rows = await query(
		served.server.port,
		`SELECT c.chat_id, r.marker, m.message_id FROM chat c
		LEFT JOIN read_state r ON r.service = c.service AND r.chat_id = c.chat_id
		LEFT JOIN message m ON r.marker IS NOT NULL
			AND m.service = c.service AND m.chat_id = c.chat_id
			AND m.thread_id IS NULL AND m.unsent = 0
			AND (length(m.message_id), m.message_id) > (length(r.marker), r.marker)
			AND NOT coalesce(CASE m.service
				WHEN 'talk' THEN m.sender = (SELECT mid FROM account)
				ELSE m.sender IN (SELECT member_id FROM square_self_member s WHERE s.chat_id = m.chat_id)
			END, 0)
		ORDER BY c.service DESC, c.chat_id, length(m.message_id), m.message_id`
	);
	const chats = new Map<string, string[] | '?'>();
	for (const entry of rows) {
		const chat = String(entry.chat_id);
		if (entry.marker === null) chats.set(chat, '?');
		else if (entry.message_id !== null)
			chats.set(chat, [...(chats.get(chat) ?? []), String(entry.message_id)]);
	}
	return [...chats].map(([chat, ids]) => `${chat}:${ids === '?' ? '?' : ids.join(',')}`);
}

/** Each chat's read position, and LINE's count with the position and time it was reported for. */
const readStates = (served: Served) =>
	query(
		served.server.port,
		`SELECT c.chat_id, c.type, r.marker, r.line_count, r.count_marker, r.count_at FROM chat c
		LEFT JOIN read_state r ON r.service = c.service AND r.chat_id = c.chat_id
		ORDER BY c.service DESC, c.chat_id`
	);

/** A user chat as `readStates` shows it, with the count of a snapshot taken at `clock`. */
const state = (chatId: string, marker: string | null, count?: number | null) => ({
	chat_id: chatId,
	type: 'user',
	marker,
	line_count: count ?? null,
	count_marker: count === undefined ? null : marker,
	count_at: count === undefined ? null : clock
});

/** A `sync` that delivers `batches` one per call, then nothing. */
function batches(...operations: object[][]): Handler {
	let revision = 0;
	return () => {
		const batch = operations.shift() ?? [];
		return {
			operationResponse: {
				operations: batch.map((operation) => ({ ...operation, revision: ++revision })),
				hasMoreOps: false
			}
		};
	};
}
const checked = (param2: string) => ({
	type: 'SEND_CHAT_CHECKED',
	param1: otherMid,
	param2,
	createdTime: clock
});

/** `getMessageBoxes` answering `boxes` when asked with unread counts. */
const boxes =
	(list: () => object[]): Handler =>
	(value) => ({ messageBoxes: field(value, 2, 5) ? list() : [], hasNext: false });

/** A read status of `squareChat` as `fetchMyEvents` delivers it. */
const status = (marker: string, count: number): SquareEvent =>
	({
		type: 'NOTIFIED_UPDATE_SQUARE_CHAT_STATUS',
		createdTime: clock,
		payload: {
			notifiedUpdateSquareChatStatus: {
				squareChatMid: squareChat,
				statusWithoutMessage: { markedAsReadMessageId: marker, unreadMessageCount: count }
			}
		}
	}) as unknown as SquareEvent;

describe('unread messages', () => {
	it('leave out own, unsent and thread messages and keep unknown senders', async () => {
		const served = await serve();
		const { db } = served.session;
		const unconfirmed = mid('m', '4');
		const earlierSelf = mid('p', '2');
		const currentSelf = mid('p', '3');
		addSquareSelfMember(db, squareChat, earlierSelf, clock);
		addSquareSelfMember(db, squareChat, currentSelf, clock + 1);
		store(
			served,
			row('talk', otherMid, '11', { sender: selfMid }),
			row('talk', otherMid, '12', { sender: null }),
			row('talk', otherMid, '13'),
			row('talk', otherMid, '14', { decryptState: 'missing_key', text: null }),
			row('talk', otherMid, '15'),
			row('square', squareChat, '21', { sender: currentSelf }),
			row('square', squareChat, '22', { sender: earlierSelf }),
			row('square', squareChat, '23', { threadId: mid('t', '5') }),
			row('square', squareChat, '24'),
			row('square', unconfirmed, '31')
		);
		apply(served, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '13' });
		for (const [service, chatId] of [
			['talk', otherMid],
			['square', squareChat],
			['square', unconfirmed]
		] as const) {
			observeSnapshot(db, service, chatId, '10', null, clock);
		}

		expect(await unread(served)).toEqual([
			`${otherMid}:12,14,15`,
			`${unconfirmed}:31`,
			`${squareChat}:24`
		]);
		expect(served.upstream.calls).toEqual([]);
	});
});

describe('read positions from Talk', () => {
	const ids = ['9007199254740995', '9007199254740996', '99999999999999999', '100000000000000000'];

	it('hides messages up to the position, comparing IDs as integers', async () => {
		const served = await serve({
			sync: batches(
				[...ids.map((id) => receive(0, textMessage(id, id))), checked('9007199254740995')],
				[checked('99999999999999999')],
				[checked('9007199254740996')],
				['0100000000000000000', '-100000000000000000', '1e18', 'later', ''].map(checked)
			)
		});
		const context = contextOf(served);
		const after = async () => {
			await syncTalkOnce(context);
			return unread(served);
		};

		expect(await after()).toEqual([`${otherMid}:${ids.slice(1).join(',')}`]);
		expect(await after()).toEqual([`${otherMid}:100000000000000000`]);
		// An older position and positions that are no canonical ID change nothing.
		expect(await after()).toEqual([`${otherMid}:100000000000000000`]);
		expect(await after()).toEqual([`${otherMid}:100000000000000000`]);
		expect(context.logs).toEqual([
			{ event: 'read_marker_ignored', service: 'talk', kind: 'non_canonical' },
			{ event: 'read_marker_ignored', service: 'talk', kind: 'non_canonical' },
			{ event: 'read_marker_ignored', service: 'talk', kind: 'malformed' },
			{ event: 'read_marker_ignored', service: 'talk', kind: 'malformed' }
		]);
	});

	it('keeps read position and cursor together when a batch cannot be committed', async () => {
		// LINE delivers the same batch again until the cursor moves past it.
		const served = await serve({
			sync: () => ({ operationResponse: { operations: [{ ...checked('3'), revision: 1 }] } })
		});
		const { db } = served.session;
		store(served, row('talk', otherMid, '2'), row('talk', otherMid, '3'));
		observeSnapshot(db, 'talk', otherMid, '1', null, clock);
		db.exec(`CREATE TRIGGER crash BEFORE INSERT ON sync_state WHEN new.key = 'talk:cursor'
			BEGIN SELECT RAISE(ABORT, 'crash'); END`);
		const context = contextOf(served);

		await expect(syncTalkOnce(context)).rejects.toThrow();
		expect(await unread(served)).toEqual([`${otherMid}:2,3`]);

		db.exec('DROP TRIGGER crash');
		await syncTalkOnce(context);
		expect(await unread(served)).toEqual([]);
	});

	it('flags unknown read positions and takes counts as LINE reports them', async () => {
		const [none, zero, absent, zeroCount, read, empty, padded] = [1, 2, 3, 4, 6, 7, 8].map(
			(digit) => mid('u', String(digit))
		) as [string, string, string, string, string, string, string];
		const newChat = mid('c', '5');
		const served = await serve({
			getMessageBoxes: boxes(() => [
				{ id: zero, midType: 'USER', lastSeenMessageId: 0n, unreadCount: 3n },
				{ id: absent, midType: 'USER' },
				{ id: zeroCount, midType: 'USER', lastSeenMessageId: 0n, unreadCount: 0n },
				{ id: newChat, midType: 'GROUP', lastSeenMessageId: 5000n, unreadCount: 2n },
				{ id: read, midType: 'USER', lastSeenMessageId: 6001n, unreadCount: 0n },
				{ id: empty, midType: 'USER', lastSeenMessageId: '', unreadCount: -1n },
				{ id: padded, midType: 'USER', lastSeenMessageId: '0008001', unreadCount: 1n }
			])
		});
		store(served, row('talk', none, '1001'), row('talk', read, '6001'));
		const context = contextOf(served);

		await snapshotTalkReadState(context, new Pool(1));
		// A message that arrives after LINE reported no unread one.
		store(served, row('talk', zeroCount, '4001'));

		expect(await readStates(served)).toEqual([
			{ ...state(newChat, '5000', 2), type: 'group' },
			// LINE leaves this chat out of the snapshot.
			state(none, null),
			state(zero, null, 3),
			state(absent, null, null),
			state(zeroCount, null, 0),
			state(read, '6001', 0),
			state(empty, null, null),
			// A position that is no canonical ID drops the snapshot.
			state(padded, null)
		]);
		expect(await unread(served)).toEqual([
			`${none}:?`,
			`${zero}:?`,
			`${absent}:?`,
			`${zeroCount}:?`,
			`${empty}:?`,
			`${padded}:?`
		]);
		expect(context.logs).toEqual([
			{ event: 'read_marker_ignored', service: 'talk', kind: 'non_canonical' }
		]);
	});

	it("keeps LINE's count with the read position it was reported for", async () => {
		const served = await serve({
			getMessageBoxes: boxes(() => [
				{ id: otherMid, midType: 'USER', lastSeenMessageId: 10n, unreadCount: 2n }
			]),
			sync: batches([checked('11')])
		});
		store(served, ...['10', '11', '12'].map((id) => row('talk', otherMid, id)));
		const context = contextOf(served);

		await snapshotTalkReadState(context, new Pool(1));
		expect(await readStates(served)).toMatchObject([
			{ marker: '10', line_count: 2, count_marker: '10' }
		]);
		await syncTalkOnce(context);

		// A live read moves the position past the one LINE counted for.
		expect(await readStates(served)).toMatchObject([
			{ marker: '11', line_count: 2, count_marker: '10' }
		]);
		expect(await unread(served)).toEqual([`${otherMid}:12`]);
	});

	it('keeps the newer count when an earlier snapshot answers last', async () => {
		const { promise: slow, resolve: answer } = Promise.withResolvers<void>();
		let requests = 0;
		const served = await serve({
			getMessageBoxes: async () => {
				const first = ++requests === 1;
				if (first) await slow;
				const unreadCount = first ? 7n : 3n;
				return {
					messageBoxes: [{ id: otherMid, midType: 'USER', lastSeenMessageId: 10n, unreadCount }],
					hasNext: false
				};
			}
		});
		upsertChat(served.session.db, { service: 'talk', chatId: otherMid, type: 'user' });
		let now = clock;
		const context = contextOf(served, () => now);
		const pool = new Pool(2);

		const earlier = snapshotTalkReadState(context, pool);
		await vi.waitFor(() => expect(requests).toBe(1));
		now += 1000;
		await snapshotTalkReadState(context, pool);
		now += 1000;
		answer();
		await earlier;

		expect(await readStates(served)).toMatchObject([{ line_count: 3, count_at: clock + 1000 }]);
	});

	it("dates LINE's count by when its request went out, not when it waited for a slot", async () => {
		const served = await serve({
			getMessageBoxes: boxes(() => [
				{ id: otherMid, midType: 'USER', lastSeenMessageId: 10n, unreadCount: 2n }
			])
		});
		upsertChat(served.session.db, { service: 'talk', chatId: otherMid, type: 'user' });
		let now = clock;
		const pool = new Pool(1);
		const { promise: busy, resolve: free } = Promise.withResolvers<void>();
		const occupied = pool.run(() => busy);

		const snapshot = snapshotTalkReadState(
			contextOf(served, () => now),
			pool
		);
		now += 120_000;
		free();
		await occupied;
		await snapshot;

		expect(await readStates(served)).toMatchObject([{ line_count: 2, count_at: clock + 120_000 }]);
	});
});

describe('read positions from OpenChat', () => {
	const noSweep = { sweepIntervalMs: Number.POSITIVE_INFINITY };

	it("takes each chat's position and count from the sweep as of its request", async () => {
		const other = mid('m', '7');
		const discovery = squareDiscovery([squareChat, other]);
		let now = clock;
		const statuses: Record<string, object> = {
			[squareChat]: { markedAsReadMessageId: '20', unreadMessageCount: 1 },
			[other]: { markedAsReadMessageId: '', unreadMessageCount: 2 }
		};
		const served = await serve({
			...discovery.handlers,
			fetchMyEvents: () => ({ events: discovery.events }),
			getSquareChat: (value, base) => {
				const answer = discovery.handlers.getSquareChat!(value, base) as object;
				// LINE answers after the clock moved on.
				now += 1000;
				return {
					...answer,
					squareChatStatus: { otherStatus: statuses[field(value, 1, 1) as string] }
				};
			}
		});
		store(served, ...['20', '21'].map((id) => row('square', squareChat, id)));

		await sweepSquareChats(contextOf(served, () => now));

		expect(await readStates(served)).toEqual([
			{
				chat_id: other,
				type: 'square',
				marker: null,
				line_count: 2,
				count_marker: null,
				count_at: clock + 1000
			},
			{
				chat_id: squareChat,
				type: 'square',
				marker: '20',
				line_count: 1,
				count_marker: '20',
				count_at: clock
			}
		]);
		expect(await unread(served)).toEqual([`${other}:?`, `${squareChat}:21`]);
	});

	it('changes neither position nor count for an older status replayed after a sweep', async () => {
		const discovery = squareDiscovery([squareChat]);
		let swept = false;
		const served = await serve({
			...discovery.handlers,
			// The sweep reads the join events; afterwards the stream replays an older status.
			fetchMyEvents: () =>
				swept ? { events: [status('19', 5)], syncToken: 'my-1' } : { events: discovery.events },
			getSquareChat: (value, base) => ({
				...(discovery.handlers.getSquareChat!(value, base) as object),
				squareChatStatus: { otherStatus: { markedAsReadMessageId: '20', unreadMessageCount: 1 } }
			})
		});
		store(served, ...['19', '20', '21'].map((id) => row('square', squareChat, id)));
		const context = contextOf(served);
		await sweepSquareChats(context);
		swept = true;
		const before = await readStates(served);

		await syncSquareOnce(context, { ...noSweep, maxTargets: 0 });

		expect(before).toMatchObject([{ marker: '20', line_count: 1, count_marker: '20' }]);
		expect(await readStates(served)).toEqual(before);
	});

	it.each([
		{ path: "the account's own events", known: true },
		{ path: "a chat's history", known: false }
	])('takes a read position only from $path', async ({ known }) => {
		const served = await serve({
			fetchMyEvents: () => ({ events: known ? [status('20', 0)] : [], syncToken: 'my-1' }),
			fetchSquareChatEvents: () => ({ events: [status('20', 0)], syncToken: 'chat-1' })
		});
		store(served, ...['20', '21'].map((id) => row('square', squareChat, id)));
		const context = contextOf(served);

		await syncSquareOnce(context, noSweep);
		await drainTarget(context, { chat: squareChat });

		expect(await unread(served)).toEqual([known ? `${squareChat}:21` : `${squareChat}:?`]);
	});

	it('keeps read position and stream position together when a page cannot be committed', async () => {
		const served = await serve({
			fetchMyEvents: () => ({ events: [status('3', 0)], syncToken: 'my-1' })
		});
		const { db } = served.session;
		store(served, row('square', squareChat, '2'), row('square', squareChat, '3'));
		observeSnapshot(db, 'square', squareChat, '1', null, clock);
		db.exec(`CREATE TRIGGER crash BEFORE INSERT ON sync_state WHEN new.key = 'square:my'
			BEGIN SELECT RAISE(ABORT, 'crash'); END`);
		const context = contextOf(served);

		await expect(syncSquareOnce(context, noSweep)).rejects.toThrow();
		expect(await unread(served)).toEqual([`${squareChat}:2,3`]);

		db.exec('DROP TRIGGER crash');
		await syncSquareOnce(context, { ...noSweep, maxTargets: 0 });
		expect(await unread(served)).toEqual([]);
	});
});

describe('read state migration', () => {
	it('upgrades a populated archive of schema 7 with every read position unknown', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const db = openDatabase(root);
		const message = row('talk', otherMid, '1001');
		transaction(db, () => applyChanges(db, [{ kind: 'message', row: message }]));
		// Schema 8 adds the read state table and an index, schema 9 the non-text
		// columns, schema 10 drops two indexes.
		db.exec(
			`${restoreReadOrderIndexes} DROP TABLE read_state; DROP INDEX message_numeric_order; ${dropNonTextColumns} PRAGMA user_version = 7`
		);
		db.close();

		const served = await serve({}, undefined, { root });

		expect(await unread(served)).toEqual([`${otherMid}:?`]);
		expect(await query(served.server.port, 'SELECT message_id, text FROM message')).toEqual([
			{ message_id: '1001', text: message.text }
		]);
	});
});
