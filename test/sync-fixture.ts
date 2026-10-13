// Shared setup for sync tests: a real session (guards, token handler, archive
// migrations) on a temporary state root, answered by a fake upstream.
import type { Message, SquareEvent } from '@evex/linejs-types';
import type { NestedArray } from '@evex/linejs/thrift';
import { afterEach } from 'vitest';
import type { SyncContext } from '../src/sync/loop.ts';
import { openSession, type Session } from '../src/session.ts';
import {
	type FakeUpstream,
	fakeUpstream,
	freePort,
	type Handler,
	otherMid,
	seedLive,
	selfMid,
	tempRoot
} from './fake-line.ts';

const open: Session[] = [];
afterEach(async () => {
	for (const session of open.splice(0)) await session.close();
});

export interface SyncFixture {
	root: string;
	upstream: FakeUpstream;
	session: Session;
	context: SyncContext;
}

export async function syncFixture(
	handlers: Record<string, Handler>,
	root = tempRoot()
): Promise<SyncFixture> {
	seedLive(root, selfMid, { authToken: 'token' });
	const upstream = fakeUpstream({ getProfile: () => ({ mid: selfMid }), ...handlers });
	const session = await openSession({
		root,
		lockPort: await freePort(),
		createClient: upstream.createClient,
		log: () => {}
	});
	open.push(session);
	return {
		root,
		upstream,
		session,
		context: { db: session.db, base: session.base, selfMid, log: () => {}, now: Date.now }
	};
}

/** Reads a field of a Thrift request struct by its field ids, e.g. `field(args, 1, 2)`. */
export function field(value: NestedArray, ...ids: number[]): unknown {
	let current: unknown = value;
	for (const id of ids) {
		const entry = (current as unknown[]).find((item) => Array.isArray(item) && item[1] === id) as
			unknown[] | undefined;
		current = entry?.[2];
	}
	return current;
}

let nextTime = 1_700_000_000_000;

/** A plain (non-E2EE) incoming one-to-one message. */
export function textMessage(id: string, text: string, extra: Partial<Message> = {}): Message {
	nextTime += 1000;
	return {
		from: otherMid,
		to: selfMid,
		toType: 'USER',
		id,
		createdTime: nextTime,
		contentType: 'NONE',
		contentMetadata: {},
		text,
		...extra
	} as Message;
}

export function receive(revision: number | bigint, message: Message) {
	return { revision, type: 'RECEIVE_MESSAGE', message, createdTime: message.createdTime };
}

export const squareChat = `m${'d'.repeat(32)}`;
export const squareMember = `p${'e'.repeat(32)}`;

/** A Square message event as `fetchSquareChatEvents` returns it. */
export function squareEvent(
	id: string,
	text: string,
	extra: { threadMid?: string; threadRoot?: string; state?: string; chat?: string } = {}
): SquareEvent {
	const chat = extra.chat ?? squareChat;
	return {
		type: 'RECEIVE_MESSAGE',
		createdTime: 1_700_000_000_000,
		payload: {
			receiveMessage: {
				squareChatMid: chat,
				senderDisplayName: 'Member',
				...(extra.threadMid ? { threadMid: extra.threadMid } : {}),
				squareMessage: {
					message: {
						from: squareMember,
						to: chat,
						toType: 'SQUARE_CHAT',
						id,
						createdTime: 1_700_000_000_000,
						contentType: 'NONE',
						contentMetadata: {},
						text
					},
					state: extra.state ?? 'SENT',
					...(extra.threadRoot
						? { threadInfo: { chatThreadMid: extra.threadRoot, threadRoot: true } }
						: {})
				}
			}
		}
	} as unknown as SquareEvent;
}

const discoveredSquare = `s${'f'.repeat(32)}`;
/** The account's own member in `discoveredSquare`. */
const discoveredSelf = `p${'1'.repeat(32)}`;

/**
 * Square discovery as the live service answers it: the joined squares, the
 * account's join events from `fetchMyEvents`, and `getSquareChat` confirming
 * each chat as JOINED. Pass `events` to the test's `fetchMyEvents` handler.
 * `otherSquares` lists further joined squares, each without a known chat.
 */
export function squareDiscovery(
	chats: string[],
	otherSquares: () => string[] = () => []
): {
	handlers: Record<string, Handler>;
	events: SquareEvent[];
} {
	return {
		handlers: {
			getJoinedSquares: () => ({
				squares: [discoveredSquare, ...otherSquares()].map((mid) => ({ mid, name: 'Square' })),
				members: { [discoveredSquare]: { squareMemberMid: discoveredSelf } }
			}),
			getSquareChat: (value) => ({
				squareChat: {
					squareChatMid: field(value, 1, 1),
					squareMid: discoveredSquare,
					name: 'Square'
				},
				squareChatMember: { membershipState: 'JOINED', squareMemberMid: discoveredSelf }
			})
		},
		events: chats.map(
			(chat, index) =>
				({
					type: 'NOTIFIED_JOIN_SQUARE_CHAT',
					createdTime: 1_700_000_000_000 + index,
					payload: {
						notifiedJoinSquareChat: {
							squareChatMid: chat,
							joinedMember: { squareMemberMid: discoveredSelf, squareMid: discoveredSquare }
						}
					}
				}) as unknown as SquareEvent
		)
	};
}
