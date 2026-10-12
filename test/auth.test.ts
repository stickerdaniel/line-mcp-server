import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readAccount } from '../src/db.ts';
import { databasePath } from '../src/paths.ts';
import { openSession, type Session, type SessionOptions } from '../src/session.ts';
import {
	fakeHttpUpstream,
	fakeUpstream,
	freePort,
	otherMid,
	seedLive,
	selfMid,
	talkError,
	tempRoot,
	thriftError,
	thriftReply
} from './fake-line.ts';

const sessions: Session[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

async function start(root: string, options: SessionOptions): Promise<Session> {
	const session = await openSession({
		root,
		lockPort: await freePort(),
		log: () => {},
		...options
	});
	sessions.push(session);
	return session;
}

function seeded(): string {
	const root = tempRoot();
	seedLive(root, selfMid, { authToken: 'access-old', refreshToken: 'refresh-old' });
	return root;
}

function stored(root: string, key: string): unknown {
	const db = new DatabaseSync(databasePath(root), { readOnly: true });
	try {
		return (db.prepare('SELECT value FROM line_kv WHERE key = ?').get(key) as { value: string })
			.value;
	} finally {
		db.close();
	}
}

const MUST_REFRESH_V3_TOKEN = 119;
const NOT_AUTHORIZED_DEVICE = 8;
const profileReply = () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]);
const timeReply = () => thriftReply('getServerTime', [[10, 0, 42n]]);
const usesOldToken = (request: Request) => request.headers.get('x-line-access') === 'access-old';
// RefreshAccessTokenResponse: accessToken, durationUntilRefreshInSec, tokenIssueTimeEpochSec, refreshToken.
const refreshed = () =>
	thriftReply('refresh', [
		[
			12,
			0,
			[
				[11, 1, 'access-new'],
				[10, 2, 3600n],
				[10, 4, 1_700_000_000n],
				[11, 5, 'refresh-new']
			]
		]
	]);
// AccessTokenRefreshException INVALID_REQUEST: the refresh token was already spent.
const refreshRejected = () => thriftReply('refresh', [[12, 1, [[8, 1, 1000]]]]);

describe('token refresh', () => {
	it('runs one refresh for concurrent expired requests', async () => {
		let expiredReplies = 0;
		let refreshes = 0;
		let bothExpired!: () => void;
		const expiredTwice = new Promise<void>((resolve) => (bothExpired = resolve));
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getServerTime: (request) => {
				if (!usesOldToken(request)) return timeReply();
				if (++expiredReplies === 2) bothExpired();
				return thriftError('getServerTime', MUST_REFRESH_V3_TOKEN);
			},
			refresh: async () => {
				if (++refreshes > 1) return refreshRejected();
				await expiredTwice;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return refreshed();
			}
		});
		const session = await start(root, { createClient: upstream.createClient });

		const results = await Promise.all([
			session.base.talk.getServerTime(),
			session.base.talk.getServerTime()
		]);

		expect(results).toEqual([42, 42]);
		expect(refreshes).toBe(1);
		expect(session.state()).toBe('online');
		expect(stored(root, 'refreshToken')).toBe('refresh-new');
	});

	it('commits the access token, rotated refresh token and expiry together or not at all', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getServerTime: () => thriftError('getServerTime', MUST_REFRESH_V3_TOKEN),
			refresh: refreshed
		});
		const session = await start(root, { createClient: upstream.createClient });
		// The expiry write fails, as a crash or a full disk would interrupt it.
		session.db.exec(`CREATE TRIGGER fail_expire BEFORE INSERT ON line_kv
			WHEN NEW.key = 'expire' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

		await expect(session.base.talk.getServerTime()).rejects.toMatchObject({
			code: 'storage_error'
		});

		expect([stored(root, 'authToken'), stored(root, 'refreshToken')]).toEqual([
			'access-old',
			'refresh-old'
		]);
	});

	it("keeps the refresh response's next-access header out of storage when the refresh fails to commit", async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getServerTime: () => thriftError('getServerTime', MUST_REFRESH_V3_TOKEN),
			refresh: () => {
				const response = refreshed();
				response.headers.set('x-line-next-access', 'access-header');
				return response;
			}
		});
		const session = await start(root, { createClient: upstream.createClient });
		session.db.exec(`CREATE TRIGGER fail_expire BEFORE INSERT ON line_kv
			WHEN NEW.key = 'expire' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

		await expect(session.base.talk.getServerTime()).rejects.toMatchObject({
			code: 'storage_error'
		});

		expect([stored(root, 'authToken'), stored(root, 'refreshToken')]).toEqual([
			'access-old',
			'refresh-old'
		]);
	});

	it('still stores a next-access header from an ordinary response', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			noop: () => thriftReply('noop', [], { 'x-line-next-access': 'access-next' })
		});
		const session = await start(root, { createClient: upstream.createClient });

		await session.base.talk.noop();

		expect(stored(root, 'authToken')).toBe('access-next');
	});
});

describe('startup', () => {
	it('opens in needs_login when the refreshed token is refused again', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			// The retry after the refresh is told to refresh again, which LINEJS
			// resolves without a profile instead of throwing.
			getProfile: () => thriftError('getProfile', MUST_REFRESH_V3_TOKEN),
			refresh: refreshed
		});

		const session = await start(root, { createClient: upstream.createClient });

		expect(session.state()).toBe('needs_login');
		expect(readAccount(session.db)?.authState).toBe('needs_login');
		expect(upstream.calls).toEqual(['getProfile', 'refresh', 'getProfile']);
	});
});

describe('upstream stop', () => {
	it('blocks media requests after storage failed', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			noop: () => thriftReply('noop', [], { 'x-line-next-access': 'access-next' }),
			'/r/talk/m/1/object_info.obs': () => Response.json({ name: 'file.bin' })
		});
		const session = await start(root, { createClient: upstream.createClient });
		session.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON line_kv
			BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
		await expect(session.base.talk.noop()).rejects.toMatchObject({ code: 'storage_error' });
		const sent = upstream.calls.length;

		await expect(session.base.obs.getMessageObsMetadata({ messageId: '1' })).rejects.toMatchObject({
			code: 'storage_error'
		});
		expect(upstream.calls).toHaveLength(sent);
	});

	it("blocks LINEJS's retry after a refresh once the device was revoked meanwhile", async () => {
		let profiles = 0;
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: () =>
				++profiles === 1 ? profileReply() : thriftError('getProfile', NOT_AUTHORIZED_DEVICE),
			getServerTime: (request) =>
				usesOldToken(request) ? thriftError('getServerTime', MUST_REFRESH_V3_TOKEN) : timeReply(),
			refresh: async () => {
				await refreshGate;
				return refreshed();
			}
		});
		const session = await start(root, { createClient: upstream.createClient });

		const pending = session.base.talk.getServerTime().catch((error: unknown) => error);
		while (!upstream.calls.includes('refresh')) await new Promise((r) => setTimeout(r, 1));
		await expect(session.base.talk.getProfile()).rejects.toBeDefined();
		expect(session.state()).toBe('needs_login');
		releaseRefresh();

		expect(await pending).toMatchObject({ code: 'needs_login' });
		expect(upstream.calls.filter((method) => method === 'getServerTime')).toHaveLength(1);
	});
});

describe('auth loss', () => {
	it('treats a Square authentication failure as auth loss but not a permission error', async () => {
		let squareCalls = 0;
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			// SquareErrorCode FORBIDDEN (403), then AUTHENTICATION_FAILURE (401)
			// before and after the refresh.
			getJoinedSquareChats: () =>
				thriftError('getJoinedSquareChats', ++squareCalls === 1 ? 403 : 401),
			refresh: refreshed
		});
		const session = await start(root, { createClient: upstream.createClient });
		const joined = () => session.base.square.getJoinedSquareChats({ request: { limit: 1 } });

		await expect(joined()).rejects.toBeDefined();
		expect(session.state()).toBe('online');
		await expect(joined()).rejects.toBeDefined();
		expect(session.state()).toBe('needs_login');
		expect(upstream.calls.filter((method) => method === 'refresh')).toHaveLength(1);
		expect(squareCalls).toBe(3);
	});

	it('refreshes once and retries a Square read whose token expired', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getJoinedSquareChats: (request) =>
				usesOldToken(request)
					? thriftError('getJoinedSquareChats', 401)
					: thriftReply('getJoinedSquareChats', [[12, 0, [[11, 4, 'next']]]]),
			refresh: refreshed
		});
		const session = await start(root, { createClient: upstream.createClient });

		await expect(
			session.base.square.getJoinedSquareChats({ request: { limit: 1 } })
		).resolves.toMatchObject({ continuationToken: 'next' });

		expect(session.state()).toBe('online');
		expect(upstream.calls).toEqual([
			'getProfile',
			'getJoinedSquareChats',
			'refresh',
			'getJoinedSquareChats'
		]);
		expect(stored(root, 'authToken')).toBe('access-new');
	});

	it('enters needs_login when the refresh for a Square read is rejected', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getJoinedSquareChats: () => thriftError('getJoinedSquareChats', 401),
			refresh: refreshRejected
		});
		const session = await start(root, { createClient: upstream.createClient });

		await expect(
			session.base.square.getJoinedSquareChats({ request: { limit: 1 } })
		).rejects.toBeDefined();

		expect(session.state()).toBe('needs_login');
		expect(upstream.calls.filter((method) => method === 'getJoinedSquareChats')).toHaveLength(1);
	});

	it('refreshes once but does not resend a Square mutation after an authentication failure', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			leaveSquareChat: () => thriftError('leaveSquareChat', 401),
			refresh: refreshed
		});
		const session = await start(root, { createClient: upstream.createClient });

		await expect(
			session.base.square.leaveSquareChat({ request: { squareChatMid: 'm1' } })
		).rejects.toMatchObject({ data: { errorCode: 'AUTHENTICATION_FAILURE' } });

		expect(session.state()).toBe('online');
		expect(upstream.calls).toEqual(['getProfile', 'leaveSquareChat', 'refresh']);
		expect(stored(root, 'authToken')).toBe('access-new');
	});

	it('enters needs_login when the refresh for a Square mutation is rejected', async () => {
		const root = seeded();
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			leaveSquareChat: () => thriftError('leaveSquareChat', 401),
			refresh: refreshRejected
		});
		const session = await start(root, { createClient: upstream.createClient });

		await expect(
			session.base.square.leaveSquareChat({ request: { squareChatMid: 'm1' } })
		).rejects.toBeDefined();

		expect(session.state()).toBe('needs_login');
		expect(upstream.calls).toEqual(['getProfile', 'leaveSquareChat', 'refresh']);
	});

	it('opens in needs_login when the device was revoked before startup', async () => {
		const root = seeded();
		const upstream = fakeUpstream({
			getProfile: () => {
				throw talkError('NOT_AUTHORIZED_DEVICE');
			}
		});

		const session = await start(root, { createClient: upstream.createClient });

		expect(session.state()).toBe('needs_login');
		expect(readAccount(session.db)?.authState).toBe('needs_login');
		await expect(session.base.talk.getProfile()).rejects.toMatchObject({ code: 'needs_login' });
		expect(upstream.calls).toEqual(['getProfile']);
	});

	it('still refuses to start when the token belongs to another account', async () => {
		const root = seeded();
		const upstream = fakeUpstream({ getProfile: () => ({ mid: otherMid }) });

		await expect(start(root, { createClient: upstream.createClient })).rejects.toMatchObject({
			code: 'wrong_account'
		});
	});
});
