import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readAccount } from '../src/db.ts';
import { mapError } from '../src/errors.ts';
import { acquireLock } from '../src/lock.ts';
import { databasePath } from '../src/paths.ts';
import { login, type LoginOptions } from '../src/session.ts';
import {
	type FakeUpstream,
	fakeUpstream,
	freePort,
	groupMid,
	keyPair,
	otherMid,
	qrLoginHandlers,
	seedLive,
	selfMid,
	snapshot,
	storedKey,
	tempRoot,
	within
} from './fake-line.ts';

async function runLogin(root: string, upstream: FakeUpstream, extra: Partial<LoginOptions> = {}) {
	return await login({
		root,
		lockPort: await freePort(),
		createClient: upstream.createClient,
		log: () => {},
		onQrUrl: () => {},
		onPin: () => {},
		...extra
	});
}

function liveRows(root: string): Record<string, string> {
	const db = new DatabaseSync(databasePath(root), { readOnly: true });
	try {
		const rows = db.prepare('SELECT key, value FROM line_kv').all();
		return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
	} finally {
		db.close();
	}
}

describe('QR login', () => {
	it('binds the account on first login and stores the token and transferred keys', async () => {
		const root = tempRoot();
		const key = keyPair(4);
		const urls: string[] = [];

		const result = await runLogin(
			root,
			fakeUpstream(qrLoginHandlers({ mid: selfMid, keys: [key] })),
			{
				onQrUrl: (url) => urls.push(url)
			}
		);

		expect(result).toEqual({ mid: selfMid, firstLogin: true, addedKeyGenerations: 1 });
		expect(urls).toHaveLength(1);
		const db = new DatabaseSync(databasePath(root), { readOnly: true });
		expect(readAccount(db)).toMatchObject({ mid: selfMid, device: 'ANDROIDSECONDARY' });
		db.close();
		const rows = liveRows(root);
		expect(rows.authToken).toBe('access-new');
		expect(rows.refreshToken).toBe('refresh-new');
		expect(JSON.parse(rows['e2eeKeys:4']!)).toMatchObject({
			privKey: key.privKey.toString('base64'),
			pubKey: key.pubKey.toString('base64')
		});
	});

	it('fails when the QR result carries no keys and never calls a register RPC', async () => {
		const root = tempRoot();
		const upstream = fakeUpstream(qrLoginHandlers({ mid: selfMid }));

		await expect(runLogin(root, upstream)).rejects.toMatchObject({ code: 'key_transfer_empty' });

		expect(upstream.calls.filter((method) => method.startsWith('register'))).toEqual([]);
		const db = new DatabaseSync(databasePath(root), { readOnly: true });
		expect(readAccount(db)).toBeUndefined();
		expect(db.prepare('SELECT count(*) AS n FROM line_kv').get()).toEqual({ n: 0 });
		db.close();
	});

	it('leaves the live session untouched when another account scans the code', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, {
			authToken: 'token-old',
			refreshToken: 'refresh-old',
			qrCert: 'cert-old',
			'e2eeKeys:1': storedKey(keyPair(1)),
			'e2eeKeys:2': storedKey(keyPair(2))
		});
		const before = snapshot(root);

		await expect(
			runLogin(root, fakeUpstream(qrLoginHandlers({ mid: otherMid, keys: [keyPair(2)] })))
		).rejects.toMatchObject({ code: 'wrong_account' });

		expect(snapshot(root)).toEqual(before);
	});

	it('keeps every stored key generation when the transfer returns only a subset', async () => {
		const root = tempRoot();
		const keys = [keyPair(1), keyPair(2), keyPair(3)];
		const cache = {
			[`e2eePublicKeys:${otherMid}:5`]: 'peer-public-key',
			[`e2eeGroupKeys:${groupMid}:9`]: '{"privKey":"group","keyId":9}'
		};
		seedLive(root, selfMid, {
			authToken: 'token-old',
			...Object.fromEntries(keys.map((key) => [`e2eeKeys:${key.keyId}`, storedKey(key)])),
			...cache
		});
		const before = liveRows(root);
		const newKey = keyPair(4);

		const result = await runLogin(
			root,
			fakeUpstream(qrLoginHandlers({ mid: selfMid, keys: [keys[2]!, newKey] }))
		);

		expect(result).toMatchObject({ firstLogin: false, addedKeyGenerations: 1 });
		const after = liveRows(root);
		for (const key of ['e2eeKeys:1', 'e2eeKeys:2', 'e2eeKeys:3', ...Object.keys(cache)]) {
			expect(after[key], key).toBe(before[key]);
		}
		expect(JSON.parse(after['e2eeKeys:4']!).privKey).toBe(newKey.privKey.toString('base64'));
		expect(after.authToken).toBe('access-new');
	});
});

// What LINEJS throws for a 410 without a Thrift body (base/request/mod.ts:183-190).
function gone(): never {
	throw new Error('Request internal failed: status=410 headers=[] body=<>');
}

describe('QR expiry', () => {
	// Live LINE allows two long polls per QR code.
	const twoPolls = { 1: 'https://line.me/R/au/lgn/sq/fake', 2: 2, 3: 1, 4: 'n' };

	it('reports an unscanned QR code as expired after the last poll', async () => {
		const root = tempRoot();
		const upstream = fakeUpstream({
			...qrLoginHandlers({ mid: selfMid }),
			createQrCodeForSecure: () => twoPolls,
			checkQrCodeVerified: gone
		});

		const error = await runLogin(root, upstream).catch((reason: unknown) => reason);

		expect(mapError(error, 'login')).toEqual({
			code: 'qr_expired',
			operation: 'login',
			message: 'The QR code expired before it was scanned; run line-mcp login again'
		});
		expect(upstream.calls.filter((method) => method === 'checkQrCodeVerified')).toHaveLength(2);
	});

	it('leaves other QR poll failures unmapped', async () => {
		const root = tempRoot();
		const upstream = fakeUpstream({
			...qrLoginHandlers({ mid: selfMid }),
			createQrCodeForSecure: () => twoPolls,
			checkQrCodeVerified: () => {
				throw new Error('Request internal failed: status=502 headers=[] body=<>');
			}
		});

		const error = await runLogin(root, upstream).catch((reason: unknown) => reason);

		expect(mapError(error, 'login').code).toBe('upstream_parse_error');
	});

	it('leaves a 410 from the PIN poll unmapped', async () => {
		const root = tempRoot();
		const upstream = fakeUpstream({
			...qrLoginHandlers({ mid: selfMid }),
			createQrCodeForSecure: () => twoPolls,
			verifyCertificate: () => {
				throw new Error('no certificate');
			},
			createPinCode: () => ({ 1: '123456' }),
			checkPinCodeVerified: gone
		});

		const error = await runLogin(root, upstream).catch((reason: unknown) => reason);

		expect(mapError(error, 'login').code).toBe('upstream_parse_error');
	});
});

describe('cancelled login', () => {
	// Ctrl-C usually comes while the QR code waits for a scan; at the profile
	// lookup, LINEJS has already written the new token and keys to staging.
	it.each(['checkQrCodeVerified', 'getProfile'])(
		'settles at once while %s is pending and commits nothing',
		async (method) => {
			const root = tempRoot();
			seedLive(root, selfMid, { authToken: 'token-old', 'e2eeKeys:1': storedKey(keyPair(1)) });
			const before = snapshot(root);
			const handlers = qrLoginHandlers({ mid: selfMid, keys: [keyPair(1), keyPair(2)] });
			const answer = handlers[method]!;
			const reached = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const upstream = fakeUpstream({
				...handlers,
				[method]: async (value, base) => {
					reached.resolve();
					await resume.promise;
					return answer(value, base);
				}
			});
			const cancel = new AbortController();
			const lockPort = await freePort();

			const pending = runLogin(root, upstream, { lockPort, signal: cancel.signal });
			await within(5000, reached.promise, `reaching ${method}`);
			const dispatched = [...upstream.calls];
			cancel.abort();

			await expect(within(1000, pending, 'the cancelled login')).rejects.toMatchObject({
				code: 'login_cancelled'
			});
			const lock = await acquireLock(lockPort);
			await lock.release();
			// The stalled call answers late, and LINEJS carries on with the login.
			resume.resolve();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(upstream.calls).toEqual(dispatched);
			expect(snapshot(root)).toEqual(before);
		}
	);

	it('binds nothing when the cancel comes right before the commit', async () => {
		const root = tempRoot();
		const cancel = new AbortController();
		const upstream = fakeUpstream(qrLoginHandlers({ mid: selfMid, keys: [keyPair(1)] }));
		// The cancel lands once LINEJS has finished, at the profile read that leads to the commit.
		const createClient: LoginOptions['createClient'] = (storage) => {
			const base = upstream.createClient(storage);
			const loginProcess = base.loginProcess.login.bind(base.loginProcess);
			let finished = false;
			base.loginProcess.login = async (...args) => {
				await loginProcess(...args);
				finished = true;
			};
			let profile = base.profile;
			Object.defineProperty(base, 'profile', {
				get: () => {
					if (finished) cancel.abort();
					return profile;
				},
				set: (value: typeof profile) => {
					profile = value;
				}
			});
			return base;
		};

		await expect(
			runLogin(root, upstream, { createClient, signal: cancel.signal })
		).rejects.toMatchObject({ code: 'login_cancelled' });

		expect(snapshot(root)).toEqual({ kv: [], account: [] });
	});
});
