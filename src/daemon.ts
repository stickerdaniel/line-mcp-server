import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
	type ArchiveStatus,
	archiveStatus,
	type Health,
	healthKey,
	type HealthRecord,
	listGaps,
	readHealth,
	upsertParticipant,
	writeState
} from './archive.ts';
import { transaction } from './db.ts';
import { LineMcpError, mapError } from './errors.ts';
import { type McpServer, startMcpServer } from './mcp/server.ts';
import { stateRoot } from './paths.ts';
import { type Log, openSession, type Session, type SessionOptions, stderrLog } from './session.ts';
import {
	backfillRound,
	discoverChats,
	nameSquareSenders,
	pendingBackfill,
	snapshotTalkReadState
} from './sync/backfill.ts';
import {
	historyStepMs,
	isStorageFailure,
	isTransient,
	type LoopOptions,
	Pool,
	runLoop,
	type Sleep,
	sleep as timerSleep,
	type SyncContext
} from './sync/loop.ts';
import { retryMissingKeys } from './sync/normalize.ts';
import { reconcileTalkGaps } from './sync/reset.ts';
import { readPending, runSquareLoop, type SquareOptions } from './sync/square.ts';
import { runTalkLoop } from './sync/talk.ts';

export type Notify = (message: string) => void | Promise<void>;

/** A macOS notification with fixed text; it never carries message content. */
export const notifyMac: Notify = (message) =>
	new Promise<void>((resolve) => {
		execFile(
			'/usr/bin/osascript',
			['-e', `display notification ${JSON.stringify(message)} with title "line-mcp"`],
			() => resolve()
		);
	});

const notices: Partial<Record<Health, string>> = {
	needs_login: 'LINE ended the session. Run line-mcp login to scan a new QR code.',
	storage_error: 'line-mcp cannot write its archive. Sync is stopped.'
};

export interface DaemonOptions extends SessionOptions {
	sleep?: Sleep;
	random?: () => number;
	now?: () => number;
	notify?: Notify;
	square?: SquareOptions;
	/** Discovery, gap reconciliation, key retries and backfill; on by default. */
	worker?: boolean;
	/** Wait between worker rounds that advanced a backfill; never below `historyStepMs`. */
	backfillPageMs?: number;
	/** Wait between worker rounds with nothing to do. */
	workerIdleMs?: number;
	/** A Talk `sync` held this long counts as caught up; `heldPollMs` by default. */
	talkHeldMs?: number;
	discoveryIntervalMs?: number;
	keyRetryIntervalMs?: number;
	/** MCP port; `LINE_MCP_PORT` or 47822 by default, 0 for any free port, false for none. */
	mcpPort?: number | false;
}

export interface Daemon {
	readonly session: Session;
	/** The MCP listener, unless the daemon runs without one. */
	readonly mcp: McpServer | undefined;
	health(): Health;
	/** Cached reads stay available in every state; `stale` says whether to trust them as current. */
	status(): ArchiveStatus;
	/** Resolves once every loop has ended. */
	readonly loops: Promise<void>;
	stop(): Promise<void>;
}

const noop = () => {};

/**
 * Starts the daemon: the session in its fixed startup order (lock, database,
 * binding, guards, token handler, restore), then the Talk loop, the Square
 * loop and the worker. When the session leaves `online` every loop stops
 * calling upstream while the archive stays open for cached reads.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
	const log = options.log ?? stderrLog;
	const now = options.now ?? Date.now;
	const notify = options.notify ?? notifyMac;
	const controller = new AbortController();
	// Assigned once the session is open; a state change during startup is read from the session.
	let update: () => void = noop;
	// Routine RPC names stay out of the launchd log; errors and state changes do not.
	const sessionLog: Log = (entry) => {
		if (entry.event === 'upstream_call' || entry.event === 'long_poll_ended') return;
		log(entry);
		if (entry.event === 'session_state') update();
	};
	const session = await openSession({ ...options, log: sessionLog });
	const { db } = session;
	// The own chat (Keep Memo) is named after the profile the session restored.
	const ownName = session.base.profile?.displayName;
	try {
		if (ownName) upsertParticipant(db, 'talk', session.account.mid, ownName, now());
	} catch {
		// Only a label; the loops meet a failing archive soon enough.
	}

	const offline = { talk: false, square: false, worker: false };
	const catchingUp = { talk: true, square: true };
	let current = readHealth(db)?.state;

	const compute = (): Health => {
		const state = session.state();
		if (state !== 'online') return state;
		if (offline.talk || offline.square) return 'offline';
		if (catchingUp.talk || catchingUp.square) return 'catching_up';
		if (listGaps(db, { status: 'open' }).length > 0) return 'catching_up';
		return 'online';
	};

	// `current` starts from the persisted state, so a restart in the same state
	// (launchd KeepAlive) is not a transition and announces nothing.
	update = () => {
		const next = compute();
		if (session.state() !== 'online') controller.abort();
		if (next === current) return;
		current = next;
		log({ event: 'health', state: next });
		try {
			writeState(db, healthKey, { state: next, since: now() } satisfies HealthRecord);
		} catch {
			// The archive itself failed; the state is still logged and announced.
		}
		const notice = notices[next];
		if (notice) void notify(notice);
	};
	update();

	const context: SyncContext = {
		db,
		base: session.base,
		selfMid: session.account.mid,
		log,
		now
	};
	const pool = new Pool(2);
	const status = () => {
		update();
		return archiveStatus(db, current);
	};

	// The MCP listener starts before the loops and stops first. A port that
	// cannot be bound ends startup like a held lock: no fallback port.
	let mcp: McpServer | undefined;
	if (options.mcpPort !== false) {
		try {
			mcp = await startMcpServer(
				{
					db,
					base: session.base,
					selfMid: session.account.mid,
					pool,
					attachments: join(options.root ?? stateRoot(), 'attachments'),
					status,
					log
				},
				options.mcpPort === undefined ? {} : { port: options.mcpPort }
			);
		} catch (error) {
			await session.close();
			throw error;
		}
		log({ event: 'mcp_listening', port: mcp.port });
	}

	const loopOptions = (name: keyof typeof offline): LoopOptions => ({
		name,
		signal: controller.signal,
		sleep: options.sleep ?? timerSleep,
		random: options.random ?? Math.random,
		canRun: () => session.state() === 'online' && !controller.signal.aborted,
		log,
		onSuccess: () => {
			offline[name] = false;
			if (name === 'square') catchingUp.square = readPending(db).length > 0;
			update();
		},
		onFailure: (error) => {
			// An archive failure is terminal for the session, like a failed token
			// write: no loop success clears it, and upstream dispatch stops.
			if (isStorageFailure(error)) session.storageFailed();
			else if (isTransient(error, name)) offline[name] = true;
			update();
		}
	});

	let discoveredAt = Number.NEGATIVE_INFINITY;
	let keysRetriedAt = Number.NEGATIVE_INFINITY;
	let discoveryDue = false;
	let keysDue = true;
	/** A chat change seen in Talk triggers discovery at most this often. */
	const rediscoveryMs = 10 * 60 * 1000;
	const discoveryIntervalMs = options.discoveryIntervalMs ?? 6 * 60 * 60 * 1000;
	const keyRetryIntervalMs = options.keyRetryIntervalMs ?? 15 * 60 * 1000;
	/** How often the Talk read state snapshot becomes due. */
	const readSnapshotIntervalMs = 10 * 60 * 1000;
	/** The first retry delay after a failed snapshot; it doubles up to the interval. */
	const readSnapshotRetryMs = 60 * 1000;
	let readSnapshotDueAt = Number.NEGATIVE_INFINITY;
	let readSnapshotBackoffMs = readSnapshotRetryMs;
	// A phase LINE refuses for good is logged and retried on its own schedule;
	// it must not keep the other phases, and backfill, from running. Resolves
	// to whether the phase succeeded.
	const phase = async (name: string, body: () => Promise<unknown>): Promise<boolean> => {
		try {
			await body();
			return true;
		} catch (error) {
			if (isTransient(error, name)) throw error;
			log({ event: 'worker_phase_failed', ...mapError(error, name) });
			return false;
		}
	};
	const worker = async (): Promise<number> => {
		const since = now() - discoveredAt;
		if (since >= discoveryIntervalMs || (discoveryDue && since >= rediscoveryMs)) {
			await phase('discovery', () => discoverChats(context, pool));
			discoveredAt = now();
			discoveryDue = false;
			// Discovery names Talk senders; this names OpenChat senders no event named.
			await phase('square_names', () => nameSquareSenders(context, pool));
		}
		// Due at start, every 10 minutes and after a Talk reset; a failed
		// snapshot is due again after a backoff that a success resets.
		if (now() >= readSnapshotDueAt) {
			const started = now();
			if (await phase('read_state', () => snapshotTalkReadState(context, pool))) {
				readSnapshotDueAt = started + readSnapshotIntervalMs;
				readSnapshotBackoffMs = readSnapshotRetryMs;
			} else {
				readSnapshotDueAt = now() + readSnapshotBackoffMs;
				readSnapshotBackoffMs = Math.min(readSnapshotBackoffMs * 2, readSnapshotIntervalMs);
			}
		}
		if (listGaps(db, { service: 'talk', status: 'open' }).length > 0) {
			await phase('reconcile', () => reconcileTalkGaps(context, pool));
			update();
		}
		if (keysDue || now() - keysRetriedAt >= keyRetryIntervalMs) {
			await pool.run(() => retryMissingKeys(db, context, (body) => transaction(db, body)));
			keysRetriedAt = now();
			keysDue = false;
		}
		const advanced = await backfillRound(context, pool);
		if (advanced > 0) return Math.max(historyStepMs, options.backfillPageMs ?? 0);
		// Backfills whose history slot is busy are due again within `historyStepMs`.
		return pendingBackfill(context).length > 0 ? historyStepMs : (options.workerIdleMs ?? 30_000);
	};

	const running: Promise<void>[] = [];
	if (session.state() === 'online') {
		running.push(
			runTalkLoop(context, loopOptions('talk'), {
				onStep: (step) => {
					catchingUp.talk = step.hasMore;
					if (step.keysChanged) keysDue = true;
					if (step.chats.length > 0) discoveryDue = true;
					// A reset can skip read operations along with the rest.
					if (step.reset) readSnapshotDueAt = Number.NEGATIVE_INFINITY;
				},
				// An idle long poll answers only after about 110 s; being held already
				// shows there is no backlog.
				onHeld: () => {
					catchingUp.talk = false;
					update();
				},
				heldMs: options.talkHeldMs
			}),
			runSquareLoop(context, loopOptions('square'), options.square)
		);
		if (options.worker !== false) running.push(runLoop(worker, loopOptions('worker')));
	}
	const loops = Promise.all(running).then(() => {});

	let stopped: Promise<void> | undefined;
	return {
		session,
		mcp,
		health: () => {
			update();
			return current!;
		},
		status,
		loops,
		// Nothing reaches LINE once ownership is released: the loops stop, the
		// MCP listener closes and cancels its calls, and the pool fails every
		// waiter (MCP and sync alike) before anything queued can dispatch. The
		// session then refuses any call a task still running would make.
		stop: () =>
			(stopped ??= (async () => {
				controller.abort();
				const closing = mcp?.close();
				const drained = pool.close(
					new LineMcpError('shutting_down', 'The daemon is shutting down')
				);
				// A blocking `sync` or an RPC in flight cannot be cancelled; do not
				// wait for it past a grace period.
				const grace = new AbortController();
				await Promise.race([
					Promise.allSettled([loops, closing, drained]),
					timerSleep(2000, grace.signal)
				]);
				grace.abort();
				await session.close();
			})())
	};
}
