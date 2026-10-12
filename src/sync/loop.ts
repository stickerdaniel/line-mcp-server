import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { mapError } from '../errors.ts';
import { isTerminalAuthError, type Log } from '../session.ts';
import type { NormalizeContext } from './normalize.ts';

/** What every sync module works with: the session's client and archive. */
export interface SyncContext extends NormalizeContext {
	db: DatabaseSync;
	log: Log;
	now: () => number;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms` or as soon as the signal aborts. */
export const sleep: Sleep = async (ms, signal) => {
	try {
		await delay(ms, undefined, { signal });
	} catch {
		// Aborted: the caller checks its signal.
	}
};

export const minBackoffMs = 1000;
export const maxBackoffMs = 5 * 60 * 1000;
/** An empty or immediately returning call waits at least this long. */
export const minIdleMs = 1000;
/**
 * Floor between two history requests (backfill, reconciliation) of one chat,
 * and between two backfill rounds: however LINE pages, history work stays
 * well below one request per second.
 */
export const historyStepMs = 3000;

/** Exponential backoff with jitter, 1 s to 5 min, for the `failures`-th consecutive failure. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
	const ceiling = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(failures, 20));
	return Math.max(minBackoffMs, Math.round(ceiling / 2 + (random() * ceiling) / 2));
}

/** Failures worth retrying later; any other LINE code is final for that request. */
const transientCodes = new Set([
	'network_error',
	'upstream_timeout',
	'upstream_parse_error',
	'upstream_error',
	'internal_error',
	// Session-wide states: the loops stop, nothing is recorded per chat.
	'needs_login',
	'storage_error',
	'INTERNAL_ERROR',
	'RETRY_LATER',
	'TRY_AGAIN_LATER',
	'NOT_AVAILABLE_SESSION',
	'EXCESSIVE_ACCESS'
]);

/**
 * Whether a failure must leave per-chat work (cursors, gaps, jobs) as it is.
 * A lost session is a session-wide pause, not a refusal of this chat: the
 * session wrapper rethrows the raw LINE error after it enters `needs_login`,
 * and the work resumes after the next login.
 */
export function isTransient(error: unknown, operation: string): boolean {
	return transientCodes.has(mapError(error, operation).code) || isTerminalAuthError(error);
}

/**
 * Bounded upstream concurrency for history, media and mutations (architecture,
 * Upstream concurrency). A finishing task hands its slot straight to the next
 * waiter.
 */
export class Pool {
	readonly size: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(size = 2) {
		this.size = size;
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.#active < this.size) {
			this.#active++;
		} else {
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		try {
			return await task();
		} finally {
			const next = this.#waiting.shift();
			if (next) next();
			else this.#active--;
		}
	}
}

export interface LoopOptions {
	name: string;
	signal: AbortSignal;
	sleep: Sleep;
	random: () => number;
	/** False once the session leaves `online`; the loop then makes no further calls. */
	canRun: () => boolean;
	log: Log;
	onSuccess?: () => void;
	onFailure?: (error: unknown) => void;
}

/**
 * Runs `step` until stopped. `step` returns how long to wait before the next
 * call; failures back off exponentially and reset after a success.
 */
export async function runLoop(step: () => Promise<number>, options: LoopOptions): Promise<void> {
	let failures = 0;
	while (!options.signal.aborted && options.canRun()) {
		let wait: number;
		try {
			wait = await step();
			failures = 0;
			options.onSuccess?.();
		} catch (error) {
			if (options.signal.aborted || !options.canRun()) break;
			wait = backoffMs(failures++, options.random);
			options.log({
				event: 'sync_retry',
				loop: options.name,
				...mapError(error, options.name),
				retryInMs: wait
			});
			options.onFailure?.(error);
		}
		if (wait > 0 && !options.signal.aborted) await options.sleep(wait, options.signal);
	}
}
