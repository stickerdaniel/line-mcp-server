import { z } from 'zod';
import { listGaps } from '../../archive.ts';
import { readAccount } from '../../db.ts';
import {
	listChangesPage,
	listChatsPage,
	listUnreadPage,
	readMessagesPage,
	searchMessagesPage
} from '../../queries.ts';
import { renderTime, timeZone } from '../../time.ts';
import { chatId, cursor, defineTool, limit, messageId, service } from '../tool.ts';

// Tools that read only the local archive; none of them calls LINE.

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

export const listChats = defineTool({
	name: 'list_chats',
	description:
		'Chats in the archive (one-to-one, groups, rooms, OpenChat), most recent activity first, with display names. last_message is the latest message of each chat, threads included, as a read_messages item with its text cut to 200 characters (text_truncated true when cut). Follow next_cursor for more chats.',
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
	run: (args, { db, selfMid }) =>
		listChatsPage(db, selfMid, {
			...(args.service ? { service: args.service } : {}),
			...(args.name ? { name: args.name } : {}),
			...(args.limit ? { limit: args.limit } : {}),
			...(args.cursor ? { cursor: args.cursor } : {})
		})
});

export const listUnread = defineTool({
	name: 'list_unread',
	description:
		"Every unread message across chats in one call, from the local archive. Marks nothing as read. Read positions come from LINE through sync and snapshots that become due every 10 minutes, so a message read elsewhere a moment ago can still be listed. For a chat with a known read position, messages from others stay listed until line-mcp sees them read, as read_messages items in message ID order. A chat whose read position is unknown has messages_unknown true and no messages. OpenChat thread messages are not included. unread_count counts the archive; line_unread_count is LINE's own count as of line_unread_as_of and can differ. A larger result continues with next_cursor; continued marks a chat carried over from the previous page.",
	input: z.object({ service: service.optional(), cursor }),
	run: (args, { db, selfMid }) =>
		listUnreadPage(db, selfMid, {
			...(args.service ? { service: args.service } : {}),
			...(args.cursor ? { cursor: args.cursor } : {})
		})
});

export const readMessages = defineTool({
	name: 'read_messages',
	description:
		"Messages of one chat or thread, oldest first within a page. Without a cursor: the newest page. older_cursor and newer_cursor page from there; around_message_id centres a page on one message. Unsent messages appear without text. A field without a value is left out: unsent appears only when true, decrypt_state only when not ok, from_self only when known. content_type is text, or LINE's type in lower case. Non-text messages carry, when LINE gives them: alt_text (sticker or Flex), file_name, duration_ms, image_set (index and total), call (type and result) and event (chat changes and the people they name). A canceled call with from_self false is a missed call. get_attachment fetches media.",
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

/**
 * A send time bound; any offset, `Z` included, names the same instant. Send
 * times are whole milliseconds, so a finer fraction is refused rather than cut,
 * which would move an inclusive or exclusive bound.
 */
const sentTime = z.iso
	.datetime({ offset: true })
	.regex(/^[^.]+(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/, 'At most millisecond precision');

export const searchMessages = defineTool({
	name: 'search_messages',
	description:
		'Search message text, newest first. Give up to 10 words or "quoted phrases"; a message matches when its text contains all of them. Text matches as written: search Traditional and Simplified Chinese, or other languages, as separate queries. since, until and sender_id narrow the hits; context adds the messages around each hit in its chat or thread. A query of only 1- or 2-character words searches back in steps: a page may hold no messages yet a next_cursor that continues further back, and scanned_through tells how far back it reached.',
	input: z.object({
		query: z
			.string()
			.min(1)
			.max(200)
			.describe('Words and "quoted phrases" that must all occur, for example 晚餐 "see you"'),
		service: service.optional(),
		chat_id: chatId.optional(),
		since: sentTime
			.optional()
			.describe(
				'Only messages sent at or after this ISO 8601 time with offset, for example 2026-10-12T06:30:00+02:00'
			),
		until: sentTime.optional().describe('Only messages sent before this ISO 8601 time with offset'),
		sender_id: z
			.string()
			.regex(/^[a-z][0-9a-f]{32}$/)
			.optional()
			.describe(
				'Only messages with this sender_id; the account MID from status finds own Talk messages'
			),
		context: z
			.number()
			.int()
			.min(0)
			.max(3)
			.optional()
			.describe(
				'Messages before and after each hit, 0 to 3, as context_before and context_after; default 0'
			),
		limit,
		cursor
	}),
	run: (args, { db, selfMid }) =>
		searchMessagesPage(db, selfMid, {
			query: args.query,
			...(args.service ? { service: args.service } : {}),
			...(args.chat_id ? { chatId: args.chat_id } : {}),
			...(args.sender_id ? { senderId: args.sender_id } : {}),
			...(args.since ? { since: Date.parse(args.since) } : {}),
			...(args.until ? { until: Date.parse(args.until) } : {}),
			...(args.context ? { context: args.context } : {}),
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
