import { Buffer } from 'node:buffer';
import { BaseClient } from '@evex/linejs/base';
import type { Message } from '@evex/linejs-types';
import { describe, expect, it } from 'vitest';
import { listChanges, readMessages, searchMessages } from '../src/archive.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { SqliteStorage } from '../src/storage.ts';
import type { SyncContext } from '../src/sync/loop.ts';
import {
	applyChanges,
	type Change,
	normalizeMessage,
	retryMissingKeys
} from '../src/sync/normalize.ts';
import { keyPair, otherMid, selfMid, storedKey, tempRoot } from './fake-line.ts';
import { textMessage } from './sync-fixture.ts';

function archive(): SyncContext {
	const db = openDatabase(tempRoot());
	const base = new BaseClient({
		device: 'ANDROIDSECONDARY',
		storage: new SqliteStorage(db),
		fetch: () => Promise.reject(new Error('no network in tests'))
	});
	return { db, base, selfMid, log: () => {}, now: Date.now };
}

async function store(context: SyncContext, message: Message): Promise<void> {
	const row = await normalizeMessage(context, message, { service: 'talk' });
	transaction(context.db, () => applyChanges(context.db, [{ kind: 'message', row }]));
}

function apply(context: SyncContext, ...changes: Change[]): void {
	transaction(context.db, () => applyChanges(context.db, changes));
}

const unsend = (message: Message): Change => ({
	kind: 'unsend',
	service: 'talk',
	chatId: otherMid,
	messageId: message.id
});

describe('unsend', () => {
	it('removes the text from search, read_messages and the retained envelope', async () => {
		const context = archive();
		const message = textMessage('300000000000000001', '今天晚上吃什麼', {
			location: { title: '台北車站', latitude: 25.04, longitude: 121.51 },
			contentMetadata: { MENTION: '{"MENTIONEES":[]}', note: 'plain-metadata' }
		} as unknown as Partial<Message>);
		await store(context, message);
		expect(searchMessages(context.db, { query: '晚上吃' }).messages).toHaveLength(1);

		apply(context, unsend(message));

		expect(searchMessages(context.db, { query: '晚上吃' }).messages).toEqual([]);
		expect(searchMessages(context.db, { query: '晚上' }).messages).toEqual([]);
		const [row] = readMessages(context.db, { service: 'talk', chatId: otherMid });
		expect(row).toMatchObject({ messageId: message.id, unsent: true, text: null, mentions: null });
		const stored = context.db
			.prepare('SELECT envelope FROM message WHERE message_id = ?')
			.get(message.id) as { envelope: string };
		for (const plaintext of ['今天晚上吃什麼', '台北車站', 'plain-metadata', 'MENTIONEES']) {
			expect(stored.envelope).not.toContain(plaintext);
		}
		expect(JSON.parse(stored.envelope)).toMatchObject({ id: message.id, from: otherMid });
	});

	it('beats history that arrives after the unsend', async () => {
		const context = archive();
		const message = textMessage('300000000000000002', 'late history');
		apply(context, unsend(message));

		await store(context, message);
		await store(context, { ...message, contentMetadata: { UPDATED_TIME: '1900000000000' } });

		const rows = readMessages(context.db, { service: 'talk', chatId: otherMid });
		expect(rows.map((row) => [row.text, row.unsent])).toEqual([[null, true]]);
		expect(searchMessages(context.db, { query: 'late history' }).messages).toEqual([]);
	});

	it('beats a decryption that completes after the unsend', async () => {
		const context = archive();
		const storage = context.base.storage as SqliteStorage;
		const self = keyPair(2);
		const peer = keyPair(5);
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		const shared = Buffer.from(context.base.e2ee.generateSharedSecret(peer.privKey, self.pubKey));
		const message = {
			...textMessage('300000000000000003', ''),
			text: undefined,
			contentMetadata: { e2eeVersion: '2' },
			chunks: context.base.e2ee.encryptE2EETextMessage(5, 2, shared, 2, '秘密', selfMid, otherMid)
		} as unknown as Message;
		await store(context, message);
		expect(readMessages(context.db, { service: 'talk', chatId: otherMid })[0]).toMatchObject({
			decryptState: 'missing_key'
		});

		apply(context, unsend(message));
		storage.setSync('e2eeKeys:2', storedKey(self));
		await retryMissingKeys(context.db, context, (body) => transaction(context.db, body));
		await store(context, message);

		const [row] = readMessages(context.db, { service: 'talk', chatId: otherMid });
		expect(row).toMatchObject({ text: null, unsent: true });
		expect(searchMessages(context.db, { query: '秘密' }).messages).toEqual([]);
	});

	it('lets a newer edit replace older content but not the other way round', async () => {
		const context = archive();
		const message = textMessage('300000000000000004', 'original');
		await store(context, {
			...message,
			text: 'edited',
			contentMetadata: { UPDATED_TIME: '1800000000000' }
		});
		await store(context, message);

		expect(readMessages(context.db, { service: 'talk', chatId: otherMid })[0]?.text).toBe('edited');
	});

	it('decrypts a missing_key row once its key generation arrives', async () => {
		const context = archive();
		const storage = context.base.storage as SqliteStorage;
		const self = keyPair(2);
		const peer = keyPair(5);
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		const shared = Buffer.from(context.base.e2ee.generateSharedSecret(peer.privKey, self.pubKey));
		await store(context, {
			...textMessage('300000000000000005', ''),
			text: undefined,
			contentMetadata: { e2eeVersion: '2' },
			chunks: context.base.e2ee.encryptE2EETextMessage(5, 2, shared, 2, '你好', selfMid, otherMid)
		} as unknown as Message);

		storage.setSync('e2eeKeys:2', storedKey(self));
		await retryMissingKeys(context.db, context, (body) => transaction(context.db, body));

		expect(readMessages(context.db, { service: 'talk', chatId: otherMid })[0]).toMatchObject({
			text: '你好',
			decryptState: 'ok'
		});
	});

	it('reaches a recoverable row behind a full batch of rows that stay undecryptable', async () => {
		const context = archive();
		const storage = context.base.storage as SqliteStorage;
		const [lost, kept, peer] = [keyPair(2), keyPair(3), keyPair(5)];
		storage.setSync(`e2eePublicKeys:${otherMid}:5`, peer.pubKey.toString('base64'));
		const encrypt = (key: typeof lost, id: string, text: string) =>
			({
				...textMessage(id, ''),
				text: undefined,
				contentMetadata: { e2eeVersion: '2' },
				chunks: context.base.e2ee.encryptE2EETextMessage(
					5,
					key.keyId,
					Buffer.from(context.base.e2ee.generateSharedSecret(peer.privKey, key.pubKey)),
					2,
					text,
					selfMid,
					otherMid
				)
			}) as unknown as Message;
		await store(context, encrypt(lost, '300000000000000011', 'lost one'));
		await store(context, encrypt(lost, '300000000000000012', 'lost two'));
		await store(context, encrypt(kept, '300000000000000013', '找回來了'));

		storage.setSync('e2eeKeys:3', storedKey(kept));
		const retry = () =>
			retryMissingKeys(context.db, context, (body) => transaction(context.db, body), 2);

		expect([await retry(), await retry()]).toEqual([0, 1]);
		expect(searchMessages(context.db, { query: '找回來了' }).messages).toHaveLength(1);
		// Wrapped back to the first rows, which still have no key.
		expect(await retry()).toBe(0);
	});
});

describe('list_changes', () => {
	it('returns a row again with its new seq when it changes between pages', async () => {
		const context = archive();
		const [a, b, c] = ['400000000000000001', '400000000000000002', '400000000000000003'].map(
			(id, index) => textMessage(id, `message ${index}`)
		) as [Message, Message, Message];
		for (const message of [a, b, c]) await store(context, message);

		const page1 = listChanges(context.db, { afterSeq: 0, limit: 2 });
		await store(context, {
			...a,
			text: 'message 0, edited',
			contentMetadata: { UPDATED_TIME: '1800000000000' }
		});
		const page2 = listChanges(context.db, { afterSeq: page1.at(-1)!.seq, limit: 2 });

		expect(page1.map((row) => row.messageId)).toEqual([a.id, b.id]);
		expect(page2.map((row) => [row.messageId, row.text])).toEqual([
			[c.id, 'message 2'],
			[a.id, 'message 0, edited']
		]);
	});

	it('does not report a message again when the same content arrives twice', async () => {
		const context = archive();
		const message = textMessage('400000000000000004', 'once');
		await store(context, message);
		await store(context, message);

		expect(listChanges(context.db, { afterSeq: 0 })).toHaveLength(1);
	});
});

describe('search', () => {
	it('finds one- and two-character queries that the trigram index cannot match', async () => {
		const context = archive();
		await store(context, textMessage('500000000000000001', '今天晚上吃什麼'));
		await store(context, textMessage('500000000000000002', '明天見'));

		expect(searchMessages(context.db, { query: '晚上' })).toMatchObject({
			mode: 'scan',
			messages: [{ text: '今天晚上吃什麼' }]
		});
		expect(
			searchMessages(context.db, { query: '天', chatId: otherMid }).messages.map((m) => m.text)
		).toEqual(['明天見', '今天晚上吃什麼']);
		expect(searchMessages(context.db, { query: '晚上吃' })).toMatchObject({
			mode: 'fts',
			messages: [{ text: '今天晚上吃什麼' }]
		});
	});
});
