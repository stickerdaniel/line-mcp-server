import { z } from 'zod';
import { listGaps } from '../../archive.ts';
import { readAccount } from '../../db.ts';
import {
	listChangesPage,
	listChatsPage,
	readMessagesPage,
	renderTime,
	searchMessagesPage,
	timeZone
} from '../../queries.ts';
import { chatId, cursor, defineTool, limit, messageId, service } from '../tool.ts';

// Tools that read only the local archive; none of them calls LINE.

export const status = defineTool({
	name: 'status',
	description:
		'Session health, last sync times, unreconciled coverage gaps, backfill progress, archive size and time_zone, the zone every local time is given in. Check stale before treating other results as current.',
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

export const listChats = defineTool({
	name: 'list_chats',
	description:
		'Chats in the archive (one-to-one, groups, rooms, OpenChat), most recent activity first, with display names.',
	input: z.object({
		service: service.optional(),
		name: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe('Only chats whose display name contains this text'),
		limit,
		cursor
	}),
	run: (args, { db }) =>
		listChatsPage(db, {
			...(args.service ? { service: args.service } : {}),
			...(args.name ? { name: args.name } : {}),
			...(args.limit ? { limit: args.limit } : {}),
			...(args.cursor ? { cursor: args.cursor } : {})
		})
});

export const readMessages = defineTool({
	name: 'read_messages',
	description:
		'Messages of one chat or thread, oldest first within a page. Without a cursor: the newest page. older_cursor and newer_cursor page from there; around_message_id centres a page on one message. Unsent messages appear without text.',
	input: z.object({
		service,
		chat_id: chatId,
		thread_id: z.string().min(1).max(100).optional().describe('Only this Square thread'),
		around_message_id: messageId.optional().describe('Centre the page on this message'),
		limit,
		cursor
	}),
	run: (args, { db, selfMid }) =>
		readMessagesPage(db, selfMid, {
			service: args.service,
			chatId: args.chat_id,
			...(args.thread_id ? { threadId: args.thread_id } : {}),
			...(args.around_message_id ? { aroundMessageId: args.around_message_id } : {}),
			...(args.limit ? { limit: args.limit } : {}),
			...(args.cursor ? { cursor: args.cursor } : {})
		})
});

export const searchMessages = defineTool({
	name: 'search_messages',
	description:
		'Search message text, newest first. Queries of 3 or more characters use the trigram index; 1 or 2 characters scan one chat, or the 20,000 most recent messages when no chat is given.',
	input: z.object({
		query: z.string().min(1).max(200).describe('Text to find, for example 晚餐'),
		service: service.optional(),
		chat_id: chatId.optional(),
		limit,
		cursor
	}),
	run: (args, { db, selfMid }) =>
		searchMessagesPage(db, selfMid, {
			query: args.query,
			...(args.service ? { service: args.service } : {}),
			...(args.chat_id ? { chatId: args.chat_id } : {}),
			...(args.limit ? { limit: args.limit } : {}),
			...(args.cursor ? { cursor: args.cursor } : {})
		})
});

export const listChanges = defineTool({
	name: 'list_changes',
	description:
		'Every message inserted or changed (edit, unsend, late decryption) after after_seq, in seq order. Continue with next_after_seq. A message changed again reappears with its new seq; nothing is skipped.',
	input: z.object({
		after_seq: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe('Return changes with a larger seq; default 0'),
		limit
	}),
	run: (args, { db, selfMid }) =>
		listChangesPage(db, selfMid, {
			afterSeq: args.after_seq ?? 0,
			...(args.limit ? { limit: args.limit } : {})
		})
});
