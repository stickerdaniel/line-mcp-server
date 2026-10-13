import type { NestedArray } from '@evex/linejs/thrift';
import { describe, expect, it } from 'vitest';
import { transaction } from '../src/db.ts';
import { type Service, upsertChat } from '../src/archive.ts';
import { discoverChats, nameSquareSenders, squareMemberBatch } from '../src/sync/backfill.ts';
import { Pool, type SyncContext } from '../src/sync/loop.ts';
import { applyChanges, type Change, type MessageRow } from '../src/sync/normalize.ts';
import { groupMid, type Handler, otherMid, selfMid, talkError } from './fake-line.ts';
import { callTool, type Served, serve } from './mcp-client.ts';
import { field, squareChat } from './sync-fixture.ts';

const roomMid = `r${'9'.repeat(32)}`;
const mid = (prefix: string, index: number) => `${prefix}${String(index).padStart(32, '0')}`;
/** In the group, but no one-to-one chat with the account. */
const groupOnly = mid('u', 1);
/** Left the group; only archived messages remain. */
const departed = mid('u', 2);
/** Wrote in a room, which `getChats` lists no members for. */
const roomSender = mid('u', 3);
const squareSender = mid('p', 1);

/** The MIDs a request named, read from its Thrift arguments at `ids`. */
const requested = (value: NestedArray, ...ids: number[]) =>
	(field(value, ...ids) as [number, string[]])[1];

/** Talk discovery as LINE answers it: one DM, one group of `members`, one room. */
function talkHandlers(
	members: string[],
	contacts: (mids: string[]) => Record<string, string> | Error
): Record<string, Handler> {
	return {
		getMessageBoxes: () => ({
			messageBoxes: [
				{ id: otherMid, midType: 'USER' },
				{ id: groupMid, midType: 'GROUP' }
			],
			hasNext: false
		}),
		getAllChatMids: () => ({ memberChatMids: [groupMid, roomMid] }),
		getChats: () => ({
			chats: [
				{
					chatMid: groupMid,
					chatName: 'Group',
					extra: {
						groupExtra: {
							memberMids: Object.fromEntries([selfMid, ...members].map((entry) => [entry, 0]))
						}
					}
				}
			]
		}),
		getContactsV2: (value) => {
			const answer = contacts(requested(value, 1, 1));
			if (answer instanceof Error) throw answer;
			return {
				contacts: Object.fromEntries(
					Object.entries(answer).map(([id, displayName]) => [id, { contact: { displayName } }])
				)
			};
		}
	};
}

/** Answers every contact asked for with a name derived from its MID. */
const everyone = (mids: string[]) =>
	Object.fromEntries(mids.map((entry) => [entry, `Name ${entry.slice(-3)}`]));

function context({ session }: Served): SyncContext {
	return { db: session.db, base: session.base, selfMid, log: () => {}, now: Date.now };
}

let nextId = 1000;

/** Archives one message, as live sync or backfill would; returns its ID and text. */
function archive(served: Served, service: Service, chatId: string, sender: string) {
	const messageId = String(nextId++);
	const text = `message ${messageId}`;
	const row: MessageRow = {
		service,
		chatId,
		chatType: service === 'square' ? 'square' : chatId.startsWith('r') ? 'room' : 'group',
		messageId,
		threadId: null,
		sender,
		sentAt: Date.UTC(2026, 9, 12) + nextId,
		editedAt: null,
		contentType: 'NONE',
		text,
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id: messageId, text }),
		decryptState: 'ok',
		missingKey: null
	};
	apply(served, { kind: 'message', row });
	return { service, chatId, messageId, text };
}

function apply(served: Served, ...changes: Change[]) {
	const { db } = served.session;
	transaction(db, () => applyChanges(db, changes));
}

/** The sender name read_messages, search_messages and list_changes show for one message. */
async function shownNames(served: Served, message: ReturnType<typeof archive>) {
	const { port } = served.server;
	const pick = (data: Record<string, unknown>, key: string) =>
		(data[key] as { message_id: string; sender_name: string | null }[]).find(
			(item) => item.message_id === message.messageId
		)?.sender_name;
	const read = await callTool(port, 'read_messages', {
		service: message.service,
		chat_id: message.chatId
	});
	const search = await callTool(port, 'search_messages', { query: message.text });
	const changes = await callTool(port, 'list_changes', { limit: 200 });
	return [
		pick(read.data, 'messages'),
		pick(search.data, 'messages'),
		pick(changes.data, 'changes')
	];
}

describe('sender names', () => {
	it('renames the own chat when the account renames itself', async () => {
		const served = await serve({
			...talkHandlers([], everyone),
			getMessageBoxes: () => ({ messageBoxes: [{ id: selfMid, midType: 'USER' }], hasNext: false })
		});
		upsertChat(served.session.db, { service: 'talk', chatId: selfMid, type: 'user', name: 'Old' });

		await discoverChats(context(served), new Pool(2));

		const listed = await callTool(served.server.port, 'list_chats');
		expect(listed.data.chats).toContainEqual(
			expect.objectContaining({ chat_id: selfMid, name: 'Name aaa' })
		);
	});

	it('names a group member with no one-to-one chat as soon as they write', async () => {
		const served = await serve(talkHandlers([otherMid, groupOnly], everyone));

		await discoverChats(context(served), new Pool(2));
		const message = archive(served, 'talk', groupMid, groupOnly);

		expect(await shownNames(served, message)).toEqual(Array(3).fill('Name 001'));
	});

	it('names archived senders no member list holds: departed members and room senders', async () => {
		const served = await serve(talkHandlers([otherMid], everyone));
		const left = archive(served, 'talk', groupMid, departed);
		const room = archive(served, 'talk', roomMid, roomSender);

		await discoverChats(context(served), new Pool(2));

		expect(await shownNames(served, left)).toEqual(Array(3).fill('Name 002'));
		expect(await shownNames(served, room)).toEqual(Array(3).fill('Name 003'));
	});

	it('keeps stored names when a lookup is partial, empty or refused', async () => {
		let answer: (mids: string[]) => Record<string, string> | Error = everyone;
		const served = await serve(talkHandlers([otherMid, groupOnly], (mids) => answer(mids)));
		const fromPeer = archive(served, 'talk', groupMid, otherMid);
		const fromMember = archive(served, 'talk', groupMid, groupOnly);
		await discoverChats(context(served), new Pool(2));

		answer = () => ({ [otherMid]: 'Renamed' });
		await discoverChats(context(served), new Pool(2));
		expect(await shownNames(served, fromPeer)).toEqual(Array(3).fill('Renamed'));
		expect(await shownNames(served, fromMember)).toEqual(Array(3).fill('Name 001'));

		for (const next of [() => ({}), () => talkError('NOT_FOUND')]) {
			answer = next;
			await discoverChats(context(served), new Pool(2));
			expect(await shownNames(served, fromMember)).toEqual(Array(3).fill('Name 001'));
		}
	});

	it('names an OpenChat sender that no event named', async () => {
		const served = await serve({
			getSquareMembers: (value) => ({
				members: Object.fromEntries(
					requested(value, 1, 2).map((entry) => [entry, { displayName: 'Square Name' }])
				)
			})
		});
		const message = archive(served, 'square', squareChat, squareSender);

		await nameSquareSenders(context(served), new Pool(2));

		expect(await shownNames(served, message)).toEqual(Array(3).fill('Square Name'));
	});

	it('keeps an event name that arrives while the OpenChat lookup is in flight', async () => {
		const served: Served = await serve({
			getSquareMembers: () => {
				// The Square loop commits an event carrying the sender's name meanwhile.
				apply(served, {
					kind: 'participant',
					service: 'square',
					id: squareSender,
					displayName: 'Event Name'
				});
				return { members: { [squareSender]: { displayName: 'Lookup Name' } } };
			}
		});
		const message = archive(served, 'square', squareChat, squareSender);

		await nameSquareSenders(context(served), new Pool(2));

		expect(await shownNames(served, message)).toEqual(Array(3).fill('Event Name'));
	});

	it('names more senders than one request holds, in requests of bounded size', async () => {
		const asked = { talk: [0], square: [0] };
		const members = Array.from({ length: 150 }, (_, index) => mid('u', 100 + index));
		const square = Array.from({ length: 60 }, (_, index) => mid('p', 100 + index));
		const served = await serve({
			...talkHandlers(members, (mids) => {
				asked.talk.push(mids.length);
				return everyone(mids);
			}),
			getSquareMembers: (value) => {
				const mids = requested(value, 1, 2);
				asked.square.push(mids.length);
				return {
					members: Object.fromEntries(mids.map((entry) => [entry, { displayName: 'Square' }]))
				};
			}
		});
		for (const sender of square) archive(served, 'square', squareChat, sender);

		await discoverChats(context(served), new Pool(2));
		await nameSquareSenders(context(served), new Pool(2));
		const talkLast = archive(served, 'talk', groupMid, members.at(-1)!);

		expect(await shownNames(served, talkLast)).toEqual(Array(3).fill('Name 249'));
		const page = await callTool(served.server.port, 'read_messages', {
			service: 'square',
			chat_id: squareChat,
			limit: 200
		});
		const names = (page.data.messages as { sender_name: string | null }[]).map(
			(item) => item.sender_name
		);
		expect(names).toEqual(Array(60).fill('Square'));
		expect(Math.max(...asked.talk)).toBeLessThanOrEqual(100);
		expect(Math.max(...asked.square)).toBeLessThanOrEqual(squareMemberBatch);
	});
});
