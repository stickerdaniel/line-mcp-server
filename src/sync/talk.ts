import type { DatabaseSync } from 'node:sqlite';
import type { Pb1_X7 as SyncResponse } from '@evex/linejs-types';
import { readState, talkSyncedAtKey, writeState } from '../archive.ts';
import { transaction } from '../db.ts';
import { isHttpStatus } from '../errors.ts';
import { decimal } from '../probe.ts';
import { type LoopOptions, minIdleMs, runLoop, type SyncContext } from './loop.ts';
import { applyChanges, messageBoundary, normalizeOperations, opName } from './normalize.ts';
import { applyResetCursor, recordReset } from './reset.ts';

/** Talk revisions, as decimal strings. */
export interface TalkCursor {
	revision: string;
	globalRev: string;
	individualRev: string;
	/**
	 * Trusted boundary of this position (see `messageBoundary`): rows at or
	 * below it reached the archive before a request whose operations this
	 * cursor fully covers. Absent before the first complete sync, which
	 * means unknown: no row is trusted.
	 */
	boundary?: number;
}

export const talkCursorKey = 'talk:cursor';

export function readTalkCursor(db: DatabaseSync): TalkCursor {
	return (
		readState<TalkCursor>(db, talkCursorKey) ?? {
			revision: '0',
			globalRev: '0',
			individualRev: '0'
		}
	);
}

export interface TalkStep {
	operations: number;
	hasMore: boolean;
	reset: boolean;
	keysChanged: boolean;
	chats: string[];
	elapsedMs: number;
	/** LINE ended an idle long poll (HTTP 410) instead of answering. */
	longPollEnded: boolean;
}

const idleStep = { operations: 0, hasMore: false, reset: false, keysChanged: false, chats: [] };

/**
 * One `talk.sync` call from the last committed revisions. Messages, tombstones,
 * any coverage gap and the new revisions are written in one transaction, so a
 * crash before the commit refetches the batch and a crash after it loses
 * nothing.
 */
export async function syncTalkOnce(context: SyncContext, limit = 100): Promise<TalkStep> {
	const { db } = context;
	const from = readTalkCursor(db);
	// Fixed before the first await: rows other workers commit while the
	// request is pending never become trusted through it.
	const requested = messageBoundary(db);
	// A cursor without a boundary (the first sync, also after a crash that
	// kept backfill rows but not the first cursor) proves nothing: trust no row.
	const trusted = from.boundary ?? 0;
	const started = context.now();
	let response: Partial<SyncResponse> | undefined;
	try {
		// LINEJS sends `sync` with `config.longTimeout` (180 s in 3.5.0), longer
		// than the roughly 110 s LINE holds an idle long poll.
		response = (await context.base.talk.sync({
			limit,
			revision: BigInt(from.revision),
			globalRev: BigInt(from.globalRev),
			individualRev: BigInt(from.individualRev)
		})) as Partial<SyncResponse> | undefined;
	} catch (error) {
		if (!isHttpStatus(error, 410)) throw error;
		// The long poll ended without news: an empty batch that leaves the
		// cursor as it is and is not a failure. It proves the archive current.
		const now = context.now();
		writeState(db, talkSyncedAtKey, now, now);
		return { ...idleStep, elapsedMs: now - started, longPollEnded: true };
	}
	const elapsedMs = context.now() - started;
	const operations = response?.operationResponse?.operations ?? [];
	const batch = await normalizeOperations(context, operations);
	const hasMore = response?.operationResponse?.hasMoreOps === true;
	// As in LINEJS, a reset sets the revision first and the batch's operations then advance it.
	// A complete response covers every message that existed when it was requested;
	// a truncated one does not, so it keeps the boundary it continues from.
	const to = {
		...advanceCursor(applyResetCursor(from, response), response),
		boundary: hasMore ? trusted : requested
	};
	const since = readState<number>(db, talkSyncedAtKey) ?? null;
	const reset = transaction(db, () => {
		const now = context.now();
		applyChanges(db, batch.changes, { now });
		// A reset loses operations after `from`: only rows trusted at `from` anchor it.
		const gaps = recordReset(db, { from, to, response, since, boundary: trusted, now });
		writeState(db, talkCursorKey, to, now);
		writeState(db, talkSyncedAtKey, now, now);
		return gaps.length > 0;
	});
	return {
		operations: operations.length,
		hasMore,
		reset,
		keysChanged: batch.keysChanged,
		chats: [...batch.chats],
		elapsedMs,
		longPollEnded: false
	};
}

function integer(value: unknown): string | undefined {
	if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') {
		return undefined;
	}
	try {
		return decimal(value);
	} catch {
		return undefined;
	}
}

/**
 * Operation revisions only move the cursor forward. `END_OF_OPERATION` carries
 * the individual and global revisions in param1 and param2 (as LINEJS reads
 * them in base/push/connManager.ts:391-409).
 */
export function advanceCursor(
	from: TalkCursor,
	response: Partial<SyncResponse> | undefined
): TalkCursor {
	const next = { ...from };
	const operationResponse = response?.operationResponse;
	for (const operation of operationResponse?.operations ?? []) {
		const revision = integer(operation.revision);
		if (revision !== undefined && BigInt(revision) > BigInt(next.revision)) {
			next.revision = revision;
		}
		if (opName(operation.type) === 'END_OF_OPERATION') {
			const individual = integer(String(operation.param1 ?? '').split('\x1e')[0]);
			const global = integer(String(operation.param2 ?? '').split('\x1e')[0]);
			if (individual !== undefined) next.individualRev = individual;
			if (global !== undefined) next.globalRev = global;
		}
	}
	const global = integer(operationResponse?.globalEvents?.lastRevision);
	if (global !== undefined) next.globalRev = global;
	const individual = integer(operationResponse?.individualEvents?.lastRevision);
	if (individual !== undefined) next.individualRev = individual;
	return next;
}

/**
 * Only a batch that says more operations are waiting is fetched at once. An
 * empty batch waits a full second; a non-empty one returning sooner than a
 * second waits out the rest. A long poll that LINE ended polls again at once,
 * unless it ended within a second.
 */
export function talkDelay(step: TalkStep): number {
	if (step.operations > 0 && step.hasMore) return 0;
	if (step.operations === 0 && !step.longPollEnded) return minIdleMs;
	return Math.max(0, minIdleMs - step.elapsedMs);
}

/** A `sync` request LINE still holds after this long had nothing waiting. */
export const heldPollMs = 5000;

export interface TalkLoopHooks {
	onStep?: (step: TalkStep) => void;
	/**
	 * A request is still pending after `heldMs`: LINE holds a long poll only
	 * when it has nothing to deliver, so there is no backlog.
	 */
	onHeld?: () => void;
	heldMs?: number;
}

export async function runTalkLoop(
	context: SyncContext,
	options: LoopOptions,
	hooks: TalkLoopHooks = {}
): Promise<void> {
	await runLoop(async () => {
		const held = setTimeout(() => {
			if (!options.signal.aborted) hooks.onHeld?.();
		}, hooks.heldMs ?? heldPollMs);
		held.unref();
		let step: TalkStep;
		try {
			step = await syncTalkOnce(context);
		} finally {
			clearTimeout(held);
		}
		hooks.onStep?.(step);
		return talkDelay(step);
	}, options);
}
