import type { DatabaseSync } from 'node:sqlite';

// The archive's message rows as storage tests assert them: plain SQL over the
// database a test wrote, with no tool in between.

/** One stored message row; `unsent` as a boolean. */
export interface StoredMessage {
	messageId: string;
	threadId: string | null;
	sender: string | null;
	text: string | null;
	mentions: string | null;
	decryptState: string;
	unsent: boolean;
	seq: number;
}

const columns = `message_id, thread_id, sender, text, mentions, decrypt_state, unsent, seq`;

function stored(row: Record<string, unknown>): StoredMessage {
	return {
		messageId: String(row.message_id),
		threadId: row.thread_id === null ? null : String(row.thread_id),
		sender: row.sender === null ? null : String(row.sender),
		text: row.text === null ? null : String(row.text),
		mentions: row.mentions === null ? null : String(row.mentions),
		decryptState: String(row.decrypt_state),
		unsent: row.unsent === 1,
		seq: Number(row.seq)
	};
}

/**
 * The messages of one chat, threads included, newest first: by send time (a
 * row without one counts as 0), then by the order they were archived.
 */
export function chatMessages(db: DatabaseSync, service: string, chatId: string): StoredMessage[] {
	return db
		.prepare(
			`SELECT ${columns} FROM message WHERE service = ? AND chat_id = ?
			ORDER BY coalesce(sent_at, 0) DESC, id DESC`
		)
		.all(service, chatId)
		.map(stored);
}

/** Every message whose last insert or change took a `seq` above `afterSeq`, in `seq` order. */
export function changedSince(db: DatabaseSync, afterSeq = 0): StoredMessage[] {
	return db
		.prepare(`SELECT ${columns} FROM message WHERE seq > ? ORDER BY seq`)
		.all(afterSeq)
		.map(stored);
}

/** The message IDs whose text the FTS index finds `term` in, as one quoted phrase. */
export function indexed(db: DatabaseSync, term: string): string[] {
	return db
		.prepare(
			`SELECT m.message_id FROM message_fts f JOIN message m ON m.id = f.rowid
			WHERE message_fts MATCH ? ORDER BY m.id`
		)
		.all(`"${term}"`)
		.map((row) => String(row.message_id));
}
