import type { DatabaseSync } from 'node:sqlite';
import { enums, type Pb1_X7 as SyncResponse } from '@evex/linejs-types';
import { closeGap, type Gap, listGaps, openGap } from '../archive.ts';
import { decimal } from '../probe.ts';
import { discoverChats, reconcileTalkChat } from './backfill.ts';
import type { Pool, SyncContext } from './loop.ts';
import { enumName } from './normalize.ts';
import type { TalkCursor } from './talk.ts';

const opsCategory = enums.SyncCategory.OPS;

/**
 * Checkpoints a reset as the response says: a full sync continues from its
 * `nextRevision`, a partial full sync of the OPS category from that category's
 * revision. Other categories do not move the operation revision.
 */
export function applyResetCursor(
	cursor: TalkCursor,
	response: Partial<SyncResponse> | undefined
): TalkCursor {
	const next = { ...cursor };
	const full = response?.fullSyncResponse?.nextRevision;
	if (full !== undefined && full !== null) next.revision = decimal(full);
	const ops = response?.partialFullSyncResponse?.targetCategories?.[opsCategory];
	if (ops !== undefined && ops !== null) next.revision = decimal(ops);
	return next;
}

/**
 * Records every reset in the response as an open coverage gap: one for a full
 * sync and one per partial-full-sync category, including categories this
 * version does not know. The library loop is not copied here because it
 * advances without reconciliation (base/polling/mod.ts:104-138).
 */
export function recordReset(
	db: DatabaseSync,
	input: {
		from: TalkCursor;
		to: TalkCursor;
		response: Partial<SyncResponse> | undefined;
		since: number | null;
		/** Highest message row id before the response was applied: the trusted history. */
		boundary: number;
		now: number;
	}
): number[] {
	const ids: number[] = [];
	const base = {
		fromRevision: input.from.revision,
		toRevision: input.to.revision,
		since: input.since,
		boundary: input.boundary
	};
	const full = input.response?.fullSyncResponse;
	if (full) {
		ids.push(
			openGap(
				db,
				{
					service: 'talk',
					scope: 'all',
					reason: 'full_sync',
					detail: { ...base, reasons: (full.reasons ?? []).map((reason) => String(reason)) }
				},
				{ now: input.now }
			)
		);
	}
	const partial = input.response?.partialFullSyncResponse;
	if (partial) {
		const categories = Object.entries(partial.targetCategories ?? {});
		if (categories.length === 0) {
			ids.push(
				openGap(
					db,
					{ service: 'talk', scope: 'unspecified', reason: 'partial_full_sync', detail: base },
					{ now: input.now }
				)
			);
		}
		for (const [category, revision] of categories) {
			const known = (Object.values(enums.SyncCategory) as number[]).includes(Number(category));
			const name = known ? enumName(enums.SyncCategory, Number(category)) : category;
			ids.push(
				openGap(
					db,
					{
						service: 'talk',
						scope: `category:${name}`,
						reason: 'partial_full_sync',
						detail: {
							...base,
							category,
							known,
							revision: revision === undefined || revision === null ? null : decimal(revision)
						}
					},
					{ now: input.now }
				)
			);
		}
	}
	return ids;
}

/** Chat and contact categories are reconciled by enumeration; anything else also needs history. */
const enumerationScopes = new Set(
	[
		'PROFILE',
		'SETTINGS',
		'CONTACT',
		'RECOMMEND',
		'BLOCK',
		'GROUP',
		'ROOM',
		'NOTIFICATION',
		'ADDRESS_BOOK',
		'MULTI_PROFILE'
	].map((name) => `category:${name}`)
);

function needsHistory(gap: Gap): boolean {
	return !enumerationScopes.has(gap.scope);
}

/** Chats active within this margin before the last good sync are reconciled too. */
const activityMarginMs = 10 * 60 * 1000;

export interface ReconcileOptions {
	maxPages?: number;
}

/**
 * Reconciles open Talk gaps: re-enumerates chats, then pages each chat with
 * activity since the last good sync back until it meets archived history or
 * the page bound. A gap is `reconciled` when every chat met its history and
 * `incomplete` otherwise; both stay listed until reconciled. A transient
 * failure leaves the gap open for the next attempt.
 */
export async function reconcileTalkGaps(
	context: SyncContext,
	pool: Pool,
	options: ReconcileOptions = {}
): Promise<number> {
	const gaps = listGaps(context.db, { service: 'talk', status: 'open' });
	if (gaps.length === 0) return 0;
	const chats = (await discoverChats(context, pool)).filter((chat) => chat.service === 'talk');
	for (const gap of gaps) {
		if (!needsHistory(gap)) {
			closeGap(context.db, gap.id, 'reconciled', { chats: chats.length }, context.now());
			continue;
		}
		const since = typeof gap.detail.since === 'number' ? gap.detail.since : null;
		// Only rows archived before the gap opened anchor it; the same boundary
		// holds for every retry, so pages a failed attempt committed never do.
		const boundary = typeof gap.detail.boundary === 'number' ? gap.detail.boundary : 0;
		const affected = chats.filter(
			(chat) =>
				since === null ||
				chat.lastActivityAt === undefined ||
				chat.lastActivityAt >= since - activityMarginMs
		);
		const results = await Promise.all(
			affected.map((chat) =>
				reconcileTalkChat(context, pool, chat.chatId, boundary, options.maxPages)
			)
		);
		const incomplete = results.filter((met) => !met).length;
		closeGap(
			context.db,
			gap.id,
			incomplete ? 'incomplete' : 'reconciled',
			{ chats: affected.length, incomplete },
			context.now()
		);
	}
	return gaps.length;
}
