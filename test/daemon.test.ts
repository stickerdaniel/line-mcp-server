import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openGap, readMessages, searchMessages, upsertChat, writeState } from '../src/archive.ts';
import { type Daemon, type DaemonOptions, startDaemon } from '../src/daemon.ts';
import { openDatabase, readAccount } from '../src/db.ts';
import { historyStepMs, type Sleep } from '../src/sync/loop.ts';
import {
	fakeUpstream,
	freePort,
	type Handler,
	otherMid,
	seedLive,
	selfMid,
	talkError,
	tempRoot,
	within
} from './fake-line.ts';
import { callTool, post } from './mcp-client.ts';
import { receive, textMessage } from './sync-fixture.ts';

const daemons: Daemon[] = [];
afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.stop();
});

/** Real timers, capped at a few milliseconds so the loops run many rounds quickly. */
const fastSleep: Sleep = (ms, signal) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, Math.min(ms, 3));
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve();
		});
	});

const quiet: Record<string, Handler> = {
	getProfile: () => ({ mid: selfMid }),
	fetchMyEvents: () => ({ events: [], syncToken: 'my-1' }),
	getJoinedSquares: () => ({ squares: [] }),
	getMessageBoxes: () => ({ messageBoxes: [], hasNext: false }),
	getAllChatMids: () => ({ memberChatMids: [] })
};

async function start(
	root: string,
	handlers: Record<string, Handler>,
	extra: Partial<DaemonOptions>
) {
	const upstream = fakeUpstream({ ...quiet, ...handlers });
	const daemon = await startDaemon({
		root,
		lockPort: await freePort(),
		createClient: upstream.createClient,
		log: () => {},
		sleep: fastSleep,
		square: { idleMs: 3 },
		workerIdleMs: 3,
		mcpPort: 0,
		...extra
	});
	daemons.push(daemon);
	return { daemon, upstream };
}

async function until(condition: () => boolean, what: string): Promise<void> {
	await within(
		3000,
		(async () => {
			while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
		})(),
		what
	);
}

describe('daemon', () => {
	it('stops all upstream calls when LINE revokes the session and keeps serving cached reads', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const message = textMessage('800000000000000001', '晚安，明天見');
		let syncs = 0;
		const notices: string[] = [];
		const { daemon, upstream } = await start(
			root,
			{
				sync: () => {
					syncs++;
					if (syncs === 1) return { operationResponse: { operations: [receive(1, message)] } };
					if (syncs < 4) return {};
					throw talkError('NOT_AUTHORIZED_DEVICE');
				}
			},
			{ notify: (text) => void notices.push(text) }
		);

		await until(() => daemon.health() === 'needs_login', 'needs_login');
		// Both loops were running when the session ended.
		expect(upstream.calls).toContain('fetchMyEvents');
		await within(3000, daemon.loops, 'loops to stop');
		const calls = upstream.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(upstream.calls).toHaveLength(calls);
		expect(daemon.status()).toMatchObject({ health: 'needs_login', stale: true });
		expect(daemon.status().talkSyncedAt).toEqual(expect.any(Number));
		const { db } = daemon.session;
		expect(readMessages(db, { service: 'talk', chatId: otherMid })[0]?.text).toBe('晚安，明天見');
		expect(searchMessages(db, { query: '明天' }).messages).toHaveLength(1);
		expect(readAccount(db)?.authState).toBe('needs_login');
		expect(notices).toHaveLength(1);
		expect(notices[0]).not.toContain('晚安');

		await daemon.stop();
		const restarted = await start(root, {}, { notify: (text) => void notices.push(text) });

		expect(restarted.daemon.health()).toBe('needs_login');
		expect(restarted.upstream.calls).toEqual([]);
		expect(notices).toHaveLength(1);
	});

	it('starts cache-only when LINE rejects the stored session at startup', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const notices: string[] = [];
		const { daemon, upstream } = await start(
			root,
			{
				getProfile: () => {
					throw talkError('NOT_AUTHORIZED_DEVICE');
				}
			},
			{ notify: (text) => void notices.push(text) }
		);

		await within(1000, daemon.loops, 'loops to stay idle');
		expect(daemon.session.base.profile).toBeUndefined();
		expect(daemon.status()).toMatchObject({ health: 'needs_login', stale: true });
		expect(upstream.calls).toEqual(['getProfile']);
		expect(notices).toHaveLength(1);
	});

	it('stops every loop for good when the archive cannot be written', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { promise: full, resolve: release } = Promise.withResolvers<void>();
		let syncs = 0;
		const notices: string[] = [];
		const healths: unknown[] = [];
		const { daemon, upstream } = await start(
			root,
			{
				sync: async () => {
					syncs++;
					if (syncs === 1) {
						return {
							operationResponse: {
								operations: [receive(1, textMessage('800000000000000002', '已經存好了'))]
							}
						};
					}
					await full;
					return {
						operationResponse: {
							operations: [
								receive(syncs, textMessage(`80000000000000010${syncs}`, '滿'.repeat(200_000)))
							]
						}
					};
				}
			},
			{
				notify: (text) => void notices.push(text),
				log: (entry) => {
					if (entry.event === 'health') healths.push(entry.state);
				}
			}
		);
		const { db } = daemon.session;
		await until(() => searchMessages(db, { query: '存好' }).messages.length === 1, 'first sync');
		// The disk is full from here on: no write can grow the database.
		const { page_count: pages } = db.prepare('PRAGMA page_count').get() as { page_count: number };
		db.exec(`PRAGMA max_page_count = ${pages}`);
		release();

		await within(3000, daemon.loops, 'loops to stop');
		const calls = upstream.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(daemon.session.state()).toBe('storage_error');
		expect(upstream.calls).toHaveLength(calls);
		expect(healths.slice(healths.indexOf('storage_error'))).toEqual(['storage_error']);
		expect(daemon.status()).toMatchObject({ health: 'storage_error', stale: true });
		expect(searchMessages(db, { query: '存好' }).messages).toHaveLength(1);
		expect(notices).toEqual(['line-mcp cannot write its archive. Sync is stopped.']);
	});

	it('reports storage_error in status when the health record itself cannot be written', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { promise: pending, resolve: release } = Promise.withResolvers<void>();
		let syncs = 0;
		const { daemon } = await start(
			root,
			{
				sync: async () => {
					if (++syncs === 1) return {};
					await pending;
					return {
						operationResponse: {
							operations: [receive(1, textMessage('800000000000000003', 'cannot be stored'))]
						}
					};
				}
			},
			{ notify: () => {}, worker: false }
		);
		await until(() => daemon.health() === 'online', 'online');
		expect(daemon.status()).toMatchObject({ health: 'online', stale: false });

		// Every write fails from here on, the health record included.
		daemon.session.db.exec('PRAGMA query_only = ON');
		release();
		await within(3000, daemon.loops, 'loops to stop');

		expect(daemon.status()).toMatchObject({ health: 'storage_error', stale: true });
	});

	it('stays online without errors or backoff while idle long polls end with 410', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		let syncs = 0;
		const entries: Record<string, unknown>[] = [];
		const { daemon } = await start(
			root,
			{
				sync: () => {
					if (++syncs === 1) return {};
					throw new Error('Request internal failed: status=410 headers=[] body=<>');
				}
			},
			{ notify: () => {}, worker: false, log: (entry) => void entries.push(entry) }
		);

		await until(() => syncs >= 6, 'several idle polls');

		expect(daemon.health()).toBe('online');
		expect(entries.map((entry) => entry.event)).not.toContain('upstream_error');
		expect(entries.map((entry) => entry.event)).not.toContain('sync_retry');
		expect(entries.filter((entry) => entry.event === 'health').map((entry) => entry.state)).toEqual(
			['catching_up', 'online']
		);
	});

	it('waits at least historyStepMs between backfill rounds, whatever it is configured to', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const message = textMessage('800000000000000002', 'history');
		const waits: number[] = [];
		const { daemon } = await start(
			root,
			{
				sync: () => ({}),
				getMessageBoxes: () => ({
					messageBoxes: [{ id: otherMid, midType: 'USER' }],
					hasNext: false
				}),
				getContactsV2: () => ({ contacts: {} }),
				getRecentMessagesV2: () => [message],
				getPreviousMessagesV2WithRequest: () => [message]
			},
			{
				notify: () => {},
				backfillPageMs: 0,
				sleep: (ms, signal) => {
					waits.push(ms);
					return fastSleep(ms, signal);
				}
			}
		);

		await until(() => daemon.status().backfill.complete === 1, 'backfill to complete');

		expect(waits).toContain(historyStepMs);
	});

	it('comes back for a backfill whose history slot is busy within historyStepMs', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const chat = `m${'5'.repeat(32)}`;
		const db = openDatabase(root);
		writeState(db, `backfill:square:${chat}`, { pages: 0, syncToken: 'start' });
		// Reconciliation of the chat holds its history slot for the whole test.
		writeState(db, `square:historyAt:${chat}`, Date.now() + 60_000);
		db.close();
		const waits: number[] = [];
		await start(
			root,
			{ sync: () => ({}) },
			{
				notify: () => {},
				workerIdleMs: 30_000,
				sleep: (ms, signal) => {
					waits.push(ms);
					return fastSleep(ms, signal);
				}
			}
		);

		await until(() => waits.filter((wait) => wait === historyStepMs).length >= 3, 'worker rounds');

		expect(waits).not.toContain(30_000);
	});

	it('reports online while the first long poll is still held after a restart', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { promise: idle, resolve: release } = Promise.withResolvers<void>();
		const { daemon } = await start(
			root,
			{
				sync: async () => {
					await idle;
					return {};
				}
			},
			{ notify: () => {}, worker: false, talkHeldMs: 20 }
		);

		try {
			await until(() => daemon.health() === 'online', 'online during the held poll');
		} finally {
			release();
		}
	});

	it('stays catching_up while every poll answers at once with more operations', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		let revision = 0;
		const { daemon } = await start(
			root,
			{
				sync: async () => {
					revision++;
					await new Promise((resolve) => setTimeout(resolve, 5));
					const message = textMessage(String(810_000_000_000_000_000n + BigInt(revision)), 'x');
					return {
						operationResponse: { operations: [receive(revision, message)], hasMoreOps: true }
					};
				}
			},
			{ notify: () => {}, worker: false, talkHeldMs: 20 }
		);

		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(revision).toBeGreaterThan(5);
		expect(daemon.health()).toBe('catching_up');
	});

	it('stays catching_up during a held poll while a reset gap is open', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const db = openDatabase(root);
		openGap(db, { service: 'talk', scope: 'all', reason: 'full_sync', detail: { boundary: 0 } });
		db.close();
		const { promise: idle, resolve: release } = Promise.withResolvers<void>();
		const { daemon } = await start(
			root,
			{
				sync: async () => {
					await idle;
					return {};
				}
			},
			{ notify: () => {}, worker: false, talkHeldMs: 20 }
		);

		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(daemon.health()).toBe('catching_up');
		} finally {
			release();
		}
	});

	it('serves MCP while it runs and frees the port when it stops', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { daemon } = await start(root, { sync: () => ({}) }, { notify: () => {} });
		const port = daemon.mcp!.port;

		await until(() => daemon.health() === 'online', 'online');
		expect((await callTool(port, 'status')).data).toMatchObject({ health: 'online', stale: false });
		await daemon.stop();

		await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(
			/ECONNREFUSED/
		);
	});

	it('fails startup and releases the lock when the MCP port is taken', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const occupant = createServer();
		await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
		const taken = (occupant.address() as AddressInfo).port;
		const lockPort = await freePort();
		try {
			await expect(
				start(root, { sync: () => ({}) }, { notify: () => {}, lockPort, mcpPort: taken })
			).rejects.toMatchObject({ code: 'mcp_port_in_use' });
		} finally {
			occupant.close();
		}

		const { daemon } = await start(root, { sync: () => ({}) }, { notify: () => {}, lockPort });
		expect(daemon.session.state()).toBe('online');
	});

	it('dispatches nothing queued, from MCP or the worker, once it stops', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let lookups = 0;
		const { daemon, upstream } = await start(
			root,
			{
				sync: () => ({}),
				getContactsV2: async () => {
					lookups += 1;
					await gate;
					return { contacts: {} };
				}
			},
			// Discovery every round keeps the worker queueing for the pool.
			{ notify: () => {}, discoveryIntervalMs: 0 }
		);
		const port = daemon.mcp!.port;
		const calls = Array.from({ length: 20 }, () =>
			callTool(port, 'get_profile', { id: otherMid }).catch(() => 'closed')
		);
		await until(() => lookups === 2, 'both pool slots held');
		await new Promise((resolve) => setTimeout(resolve, 20));

		const sent = upstream.calls.length;
		const stopping = daemon.stop();
		release();
		await within(1000, stopping, 'stop');
		expect(await Promise.all(calls)).toHaveLength(20);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(upstream.calls.slice(sent)).toEqual([]);
		expect(lookups).toBe(2);
	});

	it('names the own chat after the profile it restored', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { daemon } = await start(
			root,
			{ sync: () => ({}), getProfile: () => ({ mid: selfMid, displayName: '丹尼爾' }) },
			{ notify: () => {} }
		);
		upsertChat(daemon.session.db, { service: 'talk', chatId: selfMid, type: 'user' });

		const listed = await callTool(daemon.mcp!.port, 'list_chats');
		expect(listed.data.chats).toEqual([
			expect.objectContaining({ chat_id: selfMid, name: '丹尼爾' })
		]);
	});

	it('reports online once both loops are caught up', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { daemon } = await start(root, { sync: () => ({}) }, { notify: () => {} });

		await until(() => daemon.health() === 'online', 'online');
		expect(daemon.status()).toMatchObject({ health: 'online', stale: false });
	});
});
