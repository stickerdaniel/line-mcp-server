import { findMessage, type Service } from '../../archive.ts';
import { LineMcpError } from '../../errors.ts';
import type { ExecuteOptions } from '../../outbox.ts';
import { decimal } from '../../probe.ts';
import type { ServedContext } from '../tool.ts';

// Shared by the mutating tools: where a chat and a message are, settled
// before the outbox claims the idempotency key or anything reaches LINE.

export type ChatKind = 'user' | 'group' | 'room' | 'square';

/** The kind of a chat from its MID prefix; anything else is refused before LINE sees it. */
export function chatKind(service: Service, chatId: string): ChatKind {
	if (service === 'square') {
		if (chatId.startsWith('m')) return 'square';
		throw new LineMcpError('invalid_argument', 'Not an OpenChat chat ID');
	}
	if (chatId.startsWith('u')) return 'user';
	if (chatId.startsWith('c')) return 'group';
	if (chatId.startsWith('r')) return 'room';
	throw new LineMcpError('invalid_argument', 'Not a Talk chat ID');
}

export interface TargetMessage {
	/** The OpenChat thread the message is in; null in the chat itself and in Talk. */
	threadId: string | null;
	/** Talk only: whether the archive has it as the account's own message, null when unknown. */
	own: boolean | null;
}

/**
 * The message an action refers to. An OpenChat thread message must be
 * answered, reacted to and unsent in its thread, so in Square the thread has
 * to be known: from the outbox, which is authoritative for a message this
 * account sent, or from an archived message. Talk has no threads and LINE
 * checks the message itself; a Talk message the archive files under another
 * chat is refused.
 */
export function targetMessage(
	context: ServedContext,
	service: Service,
	chatId: string,
	messageId: string
): TargetMessage {
	const sent = context.outbox.sentMessage(service, chatId, messageId);
	if (sent) return { threadId: sent.threadId, own: service === 'talk' ? true : null };
	const archived = findMessage(context.db, { service, chatId, messageId });
	// A Square row without a sender is the tombstone of a message sync never
	// saw: its thread is unknown, not the parent chat.
	if (archived && (service === 'talk' || archived.sender !== null)) {
		return {
			threadId: archived.threadId,
			own:
				service === 'talk' && archived.sender !== null ? archived.sender === context.selfMid : null
		};
	}
	if (service === 'square') {
		throw new LineMcpError(
			'not_found',
			'The thread of this OpenChat message is unknown: the archive does not have the message yet, or only as unsent; try again after the next sync'
		);
	}
	const elsewhere = context.db
		.prepare(`SELECT 1 FROM message WHERE service = 'talk' AND message_id = ? AND chat_id != ?`)
		.get(messageId, chatId);
	if (elsewhere) throw new LineMcpError('not_found', 'No such message in this chat');
	return { threadId: null, own: null };
}

/** The outbox options of one call: its abort signal, and the shared upstream pool. */
export function pooled(context: ServedContext, signal: AbortSignal): ExecuteOptions {
	return { signal, run: (task) => context.pool.run(task, signal) };
}

/** A message ID from a LINE answer, as a decimal string; null when the answer has none. */
export function answeredId(value: unknown): string | null {
	if (typeof value === 'string') return value === '' ? null : value;
	if (typeof value !== 'number' && typeof value !== 'bigint') return null;
	try {
		return decimal(value);
	} catch {
		return null;
	}
}
