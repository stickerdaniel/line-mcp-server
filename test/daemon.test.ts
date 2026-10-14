import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGap, readMessages, searchMessages, upsertChat, writeState } from '../src/archive.ts';
import { type Daemon, type DaemonOptions, startDaemon } from '../src/daemon.ts';
import { openDatabase, readAccount, transaction } from '../src/db.ts';
import { applyChanges } from '../src/sync/normalize.ts';
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
import { field, receive, squareChat, squareDiscovery, textMessage } from './sync-fixture.ts';

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

/** Archives one OpenChat message whose sender no event named. */
function archiveUnnamedSquareSender(root: string): void {
	const db = openDatabase(root);
	const row = { messageId: '1', text: 'hello', sentAt: 1 };
	transaction(db, () =>
		applyChanges(db, [
			{
				kind: 'message',
				row: {
					service: 'square',
					chatId: `m${'5'.repeat(32)}`,
					chatType: 'square',
					...row,
					threadId: null,
					sender: `p${'6'.repeat(32)}`,
					editedAt: null,
					contentType: 'NONE',
					replyTo: null,
					mentions: null,
					envelope: JSON.stringify(row),
					decryptState: 'ok',
					missingKey: null
				}
			}
		])
	);
	db.close();
}

/** Archives one Talk message from the peer of the one-to-one chat `chatId`. */
function archiveTalk(root: string, chatId: string, messageId: string): void {
	const db = openDatabase(root);
	const row = { messageId, text: 'hello', sentAt: 1 };
	transaction(db, () =>
		applyChanges(db, [
			{
				kind: 'message',
				row: {
					service: 'talk',
					chatId,
					chatType: 'user',
					...row,
					threadId: null,
					sender: chatId,
					editedAt: null,
					contentType: 'NONE',
					replyTo: null,
					mentions: null,
					envelope: JSON.stringify(row),
					decryptState: 'ok',
					missingKey: null
				}
			}
		])
	);
	db.close();
}

/** A `getMessageBoxes` box with the account's read position and one unread message. */
const readBox = (id: string, marker: bigint) => ({
	id,
	midType: 'USER',
	lastSeenMessageId: marker,
	unreadCount: 1n
});

/** Waits until the worker finished the round it was in and ran two more; `rounds` counts started rounds. */
async function idleRounds(rounds: () => number): Promise<void> {
	const from = rounds();
	await until(() => rounds() >= from + 3, 'worker rounds');
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

	it('keeps backfilling while OpenChat name lookups fail', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		archiveUnnamedSquareSender(root);
		const message = textMessage('800000000000000003', 'history');
		const { daemon } = await start(
			root,
			{
				sync: () => ({}),
				getMessageBoxes: () => ({
					messageBoxes: [{ id: otherMid, midType: 'USER' }],
					hasNext: false
				}),
				getContactsV2: () => ({ contacts: {} }),
				getSquareMembers: () => {
					throw new Error('timed out');
				},
				getRecentMessagesV2: () => [message],
				getPreviousMessagesV2WithRequest: () => [message]
			},
			{ notify: () => {}, backfillPageMs: 0 }
		);

		await until(() => daemon.status().backfill.complete === 1, 'backfill to complete');
	});

	it('stops for good when the archive fails during an OpenChat name lookup', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		archiveUnnamedSquareSender(root);
		const { daemon } = await start(
			root,
			{
				sync: () => ({}),
				getSquareMembers: () => {
					throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
				}
			},
			{ notify: () => {} }
		);

		await until(() => daemon.session.state() === 'storage_error', 'storage_error');
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
			// Far above the 5 ms answers, so a slow runner cannot make one look held.
			{ notify: () => {}, worker: false, talkHeldMs: 1000 }
		);

		await until(() => revision > 5, 'more than five polls');

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

	it('takes a Talk read snapshot at start, every 10 minutes and after a reset', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		// A chat LINE leaves out of every snapshot.
		const left = `u${'7'.repeat(32)}`;
		archiveTalk(root, left, '1001');
		let clock = 1_900_000_000_000;
		let snapshots = 0;
		let rounds = 0;
		let reset = false;
		const { daemon } = await start(
			root,
			{
				sync: () => {
					if (!reset) return {};
					reset = false;
					return { fullSyncResponse: { nextRevision: 10n, reasons: [] } };
				},
				getMessageBoxes: (value) => {
					if (!field(value, 2, 5)) return { messageBoxes: [], hasNext: false };
					snapshots++;
					const box = { id: otherMid, midType: 'USER', lastSeenMessageId: 10n, unreadCount: 1n };
					return { messageBoxes: [box], hasNext: false };
				},
				// Discovery runs every worker round here, so it counts the rounds.
				getAllChatMids: () => {
					rounds++;
					return { memberChatMids: [] };
				},
				getContactsV2: () => ({ contacts: {} })
			},
			{ notify: () => {}, now: () => clock, discoveryIntervalMs: 0 }
		);

		await until(() => snapshots === 1 && rounds >= 6, 'worker rounds after the first snapshot');
		expect(snapshots).toBe(1);
		const listed = await callTool(daemon.mcp!.port, 'list_unread');
		expect(listed.data.chats).toEqual([
			expect.objectContaining({ chat_id: left, messages_unknown: true }),
			expect.objectContaining({ chat_id: otherMid, unread_count: 0, line_unread_count: 1 })
		]);

		clock += 10 * 60 * 1000;
		await until(() => snapshots === 2, 'a snapshot 10 minutes later');
		reset = true;
		await until(() => snapshots === 3, 'a snapshot after a reset');
	});

	it('keeps the pages a failed Talk read snapshot committed and retries it after a backoff', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const [first, second] = [`u${'3'.repeat(32)}`, `u${'4'.repeat(32)}`];
		let clock = 1_900_000_000_000;
		let failing = true;
		let attempts = 0;
		let rounds = 0;
		const { daemon } = await start(
			root,
			{
				sync: () => ({}),
				getMessageBoxes: (value) => {
					if (!field(value, 2, 5)) return { messageBoxes: [], hasNext: false };
					if (field(value, 2, 1) !== first) {
						return { messageBoxes: [readBox(first, 10n)], hasNext: true };
					}
					attempts++;
					if (failing) throw talkError('ILLEGAL_ARGUMENT');
					return { messageBoxes: [readBox(second, 20n)], hasNext: false };
				},
				// Discovery runs every worker round here, so it counts the rounds.
				getAllChatMids: () => {
					rounds++;
					return { memberChatMids: [] };
				},
				getContactsV2: () => ({ contacts: {} })
			},
			{ notify: () => {}, now: () => clock, discoveryIntervalMs: 0 }
		);
		const known = async () =>
			((await callTool(daemon.mcp!.port, 'list_unread')).data.chats as { chat_id: string }[]).map(
				(chat) => chat.chat_id
			);
		const idle = () => idleRounds(() => rounds);

		await until(() => attempts === 1, 'the first snapshot');
		await idle();
		expect(attempts).toBe(1);
		expect(await known()).toEqual([first]);

		clock += 60_000 - 1;
		await idle();
		expect(attempts).toBe(1);
		clock += 1;
		await until(() => attempts === 2, 'a retry after 1 minute');
		await idle();

		clock += 120_000 - 1;
		await idle();
		expect(attempts).toBe(2);
		failing = false;
		clock += 1;
		await until(() => attempts === 3, 'a retry after 2 more minutes');
		await vi.waitFor(async () => expect(await known()).toEqual([first, second]), {
			timeout: 3000
		});

		// A success resets the backoff to 1 minute.
		failing = true;
		clock += 10 * 60 * 1000;
		await until(() => attempts === 4, 'the next snapshot 10 minutes later');
		await idle();
		clock += 60_000;
		await until(() => attempts === 5, 'a retry 1 minute after it failed');
	});

	it('caps the backoff of a failing Talk read snapshot at 10 minutes', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		let clock = 1_900_000_000_000;
		let attempts = 0;
		let rounds = 0;
		await start(
			root,
			{
				sync: () => ({}),
				getMessageBoxes: (value) => {
					if (!field(value, 2, 5)) return { messageBoxes: [], hasNext: false };
					attempts++;
					throw talkError('ILLEGAL_ARGUMENT');
				},
				// Discovery runs every worker round here, so it counts the rounds.
				getAllChatMids: () => {
					rounds++;
					return { memberChatMids: [] };
				},
				getContactsV2: () => ({ contacts: {} })
			},
			{ notify: () => {}, now: () => clock, discoveryIntervalMs: 0 }
		);
		const idle = () => idleRounds(() => rounds);

		// The waits after five failures: 1, 2, 4 and 8 minutes, then 10 rather than 16.
		for (const [attempt, minutes] of [
			[1, 1],
			[2, 2],
			[3, 4],
			[4, 8],
			[5, 10]
		] as const) {
			await until(() => attempts === attempt, `attempt ${attempt}`);
			await idle();
			clock += minutes * 60_000 - 1;
			await idle();
			expect(attempts).toBe(attempt);
			clock += 1;
		}
		await until(() => attempts === 6, 'a retry 10 minutes after the fifth failure');
	});

	it('takes the Talk read snapshot again when a reset arrives while it runs', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { promise: gate, resolve: open } = Promise.withResolvers<void>();
		let snapshots = 0;
		let syncs = 0;
		let reset = false;
		let resetSync: number | undefined;
		await start(
			root,
			{
				sync: () => {
					syncs++;
					if (!reset) return {};
					reset = false;
					resetSync = syncs;
					return { fullSyncResponse: { nextRevision: 10n, reasons: [] } };
				},
				getMessageBoxes: async (value) => {
					if (!field(value, 2, 5)) return { messageBoxes: [], hasNext: false };
					if (++snapshots === 1) await gate;
					return { messageBoxes: [readBox(otherMid, 10n)], hasNext: false };
				}
			},
			// The clock stands still: only a reset makes the snapshot due again.
			{ notify: () => {}, now: () => 1_900_000_000_000 }
		);

		await until(() => snapshots === 1, 'the first page pending');
		reset = true;
		// The Talk loop handles a step before it asks for the next one.
		await until(() => resetSync !== undefined && syncs > resetSync, 'the reset handled');
		open();
		await until(() => snapshots === 2, 'a snapshot after the reset');
	});

	it('sweeps OpenChat once at start despite a recent sweep, and again after a stall', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const clock = 1_900_000_000_000;
		const db = openDatabase(root);
		writeState(db, 'square:sweptAt', clock);
		db.close();
		const discovery = squareDiscovery([squareChat]);
		let sweeps = 0;
		let fetches = 0;
		let stallPages = 0;
		const { daemon } = await start(
			root,
			{
				...discovery.handlers,
				sync: () => ({}),
				getSquareChat: (value, base) => ({
					...(discovery.handlers.getSquareChat!(value, base) as object),
					squareChatStatus: {
						otherStatus: { markedAsReadMessageId: '20', unreadMessageCount: ++sweeps }
					}
				}),
				// A token that leads back to itself stalls the stream.
				fetchMyEvents: () => {
					fetches++;
					const stalling = stallPages > 0;
					if (stalling) stallPages--;
					return {
						events: discovery.events,
						syncToken: 'my-1',
						...(stalling ? { continuationToken: 'again' } : {})
					};
				},
				fetchSquareChatEvents: () => ({ events: [], syncToken: 'chat-1' })
			},
			{ notify: () => {}, now: () => clock, worker: false }
		);

		await until(() => sweeps === 1, 'a sweep at start');
		const steps = fetches;
		await until(() => fetches >= steps + 5, 'more Square steps');
		expect(sweeps).toBe(1);
		const listed = await callTool(daemon.mcp!.port, 'list_unread');
		expect(listed.data.chats).toEqual([
			expect.objectContaining({ chat_id: squareChat, unread_count: 0, line_unread_count: 1 })
		]);

		// Two pages under the same token close one cycle: exactly one stall, so the count settles.
		stallPages = 2;
		await until(() => sweeps === 2, 'a sweep after the stall');
	});

	it('reports online once both loops are caught up', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const { daemon } = await start(root, { sync: () => ({}) }, { notify: () => {} });

		await until(() => daemon.health() === 'online', 'online');
		expect(daemon.status()).toMatchObject({ health: 'online', stale: false });
	});
});
