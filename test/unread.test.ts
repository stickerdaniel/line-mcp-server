import type { SquareEvent } from '@evex/linejs-types';
import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { addSquareSelfMember, upsertChat } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { renderTime, sizeCap } from '../src/queries.ts';
import { advanceMarker, observeSnapshot } from '../src/read-state.ts';
import type { LogEntry } from '../src/session.ts';
import { snapshotTalkReadState } from '../src/sync/backfill.ts';
import type { SyncContext } from '../src/sync/loop.ts';
import { Pool } from '../src/sync/loop.ts';
import { applyChanges, type Change, type MessageRow } from '../src/sync/normalize.ts';
import { drainTarget, sweepSquareChats, syncSquareOnce } from '../src/sync/square.ts';
import { syncTalkOnce } from '../src/sync/talk.ts';
import { toolCommands } from '../src/tool-cli.ts';
import { groupMid, type Handler, otherMid, seedLive, selfMid, tempRoot } from './fake-line.ts';
import { callTool, listTools, type Served, serve } from './mcp-client.ts';
import {
	field,
	receive,
	squareChat,
	squareDiscovery,
	squareMember,
	textMessage
} from './sync-fixture.ts';

type Item = { message_id: string; from_self?: boolean; decrypt_state?: string; text?: string };
type Chat = {
	service: string;
	chat_id: string;
	type: string;
	unread_count?: number;
	line_unread_count?: number;
	line_unread_as_of?: string;
	messages_unknown?: true;
	continued?: true;
	messages?: Item[];
};
type Page = { chats: Chat[]; next_cursor: string | null; size_capped: boolean };

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

async function unread(served: Served, args: Record<string, unknown> = {}): Promise<Page> {
	return (await callTool(served.server.port, 'list_unread', args)).data as Page;
}

/** Every page of `list_unread`, following `next_cursor`; `between` runs after the first page. */
async function pages(served: Served, between?: () => void): Promise<Page[]> {
	const all = [await unread(served)];
	between?.();
	while (all.at(-1)!.next_cursor) {
		all.push(await unread(served, { cursor: all.at(-1)!.next_cursor }));
	}
	return all;
}

/** Each listed chat as `chat:id,id` or `chat:?` for an unknown read position. */
const shown = (chats: Chat[]) =>
	chats.map((chat) =>
		chat.messages_unknown
			? `${chat.chat_id}:?`
			: `${chat.chat_id}:${chat.messages!.map((item) => item.message_id).join(',')}`
	);

/** Every message the pages list, as `chat:id`, in the order they list them. */
const listed = (all: Page[]) =>
	all.flatMap((page) =>
		page.chats.flatMap((chat) =>
			(chat.messages ?? []).map((item) => `${chat.chat_id}:${item.message_id}`)
		)
	);

/** Bytes of `value` as JSON. */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

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

describe('list_unread', () => {
	it('lists every unread message of every chat in one call without asking LINE', async () => {
		const served = await serve();
		const { db } = served.session;
		const peer = Array.from({ length: 25 }, (_, index) =>
			row('talk', otherMid, String(1001 + index))
		);
		store(
			served,
			row('talk', otherMid, '1000'),
			...peer,
			row('talk', otherMid, '1026', { sender: selfMid }),
			row('talk', groupMid, '2001'),
			row('talk', groupMid, '2002'),
			row('square', squareChat, '3001')
		);
		observeSnapshot(db, 'talk', otherMid, '1000', null, clock);
		observeSnapshot(db, 'talk', groupMid, '2000', null, clock);
		observeSnapshot(db, 'square', squareChat, '3000', null, clock);

		const page = await unread(served);

		expect(shown(page.chats)).toEqual([
			`${squareChat}:3001`,
			`${groupMid}:2001,2002`,
			`${otherMid}:${peer.map((entry) => entry.messageId).join(',')}`
		]);
		expect(page.chats.map((chat) => chat.unread_count)).toEqual([1, 2, 25]);
		expect(page).toMatchObject({ next_cursor: null, size_capped: false });
		expect(served.upstream.calls).toEqual([]);
		const tools = await listTools(served.server.port);
		expect(tools.find((tool) => tool.name === 'list_unread')?.annotations).toMatchObject({
			readOnlyHint: true,
			openWorldHint: false
		});
		expect(toolCommands.get('list-unread')?.tool).toBe('list_unread');
	});

	it('leaves out own, unsent and thread messages and keeps unknown senders', async () => {
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

		const page = await unread(served);

		expect(shown(page.chats)).toEqual([
			`${unconfirmed}:31`,
			`${squareChat}:24`,
			`${otherMid}:12,14,15`
		]);
		const [unconfirmedItem, squareItem, talkItem] = page.chats.map((chat) => chat.messages!);
		expect(unconfirmedItem![0]).not.toHaveProperty('from_self');
		expect(squareItem![0]).toMatchObject({ from_self: false });
		expect(talkItem![0]).not.toHaveProperty('from_self');
		expect(talkItem![1]).toMatchObject({ decrypt_state: 'missing_key' });
		expect(talkItem![2]).toMatchObject({ from_self: false, text: 'message 15' });
	});

	it('rejects a cursor issued for another service', async () => {
		const served = await serve();
		const { db } = served.session;
		upsertChat(db, { service: 'talk', chatId: otherMid, type: 'user' });
		const first = await unread(served, { service: 'talk' });
		// Many chats without a read position fill more than one page.
		transaction(db, () => {
			for (let index = 0; index < 1000; index++) {
				upsertChat(db, {
					service: 'talk',
					chatId: `u${String(index).padStart(32, '0')}`,
					type: 'user'
				});
			}
		});
		const page = await unread(served, { service: 'talk' });
		expect(first.next_cursor).toBeNull();
		expect(page.next_cursor).not.toBeNull();

		const replayed = await callTool(served.server.port, 'list_unread', {
			service: 'square',
			cursor: page.next_cursor
		});

		expect(replayed).toMatchObject({ isError: true, data: { error: { code: 'invalid_cursor' } } });
	});
});

describe('list_unread size cap', () => {
	it.each([
		{
			name: 'continues inside one large chat',
			chats: [{ id: otherMid, messages: 10, text: 10_000 }],
			pages: 2
		},
		{
			name: 'lets several chats share a page',
			chats: Array.from({ length: 5 }, (_, index) => ({
				id: mid('u', String(index + 1)),
				messages: 2,
				text: 10
			})),
			pages: 1
		},
		{
			name: 'pages a message over the cap alone',
			chats: [
				{ id: mid('u', '2'), messages: 1, text: 70_000 },
				{ id: mid('u', '1'), messages: 1, text: 10 }
			],
			pages: 2
		}
	])('$name', async ({ chats, pages: expectedPages }) => {
		const served = await serve();
		const { db } = served.session;
		const expected: string[] = [];
		chats.forEach((chat, index) => {
			// Earlier chats get higher IDs, so they come first.
			const base = (chats.length - index) * 1000;
			const rows = Array.from({ length: chat.messages }, (_, offset) =>
				row('talk', chat.id, String(base + 1 + offset), { text: 'x'.repeat(chat.text) })
			);
			store(served, ...rows);
			observeSnapshot(db, 'talk', chat.id, String(base), null, clock);
			expected.push(...rows.map((entry) => `${chat.id}:${entry.messageId}`));
		});

		const all = await pages(served);

		expect(listed(all)).toEqual(expected);
		expect(all).toHaveLength(expectedPages);
		for (const page of all.slice(1)) {
			const continued = page.chats[0]!.chat_id === all[0]!.chats.at(-1)!.chat_id;
			expect(page.chats[0]!.continued).toBe(continued || undefined);
		}
		// A continued header still counts every unread message of its chat.
		for (const item of all.flatMap((page) => page.chats)) {
			expect(item.unread_count).toBe(chats.find((chat) => chat.id === item.chat_id)!.messages);
		}
	});

	it('pages chats with unknown read positions', async () => {
		const served = await serve();
		const { db } = served.session;
		const ids = Array.from({ length: 1000 }, (_, index) => `u${String(index).padStart(32, '0')}`);
		transaction(db, () => {
			for (const id of ids) upsertChat(db, { service: 'talk', chatId: id, type: 'user' });
		});

		const all = await pages(served);

		expect(all.length).toBeGreaterThan(1);
		expect(all.flatMap((page) => page.chats.map((chat) => chat.chat_id))).toEqual(ids);
	});

	it('moves on when a message fits the cap alone but not with its chat', async () => {
		const served = await serve();
		const { db } = served.session;
		const [big, small] = [mid('u', '2'), mid('u', '1')];
		store(
			served,
			row('talk', big, '2001', { text: '', editedAt: clock }),
			row('talk', small, '1001')
		);
		observeSnapshot(db, 'talk', big, '2000', null, clock);
		observeSnapshot(db, 'talk', small, '1000', null, clock);
		const empty = (await unread(served)).chats[0]!;
		// Text that brings the message to just under the cap.
		const length = sizeCap - 16 - bytes(empty.messages![0]);
		store(served, row('talk', big, '2001', { text: 'x'.repeat(length), editedAt: clock + 1 }));

		const all = await pages(served);

		const header = { ...all[0]!.chats[0]!, messages: [] };
		const message = all[0]!.chats[0]!.messages![0]!;
		expect(bytes(message)).toBeLessThan(sizeCap);
		expect(bytes(header) + bytes(message)).toBeGreaterThan(sizeCap);
		expect(all.map((page) => shown(page.chats))).toEqual([[`${big}:2001`], [`${small}:1001`]]);
	});
});

describe('list_unread across pages', () => {
	const [a, b, c] = [mid('u', '1'), mid('u', '2'), mid('u', '3')];
	const text = { text: 'x'.repeat(10_000) };

	/**
	 * Three chats whose messages fill two pages: the first ends inside `b`.
	 * `a` holds the highest message ID; without it, `a` would sort after `b`.
	 */
	async function threeChats() {
		const served = await serve();
		const { db } = served.session;
		store(
			served,
			...['1501', '1502', '3003'].map((id) => row('talk', a, id, text)),
			...['2001', '2002', '2003', '2004', '2005', '2006'].map((id) => row('talk', b, id, text)),
			row('talk', c, '1001', { ...text, sentAt: null }),
			...['1002', '1003'].map((id) => row('talk', c, id, text))
		);
		observeSnapshot(db, 'talk', a, '1500', null, clock);
		observeSnapshot(db, 'talk', b, '2000', null, clock);
		observeSnapshot(db, 'talk', c, '1000', null, clock);
		return served;
	}

	const all = [
		...['1501', '1502', '3003'].map((id) => `${a}:${id}`),
		...['2001', '2002', '2003', '2004', '2005', '2006'].map((id) => `${b}:${id}`),
		...['1001', '1002', '1003'].map((id) => `${c}:${id}`)
	];

	it.each([
		{ name: 'nothing', change: () => {}, expected: all },
		{
			name: 'a read of the next message',
			change: (served: Served) => advanceMarker(served.session.db, 'talk', b, '2004'),
			expected: all.filter((entry) => entry !== `${b}:2004`)
		},
		{
			name: 'new messages',
			change: (served: Served) =>
				store(served, row('talk', b, '2007', text), row('talk', c, '1004', text)),
			expected: all
		},
		{
			name: "an unsend of a listed chat's newest",
			change: (served: Served) =>
				apply(served, { kind: 'unsend', service: 'talk', chatId: a, messageId: '3003' }),
			expected: all
		},
		{
			name: 'a message that gains its send time',
			change: (served: Served) =>
				store(served, row('talk', c, '1001', { ...text, sentAt: clock * 2 })),
			expected: all
		},
		{
			name: 'an edit of a message not yet listed',
			change: (served: Served) =>
				store(served, row('talk', c, '1002', { text: 'edited', editedAt: clock * 2 })),
			expected: all
		}
	])('neither skips, repeats nor reorders after $name', async ({ change, expected }) => {
		const served = await threeChats();

		const result = await pages(served, () => change(served));

		expect(result).toHaveLength(2);
		expect(result[1]!.chats[0]).toMatchObject({ chat_id: b, continued: true });
		expect(listed(result)).toEqual(expected);
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
			return shown((await unread(served)).chats);
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
		expect(shown((await unread(served)).chats)).toEqual([`${otherMid}:2,3`]);

		db.exec('DROP TRIGGER crash');
		await syncTalkOnce(context);
		expect((await unread(served)).chats).toEqual([]);
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
		const page = await unread(served);

		const asOf = renderTime(clock);
		const unknown = (chatId: string, line?: number) => ({
			chat_id: chatId,
			type: 'user',
			messages_unknown: true,
			...(line === undefined ? {} : { line_unread_count: line, line_unread_as_of: asOf })
		});
		// toEqual counts a field left out the same as one set to undefined.
		expect(
			page.chats.map((chat) => ({
				chat_id: chat.chat_id,
				type: chat.type,
				messages_unknown: chat.messages_unknown,
				unread_count: chat.unread_count,
				line_unread_count: chat.line_unread_count,
				line_unread_as_of: chat.line_unread_as_of,
				messages: chat.messages
			}))
		).toEqual([
			unknown(zeroCount, 0),
			unknown(none),
			{
				chat_id: newChat,
				type: 'group',
				unread_count: 0,
				line_unread_count: 2,
				line_unread_as_of: asOf,
				messages: []
			},
			unknown(zero, 3),
			unknown(absent),
			unknown(empty),
			unknown(padded)
		]);
		expect(context.logs).toEqual([
			{ event: 'read_marker_ignored', service: 'talk', kind: 'non_canonical' }
		]);
	});

	it("reports LINE's count only while it belongs to the current read position", async () => {
		const served = await serve({
			getMessageBoxes: boxes(() => [
				{ id: otherMid, midType: 'USER', lastSeenMessageId: 10n, unreadCount: 2n }
			]),
			sync: batches([checked('11')])
		});
		store(served, ...['10', '11', '12'].map((id) => row('talk', otherMid, id)));
		const context = contextOf(served);

		await snapshotTalkReadState(context, new Pool(1));
		expect((await unread(served)).chats).toMatchObject([{ line_unread_count: 2 }]);
		await syncTalkOnce(context);

		const [chat] = (await unread(served)).chats;
		expect(shown([chat!])).toEqual([`${otherMid}:12`]);
		expect(chat).not.toHaveProperty('line_unread_count');
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

		expect((await unread(served)).chats).toMatchObject([
			{ line_unread_count: 3, line_unread_as_of: renderTime(clock + 1000) }
		]);
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

		expect((await unread(served)).chats).toEqual([
			expect.objectContaining({
				chat_id: squareChat,
				unread_count: 1,
				line_unread_count: 1,
				line_unread_as_of: renderTime(clock)
			}),
			expect.objectContaining({
				chat_id: other,
				messages_unknown: true,
				line_unread_count: 2,
				line_unread_as_of: renderTime(clock + 1000)
			})
		]);
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
		const before = await unread(served);

		await syncSquareOnce(context, { ...noSweep, maxTargets: 0 });

		expect(before.chats).toMatchObject([{ line_unread_count: 1 }]);
		expect((await unread(served)).chats).toEqual(before.chats);
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

		expect(shown((await unread(served)).chats)).toEqual([
			known ? `${squareChat}:21` : `${squareChat}:?`
		]);
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
		expect(shown((await unread(served)).chats)).toEqual([`${squareChat}:2,3`]);

		db.exec('DROP TRIGGER crash');
		await syncSquareOnce(context, { ...noSweep, maxTargets: 0 });
		expect((await unread(served)).chats).toEqual([]);
	});
});

describe('read state migration', () => {
	it('upgrades a populated archive of schema 7 and lists its chats as unknown', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const db = openDatabase(root);
		const message = row('talk', otherMid, '1001');
		transaction(db, () => applyChanges(db, [{ kind: 'message', row: message }]));
		db.exec('DROP TABLE read_state; DROP INDEX message_numeric_order; PRAGMA user_version = 7');
		db.close();

		const served = await serve({}, undefined, { root });
		const page = await callTool(served.server.port, 'read_messages', {
			service: 'talk',
			chat_id: otherMid
		});

		expect(shown((await unread(served)).chats)).toEqual([`${otherMid}:?`]);
		expect(page.data.messages).toMatchObject([{ message_id: '1001', text: message.text }]);
	});
});
