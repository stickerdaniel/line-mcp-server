import { Buffer } from 'node:buffer';
import { type ChildProcess, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BaseClient, InternalError } from '@evex/linejs/base';
import type { NestedArray } from '@evex/linejs/thrift';
import type { Message } from '@evex/linejs-types';
import { afterEach, describe, expect, it } from 'vitest';
import { readAccount, transaction } from '../src/db.ts';
import { decryptMessage } from '../src/keys.ts';
import type { SqliteStorage } from '../src/storage.ts';
import { applyChanges, encodeEnvelope, type MessageRow } from '../src/sync/normalize.ts';
import {
	callArgs,
	fakeHttpUpstream,
	freePort,
	groupMid,
	type Handler,
	keyPair,
	otherMid,
	seedLive,
	selfMid,
	storedKey,
	tempRoot,
	thriftError,
	thriftReply,
	within
} from './fake-line.ts';
import { callTool, runCli, serve, type Served, startCli } from './mcp-client.ts';

const square = `m${'d'.repeat(32)}`;
const thread = `t${'e'.repeat(32)}`;
const member = `p${'f'.repeat(32)}`;
const self = keyPair(2);
const peer = keyPair(5);

/** The own key and the contact's key, as a QR login and an earlier lookup leave them. */
const keyRows: Record<string, string> = {
	'e2eeKeys:2': storedKey(self),
	[`e2eeKeys:${selfMid}`]: storedKey(self),
	[`e2eePublicKeys:${otherMid}:5`]: peer.pubKey.toString('base64')
};

function withKeys(served: Served): Served {
	const storage = served.session.base.storage as SqliteStorage;
	for (const [key, value] of Object.entries(keyRows)) storage.setSync(key, value);
	return served;
}

/** LINE's answer to a key negotiation with the contact's current key. */
const negotiate: Handler = () => ({
	specVersion: 2,
	publicKey: { keyId: 5, keyData: peer.pubKey }
});

/** Field `id` of a Thrift struct as LINEJS writes it: a list of [type, id, value]. */
function field(struct: unknown, ...path: number[]): unknown {
	let current = struct;
	for (const id of path) {
		current = (current as [number, number, unknown][]).find((entry) => entry?.[1] === id)?.[2];
	}
	return current;
}

/** The requests one RPC received, answered by `answer`. */
function recorder(answer: (value: NestedArray, count: number) => unknown) {
	const requests: NestedArray[] = [];
	const handler: Handler = (value) => {
		requests.push(value);
		return answer(value, requests.length);
	};
	return { requests, handler };
}

/** The chunks of a Talk `sendMessage_args` request. */
function chunksOf(value: NestedArray): Buffer[] {
	return (field(value, 2, 20) as [number, Buffer[]])[1];
}

/** Decrypts sent chunks the way another device of the account does. */
function readBack(base: BaseClient, chunks: Buffer[], to: string, contentType = 'NONE') {
	return decryptMessage(base, selfMid, {
		id: '1',
		from: selfMid,
		to,
		toType: to.startsWith('c') ? 'GROUP' : 'USER',
		contentType,
		contentMetadata: { e2eeVersion: '2' },
		chunks
	} as unknown as Message);
}

function row(fields: Partial<MessageRow> & { messageId: string }): MessageRow {
	return {
		service: 'talk',
		chatId: otherMid,
		chatType: 'user',
		threadId: null,
		sender: otherMid,
		sentAt: Date.now(),
		editedAt: null,
		contentType: 'NONE',
		text: '你好',
		replyTo: null,
		mentions: null,
		envelope: JSON.stringify({ id: fields.messageId }),
		decryptState: 'ok',
		missingKey: null,
		...fields
	};
}

function store(served: Served, ...rows: MessageRow[]): void {
	const { db } = served.session;
	transaction(db, () =>
		applyChanges(
			db,
			rows.map((entry) => ({ kind: 'message', row: entry }))
		)
	);
}

/** How often an RPC reached the fake upstream. */
const count = (served: Served, method: string) =>
	served.upstream.calls.filter((call) => call === method).length;

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
	await within(
		ms,
		(async () => {
			while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
		})(),
		what
	);
}

/**
 * Calls a tool and drops the connection once `drop` resolves, as a client
 * that crashed or timed out would; the answer, if any, is lost.
 */
function callAndDrop(port: number, name: string, args: object, drop: Promise<unknown>): void {
	const req = httpRequest({
		host: '127.0.0.1',
		port,
		path: '/mcp',
		method: 'POST',
		agent: false,
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		}
	});
	req.on('error', () => {});
	req.end(
		JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args }
		})
	);
	void drop.then(() => req.destroy());
}

/** An own E2EE message reading 到了 to the peer, as sync stores it. */
const ownSynced = (messageId: string, chunks: Buffer[]) =>
	row({
		messageId,
		sender: selfMid,
		text: '到了',
		envelope: encodeEnvelope({
			id: messageId,
			from: selfMid,
			to: otherMid,
			toType: 'USER',
			contentType: 'NONE',
			contentMetadata: { e2eeVersion: '2' },
			chunks
		} as unknown as Message)
	});

const toPeer = (args: object) => ({ service: 'talk', chat_id: otherMid, ...args });

// Answers at the HTTP layer, for the real LINEJS request code.
const profileReply = () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]);
/** E2EENegotiationResult with specVersion -1: the contact has no E2EE. */
const plainNegotiation = () => thriftReply('negotiateE2EEPublicKey', [[12, 0, [[8, 3, -1]]]]);
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

/** A refresh token, so LINEJS and the session can refresh an expired access token. */
function withRefresh(served: Served): Served {
	(served.session.base.storage as SqliteStorage).setSync('refreshToken', 'refresh-old');
	return served;
}

describe('send_message in Talk', () => {
	it('sends end-to-end encrypted, and a repeated key sends once', async () => {
		const sent = recorder((_value, nth) => ({ id: String(9000 + nth) }));
		const served = withKeys(
			await serve({ negotiateE2EEPublicKey: negotiate, sendMessage: sent.handler })
		);
		const { port } = served.server;
		const args = toPeer({ text: '今晚七點見 🍜', idempotency_key: 'dinner-0001' });

		const first = await callTool(port, 'send_message', args);
		const again = await callTool(port, 'send_message', args);
		const together = await Promise.all([
			callTool(port, 'send_message', { ...args, idempotency_key: 'dinner-0002' }),
			callTool(port, 'send_message', { ...args, idempotency_key: 'dinner-0002' })
		]);

		expect(first.data).toMatchObject({
			idempotency_key: 'dinner-0001',
			state: 'sent',
			replayed: false,
			message_id: '9001',
			e2ee: true
		});
		expect(again.data).toMatchObject({ state: 'sent', replayed: true, message_id: '9001' });
		expect(
			together.map((result) => [result.data.message_id, result.data.replayed]).toSorted()
		).toEqual([
			['9002', false],
			['9002', true]
		]);
		expect(count(served, 'sendMessage')).toBe(2);
		const [request] = sent.requests;
		expect(field(request, 2, 10)).toBeUndefined();
		expect(field(request, 2, 18)).toEqual([
			11,
			11,
			{ e2eeVersion: '2', contentType: '0', e2eeMark: '2' }
		]);
		expect(await readBack(served.session.base, chunksOf(request!), otherMid)).toEqual({
			state: 'ok',
			payload: { text: '今晚七點見 🍜' }
		});
		expect(served.upstream.calls.filter((call) => call.startsWith('register'))).toEqual([]);
	});

	it('replies in plain text to a contact without E2EE', async () => {
		const sent = recorder(() => ({ id: '9100' }));
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: () => ({ specVersion: -1 }),
				sendMessage: sent.handler
			})
		);

		const result = await callTool(
			served.server.port,
			'send_message',
			toPeer({ text: 'ok', reply_to: '1234567890123456789', idempotency_key: 'reply-0001' })
		);

		expect(result.data).toMatchObject({ state: 'sent', e2ee: false, message_id: '9100' });
		const [request] = sent.requests;
		expect(field(request, 2, 10)).toBe('ok');
		expect(field(request, 2, 21)).toBe('1234567890123456789');
		expect(field(request, 2, 22)).toBe(3);
	});

	it('sends in a group with its current key', async () => {
		const creator = keyPair(7);
		const group = keyPair(9);
		const shared = (base: BaseClient) => ({
			keyVersion: 2,
			groupKeyId: 9,
			creator: otherMid,
			creatorKeyId: 7,
			receiver: selfMid,
			receiverKeyId: 2,
			encryptedSharedKey: wrapGroupKey(base, group.privKey, creator.privKey, self.pubKey)
		});
		const sent = recorder(() => ({ id: '9200' }));
		const served = withKeys(
			await serve({
				getLastE2EEGroupSharedKey: (_value, base) => shared(base),
				getE2EEGroupSharedKey: (_value, base) => shared(base),
				getE2EEPublicKey: () => ({ version: 1, keyId: 7, keyData: creator.pubKey }),
				sendMessage: sent.handler
			})
		);

		const result = await callTool(served.server.port, 'send_message', {
			service: 'talk',
			chat_id: groupMid,
			text: '大家好',
			idempotency_key: 'group-0001'
		});

		expect(result.data).toMatchObject({ state: 'sent', e2ee: true });
		expect(await readBack(served.session.base, chunksOf(sent.requests[0]!), groupMid)).toEqual({
			state: 'ok',
			payload: { text: '大家好' }
		});
		expect(
			served.upstream.calls.filter((call) => /register|getLastE2EEPublicKeys/.test(call))
		).toEqual([]);
	});

	it('sends an image encrypted, with its key only inside the message', async () => {
		const uploads: { path: string; body: Buffer }[] = [];
		const sent = recorder(() => ({ id: '9300' }));
		const served = withKeys(
			await serve(
				{ negotiateE2EEPublicKey: negotiate, sendMessage: sent.handler },
				async (request) => {
					uploads.push({
						path: new URL(request.url).pathname,
						body: Buffer.from(await request.arrayBuffer())
					});
					return new Response(null, { headers: { 'x-obs-oid': 'obj-1' } });
				}
			)
		);
		const image = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 3)]);
		const path = join(served.root, 'photo.png');
		writeFileSync(path, image);

		const result = await callTool(
			served.server.port,
			'send_message',
			toPeer({ file_path: path, idempotency_key: 'image-0001' })
		);

		expect(result.data).toMatchObject({ state: 'sent', e2ee: true, message_id: '9300' });
		expect(uploads.map((upload) => upload.path)).toEqual([
			expect.stringMatching(/^\/+r\/talk\/emi\/reqid-/),
			expect.stringMatching(/^\/+r\/talk\/emi\/obj-1__ud-preview$/)
		]);
		const [request] = sent.requests;
		expect(field(request, 2, 15)).toBe(1);
		expect(field(request, 2, 18)).toMatchObject([
			11,
			11,
			{ SID: 'emi', OID: 'obj-1', e2eeVersion: '2' }
		]);
		const opened = await readBack(served.session.base, chunksOf(request!), otherMid, 'IMAGE');
		expect(opened).toMatchObject({ state: 'ok', payload: { fileName: 'photo.png' } });
		const { keyMaterial } = (opened as unknown as { payload: { keyMaterial: string } }).payload;
		const decrypted = await served.session.base.e2ee.decryptByKeyMaterial(
			uploads[0]!.body,
			keyMaterial
		);
		expect(Buffer.from(decrypted)).toEqual(image);
		expect(uploads[0]!.body.includes(image)).toBe(false);
	});
});

const keyless = `c${'9'.repeat(32)}`;
/** E2EEGroupSharedKey as LINE answers it: the key wrapped for this account. */
const sharedKey = (
	id: number,
	creator: string,
	creatorKeyId: number,
	wrapped: Buffer
): NestedArray => [
	[8, 1, 1],
	[8, 2, id],
	[11, 3, creator],
	[8, 4, creatorKeyId],
	[11, 5, selfMid],
	[8, 6, self.keyId],
	[11, 7, wrapped]
];
/** getLastE2EEPublicKeys: the current public key of every member. */
const memberKeys = () =>
	thriftReply('getLastE2EEPublicKeys', [
		[
			13,
			0,
			[
				11,
				12,
				{
					[selfMid]: [
						[8, 2, self.keyId],
						[11, 4, self.pubKey]
					],
					[otherMid]: [
						[8, 2, peer.keyId],
						[11, 4, peer.pubKey]
					]
				}
			]
		]
	]);
// TalkException NOT_FOUND: the group has no shared key.
const noKey = () => thriftError('getLastE2EEGroupSharedKey', 5);
const messageReply = () => thriftReply('sendMessage', [[12, 0, [[11, 4, '9900']]]]);
const sendTo = (served: Served, key: string) =>
	callTool(served.server.port, 'send_message', {
		service: 'talk',
		chat_id: keyless,
		text: '大家好',
		idempotency_key: key
	});

describe('send_message to a group without a key', () => {
	it('registers a key wrapped for every member and sends under it', async () => {
		let registered: Record<number, unknown> = {};
		let created: NestedArray = [];
		let message: Record<number, unknown> = {};
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getLastE2EEGroupSharedKey: noKey,
			getLastE2EEPublicKeys: memberKeys,
			registerE2EEGroupKey: async (request) => {
				registered = await callArgs(request);
				const members = registered[4] as string[];
				const wrapped = (registered[6] as Buffer[])[members.indexOf(selfMid)]!;
				created = sharedKey(11, selfMid, self.keyId, wrapped);
				return thriftReply('registerE2EEGroupKey', [[12, 0, created]]);
			},
			getE2EEGroupSharedKey: () => thriftReply('getE2EEGroupSharedKey', [[12, 0, created]]),
			sendMessage: async (request) => {
				message = (await callArgs(request))[2] as Record<number, unknown>;
				return messageReply();
			}
		});
		const served = withKeys(await serve({}, undefined, { upstream }));
		const { base } = served.session;

		const result = await sendTo(served, 'register-0001');

		expect(result.data).toMatchObject({ state: 'sent', e2ee: true, message_id: '9900' });
		const members = registered[4] as string[];
		expect(registered).toMatchObject({ 2: 1, 3: keyless });
		expect(members.toSorted()).toEqual([selfMid, otherMid].toSorted());
		expect(registered[5]).toEqual(
			members.map((mid) => (mid === selfMid ? self.keyId : peer.keyId))
		);
		const chunks = (message[20] as (Buffer | string)[]).map((chunk) => Buffer.from(chunk));
		// The other member unwraps its copy of the new key and reads the message.
		const forPeer = (registered[6] as Buffer[])[members.indexOf(otherMid)]!;
		const groupPrivate = unwrapGroupKey(base, forPeer, peer.privKey, self.pubKey);
		expect(
			base.e2ee.decryptE2EEMessageV2(keyless, selfMid, chunks, groupPrivate, self.pubKey, 2, 0)
		).toEqual({ text: '大家好' });
		expect(await readBack(base, chunks, keyless)).toEqual({
			state: 'ok',
			payload: { text: '大家好' }
		});
		expect(served.upstream.calls.filter((call) => call.startsWith('register'))).toEqual([
			'registerE2EEGroupKey'
		]);
		expect(served.logs).toContainEqual({ event: 'group_key_registered', chat_id: keyless });
		expect(JSON.stringify(served.logs)).not.toContain(groupPrivate.toString('base64'));
	});

	it('uses the key another member registered first', async () => {
		const creator = keyPair(7);
		const group = keyPair(9);
		let existing: NestedArray = [];
		let lookups = 0;
		let message: Record<number, unknown> = {};
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getLastE2EEGroupSharedKey: () =>
				++lookups === 1 ? noKey() : thriftReply('getLastE2EEGroupSharedKey', [[12, 0, existing]]),
			getLastE2EEPublicKeys: memberKeys,
			// Assumed: LINE documents no code for a key that exists by now, so the
			// refusal here is a stand-in (TalkException INVALID_STATE).
			registerE2EEGroupKey: () => thriftError('registerE2EEGroupKey', 3),
			getE2EEGroupSharedKey: () => thriftReply('getE2EEGroupSharedKey', [[12, 0, existing]]),
			getE2EEPublicKey: () =>
				thriftReply('getE2EEPublicKey', [
					[
						12,
						0,
						[
							[8, 1, 1],
							[8, 2, creator.keyId],
							[11, 4, creator.pubKey]
						]
					]
				]),
			sendMessage: async (request) => {
				message = (await callArgs(request))[2] as Record<number, unknown>;
				return messageReply();
			}
		});
		const served = withKeys(await serve({}, undefined, { upstream }));
		const { base } = served.session;
		existing = sharedKey(
			group.keyId,
			otherMid,
			creator.keyId,
			wrapGroupKey(base, group.privKey, creator.privKey, self.pubKey)
		);

		const result = await sendTo(served, 'race-0001');

		expect(result.data).toMatchObject({ state: 'sent', e2ee: true, message_id: '9900' });
		const chunks = (message[20] as (Buffer | string)[]).map((chunk) => Buffer.from(chunk));
		expect(
			base.e2ee.decryptE2EEMessageV2(keyless, selfMid, chunks, group.privKey, self.pubKey, 2, 0)
		).toEqual({ text: '大家好' });
		expect(lookups).toBe(2);
		expect(count(served, 'registerE2EEGroupKey')).toBe(1);
		expect(served.logs.map((entry) => entry.event)).not.toContain('group_key_registered');
	});

	it('fails without sending anything when the registration is refused', async () => {
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			getLastE2EEGroupSharedKey: noKey,
			getLastE2EEPublicKeys: memberKeys,
			// E2EE_GROUP_TOO_MANY_MEMBERS, as LINE refused it to the beeper LINE
			// bridge ("exceed max member").
			registerE2EEGroupKey: () => thriftError('registerE2EEGroupKey', 100),
			sendMessage: messageReply
		});
		const served = withKeys(await serve({}, undefined, { upstream }));

		const result = await sendTo(served, 'refused-0001');

		expect(result).toMatchObject({
			isError: true,
			data: { error: { code: 'E2EE_GROUP_TOO_MANY_MEMBERS' }, state: 'failed' }
		});
		expect(served.upstream.calls).toEqual([
			'getLastE2EEGroupSharedKey',
			'getLastE2EEPublicKeys',
			'registerE2EEGroupKey',
			'getLastE2EEGroupSharedKey'
		]);
	});
});

describe('idempotency keys', () => {
	it('refuses a key reused for a different action and sends nothing for it', async () => {
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: negotiate,
				sendMessage: () => ({ id: '9400' }),
				react: () => undefined
			})
		);
		const { port } = served.server;
		await callTool(port, 'send_message', toPeer({ text: 'A', idempotency_key: 'reused-0001' }));

		const otherText = await callTool(
			port,
			'send_message',
			toPeer({ text: 'B', idempotency_key: 'reused-0001' })
		);
		const otherChat = await callTool(port, 'send_message', {
			service: 'talk',
			chat_id: selfMid,
			text: 'A',
			idempotency_key: 'reused-0001'
		});
		const reaction = await callTool(
			port,
			'react',
			toPeer({ message_id: '9400', reaction: 'love', idempotency_key: 'reused-0001' })
		);

		for (const result of [otherText, otherChat, reaction]) {
			expect(result).toMatchObject({
				isError: true,
				data: { error: { code: 'idempotency_conflict' } }
			});
		}
		expect(count(served, 'sendMessage')).toBe(1);
		expect(count(served, 'react')).toBe(0);
	});
});

describe('outcomes after dispatch', () => {
	it('reports unknown, not failed, when the answer cannot be parsed', async () => {
		const token = 'SECRET-NEXT-ACCESS-TOKEN';
		const upstream = fakeHttpUpstream({
			getProfile: () => thriftReply('getProfile', [[12, 0, [[11, 1, selfMid]]]]),
			sendMessage: () =>
				new Response(Buffer.from('<html>祕密 Gateway Error</html>'), {
					headers: { 'x-line-next-access': token }
				})
		});
		const served = await serve({}, undefined, { upstream });
		const args = {
			service: 'square',
			chat_id: square,
			text: '大家好',
			idempotency_key: 'parse-0001'
		};

		const result = await callTool(served.server.port, 'send_message', args);
		const retried = await callTool(served.server.port, 'send_message', args);

		expect(result).toMatchObject({
			isError: true,
			data: {
				error: { code: 'outcome_unknown', operation: 'send_message' },
				state: 'unknown',
				replayed: false,
				cause: { code: 'upstream_parse_error' }
			}
		});
		expect(retried.data).toMatchObject({ state: 'unknown', replayed: true });
		expect(count(served, 'sendMessage')).toBe(1);
		for (const output of [result.text, retried.text, JSON.stringify(served.logs)]) {
			expect(output).not.toContain(token);
			expect(output).not.toContain('祕密');
		}
	});

	it('maps every failure: failed before dispatch and retried, unknown after', async () => {
		const secret = 'reason quoting 祕密 SECRET-TOKEN';
		const rejected = (code: string) =>
			new InternalError('RequestError', secret, { code, reason: secret });
		let refuseLookup = true;
		let sends = 0;
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: (value, base) => {
					if (refuseLookup) throw rejected('NOT_A_MEMBER');
					return negotiate(value, base);
				},
				sendMessage: () => {
					if (++sends > 1) throw rejected('ABUSE_BLOCK');
					return { id: '9500' };
				}
			})
		);
		const { port } = served.server;
		const args = toPeer({ text: 'hi', idempotency_key: 'mapped-0001' });

		const before = await callTool(port, 'send_message', args);
		refuseLookup = false;
		const retried = await callTool(port, 'send_message', args);
		const after = await callTool(
			port,
			'send_message',
			toPeer({ text: 'hi again', idempotency_key: 'mapped-0002' })
		);

		expect(before).toMatchObject({
			isError: true,
			data: { error: { code: 'NOT_A_MEMBER' }, state: 'failed' }
		});
		expect(retried.data).toMatchObject({ state: 'sent', replayed: false, message_id: '9500' });
		expect(after).toMatchObject({
			isError: true,
			data: {
				error: { code: 'outcome_unknown' },
				state: 'unknown',
				cause: { code: 'ABUSE_BLOCK' }
			}
		});
		for (const output of [before.text, after.text, JSON.stringify(served.logs)]) {
			expect(output).not.toContain('祕密');
			expect(output).not.toContain('SECRET-TOKEN');
		}
	});

	it('keeps a timeout unknown beside an identical message, and settles it on its own chunks', async () => {
		const sent = recorder(() => {
			throw new DOMException('The operation timed out', 'TimeoutError');
		});
		const served = withKeys(
			await serve({ negotiateE2EEPublicKey: negotiate, sendMessage: sent.handler })
		);
		const { port } = served.server;
		const { base } = served.session;
		const args = toPeer({ text: '到了', idempotency_key: 'timeout-0001' });

		const result = await callTool(port, 'send_message', args);
		// The same words from another device: the same text, other chunks.
		const secret = Buffer.from(base.e2ee.generateSharedSecret(self.privKey, peer.pubKey));
		store(
			served,
			ownSynced(
				'9601',
				base.e2ee.encryptE2EETextMessage(2, 5, secret, 2, '到了', otherMid, selfMid)
			)
		);
		const ambiguous = await callTool(port, 'send_message', args);
		store(served, ownSynced('9602', chunksOf(sent.requests[0]!)));
		const settled = await callTool(port, 'send_message', args);

		expect(result.data).toMatchObject({ state: 'unknown', cause: { code: 'upstream_timeout' } });
		expect(ambiguous.data).toMatchObject({ state: 'unknown', replayed: true });
		expect(settled.data).toMatchObject({
			state: 'sent',
			replayed: true,
			message_id: '9602',
			reconciled_by: 'synced_chunks'
		});
		expect(count(served, 'sendMessage')).toBe(1);
	});

	it('is not sent when the retry after a refresh is told to refresh again', async () => {
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			negotiateE2EEPublicKey: plainNegotiation,
			// TalkException MUST_REFRESH_V3_TOKEN, before and after the refresh.
			sendMessage: () => thriftError('sendMessage', 119),
			refresh: refreshed
		});
		const served = withRefresh(withKeys(await serve({}, undefined, { upstream })));
		const args = toPeer({ text: 'hi', idempotency_key: 'refresh-0001' });

		const result = await callTool(served.server.port, 'send_message', args);
		const retried = await callTool(served.server.port, 'send_message', args);

		expect(result).toMatchObject({
			isError: true,
			data: { state: 'unknown', replayed: false, cause: { code: 'MUST_REFRESH_V3_TOKEN' } }
		});
		expect(retried.data).toMatchObject({ state: 'unknown', replayed: true });
		expect(served.session.state()).toBe('needs_login');
		expect(served.upstream.calls).toEqual([
			'negotiateE2EEPublicKey',
			'sendMessage',
			'refresh',
			'sendMessage'
		]);
	});

	it('refreshes once after an OpenChat authentication failure, without resending or logging out', async () => {
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			// SquareException AUTHENTICATION_FAILURE.
			sendMessage: () => thriftError('sendMessage', 401),
			refresh: refreshed
		});
		const served = withRefresh(await serve({}, undefined, { upstream }));

		const result = await callTool(served.server.port, 'send_message', {
			service: 'square',
			chat_id: square,
			text: '大家好',
			idempotency_key: 'square-auth-0001'
		});

		expect(result).toMatchObject({
			isError: true,
			data: { state: 'unknown', cause: { code: 'AUTHENTICATION_FAILURE' } }
		});
		expect(served.upstream.calls).toEqual(['sendMessage', 'refresh']);
		expect(served.session.state()).toBe('online');
		expect(readAccount(served.session.db)?.authState).not.toBe('needs_login');
	});

	it('fails, not unknown, when LINEJS cannot build the request', async () => {
		const upstream = fakeHttpUpstream({
			getProfile: profileReply,
			negotiateE2EEPublicKey: plainNegotiation
		});
		const served = withKeys(await serve({}, undefined, { upstream }));
		const { thrift } = served.session.base;
		const write = thrift.writeThrift.bind(thrift);
		thrift.writeThrift = (...args) => {
			if (args[1] === 'sendMessage') throw new TypeError('Cannot write field 2');
			return write(...args);
		};

		const result = await callTool(
			served.server.port,
			'send_message',
			toPeer({ text: 'hi', idempotency_key: 'build-0001' })
		);

		expect(result).toMatchObject({
			isError: true,
			data: { state: 'failed', error: { code: 'internal_error' } }
		});
		expect(served.upstream.calls).toEqual(['negotiateE2EEPublicKey']);
	});
});

describe('cancellation', () => {
	it('sends once when the first answer is lost and the call is retried with its key', async () => {
		const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
		const { promise: answer, resolve: release } = Promise.withResolvers<void>();
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: negotiate,
				sendMessage: async () => {
					reach();
					await answer;
					return { id: '9700' };
				}
			})
		);
		const { port } = served.server;
		const args = toPeer({ text: '收到', idempotency_key: 'lost-0001' });

		callAndDrop(port, 'send_message', args, reached);
		await until(
			() => served.logs.some((entry) => entry.code === 'outcome_unknown'),
			'the dropped call'
		);
		release();
		const retried = await callTool(port, 'send_message', args);

		expect(retried.data).toMatchObject({ state: 'sent', replayed: true, message_id: '9700' });
		expect(count(served, 'sendMessage')).toBe(1);
	});

	it('leaves unknown after dispatch and failed before it, and never sends a dropped call', async () => {
		const { promise: dispatched, resolve: dispatch } = Promise.withResolvers<void>();
		const { promise: preparing, resolve: prepare } = Promise.withResolvers<void>();
		const { promise: gate, resolve: open } = Promise.withResolvers<void>();
		let gated = true;
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: async (value, base) => {
					if (field(value, 2) === selfMid && gated) {
						prepare();
						await gate;
					}
					return negotiate(value, base);
				},
				sendMessage: async (value) => {
					if (field(value, 2, 2) === otherMid) {
						dispatch();
						await gate;
						throw new TypeError('fetch failed');
					}
					return { id: '9800' };
				}
			})
		);
		const { port } = served.server;
		const late = toPeer({ text: 'late', idempotency_key: 'cancel-0001' });
		const early = {
			service: 'talk',
			chat_id: selfMid,
			text: 'early',
			idempotency_key: 'cancel-0002'
		};

		callAndDrop(port, 'send_message', late, dispatched);
		callAndDrop(port, 'send_message', early, preparing);
		await until(
			() =>
				served.logs.some((entry) => entry.code === 'outcome_unknown') &&
				served.logs.some((entry) => entry.code === 'cancelled'),
			'both dropped calls'
		);
		gated = false;
		open();
		const afterDispatch = await callTool(port, 'send_message', late);
		const beforeDispatch = await callTool(port, 'send_message', early);

		expect(afterDispatch.data).toMatchObject({ state: 'unknown', replayed: true });
		expect(beforeDispatch.data).toMatchObject({
			state: 'sent',
			replayed: false,
			message_id: '9800'
		});
		// The late call went out once; the early one only on its retry.
		expect(count(served, 'sendMessage')).toBe(2);
	});
});

describe('OpenChat media', () => {
	it('sends an image as the upload LINE creates the message from; an unanswered upload is unknown', async () => {
		const uploads: { path: string; params: Record<string, string> }[] = [];
		const served = await serve({}, async (request) => {
			const params = JSON.parse(
				Buffer.from(request.headers.get('x-obs-params') ?? '', 'base64').toString()
			) as Record<string, string>;
			uploads.push({ path: new URL(request.url).pathname, params });
			// The second upload's answer names no object: LINE may still have created it.
			return new Response(null, {
				headers: uploads.length === 1 ? { 'x-obs-oid': 'obj-9' } : {}
			});
		});
		const image = join(served.root, 'photo.jpg');
		writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
		const send = (key: string) =>
			callTool(served.server.port, 'send_message', {
				service: 'square',
				chat_id: square,
				file_path: image,
				idempotency_key: key
			});

		const sent = await send('square-image-0001');
		const unanswered = await send('square-image-0002');

		expect(sent.data).toMatchObject({ state: 'sent', e2ee: false, message_id: null });
		expect(uploads[0]).toMatchObject({
			path: expect.stringMatching(/^\/+r\/g2\/m\/reqseq$/),
			params: { type: 'image', oid: 'reqseq', tomid: square, cat: 'original', name: 'photo.jpg' }
		});
		expect(unanswered.data).toMatchObject({ state: 'unknown', cause: { code: 'upload_failed' } });
		expect(uploads).toHaveLength(2);
	});
});

/** An OpenChat unsend as sync applies it, without the message's thread. */
const squareUnsend = (messageId: string) =>
	({ kind: 'unsend', service: 'square', chatId: square, messageId }) as const;

describe('OpenChat threads', () => {
	it('replies, reacts and unsends in a thread with threadMid, never in the parent chat', async () => {
		const threaded = recorder(() => ({ createdThreadMessage: { message: { id: '8001' } } }));
		const chat = recorder(() => ({ createdSquareMessage: { message: { id: '8002' } } }));
		const reacted = recorder(() => ({}));
		const unsent = recorder(() => ({}));
		const served = await serve(
			{
				sendSquareThreadMessage: threaded.handler,
				sendMessage: chat.handler,
				reactToMessage: reacted.handler,
				unsendMessage: unsent.handler
			},
			async () => {
				throw new Error('no upload may happen');
			}
		);
		const { port } = served.server;
		const inSquare = { service: 'square' as const, chatId: square, chatType: 'square' };
		store(
			served,
			row({ ...inSquare, messageId: '700', threadId: thread, sender: member }),
			row({ ...inSquare, messageId: '701', sender: member })
		);
		const image = join(served.root, 'photo.png');
		writeFileSync(
			image,
			Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(8)])
		);
		const call = (name: string, args: object) =>
			callTool(port, name, { service: 'square', chat_id: square, ...args });

		const reply = await call('send_message', {
			text: '+1',
			reply_to: '700',
			idempotency_key: 'thread-0001'
		});
		const inChat = await call('send_message', {
			text: '+1',
			reply_to: '701',
			idempotency_key: 'thread-0002'
		});
		const reaction = await call('react', {
			message_id: '700',
			reaction: 'fun',
			idempotency_key: 'thread-0003'
		});
		// Sync has not delivered the reply yet; the outbox knows its thread.
		const unsend = await call('unsend', { message_id: '8001', idempotency_key: 'thread-0004' });
		const media = await call('send_message', {
			file_path: image,
			thread_id: thread,
			idempotency_key: 'thread-0005'
		});
		const mediaReply = await call('send_message', {
			file_path: image,
			reply_to: '700',
			idempotency_key: 'thread-0006'
		});
		const unknownTarget = await call('react', {
			message_id: '799',
			reaction: 'fun',
			idempotency_key: 'thread-0007'
		});

		expect(reply.data).toMatchObject({ state: 'sent', message_id: '8001' });
		const threadRequest = field(threaded.requests[0], 1);
		expect([field(threadRequest, 2), field(threadRequest, 3)]).toEqual([square, thread]);
		expect(field(threadRequest, 4, 1, 21)).toBe('700');
		expect(inChat.data).toMatchObject({ state: 'sent', message_id: '8002' });
		expect(field(chat.requests[0], 1, 2)).toBe(square);
		expect(reaction.data).toMatchObject({ state: 'sent' });
		expect(field(reacted.requests[0], 1, 5)).toBe(thread);
		expect(unsend.data).toMatchObject({ state: 'sent' });
		expect([field(unsent.requests[0], 1, 3), field(unsent.requests[0], 1, 4)]).toEqual([
			'8001',
			thread
		]);
		for (const refused of [media, mediaReply]) {
			expect(refused).toMatchObject({
				isError: true,
				data: { error: { code: 'unsupported_action' } }
			});
		}
		expect(unknownTarget).toMatchObject({ isError: true, data: { error: { code: 'not_found' } } });
		expect([threaded.requests.length, chat.requests.length]).toEqual([1, 1]);
	});

	it('keeps an unsend in its thread when a tombstone without the thread arrives first', async () => {
		const unsent = recorder(() => ({}));
		const served = await serve({
			sendSquareThreadMessage: () => ({ createdThreadMessage: { message: { id: '8001' } } }),
			unsendMessage: unsent.handler
		});
		const call = (name: string, args: object) =>
			callTool(served.server.port, name, { service: 'square', chat_id: square, ...args });
		const undo = { message_id: '8001', idempotency_key: 'tombstone-0002' };

		await call('send_message', {
			text: '+1',
			thread_id: thread,
			idempotency_key: 'tombstone-0001'
		});
		const first = await call('unsend', undo);
		// Sync learns of both unsends before it ever saw either message.
		const { db } = served.session;
		transaction(db, () => applyChanges(db, [squareUnsend('8001'), squareUnsend('8009')]));
		const replayed = await call('unsend', undo);
		const fresh = await call('unsend', { message_id: '8001', idempotency_key: 'tombstone-0003' });
		const stranger = await call('unsend', {
			message_id: '8009',
			idempotency_key: 'tombstone-0004'
		});

		expect(first.data).toMatchObject({ state: 'sent', replayed: false });
		expect(replayed.data).toMatchObject({ state: 'sent', replayed: true });
		expect(fresh.data).toMatchObject({ state: 'sent', replayed: false });
		expect(unsent.requests.map((request) => field(request, 1, 4))).toEqual([thread, thread]);
		expect(stranger).toMatchObject({ isError: true, data: { error: { code: 'not_found' } } });
		expect(unsent.requests).toHaveLength(2);
	});
});

const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** Starts the crash fixture; `line` waits for a line of its output. */
function crashFixture(root: string, lockPort: number, mode: 'before' | 'after') {
	const path = fileURLToPath(new URL('./fixtures/send-crash.ts', import.meta.url));
	const child = spawn(process.execPath, [path, root, String(lockPort), mode], {
		stdio: ['ignore', 'pipe', 'inherit']
	});
	children.push(child);
	const lines: string[] = [];
	let partial = '';
	child.stdout!.on('data', (chunk: Buffer) => {
		const parts = (partial + chunk.toString()).split('\n');
		partial = parts.pop()!;
		lines.push(...parts);
	});
	// 10 s like serving() in cli.test.ts: the first line waits for a cold start of the server.
	const line = async (pattern: RegExp) => {
		await until(
			() => lines.some((entry) => pattern.test(entry)),
			`fixture line ${pattern}`,
			10_000
		);
		return lines.find((entry) => pattern.test(entry))!;
	};
	return { child, line };
}

// The timeout covers the fixture's 10 s start deadline plus the retry.
describe('crash', { timeout: 15_000 }, () => {
	it.each([
		['after', { state: 'unknown', replayed: true, cause: { code: 'interrupted' } }, 0],
		['before', { state: 'sent', replayed: false, message_id: '9900' }, 1]
	] as const)(
		'resends nothing after a crash %s the upstream call',
		async (mode, expected, sends) => {
			const root = tempRoot();
			seedLive(root, selfMid, { authToken: 'token', ...keyRows });
			const fixture = crashFixture(root, await freePort(), mode);
			const port = Number((await fixture.line(/^listening \d+$/)).split(' ')[1]);
			const args = toPeer({ text: '當機', idempotency_key: `crash-${mode}` });
			callAndDrop(port, 'send_message', args, new Promise(() => {}));
			await fixture.line(mode === 'after' ? /^dispatched$/ : /^preparing$/);
			const exited = once(fixture.child, 'exit');
			fixture.child.kill('SIGKILL');
			await exited;

			const served = await serve(
				{ negotiateE2EEPublicKey: negotiate, sendMessage: () => ({ id: '9900' }) },
				undefined,
				{ root }
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(count(served, 'sendMessage')).toBe(0);
			const retried = await callTool(served.server.port, 'send_message', args);

			expect(retried.data).toMatchObject(expected);
			expect(count(served, 'sendMessage')).toBe(sends);
		}
	);
});

/** `line-mcp send-message` to the peer with `extra` flags. */
const sendToPeer = (extra: string[]) => [
	'send-message',
	'--service',
	'talk',
	'--chat-id',
	otherMid,
	...extra
];

// Each CLI run loads the whole server on a cold start.
describe('CLI', { timeout: 30_000 }, () => {
	it('sends once when the first CLI is killed after dispatch and the retry uses the same key', async () => {
		const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
		const { promise: answer, resolve: release } = Promise.withResolvers<void>();
		const served = withKeys(
			await serve({
				negotiateE2EEPublicKey: negotiate,
				sendMessage: async () => {
					reach();
					await answer;
					return { id: '9990' };
				}
			})
		);
		const send = sendToPeer(['--idempotency-key', 'cli-retry-0001', '--text', '從終端機送出']);

		const first = startCli(served.server.port, send);
		await within(10_000, reached, 'the first CLI call');
		first.child.kill('SIGKILL');
		await first.done;
		release();
		const second = await runCli(served.server.port, send);

		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({
			state: 'sent',
			replayed: true,
			message_id: '9990'
		});
		expect(count(served, 'sendMessage')).toBe(1);
	});

	it('sends a file named relative to the current directory', async () => {
		const served = withKeys(
			await serve(
				{ negotiateE2EEPublicKey: negotiate, sendMessage: () => ({ id: '9991' }) },
				async () => new Response(null, { headers: { 'x-obs-oid': 'obj-2' } })
			)
		);
		const image = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 3)]);
		writeFileSync(join(served.root, 'photo.png'), image);

		const run = await runCli(
			served.server.port,
			sendToPeer(['--idempotency-key', 'cli-file-0001', '--file-path', 'photo.png']),
			served.root
		);

		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ state: 'sent', message_id: '9991' });
	});
});

/** The creator's side of LINEJS's group key unwrap (base/e2ee/mod.ts:291-355). */
/** The inverse of `wrapGroupKey`: what a member does with its copy of a group key. */
function unwrapGroupKey(
	base: BaseClient,
	wrapped: Buffer,
	receiverPrivate: Buffer,
	creatorPublic: Buffer
): Buffer {
	const shared = Buffer.from(base.e2ee.generateSharedSecret(receiverPrivate, creatorPublic));
	const decipher = createDecipheriv(
		'aes-256-cbc',
		base.e2ee.getSHA256Sum(shared, 'Key'),
		base.e2ee.xor(base.e2ee.getSHA256Sum(shared, 'IV'))
	);
	return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}

function wrapGroupKey(
	base: BaseClient,
	groupPrivate: Buffer,
	creatorPrivate: Buffer,
	receiverPublic: Buffer
): Buffer {
	const shared = Buffer.from(base.e2ee.generateSharedSecret(creatorPrivate, receiverPublic));
	const cipher = createCipheriv(
		'aes-256-cbc',
		base.e2ee.getSHA256Sum(shared, 'Key'),
		base.e2ee.xor(base.e2ee.getSHA256Sum(shared, 'IV'))
	);
	return Buffer.concat([cipher.update(groupPrivate), cipher.final()]);
}
