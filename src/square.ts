import { type BaseClient, InternalError } from '@evex/linejs/base';
import { LINEStruct } from '@evex/linejs/thrift';
import type {
	FetchMyEventsRequest,
	FetchMyEventsResponse,
	FetchSquareChatEventsRequest,
	FetchSquareChatEventsResponse,
	Square,
	SquareChat,
	SquareEvent
} from '@evex/linejs-types';

/**
 * `fetchSquareChatEvents` through the generated Thrift request, because the
 * handwritten wrapper drops `continuationToken`, `subscriptionId`, `inclusive`
 * and `fetchType` (base/service/square/mod.ts:127-144).
 */
export async function fetchSquareChatEvents(
	base: BaseClient,
	request: Partial<FetchSquareChatEventsRequest> & { squareChatMid: string }
): Promise<FetchSquareChatEventsResponse> {
	return await base.request.request(
		LINEStruct.SquareService_fetchSquareChatEvents_args({ request: { limit: 100, ...request } }),
		'fetchSquareChatEvents',
		4,
		true,
		'/SQ1'
	);
}

/**
 * `fetchMyEvents` through the generated Thrift request, so a 64-bit
 * `subscriptionId` passes as a bigint (the wrapper types it as `number`,
 * base/service/square/mod.ts:105-125).
 */
export async function fetchMyEvents(
	base: BaseClient,
	request: Partial<FetchMyEventsRequest>
): Promise<FetchMyEventsResponse> {
	return await base.request.request(
		LINEStruct.SquareService_fetchMyEvents_args({ request: { limit: 100, ...request } }),
		'fetchMyEvents',
		4,
		true,
		'/SQ1'
	);
}

export interface JoinedSquareChat {
	chat: SquareChat;
	/** The account's own member MID in the chat, unknown when `getSquareChat` omits it. */
	selfMemberId: string | undefined;
}

export interface JoinedSquareChats {
	/** Chats LINE confirms as `JOINED` through `getSquareChat`. */
	chats: JoinedSquareChat[];
	/** Joined squares with no confirmed chat: a coverage gap for the caller to record. */
	uncoveredSquares: Square[];
	/** True when a continuation token stopped advancing and paging ended early. */
	stalled: boolean;
}

/**
 * LINE answers `getJoinedSquareChats` with NOT_IMPLEMENTED for this device, so
 * the joined chats come from the account's own Square events: every chat the
 * account joined is a candidate unless a later event removed the account from
 * it, and `getSquareChat` then has the final word on membership.
 */
export async function listJoinedSquareChats(base: BaseClient): Promise<JoinedSquareChats> {
	const squares = await drain((continuationToken) =>
		base.square.getJoinedSquares({ limit: 100, continuationToken })
	);
	const events = await drain((continuationToken) =>
		base.square.fetchMyEvents({ limit: 100, continuationToken })
	);
	const ownMembers = new Set<string>();
	for (const page of squares.pages) {
		for (const member of Object.values(page.members ?? {})) ownMembers.add(member.squareMemberMid);
	}
	const candidates = joinedCandidates(
		events.pages.flatMap((page) => page.events ?? []),
		ownMembers
	);

	const chats: JoinedSquareChat[] = [];
	for (const squareChatMid of candidates) {
		const joined = await confirmedChat(base, squareChatMid);
		if (joined) chats.push(joined);
	}
	const covered = new Set(chats.map(({ chat }) => chat.squareMid));
	const uncoveredSquares = squares.pages
		.flatMap((page) => page.squares ?? [])
		.filter((square) => !covered.has(square.mid));
	return { chats, uncoveredSquares, stalled: squares.stalled || events.stalled };
}

/** Follows continuation tokens to the end; stops on a token that does not advance. */
async function drain<Page extends { continuationToken?: string }>(
	fetchPage: (continuationToken: string | undefined) => Promise<Page>
): Promise<{ pages: Page[]; stalled: boolean }> {
	const pages: Page[] = [];
	const seen = new Set<string>();
	let continuationToken: string | undefined;
	for (;;) {
		const page = await fetchPage(continuationToken);
		pages.push(page);
		if (!page.continuationToken) return { pages, stalled: false };
		if (seen.has(page.continuationToken)) return { pages, stalled: true };
		seen.add(page.continuationToken);
		continuationToken = page.continuationToken;
	}
}

type Membership = 'joined' | 'removed';

/**
 * The latest membership event per chat decides, by `createdTime`. Join events
 * count whoever they name, since `getSquareChat` confirms them later; removals
 * count only when they name the account, so another member leaving never hides
 * a chat.
 */
function joinedCandidates(events: SquareEvent[], ownMembers: Set<string>): string[] {
	// The account's member MID per square also arrives in its own create events,
	// which covers squares it has since left.
	for (const event of events) {
		const member = event.payload?.notifiedCreateSquareChatMember?.chatMember?.squareMemberMid;
		if (member) ownMembers.add(member);
	}
	const latest = new Map<string, { at: bigint; membership: Membership }>();
	for (const event of events) {
		const change = membershipChange(event, ownMembers);
		if (!change) continue;
		const at = BigInt(event.createdTime ?? 0);
		const previous = latest.get(change.squareChatMid);
		// Events at the same time have no defined order, so a join among them
		// keeps the chat a candidate and `getSquareChat` decides.
		if (!previous || at > previous.at || (at === previous.at && change.membership === 'joined')) {
			latest.set(change.squareChatMid, { at, membership: change.membership });
		}
	}
	return [...latest].filter(([, entry]) => entry.membership === 'joined').map(([mid]) => mid);
}

function membershipChange(
	event: SquareEvent,
	ownMembers: Set<string>
): { squareChatMid: string; membership: Membership } | undefined {
	const payload = event.payload;
	let squareChatMid: string | undefined;
	let membership: Membership = 'joined';
	switch (event.type) {
		case 'NOTIFIED_CREATE_SQUARE_CHAT_MEMBER':
			squareChatMid = payload?.notifiedCreateSquareChatMember?.chat?.squareChatMid;
			break;
		case 'NOTIFIED_JOIN_SQUARE_CHAT':
			squareChatMid = payload?.notifiedJoinSquareChat?.squareChatMid;
			break;
		case 'NOTIFIED_LEAVE_SQUARE_CHAT': {
			const leave = payload?.notifiedLeaveSquareChat;
			if (ownMembers.has(leave?.squareMemberMid ?? '')) squareChatMid = leave?.squareChatMid;
			membership = 'removed';
			break;
		}
		case 'NOTIFIED_KICKOUT_FROM_SQUARE': {
			const kickout = payload?.notifiedKickoutFromSquare;
			if (kickout?.kickees?.some((kickee) => ownMembers.has(kickee.squareMemberMid))) {
				squareChatMid = kickout.squareChatMid;
			}
			membership = 'removed';
			break;
		}
		case 'NOTIFIED_DELETE_SQUARE_CHAT':
			squareChatMid = payload?.notifiedDeleteSquareChat?.squareChat?.squareChatMid;
			membership = 'removed';
			break;
		case 'NOTIFICATION_SQUARE_CHAT_DELETE':
			squareChatMid = payload?.notificationSquareChatDelete?.squareChatMid;
			membership = 'removed';
			break;
	}
	return squareChatMid ? { squareChatMid, membership } : undefined;
}

/**
 * The chat and the account's member in it when LINE reports the account as
 * `JOINED`. FORBIDDEN and NOT_FOUND mean the account cannot read the chat
 * (gone, or no longer a member), so the candidate is dropped; any other
 * failure ends discovery.
 */
async function confirmedChat(
	base: BaseClient,
	squareChatMid: string
): Promise<JoinedSquareChat | undefined> {
	try {
		const { squareChat, squareChatMember } = await base.square.getSquareChat({ squareChatMid });
		return squareChatMember?.membershipState === 'JOINED'
			? { chat: squareChat, selfMemberId: squareChatMember.squareMemberMid || undefined }
			: undefined;
	} catch (error) {
		const code = error instanceof InternalError ? error.data?.errorCode : undefined;
		if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return undefined;
		throw error;
	}
}
