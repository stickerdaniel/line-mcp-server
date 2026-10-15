import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { InternalError } from '@evex/linejs/base';
import type { Message } from '@evex/linejs-types';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { archiveStatus, openGap, upsertChat, upsertParticipant } from '../src/archive.ts';
import { transaction } from '../src/db.ts';
import { QueryRunner } from '../src/mcp/tools/query.ts';
import { getAttachment, writeAll } from '../src/mcp/tools/upstream.ts';
import { Outbox } from '../src/outbox.ts';
import { statePrivacy } from '../src/privacy.ts';
import { advanceMarker } from '../src/read-state.ts';
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
import { callTool, message, post, query, serve } from './mcp-client.ts';

// Local times below are Berlin's, whatever zone the machine running the tests has.
vi.hoisted(() => {
	process.env.TZ = 'Europe/Berlin';
});

const square = `m${'d'.repeat(32)}`;
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

/** An image message whose retained envelope names its file. */
/** `get_attachment` with download for a message in the chat with `otherMid`. */
function downloadMedia(port: number, id: string) {
	return callTool(port, 'get_attachment', {
		service: 'talk',
		chat_id: otherMid,
		message_id: id,
		download: true
	});
}

/** Adds an allow entry with icacls (Windows), as `*<SID>:<rights>`. */
function grant(path: string, entry: string): void {
	execFileSync('icacls', [path, '/grant', entry], { stdio: 'ignore' });
}

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

describe('query results', () => {
	it('show names from the archive, Chinese text unchanged, and times in the local zone', async () => {
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

		const read = await callTool(server.port, 'query', {
			sql: `SELECT p.display_name, m.text, m.sender = (SELECT mid FROM account) AS own,
				local_time(m.sent_at) AS sent_at
			FROM message m LEFT JOIN participant p ON p.service = m.service AND p.participant_id = m.sender
			ORDER BY m.id`
		});

		expect(read.data).toMatchObject({
			stale: true,
			synced_at: { talk: '2026-10-12T06:30:00.000+02:00' },
			rows: [
				['王小明', '今天晚上吃什麼？🍜', 0, '2026-10-12T06:30:00.000+02:00'],
				[null, '好', 1, '2026-10-12T06:30:00.001+02:00']
			]
		});
		expect(read.text).toContain('今天晚上吃什麼？🍜');
	});

	it('give every change a new seq, and leave it for names and read positions', async () => {
		const { server, session } = await serve();
		const { db } = session;
		store(db, ...['1', '2', '3', '4', '5'].map((id, index) => row(id, base + index, `v1 ${id}`)));
		const latest = async () =>
			(await query(server.port, 'SELECT max(seq) AS seq FROM message'))[0]!.seq as number;
		const changedAfter = (seq: number) =>
			query(server.port, `SELECT message_id, text FROM message WHERE seq > ${seq} ORDER BY seq`);
		const read = await latest();

		store(db, row('1', base, 'v2 1', { editedAt: base + 10 }));
		store(db, row('4', base + 3, 'v2 4', { editedAt: base + 10 }));
		apply(db, { kind: 'unsend', service: 'talk', chatId: otherMid, messageId: '2' });

		expect(await changedAfter(read)).toEqual([
			{ message_id: '1', text: 'v2 1' },
			{ message_id: '4', text: 'v2 4' },
			{ message_id: '2', text: null }
		]);
		const after = await latest();
		upsertParticipant(db, 'talk', otherMid, '王小明');
		advanceMarker(db, 'talk', otherMid, '5');
		expect(await changedAfter(after)).toEqual([]);
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
	it('gives each time as one string with the local offset and leaves empty message fields out', async () => {
		const { server, session } = await serve();
		const { db } = session;
		transaction(db, () => {
			upsertParticipant(db, 'talk', otherMid, '王小明');
			db.prepare(
				`INSERT INTO sync_state (key, value, updated_at) VALUES ('talk:syncedAt', ?, 0)`
			).run(String(base + 9));
			openGap(db, { service: 'talk', scope: 'chat', reason: 'reset', detail: {} }, { now: base });
		});
		store(db, media('41'));

		const status = (await callTool(server.port, 'status')).data;
		const attachment = (
			await callTool(server.port, 'get_attachment', {
				service: 'talk',
				chat_id: otherMid,
				message_id: '41'
			})
		).data;

		for (const result of [status, attachment]) {
			for (const [key, value, holder] of walk(result)) {
				const isTime = (key.endsWith('_at') && key !== 'synced_at') || holder === result.synced_at;
				if (isTime) expect(value).toMatch(time);
			}
			expect(result.synced_at).toEqual({ talk: '2026-10-12T06:30:00.009+02:00' });
		}
		expect(status.gaps).toMatchObject([{ opened_at: '2026-10-12T06:30:00.000+02:00' }]);
		expect(attachment.message).toEqual({
			service: 'talk',
			chat_id: otherMid,
			chat_name: '王小明',
			message_id: '41',
			sender_id: otherMid,
			sender_name: '王小明',
			from_self: false,
			sent_at: '2026-10-12T06:30:00.000+02:00',
			content_type: 'image',
			seq: expect.any(Number)
		});
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

	it.runIf(process.platform === 'win32')(
		'returns no attachment from a cache or file that is not private',
		async () => {
			const fetched: string[] = [];
			const fetch = async (request: Request) => {
				fetched.push(new URL(request.url).pathname);
				return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			};
			const first = await serve({}, fetch, { privacy: statePrivacy() });
			store(first.session.db, media('41'), media('42'));
			const refused = { isError: true, data: { error: { code: 'insecure_directory' } } };

			const saved = await downloadMedia(first.server.port, '41');
			grant(saved.data.path as string, '*S-1-1-0:(R)');
			const cached = await downloadMedia(first.server.port, '41');
			grant(join(first.root, 'attachments'), '*S-1-1-0:(OI)(CI)(R)');
			// Another process checks the cache directory before it reads or writes there.
			const second = await serve({}, fetch, { root: first.root, privacy: statePrivacy() });
			const fresh = await downloadMedia(second.server.port, '42');

			expect(saved.data).toMatchObject({ cached: false });
			expect(cached).toMatchObject(refused);
			expect(fresh).toMatchObject(refused);
			expect(fetched).toEqual(['/r/talk/m/41']);
		}
	);

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
			root,
			base: session.base,
			selfMid,
			pool,
			attachments: join(root, 'attachments'),
			privacy: statePrivacy(),
			status: () => archiveStatus(session.db),
			log: () => {},
			outbox: new Outbox(session.db, { log: () => {} }),
			// Never started: no query runs here.
			queries: new QueryRunner({ root, privacy: statePrivacy() })
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
