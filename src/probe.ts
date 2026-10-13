import type { BaseClient } from '@evex/linejs/base';
import type { Message, SquareEvent } from '@evex/linejs-types';
import { mapError } from './errors.ts';
import { decryptMessage } from './keys.ts';
import type { Session } from './session.ts';
import { fetchSquareChatEvents, listJoinedSquareChats } from './square.ts';
import type { SqliteStorage } from './storage.ts';

export interface ProbeOptions {
	dm?: string;
	group?: string;
	square?: string;
}

/**
 * Read-only checks against the live account. Message text never appears in the
 * report; decrypted messages show only their state and text length.
 */
export async function probe(
	session: Session,
	options: ProbeOptions = {}
): Promise<Record<string, unknown>> {
	const { base, account } = session;
	const report: Record<string, unknown> = {};
	const step = async (name: string, body: () => Promise<unknown>) => {
		try {
			report[name] = await body();
		} catch (error) {
			report[name] = { error: mapError(error, name) };
		}
	};

	await step('profile', async () => {
		const profile = await base.talk.getProfile();
		return { mid: profile.mid, matchesBoundAccount: profile.mid === account.mid };
	});

	let dm = options.dm;
	let group = options.group;
	await step('chats', async () => {
		const chats = await base.talk.getAllChatMids({
			request: { withMemberChats: true, withInvitedChats: true },
			syncReason: 'INTERNAL'
		});
		const contacts = await base.talk.getAllContactIds({ syncReason: 'INTERNAL' });
		const boxes = await base.talk.getMessageBoxes({
			messageBoxListRequest: { messageBoxCountLimit: 100, lastMessagesPerMessageBoxCount: 0 },
			syncReason: 'INTERNAL'
		});
		const ids = (boxes.messageBoxes ?? []).map((box) => box.id);
		dm ??= ids.find((id) => base.getToType(id) === 0);
		group ??= ids.find((id) => base.getToType(id) === 1 || base.getToType(id) === 2);
		return {
			groups: chats.memberChatMids?.length ?? 0,
			invitedGroups: chats.invitedChatMids?.length ?? 0,
			contacts: contacts?.length ?? 0,
			recentMessageBoxes: ids.length
		};
	});

	for (const [name, chat] of [
		['dm', dm],
		['group', group]
	] as const) {
		await step(name, async () => {
			if (!chat) return { skipped: 'no chat found' };
			const messages = await base.talk.getRecentMessagesV2({
				messageBoxId: chat,
				messagesCount: 5
			});
			return { chat, messages: await classify(base, account.mid, messages ?? []) };
		});
	}

	await step('talkSync', () => talkSync(base));
	await step('square', () => square(base, options.square));
	return report;
}

async function classify(base: BaseClient, selfMid: string, messages: Message[]) {
	const rows = [];
	for (const message of messages) {
		const result = await decryptMessage(base, selfMid, message);
		const text =
			result.state === 'ok' ? (result.payload ? result.payload.text : message.text) : undefined;
		rows.push({
			id: message.id,
			fromSelf: message.from === selfMid,
			contentType: message.contentType,
			e2ee: Boolean(message.chunks?.length),
			state: result.state,
			...(result.state === 'missing_key' ? { missing: result.missing } : {}),
			...(typeof text === 'string' ? { textLength: text.length } : {})
		});
	}
	return rows;
}

const cursorKey = 'probe:talkSyncCursor';

interface Cursor {
	revision: string;
	globalRev: string;
	individualRev: string;
}

/**
 * Two consecutive `talk.sync` calls from the stored cursor, each reporting how
 * long it blocked and what it returned. The cursor stays in decimal strings.
 */
export async function talkSync(base: BaseClient, calls = 2) {
	const storage = base.storage as SqliteStorage;
	const stored = storage.getSync(cursorKey);
	let cursor: Cursor =
		typeof stored === 'string'
			? (JSON.parse(stored) as Cursor)
			: { revision: '0', globalRev: '0', individualRev: '0' };
	const results = [];
	for (let call = 1; call <= calls; call++) {
		const started = Date.now();
		const response = await base.talk.sync({
			limit: 100,
			revision: BigInt(cursor.revision),
			globalRev: BigInt(cursor.globalRev),
			individualRev: BigInt(cursor.individualRev)
		});
		const durationMs = Date.now() - started;
		const operations = response.operationResponse?.operations ?? [];
		const next = { ...cursor };
		const last = operations.at(-1);
		if (last) next.revision = decimal(last.revision);
		const globalRev = response.operationResponse?.globalEvents?.lastRevision;
		if (globalRev !== undefined) next.globalRev = decimal(globalRev);
		const individualRev = response.operationResponse?.individualEvents?.lastRevision;
		if (individualRev !== undefined) next.individualRev = decimal(individualRev);
		const fullSync = response.fullSyncResponse?.nextRevision;
		if (fullSync !== undefined) next.revision = decimal(fullSync);
		results.push({
			call,
			from: cursor.revision,
			durationMs,
			blocked: durationMs >= 1000,
			operations: operations.length,
			fullSync: response.fullSyncResponse !== undefined,
			partialFullSync: response.partialFullSyncResponse !== undefined,
			to: next.revision
		});
		storage.setSync(cursorKey, JSON.stringify(next));
		cursor = next;
	}
	return { initialCursor: typeof stored !== 'string', calls: results };
}

/** Integer LINE IDs and revisions as decimal strings, never through `Number`. */
export function decimal(value: number | bigint | string): string {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
	throw new TypeError('Not an exact integer');
}

async function square(base: BaseClient, chosen: string | undefined) {
	const joined = await listJoinedSquareChats(base);
	const chat = chosen ?? joined.chats[0]?.chat.squareChatMid;
	const summary: Record<string, unknown> = {
		joinedChats: joined.chats.length,
		uncoveredSquares: joined.uncoveredSquares.map(({ mid }) => mid),
		pagingStalled: joined.stalled
	};
	if (!chat) return { ...summary, skipped: 'no joined Square chat' };
	const first = await fetchSquareChatEvents(base, { squareChatMid: chat, limit: 20 });
	const events = [...(first.events ?? [])];
	summary.chat = chat;
	summary.firstPage = page(first.events, first.syncToken, first.continuationToken);
	if (first.continuationToken) {
		const second = await fetchSquareChatEvents(base, {
			squareChatMid: chat,
			limit: 20,
			continuationToken: first.continuationToken
		});
		events.push(...(second.events ?? []));
		summary.secondPage = page(second.events, second.syncToken, second.continuationToken);
	}
	const threadMid = events.map(threadOf).find(Boolean);
	if (threadMid) {
		const thread = await fetchSquareChatEvents(base, {
			squareChatMid: chat,
			threadMid,
			limit: 20
		});
		summary.thread = {
			threadMid,
			...page(thread.events, thread.syncToken, thread.continuationToken)
		};
	} else {
		summary.thread = { skipped: 'no thread in fetched events' };
	}
	return summary;
}

function page(events: SquareEvent[] | undefined, syncToken?: string, continuationToken?: string) {
	const types: Record<string, number> = {};
	for (const event of events ?? [])
		types[String(event.type)] = (types[String(event.type)] ?? 0) + 1;
	return {
		events: events?.length ?? 0,
		types,
		syncToken: Boolean(syncToken),
		continuationToken: Boolean(continuationToken)
	};
}

function threadOf(event: SquareEvent): string | undefined {
	const payload = event.payload;
	return (
		payload?.receiveMessage?.threadMid ||
		payload?.sendMessage?.threadMid ||
		payload?.receiveMessage?.squareMessage?.threadInfo?.chatThreadMid ||
		payload?.notificationThreadMessage?.threadMid ||
		undefined
	);
}
