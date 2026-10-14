import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { InternalError } from '@evex/linejs/base';
import type { Message } from '@evex/linejs-types';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { archiveStatus, upsertChat, upsertParticipant } from '../src/archive.ts';
import { transaction } from '../src/db.ts';
import { getAttachment, writeAll } from '../src/mcp/tools/upstream.ts';
import { Outbox } from '../src/outbox.ts';
import { type ChatPage, sizeCap } from '../src/queries.ts';
import type { SqliteStorage } from '../src/storage.ts';
import { Pool } from '../src/sync/loop.ts';
import {
	applyChanges,
	type Change,
	encodeEnvelope,
	type MessageRow
} from '../src/sync/normalize.ts';
import {
	groupMid,
	type KeyPair,
	keyPair,
	otherMid,
	selfMid,
	storedKey,
	talkError
} from './fake-line.ts';
import { callTool, message, post, serve } from './mcp-client.ts';

// Local times below are Berlin's, whatever zone the machine running the tests has.
vi.hoisted(() => {
	process.env.TZ = 'Europe/Berlin';
});

const square = `m${'d'.repeat(32)}`;
const thread = `t${'e'.repeat(32)}`;
const member = `p${'f'.repeat(32)}`;
/** 2026-10-12 04:30 UTC, 06:30 in Berlin. */
const base = Date.UTC(2026, 9, 12, 4, 30);

function row(id: string, sentAt: number | null, text: string, extra: Partial<MessageRow> = {}) {
	return {
		service: 'talk',
		chatId: otherMid,
		chatType: 'user',
		messageId: id,
		threadId: null,
		sender: otherMid,
		sentAt,
		editedAt: null,
		contentType: 'NONE',
		text,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id, text }),
		decryptState: 'ok',
		missingKey: null,
		...extra
	} satisfies MessageRow;
}

function apply(db: DatabaseSync, ...changes: Change[]): void {
	transaction(db, () => applyChanges(db, changes));
}

function store(db: DatabaseSync, ...rows: MessageRow[]): void {
	apply(db, ...rows.map((entry) => ({ kind: 'message' as const, row: entry })));
}

/** A Square chat message, `minute`s after `base`, in the chat or in `thread`. */
function squareRow(id: string, minute: number, threadId: string | null): MessageRow {
	return row(id, base + minute * 60_000, `${threadId ? '討論串' : '聊天室'} ${id}`, {
		service: 'square',
		chatId: square,
		chatType: 'square',
		threadId,
		sender: member
	});
}

/** An image message whose retained envelope names its file. */
function media(id: string): MessageRow {
	return row(id, base, '', {
		text: null,
		contentType: 'IMAGE',
		envelope: JSON.stringify({
			id,
			from: otherMid,
			to: selfMid,
			toType: 'USER',
			contentType: 'IMAGE',
			contentMetadata: { FILE_NAME: 'photo.png', FILE_SIZE: '7' }
		})
	});
}

/** An image message whose envelope carries no file name or size. */
function unnamed(id: string): MessageRow {
	const entry = media(id);
	const envelope = JSON.parse(entry.envelope) as { contentMetadata: object };
	envelope.contentMetadata = {};
	return { ...entry, envelope: JSON.stringify(envelope) };
}

/** A pool that counts its waiting calls and holds each call's signal only weakly. */
class WatchedPool extends Pool {
	waiting = 0;
	readonly calls: WeakRef<AbortSignal>[] = [];

	override async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal) this.calls.push(new WeakRef(signal));
		this.waiting += 1;
		let started = false;
		try {
			return await super.run(() => {
				started = true;
				this.waiting -= 1;
				return task();
			}, signal);
		} finally {
			if (!started) this.waiting -= 1;
		}
	}
}

const ids = (messages: unknown) =>
	(messages as { message_id: string }[]).map((entry) => entry.message_id);

const chatMid = (index: number) => `u${index.toString(16).padStart(32, '0')}`;

/** list_chats, by chat ID. */
async function listed(port: number) {
	const { chats } = (await callTool(port, 'list_chats')).data as unknown as ChatPage;
	return Object.fromEntries(chats.map((chat) => [chat.chat_id, chat]));
}

/** The newest message read_messages shows for a chat. */
async function newest(port: number, service: string, chatId: string) {
	const page = await callTool(port, 'read_messages', { service, chat_id: chatId });
	return (page.data.messages as unknown[]).at(-1);
}

const bowls = (count: number) => '🍜'.repeat(count);

describe('MCP transport', () => {
	it('refuses any Origin and any Host but this listener', async () => {
		const { server } = await serve();
		const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
		const { port } = server;

		for (const origin of [
			`http://127.0.0.1:${port}`,
			`http://localhost:${port}`,
			'http://localhost:3000',
			'null',
			'https://example.com'
		]) {
			const result = await post(port, list, { origin });
			expect([origin, result.status]).toEqual([origin, 403]);
			expect(result.headers['access-control-allow-origin']).toBeUndefined();
		}
		for (const host of [
			'example.com',
			`example.com:${port}`,
			`127.0.0.1:${port + 1}`,
			'127.0.0.1',
			'localhost',
			`[::1]:${port}`
		]) {
			expect([host, (await post(port, list, { host })).status]).toEqual([host, 403]);
		}
		for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
			const result = await post(port, list, { host });
			expect(result.status).toBe(200);
			expect(message(result).result).toMatchObject({ tools: expect.any(Array) });
		}
		const preflight = await post(port, undefined, {}, 'OPTIONS');
		expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
	});

	it(
		'drops the queued work of 1,000 abandoned tool calls and keeps none of their requests alive',
		{ timeout: 30_000 },
		async () => {
			setFlagsFromString('--expose-gc');
			const gc = runInNewContext('gc') as () => void;
			const { promise: gate, resolve: release } = Promise.withResolvers<void>();
			onTestFinished(() => release());
			let lookups = 0;
			const pool = new WatchedPool(2);
			const { server, logs } = await serve(
				{
					getContactsV2: async () => {
						lookups += 1;
						await gate;
						return {
							contacts: { [otherMid]: { contact: { mid: otherMid, displayName: '王小明' } } }
						};
					}
				},
				undefined,
				{ pool }
			);
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'get_profile', arguments: { id: otherMid } }
			});
			const raw = [
				'POST /mcp HTTP/1.1',
				`Host: 127.0.0.1:${server.port}`,
				'MCP-Protocol-Version: 2025-06-18',
				'Content-Type: application/json',
				'Accept: application/json, text/event-stream',
				`Content-Length: ${Buffer.byteLength(body)}`,
				'',
				body
			].join('\r\n');
			/** Sends one call and keeps its connection open. */
			const send = () =>
				new Promise<Socket>((resolve) => {
					const socket = connect(server.port, '127.0.0.1');
					socket.on('error', () => {});
					socket.on('connect', () => {
						socket.write(raw);
						resolve(socket);
					});
				});
			// The server may lag far behind the clients on a loaded machine, so the
			// test waits for what the server did, never for a fixed time.
			const wait = { timeout: 10_000, interval: 5 };
			const cancelled = () =>
				logs.filter((entry) => entry.event === 'tool_failed' && entry.code === 'cancelled').length;

			// The first two calls hold both pool slots.
			await Promise.all([send(), send()]);
			await vi.waitFor(() => expect(lookups).toBe(2), wait);
			// Every later call queues, then its client goes away before an answer.
			for (let batch = 0; batch < 20; batch++) {
				const sockets = await Promise.all(Array.from({ length: 50 }, send));
				await vi.waitFor(() => expect(pool.waiting).toBe(50), wait);
				for (const socket of sockets) socket.destroy();
				await vi.waitFor(() => expect(pool.waiting).toBe(0), wait);
			}
			expect(cancelled()).toBe(1000);
			// Nothing keeps an abandoned call alive; only the two running ones stay.
			// Node's Date header cache timer keeps the async context of the request
			// that started it for up to a second, so the count may take that long.
			await vi.waitFor(
				() => {
					gc();
					expect(pool.calls.filter((call) => call.deref() !== undefined).length).toBe(2);
				},
				{ ...wait, interval: 50 }
			);

			release();
			// The slots came back and no queued call reached LINE: the next one runs at once.
			const next = await callTool(server.port, 'get_profile', { id: otherMid });
			expect(next.data.profile).toMatchObject({ display_name: '王小明' });
			expect(lookups).toBe(3);
		}
	);
});

describe('list_chats', () => {
	it('names the own chat after the stored profile name, or Keep Memo', async () => {
		const { server, session } = await serve();
		upsertChat(session.db, { service: 'talk', chatId: selfMid, type: 'user' });
		// The label also matches the name filter.
		const memo = await callTool(server.port, 'list_chats', { name: 'memo' });
		expect(memo.data.chats).toEqual([
			expect.objectContaining({ chat_id: selfMid, name: 'Keep Memo' })
		]);
		upsertParticipant(session.db, 'talk', selfMid, '我的記事本');
		expect((await callTool(server.port, 'list_chats')).data.chats).toEqual([
			expect.objectContaining({ chat_id: selfMid, name: '我的記事本' })
		]);
	});

	it("shows each chat's newest message as read_messages shows it, threads included", async () => {
		const { server, session } = await serve();
		const { db } = session;
		const untimed = chatMid(1);
		const tied = chatMid(2);
		const sticker = chatMid(3);
		const empty = chatMid(4);
		const sent = (id: string, sentAt: number | null, chatId: string, text = `訊息 ${id}`) =>
			row(id, sentAt, text, { chatId, sender: chatId });
		store(
			db,
			sent('10', base, otherMid),
			sent('11', base + 1000, otherMid, '明天見'),
			squareRow('20', 0, null),
			squareRow('21', 2, thread),
			squareRow('22', 1, null),
			// A message without a send time sorts as the oldest.
			sent('30', base, untimed),
			sent('31', null, untimed),
			// The same send time: the one archived later is newer, whatever its ID.
			sent('41', base, tied),
			sent('40', base, tied),
			row('50', base, '', {
				chatId: sticker,
				sender: sticker,
				contentType: 'STICKER',
				text: null,
				envelope: JSON.stringify({
					id: '50',
					contentType: 'STICKER',
					contentMetadata: { STKID: '1', STKTXT: '[OK]' }
				})
			})
		);
		upsertChat(db, { service: 'talk', chatId: empty, type: 'user' });

		const chats = await listed(server.port);
		const latest = Object.fromEntries(
			Object.values(chats).map((chat) => [chat.chat_id, chat.last_message?.message_id])
		);
		expect(latest).toEqual({
			[otherMid]: '11',
			[square]: '21',
			[untimed]: '30',
			[tied]: '40',
			[sticker]: '50',
			[empty]: undefined
		});
		expect(chats[empty]).not.toHaveProperty('last_message');
		expect(chats[sticker]!.last_message).toMatchObject({
			content_type: 'sticker',
			alt_text: '[OK]'
		});
		expect(chats[square]!.last_message).toMatchObject({ thread_id: thread });
		for (const chat of Object.values(chats).filter((entry) => entry.last_message)) {
			expect(chat.last_message).toEqual(await newest(server.port, chat.service, chat.chat_id));
		}
		expect(chats[otherMid]!.last_message).not.toHaveProperty('service');
		expect(chats[otherMid]!.last_message).not.toHaveProperty('chat_id');
	});

	it('shows an unsent latest message as unsent, without text', async () => {
		const { server, session } = await serve();
		store(session.db, row('60', base, '早安'), row('61', base + 1000, '打錯了'));
		apply(session.db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '61' });

		const { last_message } = (await listed(server.port))[otherMid]!;
		expect(last_message).toMatchObject({ message_id: '61', unsent: true });
		expect(last_message).not.toHaveProperty('text');
		expect(last_message).toEqual(await newest(server.port, 'talk', otherMid));
	});

	it('cuts the text to 200 code points without splitting a character', async () => {
		const { server, session } = await serve();
		const long = chatMid(1);
		const exact = chatMid(2);
		store(
			session.db,
			row('70', base, `a${bowls(249)}`, { chatId: long }),
			row('71', base, bowls(200), { chatId: exact })
		);

		const chats = await listed(server.port);
		expect(chats[long]!.last_message).toMatchObject({
			text: `a${bowls(199)}…`,
			text_truncated: true
		});
		expect(chats[exact]!.last_message).toMatchObject({ text: bowls(200) });
		expect(chats[exact]!.last_message).not.toHaveProperty('text_truncated');
		expect(chats[exact]!.last_message).toEqual(await newest(server.port, 'talk', exact));
	});

	it('counts the latest messages toward the size cap and pages every chat once', async () => {
		const { server, session } = await serve();
		const all = Array.from({ length: 200 }, (_, index) => chatMid(index + 1));
		store(
			session.db,
			...all.map((chatId, index) =>
				row(String(900 + index), base + index * 1000, '長'.repeat(300), { chatId })
			)
		);

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = (
				await callTool(server.port, 'list_chats', { limit: 200, ...(cursor ? { cursor } : {}) })
			).data as unknown as ChatPage;
			if (pages === 0) expect(page.size_capped).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(page.chats))).toBeLessThanOrEqual(sizeCap);
			expect(page.chats.every((chat) => chat.last_message?.text_truncated)).toBe(true);
			seen.push(...page.chats.map((chat) => chat.chat_id));
			cursor = page.next_cursor;
			pages += 1;
		} while (cursor);
		expect(pages).toBeGreaterThan(1);
		// Newest activity first, each chat exactly once.
		expect(seen).toEqual(all.toReversed());
	});
});

describe('read_messages', () => {
	it('pages over more than 200 messages returning each exactly once, both ways', async () => {
		// 450 messages in groups of three with the same send time, plus two
		// tombstones without one, so pages split inside ties.
		const { server, session } = await serve();
		const all: string[] = [];
		const rows: MessageRow[] = [];
		for (let index = 0; index < 450; index++) {
			const id = String(700000000000000000n + BigInt(index));
			all.push(id);
			rows.push(row(id, base + Math.floor(index / 3) * 1000, `訊息 ${index}`));
		}
		// One commit: each one costs about 10 ms of fsync on Windows CI.
		store(session.db, ...rows);
		for (const id of ['690000000000000001', '690000000000000002']) {
			apply(session.db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: id });
			all.push(id);
		}
		for (const limit of [200, 7]) {
			const older: string[] = [];
			let page = (
				await callTool(server.port, 'read_messages', {
					service: 'talk',
					chat_id: otherMid,
					limit
				})
			).data;
			older.unshift(...ids(page.messages));
			let oldest = page;
			while (page.older_cursor) {
				page = (
					await callTool(server.port, 'read_messages', {
						service: 'talk',
						chat_id: otherMid,
						limit,
						cursor: page.older_cursor
					})
				).data;
				older.unshift(...ids(page.messages));
				if ((page.messages as unknown[]).length) oldest = page;
			}
			expect(older).toHaveLength(all.length);
			expect(new Set(older)).toEqual(new Set(all));

			// From the oldest page forward to the newest, then nothing newer.
			const newer = [...ids(oldest.messages)];
			page = oldest;
			while (page.has_newer) {
				page = (
					await callTool(server.port, 'read_messages', {
						service: 'talk',
						chat_id: otherMid,
						limit,
						cursor: page.newer_cursor
					})
				).data;
				newer.push(...ids(page.messages));
			}
			expect(newer).toEqual(older);
			const after = await callTool(server.port, 'read_messages', {
				service: 'talk',
				chat_id: otherMid,
				cursor: page.newer_cursor
			});
			expect(after.data).toMatchObject({ messages: [], has_newer: false });
			expect(after.data.newer_cursor).toBe(page.newer_cursor);
		}
	});

	it('centres a page on around_message_id and filters a thread', async () => {
		const { server, session } = await serve();
		const { db } = session;
		// Chat messages 500-508 at minutes 0-8, thread messages 600-603 at minutes
		// 1, 3, 5 and 7; at the same minute the later stored row comes later.
		store(
			db,
			...Array.from({ length: 9 }, (_, index) => squareRow(`50${index}`, index, null)),
			...Array.from({ length: 4 }, (_, index) => squareRow(`60${index}`, index * 2 + 1, thread))
		);

		const around = await callTool(server.port, 'read_messages', {
			service: 'square',
			chat_id: square,
			around_message_id: '504',
			limit: 5
		});
		expect(ids(around.data.messages)).toEqual(['503', '601', '504', '505', '602']);
		expect(around.data).toMatchObject({ has_newer: true });
		expect(around.data.older_cursor).toEqual(expect.any(String));

		const threadPage = await callTool(server.port, 'read_messages', {
			service: 'square',
			chat_id: square,
			thread_id: thread
		});
		expect(ids(threadPage.data.messages)).toEqual(['600', '601', '602', '603']);
		const inThread = await callTool(server.port, 'read_messages', {
			service: 'square',
			chat_id: square,
			thread_id: thread,
			around_message_id: '601',
			limit: 3
		});
		expect(ids(inThread.data.messages)).toEqual(['600', '601', '602']);
	});

	it('splits a page at the size cap and continues without losing a message', async () => {
		const { server, session } = await serve();
		const big = '長'.repeat(4000);
		store(
			session.db,
			...Array.from({ length: 40 }, (_, index) =>
				row(String(800 + index), base + index * 1000, `${index} ${big}`)
			)
		);
		const seen: string[] = [];
		let page = (
			await callTool(server.port, 'read_messages', {
				service: 'talk',
				chat_id: otherMid
			})
		).data;
		expect(page.size_capped).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(sizeCap);
		seen.unshift(...ids(page.messages));
		while (page.older_cursor) {
			page = (
				await callTool(server.port, 'read_messages', {
					service: 'talk',
					chat_id: otherMid,
					cursor: page.older_cursor
				})
			).data;
			seen.unshift(...ids(page.messages));
		}
		expect(seen).toEqual(Array.from({ length: 40 }, (_, index) => String(800 + index)));
	});

	it('shows names from the archive, Chinese text unchanged, and times in the local zone', async () => {
		const { server, session } = await serve();
		const { db } = session;
		transaction(db, () => {
			upsertChat(db, { service: 'talk', chatId: otherMid, type: 'user' });
			upsertParticipant(db, 'talk', otherMid, '王小明');
			db.prepare(
				`INSERT INTO sync_state (key, value, updated_at) VALUES ('talk:syncedAt', ?, 0)`
			).run(String(base));
		});
		store(
			db,
			row('900', base, '今天晚上吃什麼？🍜'),
			row('901', base + 1, '好', { sender: selfMid })
		);

		const chats = await callTool(server.port, 'list_chats', { name: '小明' });
		expect(chats.data.chats).toEqual([
			expect.objectContaining({ chat_id: otherMid, name: '王小明' })
		]);
		const read = await callTool(server.port, 'read_messages', {
			service: 'talk',
			chat_id: otherMid
		});
		expect(read.data).toMatchObject({
			stale: true,
			synced_at: { talk: '2026-10-12T06:30:00.000+02:00' },
			chat: { name: '王小明' },
			messages: [
				{
					text: '今天晚上吃什麼？🍜',
					sender_name: '王小明',
					from_self: false,
					sent_at: '2026-10-12T06:30:00.000+02:00'
				},
				{ text: '好', from_self: true }
			]
		});
		expect(read.text).toContain('今天晚上吃什麼？🍜');
	});

	it('refuses a cursor issued for other filters', async () => {
		const { server, session } = await serve();
		store(session.db, row('1', base, 'a'), row('2', base + 1, 'b'));
		const page = await callTool(server.port, 'read_messages', {
			service: 'talk',
			chat_id: otherMid,
			limit: 1
		});
		const misused = await callTool(server.port, 'read_messages', {
			service: 'talk',
			chat_id: groupMid,
			cursor: page.data.older_cursor
		});
		expect(misused).toMatchObject({ isError: true, data: { error: { code: 'invalid_cursor' } } });
	});
});

describe('search_messages', () => {
	it('finds one- and two-character queries by scanning, longer ones through the index', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base, '今天晚上吃什麼'),
			row('2', base + 1, '明天見'),
			row('3', base + 2, 'see you')
		);

		const short = await callTool(server.port, 'search_messages', { query: '晚上' });
		expect(short.data).toMatchObject({ mode: 'scan', scanned_through: null, next_cursor: null });
		expect(ids(short.data.messages)).toEqual(['1']);
		const single = await callTool(server.port, 'search_messages', {
			query: '天',
			service: 'talk',
			chat_id: otherMid
		});
		expect(single.data).toMatchObject({ mode: 'scan', scanned_through: null });
		expect(ids(single.data.messages)).toEqual(['2', '1']);
		const long = await callTool(server.port, 'search_messages', { query: '晚上吃' });
		expect(long.data).toMatchObject({ mode: 'fts' });
		expect(ids(long.data.messages)).toEqual(['1']);
	});

	it('matches every word in any order and a quoted phrase as written', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base, 'dinner 明天見 at seven'),
			row('2', base + 1, '明天見, then dinner'),
			row('3', base + 2, 'dinner only'),
			row('4', base + 3, 'see you there'),
			row('5', base + 4, 'you will see')
		);
		const search = async (query: string) =>
			ids((await callTool(server.port, 'search_messages', { query })).data.messages);

		expect(await search('dinner 明天見')).toEqual(['2', '1']);
		expect(await search('明天見 dinner')).toEqual(['2', '1']);
		expect(await search('see you')).toEqual(['5', '4']);
		expect(await search('"see you"')).toEqual(['4']);
		// U+3000, the ideographic space, separates words too.
		expect(await search('明天見　seven')).toEqual(['1']);
	});

	it('searches AND, NEAR, *, _ and % as text', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base, 'cats AND dogs'),
			row('2', base + 1, 'cats and the dogs'),
			row('3', base + 2, 'NEAR the station'),
			row('4', base + 3, 'wow* indeed'),
			row('5', base + 4, 'wowza'),
			row('6', base + 5, '5 * 3'),
			row('7', base + 6, 'snake_case'),
			row('8', base + 7, '100%')
		);
		const search = async (query: string) =>
			ids((await callTool(server.port, 'search_messages', { query })).data.messages);

		expect(await search('"cats AND dogs"')).toEqual(['1']);
		expect(await search('NEAR')).toEqual(['3']);
		expect(await search('wow*')).toEqual(['4']);
		expect(await search('*')).toEqual(['6', '4']);
		expect(await search('_')).toEqual(['7']);
		expect(await search('%')).toEqual(['8']);
	});

	it('refuses an unclosed quote, an empty query and more than ten words', async () => {
		const { server } = await serve();
		const words = Array.from({ length: 11 }, (_, i) => `w${i}`);
		for (const query of ['"see you', 'dinner "', '" "', words.join(' ')]) {
			const result = await callTool(server.port, 'search_messages', { query });
			expect(result, query).toMatchObject({
				isError: true,
				data: { error: { code: 'invalid_argument' } }
			});
		}
		const ten = await callTool(server.port, 'search_messages', {
			query: words.slice(0, 10).join(' ')
		});
		expect(ten).toMatchObject({ data: { messages: [] } });
		expect(ten.isError).toBeFalsy();
	});

	it('matches one- and two-character terms, ASCII in any case, alone or with longer words', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base, 'OKAY, 晚上見'),
			row('2', base + 1, 'dinner OK'),
			row('3', base + 2, 'dinner later'),
			row('4', base + 3, '早'),
			// No send time: read after every message that has one.
			row('5', null, '早安'),
			row('6', base + 4, 'line one\u0000ok')
		);
		const search = async (query: string) =>
			(await callTool(server.port, 'search_messages', { query })).data;

		expect(await search('ok')).toMatchObject({ mode: 'scan' });
		expect(ids((await search('ok')).messages)).toEqual(['6', '2', '1']);
		expect(ids((await search('okay')).messages)).toEqual(['1']);
		expect(ids((await search('早')).messages)).toEqual(['4', '5']);
		expect(ids((await search('晚上 ok')).messages)).toEqual(['1']);
		const mixed = await search('dinner ok');
		expect(mixed).toMatchObject({ mode: 'fts' });
		expect(ids(mixed.messages)).toEqual(['2']);
	});

	it('scans back in bounded pages that may hold no hits, skipping and repeating nothing', async () => {
		const { server, session } = await serve();
		const { db } = session;
		// The message of rank r (1 the newest) was sent at top - r. Hits sit at
		// ranks 1, 50,000 (the last row the first page reads) and 100,001;
		// text-less rows fill the rest.
		const top = 10_000_000;
		db.prepare(
			`WITH RECURSIVE n(r) AS (SELECT 2 UNION ALL SELECT r + 1 FROM n WHERE r < 100000)
			INSERT INTO message (service, chat_id, message_id, sent_at, envelope, decrypt_state, seq)
			SELECT 'talk', ?, 'filler' || r, ? - r, '{}', 'ok', 1000000 + r FROM n
			WHERE r != 50000`
		).run(otherMid, top);
		store(
			db,
			row('new', top - 1, '罕 new'),
			row('edge', top - 50_000, '罕 edge'),
			row('old', top - 100_001, '罕 old')
		);

		const pages: Record<string, unknown>[] = [];
		let cursor: unknown;
		do {
			const { data } = await callTool(server.port, 'search_messages', {
				query: '罕',
				...(cursor ? { cursor } : {})
			});
			pages.push(data);
			cursor = data.next_cursor;
		} while (cursor && pages.length < 5);

		expect(pages.map((page) => ids(page.messages))).toEqual([['new', 'edge'], [], ['old']]);
		expect(
			pages.map((page) =>
				page.scanned_through === null ? null : Date.parse(page.scanned_through as string)
			)
		).toEqual([top - 50_000, top - 100_000, null]);
	});

	it('pages results with a cursor, each once, and never shows unsent text', async () => {
		const { server, session } = await serve();
		const { db } = session;
		store(
			db,
			...Array.from({ length: 5 }, (_, index) => row(String(10 + index), base, `晚餐 ${index}`))
		);
		apply(db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '12' });
		const seen: string[] = [];
		let page = (await callTool(server.port, 'search_messages', { query: '晚餐', limit: 2 })).data;
		seen.push(...ids(page.messages));
		while (page.next_cursor) {
			page = (
				await callTool(server.port, 'search_messages', {
					query: '晚餐',
					limit: 2,
					cursor: page.next_cursor
				})
			).data;
			seen.push(...ids(page.messages));
		}
		expect(seen).toEqual(['14', '13', '11', '10']);
	});

	it('refuses a cursor replayed with another query', async () => {
		const { server, session } = await serve();
		store(session.db, row('1', base, 'dinner 明天見'), row('2', base + 1, 'dinner 明天見'));
		const page = await callTool(server.port, 'search_messages', {
			query: 'dinner 明天見',
			limit: 1
		});
		const misused = await callTool(server.port, 'search_messages', {
			query: 'dinner',
			cursor: page.data.next_cursor
		});
		expect(misused).toMatchObject({ isError: true, data: { error: { code: 'invalid_cursor' } } });
	});

	it('keeps messages sent from since up to before until, in any offset, scanned or indexed', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base - 1, '晚餐吃 ok'),
			row('2', base, '晚餐吃 ok'),
			row('3', base + 59_999, '晚餐吃 ok'),
			row('4', base + 60_000, '晚餐吃 ok'),
			row('5', null, '晚餐吃 ok')
		);
		const search = async (query: string, bounds: Record<string, string>) => {
			const { data } = await callTool(server.port, 'search_messages', { query, ...bounds });
			return [data.mode, ids(data.messages)];
		};

		for (const [query, mode] of [
			['晚餐吃', 'fts'],
			['ok', 'scan']
		]) {
			// base is 04:30 UTC, 06:30 in Berlin.
			expect(
				await search(query!, { since: '2026-10-12T06:30:00+02:00', until: '2026-10-12T04:31:00Z' })
			).toEqual([mode, ['3', '2']]);
			expect(await search(query!, { since: '2026-10-12T04:30:00.000Z' })).toEqual([
				mode,
				['4', '3', '2']
			]);
			expect(await search(query!, { until: '2026-10-12T00:31:00-04:00' })).toEqual([
				mode,
				['3', '2', '1']
			]);
			expect(await search(query!, {})).toEqual([mode, ['4', '3', '2', '1', '5']]);
		}
	});

	it('scans from until and stops at since without a cursor', async () => {
		const { server, session } = await serve();
		const { db } = session;
		// The message of rank r (1 the newest) was sent at top - r; hits at ranks 1, 20,000 and 55,000.
		const top = 10_000_000;
		db.prepare(
			`WITH RECURSIVE n(r) AS (SELECT 2 UNION ALL SELECT r + 1 FROM n WHERE r < 60000)
			INSERT INTO message (service, chat_id, message_id, sent_at, envelope, decrypt_state, seq)
			SELECT 'talk', ?, 'filler' || r, ? - r, '{}', 'ok', 1000000 + r FROM n
			WHERE r NOT IN (20000, 55000)`
		).run(otherMid, top);
		store(
			db,
			row('new', top - 1, '罕 new'),
			row('mid', top - 20_000, '罕 mid'),
			row('old', top - 55_000, '罕 old')
		);
		const at = (rank: number) => new Date(top - rank).toISOString();
		const search = async (bounds: Record<string, string>) =>
			(await callTool(server.port, 'search_messages', { query: '罕', ...bounds })).data;

		// One page reads 50,000 messages: without since it would continue with a cursor.
		const recent = await search({ since: at(30_000) });
		expect(ids(recent.messages)).toEqual(['new', 'mid']);
		expect(recent).toMatchObject({ next_cursor: null, scanned_through: null });
		// Starting at until, one page reaches the oldest message.
		const older = await search({ until: at(10_000) });
		expect(ids(older.messages)).toEqual(['mid', 'old']);
		expect(older).toMatchObject({ next_cursor: null, scanned_through: null });
	});

	it('keeps only the messages of sender_id, own ones by the account MID', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			row('1', base, '晚餐吃 ok'),
			row('2', base + 1, '晚餐吃 ok', { sender: selfMid }),
			row('3', base + 2, '晚餐吃 ok'),
			row('4', base + 3, '晚餐吃 ok', { chatId: groupMid, chatType: 'group', sender: selfMid })
		);
		for (const query of ['晚餐吃', 'ok']) {
			const from = async (sender: string) =>
				(await callTool(server.port, 'search_messages', { query, sender_id: sender })).data
					.messages as { message_id: string; from_self: boolean }[];

			expect(ids(await from(otherMid))).toEqual(['3', '1']);
			const own = await from(selfMid);
			expect(ids(own)).toEqual(['4', '2']);
			expect(own.every((hit) => hit.from_self)).toBe(true);
			expect(ids(await from(`u${'0'.repeat(32)}`))).toEqual([]);
		}
	});

	it('adds context from the same chat and thread as read_messages shows it', async () => {
		const { server, session } = await serve();
		const { db } = session;
		store(
			db,
			squareRow('t1', 0, thread),
			{ ...squareRow('m1', 1, null), text: '關鍵字 m1' },
			squareRow('t2', 2, thread),
			{ ...squareRow('t3', 3, thread), text: '關鍵字 t3' },
			// Another OpenChat, between m1 and m2.
			{ ...squareRow('o1', 1.5, null), chatId: `m${'9'.repeat(32)}` },
			squareRow('m2', 4, null),
			squareRow('m3', 5, null),
			squareRow('t4', 6, thread),
			squareRow('m4', 7, null)
		);
		apply(db, { kind: 'unsend', service: 'square', chatId: square, messageId: 'm3' });
		const shown = new Map(
			(
				(await callTool(server.port, 'read_messages', { service: 'square', chat_id: square })).data
					.messages as { message_id: string }[]
			).map((entry) => [entry.message_id, entry])
		);
		const shownAs = (...messageIds: string[]) => messageIds.map((id) => shown.get(id));

		const { data } = await callTool(server.port, 'search_messages', {
			query: '關鍵字',
			context: 2
		});

		expect(data.messages).toMatchObject([
			{ message_id: 't3', context_before: shownAs('t1', 't2'), context_after: shownAs('t4') },
			{ message_id: 'm1', context_before: [], context_after: shownAs('m2', 'm3') }
		]);
		expect(shown.get('m3')).toMatchObject({ unsent: true });
		expect(shown.get('m3')).not.toHaveProperty('text');
		const plain = await callTool(server.port, 'search_messages', { query: '關鍵字' });
		expect(Object.keys((plain.data.messages as object[])[0]!)).not.toContain('context_before');
	});

	it('refuses a cursor replayed with another since, until, sender_id or context', async () => {
		const { server, session } = await serve();
		store(session.db, row('1', base, '晚餐吃'), row('2', base + 1, '晚餐吃'));
		const filters = {
			query: '晚餐吃',
			since: '2026-10-12T00:00:00Z',
			until: '2026-10-13T00:00:00Z',
			sender_id: otherMid,
			context: 1
		};
		const page = await callTool(server.port, 'search_messages', { ...filters, limit: 1 });
		const replay = (changed: Record<string, unknown>) =>
			callTool(server.port, 'search_messages', {
				...filters,
				...changed,
				cursor: page.data.next_cursor
			});

		expect(ids((await replay({})).data.messages)).toEqual(['1']);
		for (const changed of [
			{ since: '2026-10-11T00:00:00Z' },
			{ until: '2026-10-14T00:00:00Z' },
			{ sender_id: selfMid },
			{ context: 2 }
		]) {
			expect(await replay(changed), JSON.stringify(changed)).toMatchObject({
				isError: true,
				data: { error: { code: 'invalid_cursor' } }
			});
		}
	});

	it('sheds the farthest context of a hit too large for a page and continues after it', async () => {
		const { server, session } = await serve();
		const big = (id: string, at: number) => row(id, at, `${id} ${'長'.repeat(8000)}`);
		// Oldest first: a small hit in the group, then two hits among large messages.
		store(
			session.db,
			row('s1', base - 2000, 'small', { chatId: groupMid, chatType: 'group' }),
			row('h0', base - 1000, '關鍵字 h0', { chatId: groupMid, chatType: 'group' }),
			...['b1', 'b2', 'b3'].map((id, index) => big(id, base + index)),
			row('h1', base + 3, '關鍵字 h1'),
			...['b4', 'b5', 'b6'].map((id, index) => big(id, base + 4 + index)),
			row('h2', base + 7, '關鍵字 h2'),
			...['b7', 'b8', 'b9'].map((id, index) => big(id, base + 8 + index))
		);
		type Hit = {
			message_id: string;
			context_before: unknown;
			context_after: unknown;
			context_truncated?: boolean;
		};
		const page = async (cursor?: unknown) =>
			(
				await callTool(server.port, 'search_messages', {
					query: '關鍵字',
					context: 3,
					...(cursor ? { cursor } : {})
				})
			).data;
		const shape = (hit: Hit) => [
			hit.message_id,
			ids(hit.context_before),
			ids(hit.context_after),
			hit.context_truncated ?? false
		];

		const first = await page();
		expect(Buffer.byteLength(JSON.stringify(first.messages))).toBeLessThanOrEqual(sizeCap);
		expect((first.messages as Hit[]).map(shape)).toEqual([['h2', ['b6'], ['b7'], true]]);
		expect(first.size_capped).toBe(true);
		const second = await page(first.next_cursor);
		expect((second.messages as Hit[]).map(shape)).toEqual([
			['h1', ['b3'], ['b4'], true],
			['h0', ['s1'], [], false]
		]);
		expect(second.next_cursor).toBeNull();
	});

	it('refuses a time without an offset or finer than milliseconds, context above 3 and since not before until', async () => {
		const { server } = await serve();
		for (const args of [
			{ since: '2026-10-12T06:30:00' },
			{ until: '2026-10-12' },
			// Cut to milliseconds, either bound would move past a message sent at :00.000.
			{ since: '2026-10-12T04:30:00.0001Z' },
			{ until: '2026-10-12T04:30:00.0001+02:00' },
			{ context: 4 },
			{ sender_id: 'someone' }
		]) {
			// -32602: the tool's input schema refuses the arguments before the tool runs.
			await expect(
				callTool(server.port, 'search_messages', { query: '晚餐吃', ...args }),
				JSON.stringify(args)
			).rejects.toThrow('"code":-32602');
		}
		const empty = await callTool(server.port, 'search_messages', {
			query: '晚餐吃',
			since: '2026-10-12T04:30:00Z',
			until: '2026-10-12T06:30:00+02:00'
		});
		expect(empty).toMatchObject({ isError: true, data: { error: { code: 'invalid_argument' } } });
	});
});

describe('list_changes', () => {
	it('returns every change after after_seq once, and a row changed mid-paging again', async () => {
		const { server, session } = await serve();
		const { db } = session;
		store(db, ...['1', '2', '3', '4', '5'].map((id, index) => row(id, base + index, `v1 ${id}`)));

		const seen: [string, string | null, number][] = [];
		const take = (changes: unknown) => {
			for (const entry of changes as { message_id: string; text?: string; seq: number }[]) {
				seen.push([entry.message_id, entry.text ?? null, entry.seq]);
			}
		};
		let page = (await callTool(server.port, 'list_changes', { limit: 2 })).data;
		take(page.changes);
		// Changed while the caller pages: one row already returned, one still ahead.
		store(db, row('1', base, 'v2 1', { editedAt: base + 10 }));
		store(db, row('4', base + 3, 'v2 4', { editedAt: base + 10 }));
		apply(db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '2' });
		while (page.has_more) {
			page = (
				await callTool(server.port, 'list_changes', {
					after_seq: page.next_after_seq,
					limit: 2
				})
			).data;
			take(page.changes);
		}

		const seqs = seen.map(([, , seq]) => seq);
		expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
		expect(page.next_after_seq).toBe(page.latest_seq);
		// Every row's current version arrived, after any earlier one.
		const current = db
			.prepare('SELECT message_id, text, seq FROM message ORDER BY seq')
			.all()
			.map((entry) => [String(entry.message_id), entry.text, Number(entry.seq)]);
		for (const entry of current) expect(seen).toContainEqual(entry);
		expect(seen.filter(([id]) => id === '1').map(([, text]) => text)).toEqual(['v1 1', 'v2 1']);
		expect(seen.filter(([id]) => id === '2').at(-1)?.[1]).toBeNull();

		const idle = await callTool(server.port, 'list_changes', { after_seq: page.next_after_seq });
		expect(idle.data).toMatchObject({ changes: [], has_more: false });
		expect(idle.data.next_after_seq).toBe(page.next_after_seq);
	});
});

/** Every key and value inside `value`, depth first, with the object that holds it. */
function* walk(value: unknown): Generator<[string, unknown, object]> {
	if (typeof value !== 'object' || value === null) return;
	for (const [key, entry] of Object.entries(value)) {
		yield [key, entry, value];
		yield* walk(entry);
	}
}

const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

describe('result shape', () => {
	it('gives each time as one string with the local offset and leaves empty item fields out', async () => {
		const { server, session } = await serve();
		const { db } = session;
		const mention = JSON.stringify({ MENTIONEES: [{ S: '0', E: '3', M: selfMid }] });
		transaction(db, () => {
			upsertParticipant(db, 'talk', otherMid, '王小明');
			db.prepare(
				`INSERT INTO sync_state (key, value, updated_at) VALUES ('talk:syncedAt', ?, 0)`
			).run(String(base + 9));
		});
		store(
			db,
			row('1', base, '晚餐吃 plain'),
			row('2', base + 1, '晚餐吃 edited', { sender: selfMid, editedAt: base + 5 }),
			row('3', base + 2, '晚餐吃 @me', { mentions: mention }),
			row('4', base + 3, '', { text: null, decryptState: 'missing_key' }),
			row('5', base + 4, '晚餐吃 gone'),
			{ ...squareRow('6', 5, thread), text: '晚餐吃 thread' }
		);
		apply(db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '5' });
		const sentAt: Record<string, number> = {
			'1': base,
			'2': base + 1,
			'3': base + 2,
			'4': base + 3,
			'5': base + 4,
			'6': base + 5 * 60_000
		};

		const call = async (name: string, args: Record<string, unknown> = {}) =>
			(await callTool(server.port, name, args)).data;
		const read = await call('read_messages', { service: 'talk', chat_id: otherMid });
		const search = await call('search_messages', { query: '晚餐吃', context: 1 });
		const scan = await call('search_messages', { query: 'e', limit: 1 });
		const changes = await call('list_changes');
		const chats = await call('list_chats');
		const results = [read, search, scan, changes, chats, await call('status')];

		for (const result of results) {
			for (const [key, value, holder] of walk(result)) {
				expect(holder).not.toHaveProperty('utc');
				expect(holder).not.toHaveProperty('local');
				const isTime =
					(key.endsWith('_at') && key !== 'synced_at') ||
					key === 'scanned_through' ||
					holder === result.synced_at;
				if (isTime) {
					if (value !== null) expect(value).toMatch(time);
				}
				if (key === 'sent_at') {
					expect(Date.parse(value as string)).toBe(
						sentAt[(holder as { message_id: string }).message_id]
					);
				}
			}
		}
		expect(read.synced_at).toEqual({ talk: '2026-10-12T06:30:00.009+02:00' });
		expect(Date.parse(scan.scanned_through as string)).toBe(sentAt['6']);
		expect(read.messages).toEqual([
			{
				message_id: '1',
				sender_id: otherMid,
				sender_name: '王小明',
				from_self: false,
				sent_at: '2026-10-12T06:30:00.000+02:00',
				content_type: 'text',
				text: '晚餐吃 plain',
				seq: expect.any(Number)
			},
			expect.objectContaining({
				message_id: '2',
				from_self: true,
				edited_at: '2026-10-12T06:30:00.005+02:00'
			}),
			expect.objectContaining({ message_id: '3', mentions: [selfMid] }),
			expect.objectContaining({ message_id: '4', decrypt_state: 'missing_key' }),
			expect.objectContaining({ message_id: '5', unsent: true })
		]);
		const flagged = (key: string) =>
			(read.messages as Record<string, unknown>[])
				.filter((item) => key in item)
				.map((item) => item.message_id);
		expect([flagged('unsent'), flagged('decrypt_state'), flagged('mentions')]).toEqual([
			['5'],
			['4'],
			['3']
		]);

		// Items carry no null; a page's own fields keep theirs.
		const items = [
			read.chat,
			...(read.messages as object[]),
			...(search.messages as object[]),
			...(changes.changes as object[]),
			...(chats.chats as object[])
		];
		for (const [key, value] of walk(items)) expect([key, value]).not.toEqual([key, null]);
		expect(read).toMatchObject({ thread_id: null, older_cursor: null, has_newer: false });
		expect(search).toMatchObject({ next_cursor: null, scanned_through: null });

		// Within its own chat, a message does not repeat the chat; elsewhere it names it.
		const contexts = (
			search.messages as { context_before: object[]; context_after: object[] }[]
		).flatMap((hit) => [...hit.context_before, ...hit.context_after]);
		expect(contexts.length).toBeGreaterThan(0);
		for (const entry of [...(read.messages as object[]), ...contexts]) {
			for (const key of ['service', 'chat_id', 'chat_name']) expect(entry).not.toHaveProperty(key);
		}
		for (const entry of [...(search.messages as object[]), ...(changes.changes as object[])]) {
			expect(entry).toMatchObject({ service: expect.any(String), chat_id: expect.any(String) });
		}
		expect(search.messages).toContainEqual(
			expect.objectContaining({ message_id: '1', chat_name: '王小明' })
		);
	});

	it('continues cursors issued before items were trimmed', async () => {
		const { server, session } = await serve();
		store(
			session.db,
			...['1', '2', '3', '4', '5'].map((id, index) => row(id, base + index, `晚餐吃 ${id}`))
		);
		// Recorded from 330e1c9: each continues from message 3 (sent at base + 2).
		const older =
			'eyJrIjoicmVhZF9tZXNzYWdlcyIsInMiOiJYVHBzbE5jOEVKY1UiLCJwIjpbIm9sZGVyIiwxNzkxNzc5NDAwMDAyLDNdfQ';
		const newer =
			'eyJrIjoicmVhZF9tZXNzYWdlcyIsInMiOiJYVHBzbE5jOEVKY1UiLCJwIjpbIm5ld2VyIiwxNzkxNzc5NDAwMDAyLDNdfQ';
		const search =
			'eyJrIjoic2VhcmNoX21lc3NhZ2VzIiwicyI6IjdzbDk1WlRBNFlVQSIsInAiOlsxNzkxNzc5NDAwMDAyLDNdfQ';
		const read = async (cursor: string) =>
			(await callTool(server.port, 'read_messages', { service: 'talk', chat_id: otherMid, cursor }))
				.data.messages;

		expect(ids(await read(older))).toEqual(['1', '2']);
		expect(ids(await read(newer))).toEqual(['4', '5']);
		const hits = await callTool(server.port, 'search_messages', {
			query: '晚餐吃',
			cursor: search
		});
		expect(ids(hits.data.messages)).toEqual(['2', '1']);
	});
});

describe('errors', () => {
	it('returns only the mapped error when LINE fails, never its message', async () => {
		const token = 'SECRET-NEXT-ACCESS-TOKEN';
		const { server, logs } = await serve({
			getContactsV2: () => {
				throw new Error(
					`Request internal failed: status=500 headers=[["x-line-next-access","${token}"]] body=<祕密內容>`
				);
			},
			getChatRoomAnnouncements: () => {
				throw new InternalError('RequestError', `Request internal failed -> ${token}`, {
					code: 'NOT_A_MEMBER',
					reason: `reason quoting ${token}`
				});
			}
		});

		const profile = await callTool(server.port, 'get_profile', { id: otherMid });
		expect(profile).toMatchObject({
			isError: true,
			data: { error: { code: 'upstream_parse_error', operation: 'get_profile' } }
		});
		const announcements = await callTool(server.port, 'get_announcements', {
			service: 'talk',
			chat_id: groupMid
		});
		expect(announcements).toMatchObject({
			isError: true,
			data: { error: { code: 'NOT_A_MEMBER', operation: 'get_announcements' } }
		});
		for (const text of [profile.text, announcements.text, JSON.stringify(logs)]) {
			expect(text).not.toContain(token);
			expect(text).not.toContain('祕密');
		}
	});
});

describe('upstream tools', () => {
	it('reads profiles and announcements through the session', async () => {
		const { server, upstream, session } = await serve({
			getProfile: () => ({ mid: selfMid, displayName: '我', statusMessage: '忙碌中' }),
			getContactsV2: () => ({
				contacts: { [otherMid]: { contact: { mid: otherMid, displayName: '王小明' } } }
			}),
			getSquareMember: () => ({
				squareMember: { squareMemberMid: member, displayName: '路人', membershipState: 'JOINED' }
			}),
			getChatRoomAnnouncements: () => [
				{
					announcementSeq: 9_007_199_254_740_993n,
					contents: { text: '週五聚餐' },
					creatorMid: otherMid,
					createdTime: base
				}
			],
			getSquareChatAnnouncements: () => ({
				announcements: [
					{
						announcementSeq: 3,
						contents: {
							textMessageAnnouncementContents: {
								messageId: '123',
								text: '版規',
								senderSquareMemberMid: member
							}
						},
						createdAt: base
					}
				]
			})
		});
		upsertParticipant(session.db, 'talk', otherMid, '小明（存檔）');

		expect((await callTool(server.port, 'get_profile')).data.profile).toMatchObject({
			self: true,
			display_name: '我',
			status_message: '忙碌中'
		});
		expect(
			(await callTool(server.port, 'get_profile', { id: otherMid })).data.profile
		).toMatchObject({ display_name: '王小明', archived_name: '小明（存檔）' });
		expect(
			(await callTool(server.port, 'get_profile', { service: 'square', id: member })).data.profile
		).toMatchObject({ display_name: '路人', membership: 'JOINED' });
		expect(
			(await callTool(server.port, 'get_announcements', { service: 'talk', chat_id: groupMid }))
				.data.announcements
		).toEqual([
			expect.objectContaining({
				seq: '9007199254740993',
				text: '週五聚餐',
				creator_name: '小明（存檔）',
				created_at: '2026-10-12T06:30:00.000+02:00'
			})
		]);
		expect(
			(await callTool(server.port, 'get_announcements', { service: 'square', chat_id: square }))
				.data.announcements
		).toEqual([expect.objectContaining({ seq: '3', text: '版規', message_id: '123' })]);
		expect(upstream.calls).toEqual([
			'getProfile',
			'getContactsV2',
			'getSquareMember',
			'getChatRoomAnnouncements',
			'getSquareChatAnnouncements'
		]);
	});

	it('downloads an attachment into the cache and refuses unsent messages', async () => {
		const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const fetched: string[] = [];
		const { server, session, upstream, root } = await serve({}, async (request) => {
			fetched.push(new URL(request.url).pathname);
			return new Response(image, { headers: { 'content-type': 'image/png' } });
		});
		const { db } = session;
		store(db, media('41'), media('42'));
		apply(db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '42' });

		const info = await callTool(server.port, 'get_attachment', {
			service: 'talk',
			chat_id: otherMid,
			message_id: '41'
		});
		expect(info.data).toMatchObject({
			attachment: { file_name: 'photo.png', file_size: 7, e2ee: false },
			path: null
		});
		expect(fetched).toEqual([]);

		const saved = await callTool(server.port, 'get_attachment', {
			service: 'talk',
			chat_id: otherMid,
			message_id: '41',
			download: true
		});
		const path = saved.data.path as string;
		expect(dirname(path)).toBe(join(root, 'attachments'));
		expect(readFileSync(path)).toEqual(image);
		expect(basename(path)).toMatch(/^talk-41-[0-9a-f]{24}\.png$/);
		expect(fetched).toEqual(['/r/talk/m/41']);
		const again = await callTool(server.port, 'get_attachment', {
			service: 'talk',
			chat_id: otherMid,
			message_id: '41',
			download: true
		});
		expect(again.data).toMatchObject({ path, cached: true });

		const unsent = await callTool(server.port, 'get_attachment', {
			service: 'talk',
			chat_id: otherMid,
			message_id: '42',
			download: true
		});
		expect(unsent).toMatchObject({ isError: true, data: { error: { code: 'message_unsent' } } });
		expect(fetched).toHaveLength(1);
		expect(upstream.calls).toEqual([]);
	});

	// Windows has no POSIX modes; its private directories are ACL checks of their own.
	it.skipIf(process.platform === 'win32')('keeps the attachment cache private', async () => {
		const { server, session, root } = await serve(
			{},
			async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		);
		store(session.db, media('41'));

		const saved = await callTool(server.port, 'get_attachment', {
			service: 'talk',
			chat_id: otherMid,
			message_id: '41',
			download: true
		});

		expect(statSync(saved.data.path as string).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, 'attachments')).mode & 0o777).toBe(0o700);
	});

	it('names cached media without a file name by its leading bytes', async () => {
		const files: Record<string, Uint8Array> = {
			'61': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
			'62': Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0', 'latin1'),
			'63': Buffer.from('\0\0\0\x1cftypM4A \0\0\0\0', 'latin1'),
			'64': Buffer.from('%PDF-1.7\n', 'latin1'),
			'65': Buffer.from('plain words', 'latin1')
		};
		const { server, session, root } = await serve({}, async (request) => {
			const id = new URL(request.url).pathname.split('/').at(-1)!;
			return new Response(files[id]);
		});
		store(session.db, ...Object.keys(files).map(unnamed));

		const names: string[] = [];
		for (const id of Object.keys(files)) {
			const saved = await callTool(server.port, 'get_attachment', {
				service: 'talk',
				chat_id: otherMid,
				message_id: id,
				download: true
			});
			const path = saved.data.path as string;
			expect(dirname(path)).toBe(join(root, 'attachments'));
			expect(basename(path).startsWith(`talk-${id}-`)).toBe(true);
			names.push(basename(path).slice(`talk-${id}-`.length + 24));
		}
		expect(names).toEqual(['.jpg', '.mp4', '.m4a', '.pdf', '']);
	});

	it('stops a plain download at the limit whatever FILE_SIZE claims', async () => {
		const limit = 1024;
		let pulled = 0;
		let cancelled = 0;
		// 64 KiB in 256-byte chunks; FILE_SIZE in the envelope claims 7 bytes.
		const body = () =>
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled += 1;
					if (pulled > 256) controller.close();
					else controller.enqueue(new Uint8Array(256));
				},
				cancel() {
					cancelled += 1;
				}
			});
		const { server, session, root } = await serve(
			{},
			async (request) =>
				request.url.endsWith('/m/41')
					? new Response(body(), { headers: { 'content-length': String(64 * 1024) } })
					: new Response(body()),
			{ maxAttachmentBytes: limit }
		);
		store(session.db, media('41'), media('42'));
		const fetch = (id: string) =>
			callTool(server.port, 'get_attachment', {
				service: 'talk',
				chat_id: otherMid,
				message_id: id,
				download: true
			});

		const announced = await fetch('41');
		expect(announced).toMatchObject({
			isError: true,
			data: { error: { code: 'attachment_too_large' } }
		});
		expect(pulled).toBeLessThanOrEqual(1);
		expect(cancelled).toBe(1);

		pulled = 0;
		const streamed = await fetch('42');
		expect(streamed).toMatchObject({
			isError: true,
			data: { error: { code: 'attachment_too_large' } }
		});
		// Stopped a few chunks past the limit, not after the whole body.
		expect(pulled).toBeLessThan(16);
		expect(cancelled).toBe(2);
		expect(readdirSync(`${root}/attachments`)).toEqual([]);
	});

	it('writes every byte of a chunk the file only partly accepts', async () => {
		const written: number[] = [];
		const file = {
			write: async (chunk: Uint8Array, offset = 0, length = chunk.byteLength - offset) => {
				const bytesWritten = Math.min(length, 3);
				written.push(...chunk.subarray(offset, offset + bytesWritten));
				return { bytesWritten, buffer: chunk };
			}
		};
		await writeAll(file as never, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(written).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		const stuck = { write: async (chunk: Uint8Array) => ({ bytesWritten: 0, buffer: chunk }) };
		await expect(writeAll(stuck as never, Uint8Array.from([1]))).rejects.toThrow(/no progress/);
	});

	it('downloads E2EE media and bounds the encrypted response before decrypting', async () => {
		const limit = 256;
		const peer = keyPair(5);
		const self = keyPair(2);
		const served = new Map<string, Uint8Array>();
		const fetched: string[] = [];
		const { server, session, root } = await serve(
			{},
			async (request) => {
				const path = new URL(request.url).pathname;
				fetched.push(path);
				const data = served.get(path);
				if (!data) throw new Error(`unexpected media request ${path}`);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let at = 0; at < data.length; at += 64) {
								controller.enqueue(data.subarray(at, at + 64));
							}
							controller.close();
						}
					}),
					// 53 decrypts fine but announces more than the limit.
					{ headers: path.endsWith('oid53') ? { 'content-length': String(64 * 1024) } : {} }
				);
			},
			{ maxAttachmentBytes: limit }
		);
		const client = session.base;
		const storage = client.storage as SqliteStorage;
		storage.setSync('e2eeKeys:2', storedKey(self));
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		const shared = Buffer.from(client.e2ee.generateSharedSecret(peer.privKey, self.pubKey));
		const encrypted = async (id: string, file: Buffer, fileSize = '1') => {
			const { keyMaterial, encryptedData } = await client.e2ee.encryptByKeyMaterial(file);
			served.set(`/r/talk/emi/oid${id}`, encryptedData);
			const envelope = {
				id,
				from: otherMid,
				to: selfMid,
				toType: 'USER',
				contentType: 'IMAGE',
				contentMetadata: { e2eeVersion: '2', OID: `oid${id}`, SID: 'emi', FILE_SIZE: fileSize },
				chunks: client.e2ee.encryptE2EEMessageByData(
					5,
					2,
					shared,
					2,
					{ keyMaterial, fileName: 'secret.jpg' },
					selfMid,
					otherMid,
					1
				)
			} as unknown as Message;
			return row(id, base, '', {
				text: null,
				contentType: 'IMAGE',
				envelope: encodeEnvelope(envelope)
			});
		};
		const small = Buffer.from('秘密的照片 bytes', 'utf-8');
		store(
			session.db,
			await encrypted('51', small),
			await encrypted('52', Buffer.alloc(1024, 7)),
			await encrypted('53', small),
			// FILE_SIZE as LINE records it for E2EE media: the ciphertext size.
			await encrypted('54', Buffer.alloc(limit, 9), String(limit + 32))
		);
		const fetch = (id: string) =>
			callTool(server.port, 'get_attachment', {
				service: 'talk',
				chat_id: otherMid,
				message_id: id,
				download: true
			});

		const saved = await fetch('51');
		expect(saved.data).toMatchObject({
			attachment: { e2ee: true, file_size: small.length },
			cached: false
		});
		expect(readFileSync(saved.data.path as string)).toEqual(small);
		// The name inside the encrypted payload gives the extension.
		expect(basename(saved.data.path as string)).toMatch(/^talk-51-[0-9a-f]{24}\.jpg$/);

		// A file of exactly the limit arrives with its 32-byte HMAC on top.
		const full = await fetch('54');
		expect(full.data).toMatchObject({ attachment: { file_size: limit }, cached: false });
		expect(readFileSync(full.data.path as string)).toEqual(Buffer.alloc(limit, 9));

		const oversized = await fetch('52');
		expect(oversized).toMatchObject({
			isError: true,
			data: { error: { code: 'attachment_too_large' } }
		});
		expect(await fetch('53')).toMatchObject({
			isError: true,
			data: { error: { code: 'attachment_too_large' } }
		});
		expect(fetched).toEqual([
			'/r/talk/emi/oid51',
			'/r/talk/emi/oid54',
			'/r/talk/emi/oid52',
			'/r/talk/emi/oid53'
		]);
		expect(readdirSync(`${root}/attachments`)).toHaveLength(2);
	});

	it('names an E2EE file from its payload, with or without a download', async () => {
		const peer = keyPair(5);
		const self = keyPair(2);
		const pdf = Buffer.from('%PDF-1.7\n', 'latin1');
		const pool = new WatchedPool(1);
		let lookup: (() => Promise<unknown>) | undefined;
		const { server, session, upstream, logs, root } = await serve(
			{ getE2EEPublicKey: () => lookup?.() ?? Promise.reject(talkError('INTERNAL_ERROR')) },
			async () => new Response(encryptedPdf),
			{ pool }
		);
		const client = session.base;
		const storage = client.storage as SqliteStorage;
		storage.setSync('e2eeKeys:2', storedKey(self));
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		const { keyMaterial, encryptedData: encryptedPdf } =
			await client.e2ee.encryptByKeyMaterial(pdf);
		const file = (id: string, sender: KeyPair, decryptState: 'ok' | 'missing_key' = 'ok') => {
			const shared = Buffer.from(client.e2ee.generateSharedSecret(sender.privKey, self.pubKey));
			const envelope = {
				id,
				from: otherMid,
				to: selfMid,
				toType: 'USER',
				contentType: 'FILE',
				contentMetadata: { e2eeVersion: '2', OID: `oid${id}`, SID: 'emf', FILE_SIZE: '9' },
				chunks: client.e2ee.encryptE2EEMessageByData(
					sender.keyId,
					2,
					shared,
					2,
					{ keyMaterial, fileName: 'Q3 報告.pdf' },
					selfMid,
					otherMid,
					14
				)
			} as unknown as Message;
			return row(id, base, '', {
				text: null,
				contentType: 'FILE',
				envelope: encodeEnvelope(envelope),
				decryptState
			});
		};
		// Sender keys 7 and 8 are not stored; LINE fails 7 and answers 8 late.
		const late = keyPair(8);
		store(
			session.db,
			file('71', peer),
			file('72', peer, 'missing_key'),
			file('73', keyPair(7)),
			file('74', late)
		);
		const attachment = async (id: string, download = false) =>
			(
				await callTool(server.port, 'get_attachment', {
					service: 'talk',
					chat_id: otherMid,
					message_id: id,
					...(download ? { download } : {})
				})
			).data;

		// The name lookup waits for a pool slot like any upstream work.
		let release: (() => void) | undefined;
		const busy = pool.run(() => new Promise<void>((resolve) => (release = resolve)));
		await vi.waitFor(() => expect(pool.waiting).toBe(0));
		const pending = attachment('71');
		await vi.waitFor(() => expect(pool.waiting).toBe(1));
		release?.();
		await busy;
		expect(await pending).toMatchObject({
			attachment: { file_name: 'Q3 報告.pdf', e2ee: true },
			path: null
		});
		const saved = await attachment('71', true);
		expect(saved).toMatchObject({ attachment: { file_name: 'Q3 報告.pdf' }, cached: false });
		expect(basename(saved.path as string)).toMatch(/^talk-71-[0-9a-f]{24}\.pdf$/);
		expect(await attachment('71', true)).toMatchObject({
			attachment: { file_name: 'Q3 報告.pdf' },
			path: saved.path,
			cached: true
		});
		expect(upstream.calls).toEqual([]);

		// Unverified keys are never tried; a failed key lookup leaves the name out.
		expect(await attachment('72')).toMatchObject({ attachment: { file_name: null } });
		expect(upstream.calls).toEqual([]);
		expect(await attachment('73')).toMatchObject({ attachment: { file_name: null }, path: null });
		expect(upstream.calls).toEqual(['getE2EEPublicKey']);
		expect(logs).toContainEqual(
			expect.objectContaining({ event: 'attachment_name_skipped', operation: 'get_attachment' })
		);

		// A caller that goes away during the key lookup gets no result.
		let answer: ((key: unknown) => void) | undefined;
		lookup = () => new Promise((resolve) => (answer = resolve));
		const cancel = new AbortController();
		const context = {
			db: session.db,
			base: session.base,
			selfMid,
			pool,
			attachments: join(root, 'attachments'),
			status: () => archiveStatus(session.db),
			log: () => {},
			outbox: new Outbox(session.db, { log: () => {} })
		};
		const call = getAttachment.run(
			{ service: 'talk', chat_id: otherMid, message_id: '74' },
			context,
			cancel.signal
		);
		await vi.waitFor(() => expect(answer).toBeDefined());
		cancel.abort(new Error('the caller went away'));
		answer?.({ version: 1, keyId: 8, keyData: late.pubKey });
		await expect(call).rejects.toThrow('the caller went away');
	});
});
