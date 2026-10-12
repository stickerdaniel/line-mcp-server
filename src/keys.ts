import { Buffer } from 'node:buffer';
import { type BaseClient, InternalError } from '@evex/linejs/base';
import { enums, type Message } from '@evex/linejs-types';
import { LineMcpError } from './errors.ts';

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

async function groupKey(
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
