import { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '@evex/linejs-types';
import { afterEach, describe, expect, it } from 'vitest';
import { readAccount } from '../src/db.ts';
import { mapError } from '../src/errors.ts';
import { decryptMessage } from '../src/keys.ts';
import { databasePath } from '../src/paths.ts';
import { type LogEntry, openSession, type Session, type SessionOptions } from '../src/session.ts';
import {
	fakeHttpUpstream,
	fakeUpstream,
	freePort,
	groupMid,
	type Handler,
	seedLive,
	selfMid,
	talkError,
	tempRoot,
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

const profile: Handler = () => ({ mid: selfMid });
const notFound: Handler = () => {
	throw talkError('NOT_FOUND');
};

describe('session guards', () => {
	it('never registers a group key when the group key lookup is NOT_FOUND', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const upstream = fakeUpstream({
			getProfile: profile,
			getE2EEGroupSharedKey: notFound,
			getLastE2EEGroupSharedKey: notFound
		});
		const session = await start(root, { createClient: upstream.createClient });

		// The LINEJS lookup without a key id falls back to registration on NOT_FOUND.
		await expect(session.base.e2ee.getE2EELocalPublicKey(groupMid)).rejects.toMatchObject({
			code: 'missing_key'
		});
		const envelope = {
			from: `u${'b'.repeat(32)}`,
			to: groupMid,
			toType: 'GROUP',
			id: '1',
			contentType: 'NONE',
			contentMetadata: { e2eeVersion: '2' },
			chunks: [Buffer.alloc(16), Buffer.alloc(32), Buffer.alloc(12), int(5), int(9)]
		} as unknown as Message;
		expect(await decryptMessage(session.base, selfMid, envelope)).toEqual({
			state: 'missing_key',
			missing: 'group_key'
		});

		expect(upstream.calls).not.toContain('getLastE2EEPublicKeys');
		expect(upstream.calls.filter((method) => method.startsWith('register'))).toEqual([]);
	});

	it('blocks all upstream work after a token write fails', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token-1' });
		const upstream = fakeHttpUpstream({
			getProfile: () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]),
			noop: () => thriftReply('noop', [], { 'x-line-next-access': 'token-2' })
		});
		const session = await start(root, { createClient: upstream.createClient });
		// Every later write to line_kv fails, as on a full or failing disk.
		const other = new DatabaseSync(databasePath(root));
		other.exec(`
			CREATE TRIGGER fail_insert BEFORE INSERT ON line_kv BEGIN SELECT RAISE(ABORT, 'disk full'); END;
			CREATE TRIGGER fail_update BEFORE UPDATE ON line_kv BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
		other.close();

		await expect(session.base.talk.noop()).rejects.toMatchObject({ code: 'storage_error' });
		expect(session.state()).toBe('storage_error');
		const sent = upstream.calls.length;
		await expect(session.base.talk.getProfile()).rejects.toMatchObject({ code: 'storage_error' });
		expect(upstream.calls).toHaveLength(sent);
	});

	it('stops upstream calls and persists needs_login when LINE revokes the device', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const upstream = fakeUpstream({
			getProfile: profile,
			getServerTime: () => {
				throw talkError('NOT_AUTHORIZED_DEVICE');
			}
		});
		const session = await start(root, { createClient: upstream.createClient });

		await expect(session.base.talk.getServerTime()).rejects.toBeDefined();
		expect(session.state()).toBe('needs_login');
		const sent = upstream.calls.length;
		await expect(session.base.talk.getProfile()).rejects.toMatchObject({ code: 'needs_login' });
		expect(upstream.calls).toHaveLength(sent);
		expect(readAccount(session.db)?.authState).toBe('needs_login');
	});
});

describe('error mapper', () => {
	it('keeps the token and body of an unparseable response out of logs and mapped errors', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const token = 'next-token-6f2a91';
		const body = Buffer.from('BODY-SECRET-PAYLOAD');
		const upstream = fakeHttpUpstream({
			getProfile: () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]),
			getServerTime: () => new Response(body, { headers: { 'x-line-next-access': token } })
		});
		const logs: LogEntry[] = [];
		const session = await start(root, {
			createClient: upstream.createClient,
			log: (entry) => logs.push(entry)
		});

		const error = await session.base.talk.getServerTime().catch((caught: unknown) => caught);

		// The raw LINEJS error does carry both; nothing derived from it may.
		expect(String((error as Error).message)).toContain(token);
		const mapped = mapError(error, 'getServerTime');
		expect(mapped.code).toBe('upstream_parse_error');
		const exposed = JSON.stringify([mapped, logs]);
		const bodyHex = [...body].map((byte) => byte.toString(16)).join(' ');
		for (const secret of [token, bodyHex, 'BODY-SECRET']) {
			expect(exposed).not.toContain(secret);
		}
	});
});

function int(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}
