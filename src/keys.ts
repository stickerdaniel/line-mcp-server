import { Buffer } from 'node:buffer';
import { type BaseClient, InternalError } from '@evex/linejs/base';
import { enums, type Message } from '@evex/linejs-types';
import { LineMcpError, upstreamCode } from './errors.ts';
import { allowGroupKeyRegistration, type Log } from './session.ts';

export type DecryptResult =
	| { state: 'ok'; payload: Record<string, unknown> | undefined }
	| { state: 'missing_key'; missing: 'self_key' | 'peer_key' | 'group_key' }
	| { state: 'invalid' };

type Missing = Extract<DecryptResult, { state: 'missing_key' }>;

/**
 * Decrypts an E2EE message only with the exact key generations its envelope
 * names. LINEJS substitutes another self key for a missing DM key
 * (base/e2ee/mod.ts:903-906) and the latest group key for a missing group
 * generation (base/e2ee/mod.ts:209-226); both then fail as a generic
 * authentication error. Checking first keeps `invalid` for messages whose
 * keys were verified present. A plain message is `ok` with no payload.
 */
export async function decryptMessage(
	base: BaseClient,
	selfMid: string,
	message: Message
): Promise<DecryptResult> {
	if (!message.chunks?.length) return { state: 'ok', payload: undefined };
	const chunks = message.chunks.map((chunk) =>
		typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk)
	);
	if (chunks.length < 5) return { state: 'invalid' };
	const senderKeyId = keyId(chunks[3]!);
	const receiverKeyId = keyId(chunks[4]!);
	const fromSelf = message.from === selfMid;

	let privateKey: Buffer;
	let publicKey: Buffer;
	if (message.toType === 'USER' || message.toType === enums.MIDType.USER) {
		const self = await selfKey(base, fromSelf ? senderKeyId : receiverKeyId);
		if (!self) return missing('self_key');
		const peer = await exactPublicKey(
			base,
			selfMid,
			fromSelf ? message.to : message.from,
			fromSelf ? receiverKeyId : senderKeyId
		);
		if ('state' in peer) return peer;
		privateKey = Buffer.from(self.privKey, 'base64');
		publicKey = peer;
	} else {
		const group = await groupKey(base, selfMid, message.to, receiverKeyId);
		if ('missing' in group) return group;
		const sender = await exactPublicKey(base, selfMid, message.from, senderKeyId);
		if ('state' in sender) return sender;
		privateKey = group.privateKey;
		publicKey = sender;
	}

	try {
		const payload: unknown =
			(message.contentMetadata?.e2eeVersion || '2') === '2'
				? base.e2ee.decryptE2EEMessageV2(
						message.to,
						message.from,
						chunks,
						privateKey,
						publicKey,
						2,
						contentTypeNumber(message.contentType)
					)
				: base.e2ee.decryptE2EEMessageV1(chunks, privateKey, publicKey);
		if (typeof payload !== 'object' || payload === null) return { state: 'invalid' };
		return { state: 'ok', payload: payload as Record<string, unknown> };
	} catch {
		return { state: 'invalid' };
	}
}

function missing(key: Missing['missing']): Missing {
	return { state: 'missing_key', missing: key };
}

/** Unsigned big-endian, as LINEJS reads the key ids in chunks 3 and 4. */
function keyId(chunk: Buffer): number {
	let value = 0;
	for (const byte of chunk) value = value * 256 + byte;
	return value;
}

function contentTypeNumber(contentType: Message['contentType']): number {
	return typeof contentType === 'number' ? contentType : (enums.ContentType[contentType] ?? 0);
}

async function selfKey(
	base: BaseClient,
	id: number
): Promise<{ privKey: string; pubKey: string } | undefined> {
	const key = (await base.e2ee.getE2EESelfKeyDataByKeyId(id)) as
		{ privKey?: unknown; pubKey?: unknown } | undefined;
	if (typeof key?.privKey !== 'string' || typeof key.pubKey !== 'string') return undefined;
	return { privKey: key.privKey, pubKey: key.pubKey };
}

/**
 * The public key of exactly this generation. Own MIDs use the local self key;
 * other MIDs use the per-generation cache, then the generation-specific
 * `getE2EEPublicKey` lookup (keyVersion 1, as the beeper LINE bridge calls it).
 * LINEJS asks `negotiateE2EEPublicKey`, which knows only the current key, so
 * older generations would look missing. A found key is cached under the key
 * LINEJS reads, so its group key unwrap finds the creator key as well.
 */
async function exactPublicKey(
	base: BaseClient,
	selfMid: string,
	mid: string,
	id: number
): Promise<Buffer | Missing> {
	const cacheKey = `e2eePublicKeys:${mid}:${id}`;
	if (mid === selfMid) {
		const self = await selfKey(base, id);
		if (!self) return missing('self_key');
		await base.storage.set(cacheKey, self.pubKey);
		return Buffer.from(self.pubKey, 'base64');
	}
	const cached = await base.storage.get(cacheKey);
	if (typeof cached === 'string') return Buffer.from(cached, 'base64');
	let key;
	try {
		key = await base.talk.getE2EEPublicKey({ mid, keyVersion: 1, keyId: id });
	} catch (error) {
		if (error instanceof InternalError && error.data.code === 'NOT_FOUND') {
			return missing('peer_key');
		}
		throw error;
	}
	if (Number(key?.keyId) !== id || !key.keyData) return missing('peer_key');
	const data = Buffer.from(key.keyData);
	await base.storage.set(cacheKey, data.toString('base64'));
	return data;
}

export async function groupKey(
	base: BaseClient,
	selfMid: string,
	chatMid: string,
	id: number
): Promise<{ privateKey: Buffer } | Missing> {
	const cached = await base.storage.get(`e2eeGroupKeys:${chatMid}:${id}`);
	if (typeof cached === 'string') {
		const key = JSON.parse(cached) as { privKey: string; keyId: unknown };
		if (Number(key.keyId) === id) return { privateKey: Buffer.from(key.privKey, 'base64') };
	}
	// Ask for this generation first: on NOT_FOUND LINEJS would fall back to the
	// latest key. The lookup below then fetches it once more to unwrap and cache.
	let shared;
	try {
		shared = await base.talk.getE2EEGroupSharedKey({ keyVersion: 2, chatMid, groupKeyId: id });
	} catch (error) {
		if (error instanceof InternalError && error.data.code === 'NOT_FOUND') {
			return missing('group_key');
		}
		throw error;
	}
	if (Number(shared.groupKeyId) !== id) return missing('group_key');
	if (!(await selfKey(base, Number(shared.receiverKeyId)))) return missing('self_key');
	const creator = await exactPublicKey(base, selfMid, shared.creator, Number(shared.creatorKeyId));
	if ('state' in creator) return creator;
	let key: { privKey: string; keyId: unknown };
	try {
		key = (await base.e2ee.getE2EELocalPublicKey(chatMid, id)) as typeof key;
	} catch (error) {
		if (error instanceof LineMcpError && error.code === 'missing_key') return missing('group_key');
		if (error instanceof InternalError && error.type === 'No E2EEKey') return missing('peer_key');
		throw error;
	}
	if (Number(key.keyId) !== id) return missing('group_key');
	return { privateKey: Buffer.from(key.privKey, 'base64') };
}

/** The group's current shared key, or undefined when it has none. */
async function lastGroupKey(base: BaseClient, chatMid: string) {
	try {
		return await base.talk.getLastE2EEGroupSharedKey({ keyVersion: 2, chatMid });
	} catch (error) {
		if (error instanceof InternalError && error.data.code === 'NOT_FOUND') return undefined;
		throw error;
	}
}

/** The keys of one outgoing E2EE message, as LINEJS's `encryptE2EEMessage` derives them. */
export interface SendingKeys {
	senderKeyId: number;
	receiverKeyId: number;
	/** The ECDH secret the message key is derived from. */
	keyData: Buffer;
	specVersion: number;
}

/**
 * The keys LINEJS's `encryptE2EEMessage` uses for a Talk message to `to`
 * (base/e2ee/mod.ts:636-682), or null when a one-to-one peer does not support
 * E2EE. A DM pairs the own key with the peer key LINE negotiates. A group or
 * room uses its current shared key, unwrapped with exactly the generations it
 * names. A group without one gets a new key, registered as LINEJS does
 * (base/e2ee/mod.ts:356-409); that is the only registration line-mcp performs
 * (architecture, E2EE key boundaries). Only the send path calls this.
 */
export async function sendingKeys(
	base: BaseClient,
	selfMid: string,
	to: string,
	log: Log
): Promise<SendingKeys | null> {
	let self: { keyId?: unknown; privKey?: unknown; pubKey?: unknown } | undefined;
	try {
		self = (await base.e2ee.getE2EESelfKeyData(selfMid)) as typeof self;
	} catch (error) {
		if (!(error instanceof InternalError && error.type === 'NoE2EEKey')) throw error;
	}
	if (
		typeof self?.privKey !== 'string' ||
		typeof self.pubKey !== 'string' ||
		!Number.isSafeInteger(Number(self.keyId))
	) {
		throw new LineMcpError('missing_key', 'No own E2EE key is stored for sending');
	}
	const senderKeyId = Number(self.keyId);
	if (to.startsWith('u')) {
		const negotiated = await base.talk.negotiateE2EEPublicKey({ mid: to });
		if (Number(negotiated?.specVersion) === -1) return null;
		const peer = negotiated?.publicKey;
		if (!peer?.keyData || !Number.isSafeInteger(Number(peer.keyId))) {
			throw new LineMcpError('missing_key', 'LINE returned no public key for this contact');
		}
		return {
			senderKeyId,
			receiverKeyId: Number(peer.keyId),
			keyData: Buffer.from(
				base.e2ee.generateSharedSecret(
					Buffer.from(self.privKey, 'base64'),
					Buffer.from(peer.keyData)
				)
			),
			specVersion: Number(negotiated.specVersion)
		};
	}
	let shared = await lastGroupKey(base, to);
	if (!shared) {
		try {
			shared = await allowGroupKeyRegistration(() => base.e2ee.tryRegisterE2EEGroupKey(to));
			log({ event: 'group_key_registered', chat_id: to });
		} catch (error) {
			// Another member may have registered one meanwhile. LINE documents no
			// code for that, so any refusal gets one more lookup; a key found
			// there is the group's current key.
			if (!(error instanceof InternalError && upstreamCode(error.data))) throw error;
			shared = await lastGroupKey(base, to);
			if (!shared) throw error;
		}
	}
	const groupKeyId = Number(shared?.groupKeyId);
	const group = Number.isSafeInteger(groupKeyId)
		? await groupKey(base, selfMid, to, groupKeyId)
		: missing('group_key');
	if ('missing' in group) {
		throw new LineMcpError(
			'missing_key',
			`The keys of this group are not available (${group.missing})`
		);
	}
	return {
		senderKeyId,
		receiverKeyId: groupKeyId,
		keyData: Buffer.from(
			base.e2ee.generateSharedSecret(group.privateKey, Buffer.from(self.pubKey, 'base64'))
		),
		specVersion: 2
	};
}
