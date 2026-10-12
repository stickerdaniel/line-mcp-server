import type { NestedArray } from '@evex/linejs/thrift';
import { LINEStruct } from '@evex/linejs/thrift';
import type { SquareEvent, SquareEventPayload, SquareEventType } from '@evex/linejs-types';
import { afterEach, describe, expect, it } from 'vitest';
import { openSession, type Session } from '../src/session.ts';
import { listJoinedSquareChats } from '../src/square.ts';
import {
	fakeHttpUpstream,
	freePort,
	seedLive,
	selfMid,
	tempRoot,
	thriftError,
	thriftReply
} from './fake-line.ts';

const sessions: Session[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

// Shapes follow a live account: one joined square, and the
// account's events since joining, NOTIFIED_CREATE_SQUARE_MEMBER then
// NOTIFIED_CREATE_SQUARE_CHAT_MEMBER with the chat and the account's chat member.
const mid = (prefix: string, digit: number) => `${prefix}${String(digit).repeat(32)}`;
const square1 = mid('s', 1);
const square2 = mid('s', 2);
const square3 = mid('s', 3);
const me1 = mid('p', 1);
const me2 = mid('p', 2);
const me3 = mid('p', 3);
const someoneElse = mid('p', 9);
const [chatA, chatB, chatC, chatD, chatE] = [1, 2, 3, 4, 5].map((digit) => mid('m', digit)) as [
	string,
	string,
	string,
	string,
	string
];

interface Fixture {
	squares: string[];
	pages: SquareEvent[][];
	/** The final continuation token repeats the previous one when set. */
	stallAfter?: number;
	membership: Record<string, 'JOINED' | 'LEFT' | 'FORBIDDEN'>;
}

const chatSquare = new Map([
	[chatA, square1],
	[chatB, square1],
	[chatC, square2],
	[chatD, square2],
	[chatE, square3]
]);
const ownMember = new Map([
	[square1, me1],
	[square2, me2],
	[square3, me3]
]);

function event(type: SquareEventType, createdTime: number, payload: Partial<SquareEventPayload>) {
	return { type, createdTime, payload, syncToken: `sync-${createdTime}` } as SquareEvent;
}

function joined(chat: string, createdTime: number) {
	const squareMid = chatSquare.get(chat)!;
	return event('NOTIFIED_CREATE_SQUARE_CHAT_MEMBER', createdTime, {
		notifiedCreateSquareChatMember: {
			chat: { squareChatMid: chat, squareMid, type: 'SQUARE_DEFAULT', name: 'chat' },
			chatMember: {
				squareMemberMid: ownMember.get(squareMid)!,
				squareChatMid: chat,
				membershipState: 'JOINED'
			}
		}
	} as Partial<SquareEventPayload>);
}

function createdSquareMember(squareMid: string, createdTime: number) {
	return event('NOTIFIED_CREATE_SQUARE_MEMBER', createdTime, {
		notifiedCreateSquareMember: {
			square: { mid: squareMid, name: 'square' },
			squareMember: { squareMemberMid: ownMember.get(squareMid)!, squareMid }
		}
	} as Partial<SquareEventPayload>);
}

function joinedByEvent(chat: string, createdTime: number) {
	const squareMid = chatSquare.get(chat)!;
	return event('NOTIFIED_JOIN_SQUARE_CHAT', createdTime, {
		notifiedJoinSquareChat: {
			squareChatMid: chat,
			joinedMember: { squareMemberMid: ownMember.get(squareMid)!, squareMid }
		}
	} as Partial<SquareEventPayload>);
}

function leftChat(chat: string, member: string, createdTime: number) {
	return event('NOTIFIED_LEAVE_SQUARE_CHAT', createdTime, {
		notifiedLeaveSquareChat: { squareChatMid: chat, squareMemberMid: member, sayGoodbye: false }
	} as Partial<SquareEventPayload>);
}

async function discover(fixture: Fixture) {
	let myEventPages = 0;
	const root = tempRoot();
	seedLive(root, selfMid, { authToken: 'access', refreshToken: 'refresh' });
	const upstream = fakeHttpUpstream({
		getProfile: () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]),
		getJoinedSquares: () =>
			thriftReply('getJoinedSquares', [
				[
					12,
					0,
					[
						[
							15,
							1,
							[
								12,
								fixture.squares.map((squareMid) =>
									LINEStruct.Square({ mid: squareMid, name: 'square' })
								)
							]
						],
						[
							13,
							2,
							[
								11,
								12,
								Object.fromEntries(
									fixture.squares.map((squareMid) => [
										squareMid,
										LINEStruct.SquareMember({
											squareMemberMid: ownMember.get(squareMid)!,
											squareMid
										})
									])
								)
							]
						]
					] as NestedArray
				]
			]),
		fetchMyEvents: () => {
			const index = myEventPages++;
			const last = index === fixture.pages.length - 1;
			const token = last
				? fixture.stallAfter === undefined
					? undefined
					: `continue-${fixture.stallAfter}`
				: `continue-${index}`;
			return thriftReply('fetchMyEvents', [
				[
					12,
					0,
					LINEStruct.FetchMyEventsResponse({
						events: fixture.pages[index] ?? [],
						syncToken: 'sync',
						continuationToken: token
					})
				]
			]);
		},
		getSquareChat: async (request) => {
			const body = Buffer.from(await request.arrayBuffer()).toString('latin1');
			const chat = [...chatSquare.keys()].find((candidate) => body.includes(candidate))!;
			const state = fixture.membership[chat] ?? 'LEFT';
			if (state === 'FORBIDDEN') return thriftError('getSquareChat', 403);
			return thriftReply('getSquareChat', [
				[
					12,
					0,
					[
						[
							12,
							1,
							LINEStruct.SquareChat({
								squareChatMid: chat,
								squareMid: chatSquare.get(chat)!,
								type: 'SQUARE_DEFAULT',
								name: 'chat'
							})
						],
						[
							12,
							2,
							LINEStruct.SquareChatMember({
								squareMemberMid: ownMember.get(chatSquare.get(chat)!)!,
								squareChatMid: chat,
								membershipState: state
							})
						]
					]
				]
			]);
		}
	});
	const session = await openSession({
		root,
		lockPort: await freePort(),
		log: () => {},
		createClient: upstream.createClient
	});
	sessions.push(session);
	const result = await listJoinedSquareChats(session.base);
	return {
		chats: result.chats.map((chat) => chat.squareChatMid),
		uncoveredSquares: result.uncoveredSquares.map((square) => square.mid),
		stalled: result.stalled,
		calls: upstream.calls
	};
}

describe('Square chat discovery', () => {
	it("finds the joined chat from the account's own events", async () => {
		const result = await discover({
			squares: [square1],
			pages: [[createdSquareMember(square1, 1), joined(chatA, 2)]],
			membership: { [chatA]: 'JOINED' }
		});

		expect(result).toEqual({
			chats: [chatA],
			uncoveredSquares: [],
			stalled: false,
			calls: ['getProfile', 'getJoinedSquares', 'fetchMyEvents', 'getSquareChat']
		});
	});

	it('drops chats the account later left, was kicked from or saw deleted', async () => {
		const result = await discover({
			squares: [square1, square2, square3],
			pages: [
				[
					// Newest first: the leave sorts after the join by time, not position.
					leftChat(chatA, me1, 5),
					joined(chatA, 1),
					joined(chatB, 1),
					joined(chatC, 1),
					joined(chatD, 1),
					leftChat(chatB, someoneElse, 6),
					event('NOTIFIED_KICKOUT_FROM_SQUARE', 7, {
						notifiedKickoutFromSquare: {
							squareChatMid: chatC,
							kickees: [{ squareMemberMid: me2, squareMid: square2 }]
						}
					} as Partial<SquareEventPayload>),
					event('NOTIFIED_DELETE_SQUARE_CHAT', 8, {
						notifiedDeleteSquareChat: { squareChat: { squareChatMid: chatD, squareMid: square2 } }
					} as Partial<SquareEventPayload>),
					// The account's member MID in this square is known only from getJoinedSquares.
					joinedByEvent(chatE, 1),
					leftChat(chatE, me3, 9)
				]
			],
			membership: {
				[chatA]: 'JOINED',
				[chatB]: 'JOINED',
				[chatC]: 'JOINED',
				[chatD]: 'JOINED',
				[chatE]: 'JOINED'
			}
		});

		expect(result.chats).toEqual([chatB]);
		expect(result.uncoveredSquares).toEqual([square2, square3]);
		expect(result.calls.filter((method) => method === 'getSquareChat')).toHaveLength(1);
	});

	it('lets LINE decide when a join and a leave share a timestamp', async () => {
		const result = await discover({
			squares: [square1],
			pages: [[joined(chatA, 3), leftChat(chatA, me1, 3)]],
			membership: { [chatA]: 'JOINED' }
		});

		expect(result.chats).toEqual([chatA]);
		expect(result.uncoveredSquares).toEqual([]);
	});

	it('keeps only chats LINE confirms as JOINED', async () => {
		const result = await discover({
			squares: [square1, square2, square3],
			pages: [[joined(chatA, 1), joined(chatB, 1), joined(chatC, 1), joinedByEvent(chatE, 1)]],
			membership: { [chatA]: 'JOINED', [chatB]: 'LEFT', [chatC]: 'FORBIDDEN', [chatE]: 'JOINED' }
		});

		expect(result.chats).toEqual([chatA, chatE]);
		expect(result.uncoveredSquares).toEqual([square2]);
	});

	it('reports a joined square without a discovered chat as uncovered', async () => {
		const result = await discover({
			squares: [square1, square3],
			pages: [[joined(chatA, 1)]],
			membership: { [chatA]: 'JOINED' }
		});

		expect(result.chats).toEqual([chatA]);
		expect(result.uncoveredSquares).toEqual([square3]);
	});

	it('drains every page of events and stops on a token that does not advance', async () => {
		const result = await discover({
			squares: [square1, square2],
			pages: [[joined(chatA, 1)], [joined(chatB, 2)], [joined(chatC, 3)]],
			stallAfter: 1,
			membership: { [chatA]: 'JOINED', [chatB]: 'JOINED', [chatC]: 'JOINED' }
		});

		expect(result.chats).toEqual([chatA, chatB, chatC]);
		expect(result.stalled).toBe(true);
		expect(result.calls.filter((method) => method === 'fetchMyEvents')).toHaveLength(3);
	});
});
