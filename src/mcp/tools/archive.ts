import { z } from 'zod';
import { listGaps } from '../../archive.ts';
import { readAccount } from '../../db.ts';
import { renderTime, timeZone } from '../../time.ts';
import { defineTool } from '../tool.ts';

// The archive's status, from the local copy alone; it never calls LINE. Agents
// read the archive itself with `query` (./query.ts).

export const status = defineTool({
	name: 'status',
	description:
		'Session health, last sync times, unreconciled coverage gaps, backfill progress, archive size and time_zone, the zone whose offset every time carries. Check stale before treating other results as current.',
	input: z.object({}),
	run: (_args, context) => {
		const { db } = context;
		const account = readAccount(db);
		const gaps = listGaps(db, { status: 'unreconciled' });
		const count = (sql: string) => Number(db.prepare(sql).get()?.count ?? 0);
		return {
			account: account ? { mid: account.mid, auth_state: account.authState } : null,
			unreconciled_gaps: gaps.length,
			gaps: gaps.slice(0, 50).map((gap) => ({
				service: gap.service,
				scope: gap.scope,
				reason: gap.reason,
				status: gap.status,
				opened_at: renderTime(gap.openedAt)
			})),
			backfill: context.status().backfill,
			archive: {
				chats: count('SELECT count(*) AS count FROM chat'),
				messages: count('SELECT count(*) AS count FROM message'),
				latest_seq: count('SELECT value AS count FROM change_counter WHERE id = 1')
			},
			time_zone: timeZone()
		};
	}
});
