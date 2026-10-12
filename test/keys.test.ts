import { Buffer } from 'node:buffer';
import { createCipheriv } from 'node:crypto';
import { BaseClient } from '@evex/linejs/base';
import type { Message } from '@evex/linejs-types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.ts';
import { decryptMessage } from '../src/keys.ts';
import { SqliteStorage } from '../src/storage.ts';
import {
	fakeUpstream,
	groupMid,
	type Handler,
	type KeyPair,
	keyPair,
	otherMid,
	selfMid,
	storedKey,
	tempRoot
} from './fake-line.ts';

function envelope(from: string, to: string, chunks: Buffer[]): Message {
	return {
		from,
		to,
		toType: to === groupMid ? 'GROUP' : 'USER',
		id: '1',
		contentType: 'NONE',
		contentMetadata: { e2eeVersion: '2' },
		chunks
	} as unknown as Message;
}

/** A client on fresh storage whose upstream answers only `handlers`. */
function client(handlers: Record<string, Handler> = {}) {
	const storage = new SqliteStorage(openDatabase(tempRoot()));
	const upstream = fakeUpstream(handlers);
	return { storage, base: upstream.createClient(storage), calls: upstream.calls };
}

/** Encrypts text from `sender` to the receiver key generation `receiverId`. */
function encrypt(
	base: BaseClient,
	sender: KeyPair,
	receiverPublic: Buffer,
	receiverId: number,
	to: string,
	from: string
): Buffer[] {
	const shared = Buffer.from(base.e2ee.generateSharedSecret(sender.privKey, receiverPublic));
	return base.e2ee.encryptE2EETextMessage(
		sender.keyId,
		receiverId,
		shared,
		2,
		'你好 hello',
		to,
		from
	);
}

const decrypted = { state: 'ok', payload: { text: '你好 hello' } };

describe('E2EE key generations', () => {
	it('marks a DM missing_key while its self key generation is absent, then decrypts it', async () => {
		const { storage, base } = client();
		const oldSelf = keyPair(1);
		const currentSelf = keyPair(2);
		const peer = keyPair(5);
		storage.setSync('e2eeKeys:1', storedKey(oldSelf));
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		// The peer encrypts to generation 2, which this device does not have yet.
		const message = envelope(
			otherMid,
			selfMid,
			encrypt(base, peer, currentSelf.pubKey, 2, selfMid, otherMid)
		);

		expect(await decryptMessage(base, selfMid, message)).toEqual({
			state: 'missing_key',
			missing: 'self_key'
		});

		storage.setSync('e2eeKeys:2', storedKey(currentSelf));
		expect(await decryptMessage(base, selfMid, message)).toEqual(decrypted);
	});

	it('decrypts an own-chat message under an older self key without asking LINE', async () => {
		const { storage, base, calls } = client();
		const old = keyPair(1);
		storage.setSync('e2eeKeys:1', storedKey(old));
		storage.setSync('e2eeKeys:2', storedKey(keyPair(2)));
		const message = envelope(selfMid, selfMid, encrypt(base, old, old.pubKey, 1, selfMid, selfMid));

		expect(await decryptMessage(base, selfMid, message)).toEqual(decrypted);
		expect(calls).toEqual([]);
	});

	it("looks up a contact's older public key generation by its id", async () => {
		const self = keyPair(1);
		const old = keyPair(5);
		const { storage, base, calls } = client({
			getE2EEPublicKey: () => ({ version: 1, keyId: 5, keyData: old.pubKey }),
			negotiateE2EEPublicKey: () => ({ specVersion: 2, publicKey: keyPair(6) })
		});
		storage.setSync('e2eeKeys:1', storedKey(self));
		const message = envelope(
			otherMid,
			selfMid,
			encrypt(base, old, self.pubKey, 1, selfMid, otherMid)
		);

		expect(await decryptMessage(base, selfMid, message)).toEqual(decrypted);
		expect(await decryptMessage(base, selfMid, message)).toEqual(decrypted);
		expect(calls).toEqual(['getE2EEPublicKey']);
	});

	it('unwraps a group key whose creator used an older public key generation', async () => {
		const self = keyPair(1);
		const creator = keyPair(5);
		const group = keyPair(9);
		const { storage, base } = client({
			getE2EEGroupSharedKey: () => ({
				keyVersion: 2,
				groupKeyId: 9,
				creator: otherMid,
				creatorKeyId: 5,
				receiver: selfMid,
				receiverKeyId: 1,
				encryptedSharedKey: wrapGroupKey(base, group.privKey, creator.privKey, self.pubKey)
			}),
			getE2EEPublicKey: () => ({ version: 1, keyId: 5, keyData: creator.pubKey }),
			negotiateE2EEPublicKey: () => ({ specVersion: 2, publicKey: keyPair(6) })
		});
		storage.setSync('e2eeKeys:1', storedKey(self));
		const message = envelope(
			otherMid,
			groupMid,
			encrypt(base, creator, group.pubKey, 9, groupMid, otherMid)
		);

		expect(await decryptMessage(base, selfMid, message)).toEqual(decrypted);
	});
});

/** The creator's side of LINEJS's group key unwrap (base/e2ee/mod.ts:291-355). */
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
