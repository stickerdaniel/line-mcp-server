import type { DatabaseSync } from 'node:sqlite';
import type { BaseClient } from '@evex/linejs/base';
import type { Message, SquareEvent } from '@evex/linejs-types';
import { describe, expect, it } from 'vitest';
import { openDatabase, transaction } from '../src/db.ts';
import {
	applyChanges,
	type Change,
	normalizeOperations,
	normalizeSquareEvents
} from '../src/sync/normalize.ts';
import {
	dropNonTextColumns,
	groupMid,
	nonTextColumns,
	otherMid,
	seedLive,
	selfMid,
	tempRoot
} from './fake-line.ts';
import { callTool, query, type Served, serve } from './mcp-client.ts';
import { squareChat, squareEvent, squareMember } from './sync-fixture.ts';

// Non-text messages as LINE delivers them: the metadata keys are the ones
// archived envelopes carry, the values are synthetic.

const mid = (prefix: string, index: number) => `${prefix}${String(index).padStart(32, '0')}`;
const newcomer = mid('u', 1);
const invitee = mid('u', 2);
const unnamed = mid('u', 3);
const sep = '\u001e';
const list = '\u001f';
const base = 1_800_000_000_000;

/** Values a result must never carry: URLs, storage IDs and the Flex document. */
const hidden = {
	PREVIEW_URL: 'https://obs.example/preview-hidden-1',
	DOWNLOAD_URL: 'https://obs.example/download-hidden-2',
	OID: 'oid-hidden-3',
	SID: 'emi-hidden-4',
	FLEX_JSON: '{"type":"bubble","body":"flex-hidden-5"}',
	MEDIA_CONTENT_INFO: '{"category":"original","fileSize":"media-hidden-6"}'
};

let at = 0;
/** A plain incoming group message, as `talk.sync` delivers it. */
function talk(
	id: string,
	contentType: string,
	contentMetadata: Record<string, string>,
	text?: string
): Message {
	at += 1000;
	return {
		from: otherMid,
		to: groupMid,
		toType: 'GROUP',
		id,
		createdTime: base + at,
		contentType,
		contentMetadata,
		...(text ? { text } : {})
	} as Message;
}

async function deliver({ session }: Served, ...messages: Message[]): Promise<void> {
	const batch = await normalizeOperations(
		{ base: session.base, selfMid },
		messages.map((message, index) => ({
			revision: index + 1,
			type: 'RECEIVE_MESSAGE',
			message,
			createdTime: message.createdTime
		})) as Parameters<typeof normalizeOperations>[1]
	);
	apply(session.db, ...batch.changes);
}

function apply(db: Served['session']['db'], ...changes: Change[]): void {
	transaction(db, () => applyChanges(db, changes));
}

/** Messages LINE describes completely, and the columns `query` reads of them. */
function valid(): { messages: Message[]; expected: Record<string, object> } {
	return {
		messages: [
			talk('n1', 'NONE', {}, 'see you at dinner'),
			talk('s1', 'STICKER', {
				STKID: '52002734',
				STKPKGID: '11537',
				STKVER: '1',
				STKOPT: '0',
				STKTXT: '[OK]'
			}),
			talk('f1', 'FLEX', { ALT_TEXT: 'Your order shipped', FLEX_JSON: hidden.FLEX_JSON }),
			talk('i1', 'IMAGE', {
				GID: '900001',
				GSEQ: '2',
				GTOTAL: '3',
				PREVIEW_URL: hidden.PREVIEW_URL,
				DOWNLOAD_URL: hidden.DOWNLOAD_URL,
				OID: hidden.OID,
				SID: hidden.SID,
				MEDIA_CONTENT_INFO: hidden.MEDIA_CONTENT_INFO
			}),
			talk('i2', 'IMAGE', { FILE_SIZE: '2048' }),
			talk('v1', 'VIDEO', { DURATION: '20767', FILE_SIZE: '1048576' }),
			talk('a1', 'AUDIO', { DURATION: '5300', FILE_SIZE: '4096' }),
			talk('d1', 'FILE', { FILE_NAME: 'report.pdf', FILE_SIZE: '1234' }),
			talk('c1', 'CALL', {
				TYPE: 'A',
				RESULT: 'NORMAL',
				DURATION: '2000',
				CAUSE: '16',
				VERSION: 'X',
				SESSION_ID: 'session-hidden-7'
			}),
			talk('c2', 'CALL', { TYPE: 'V', RESULT: 'CANCELED', DURATION: '0' }, 'Video call'),
			talk('e1', 'CHATEVENT', { LOC_KEY: 'C_MJ', LOC_ARGS: newcomer, SKIP_BADGE_COUNT: 'true' }),
			talk('e2', 'CHATEVENT', {
				LOC_KEY: 'C_GI',
				LOC_ARGS: `${otherMid}${sep}${invitee}${list}${unnamed}`
			}),
			talk('e3', 'CHATEVENT', { LOC_KEY: 'C_MR', LOC_ARGS: `${otherMid}${sep}${newcomer}` }),
			talk('e4', 'CHATEVENT', { LOC_KEY: 'C_MR', LOC_ARGS: newcomer }),
			talk('e5', 'CHATEVENT', { LOC_KEY: 'C_PN', LOC_ARGS: `${otherMid}${sep}週末小組` }),
			talk('e6', 'CHATEVENT', { LOC_KEY: 'C_SN', LOC_ARGS: otherMid }),
			talk('e7', 'CHATEVENT', { LOC_KEY: 'C_SP' }),
			talk('e8', 'CHATEVENT', { LOC_KEY: 'C_ML', LOC_ARGS: invitee }),
			talk('e9', 'CHATEVENT', { LOC_KEY: 'C_IC', LOC_ARGS: `${otherMid}${sep}${unnamed}` }),
			talk('e10', 'CHATEVENT', { LOC_KEY: 'C_PI', LOC_ARGS: otherMid })
		],
		expected: {
			n1: { content_type: 'NONE' },
			s1: { content_type: 'STICKER', alt_text: '[OK]' },
			f1: { content_type: 'FLEX', alt_text: 'Your order shipped' },
			i1: { content_type: 'IMAGE', image_index: 2, image_total: 3 },
			i2: { content_type: 'IMAGE' },
			v1: { content_type: 'VIDEO', duration_ms: 20767 },
			a1: { content_type: 'AUDIO', duration_ms: 5300 },
			d1: { content_type: 'FILE', file_name: 'report.pdf' },
			c1: { content_type: 'CALL', duration_ms: 2000, call_type: 'audio', call_result: 'normal' },
			c2: { content_type: 'CALL', duration_ms: 0, call_type: 'video', call_result: 'canceled' },
			e1: { content_type: 'CHATEVENT', event: 'joined', event_members: newcomer },
			e2: {
				content_type: 'CHATEVENT',
				event: 'invited',
				event_by: otherMid,
				event_members: `${invitee},${unnamed}`
			},
			e3: {
				content_type: 'CHATEVENT',
				event: 'removed',
				event_by: otherMid,
				event_members: newcomer
			},
			e4: { content_type: 'CHATEVENT', event: 'removed', event_members: newcomer },
			e5: {
				content_type: 'CHATEVENT',
				event: 'renamed',
				event_by: otherMid,
				event_name: '週末小組'
			},
			e6: { content_type: 'CHATEVENT', event: 'link_join_allowed', event_by: otherMid },
			e7: { content_type: 'CHATEVENT', event: 'link_join_disabled' },
			e8: { content_type: 'CHATEVENT', event: 'left', event_members: invitee },
			e9: {
				content_type: 'CHATEVENT',
				event: 'invitation_canceled',
				event_by: otherMid,
				event_members: unnamed
			},
			e10: { content_type: 'CHATEVENT', event: 'picture_changed', event_by: otherMid }
		}
	};
}

/** Messages whose metadata is missing, malformed or unverified; each has its content type only. */
function invalid(): { messages: Message[]; expected: Record<string, object> } {
	const messages = [
		talk('x1', 'CHATEVENT', { LOC_KEY: 'C_MA', LOC_ARGS: newcomer }),
		talk('x2', 'CHATEVENT', { LOC_KEY: 'C_GI', LOC_ARGS: `${otherMid}${sep}someone` }),
		talk('x3', 'CHATEVENT', { LOC_KEY: 'C_GI', LOC_ARGS: `${otherMid}${sep}${invitee}${list}` }),
		talk('x4', 'CHATEVENT', { LOC_KEY: 'C_ML', LOC_ARGS: `${invitee}${sep}${newcomer}` }),
		talk('x5', 'CHATEVENT', { LOC_KEY: 'C_PN', LOC_ARGS: otherMid }),
		talk('x6', 'CHATEVENT', { LOC_KEY: 'C_MJ' }),
		talk('x7', 'CHATEVENT', { LOC_KEY: 'C_PI', LOC_ARGS: otherMid.toUpperCase() }),
		talk('x8', 'VIDEO', { DURATION: 'abc' }),
		talk('x9', 'AUDIO', { DURATION: '-5' }),
		talk('x10', 'VIDEO', { DURATION: '1.5' }),
		talk('x11', 'IMAGE', { GSEQ: '0', GTOTAL: '3' }),
		talk('x12', 'IMAGE', { GSEQ: '4', GTOTAL: '3' }),
		talk('x13', 'IMAGE', { GSEQ: '2' }),
		talk('x14', 'CALL', { TYPE: 'X' }),
		talk('x15', 'STICKER', { STKID: '1', STKPKGID: '2' }),
		talk('x16', 'FILE', { FILE_SIZE: '99', e2eeVersion: '2' }),
		talk('x17', 'IMAGE', { DURATION: '100', ALT_TEXT: 'not for images', FILE_NAME: 'a.png' }),
		// Names of inherited object properties are unknown codes like any other.
		talk('x18', 'CHATEVENT', { LOC_KEY: '__proto__', LOC_ARGS: newcomer }),
		talk('x19', 'CHATEVENT', { LOC_KEY: 'constructor', LOC_ARGS: newcomer }),
		talk('x20', 'CHATEVENT', { LOC_KEY: 'toString' }),
		talk('x21', 'CALL', { TYPE: '__proto__' }),
		talk('x22', 'CALL', { TYPE: 'constructor' })
	];
	return {
		messages,
		expected: Object.fromEntries(
			messages.map((message) => [message.id, { content_type: String(message.contentType) }])
		)
	};
}

/**
 * Each message of a chat as `query` reads it, by message ID: its content type
 * and the non-text columns that hold a value.
 */
async function shown(
	{ server }: Served,
	service = 'talk',
	chatId = groupMid
): Promise<Record<string, object>> {
	const rows = await query(
		server.port,
		`SELECT message_id, content_type, ${nonTextColumns.join(', ')} FROM message
		WHERE service = '${service}' AND chat_id = '${chatId}' ORDER BY id`
	);
	return Object.fromEntries(
		rows.map(({ message_id, ...fields }) => [
			String(message_id),
			Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))
		])
	);
}

/** An OpenChat message event as `fetchSquareChatEvents` returns it. */
function squareMessage(
	id: string,
	contentType: string,
	contentMetadata: Record<string, string>
): SquareEvent {
	const entry = squareEvent(id, '');
	const { message } = (
		entry.payload as unknown as { receiveMessage: { squareMessage: { message: Message } } }
	).receiveMessage.squareMessage;
	Object.assign(message, { contentType, contentMetadata, text: undefined });
	return entry;
}

/** Every string inside `value`, keys included. */
function* strings(value: unknown): Generator<string> {
	if (typeof value === 'string') yield value;
	if (typeof value !== 'object' || value === null) return;
	for (const [key, entry] of Object.entries(value)) {
		yield key;
		yield* strings(entry);
	}
}

describe('non-text messages', () => {
	it('keep what they hold in readable columns', async () => {
		const fixture = await serve();
		const { messages, expected } = valid();
		await deliver(fixture, ...messages);

		expect(await shown(fixture)).toEqual(expected);
	});

	it('leave out what LINE gave no valid value for, and anything once unsent', async () => {
		const fixture = await serve();
		const { messages, expected } = invalid();
		await deliver(
			fixture,
			...messages,
			talk('u1', 'STICKER', { STKID: '52002734', STKPKGID: '11537', STKTXT: '[Bye]' })
		);
		apply(fixture.session.db, {
			kind: 'unsend',
			service: 'talk',
			chatId: groupMid,
			messageId: 'u1'
		});

		expect(await shown(fixture)).toEqual({ ...expected, u1: { content_type: 'STICKER' } });
		expect(
			await query(fixture.server.port, 'SELECT message_id FROM message WHERE unsent = 1')
		).toEqual([{ message_id: 'u1' }]);
	});

	it('never carry chunks, URLs, storage IDs or the Flex document', async () => {
		const fixture = await serve();
		await deliver(fixture, ...valid().messages);

		const result = await callTool(fixture.server.port, 'query', { sql: 'SELECT * FROM message' });

		const shownStrings = [...strings(result.data)];
		expect(shownStrings).toContain('Your order shipped');
		for (const value of [...Object.values(hidden), 'session-hidden-7', '52002734', '900001']) {
			expect(shownStrings.filter((entry) => entry.includes(value))).toEqual([]);
		}
	});

	it('keep what OpenChat messages hold from the inner message LINE sends', async () => {
		const fixture = await serve();
		const joined = mid('p', 7);
		const batch = await normalizeSquareEvents({ base: fixture.session.base, selfMid }, [
			squareMessage('q1', 'STICKER', { STKID: '1', STKPKGID: '2', STKTXT: '讚' }),
			squareMessage('q2', 'CHATEVENT', {
				LOC_KEY: 'C_MJ',
				LOC_ARGS: `${squareMember}${list}${joined}`
			})
		]);
		apply(fixture.session.db, ...batch.changes);

		expect(await shown(fixture, 'square', squareChat)).toEqual({
			q1: { content_type: 'STICKER', alt_text: '讚' },
			q2: { content_type: 'CHATEVENT', event: 'joined', event_members: `${squareMember},${joined}` }
		});
	});
});

/** One archived message's envelope and stored fields. */
const stored = (db: DatabaseSync, messageId: string) =>
	db
		.prepare(`SELECT envelope, ${nonTextColumns.join(', ')} FROM message WHERE message_id = ?`)
		.get(messageId);

const noFields = Object.fromEntries(nonTextColumns.map((column) => [column, null]));

describe('stored non-text fields', () => {
	it('come from the retained envelopes when an archive of schema 8 migrates', async () => {
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token' });
		const db = openDatabase(root);
		const { messages, expected } = valid();
		const kept = messages.filter((message) =>
			['s1', 'f1', 'i1', 'd1', 'v1', 'c1', 'e2', 'e6'].includes(String(message.id))
		);
		const invalidEvent = invalid().messages[1]!;
		const unsent = talk('u1', 'STICKER', { STKTXT: '[Bye]' });
		// Plain messages: only E2EE chunks would reach the client.
		const batch = await normalizeOperations(
			{ base: {} as BaseClient, selfMid },
			[...kept, invalidEvent, unsent].map((message, index) => ({
				revision: index + 1,
				type: 'RECEIVE_MESSAGE',
				message,
				createdTime: message.createdTime
			})) as Parameters<typeof normalizeOperations>[1]
		);
		transaction(db, () =>
			applyChanges(db, [
				...batch.changes,
				{ kind: 'unsend', service: 'talk', chatId: groupMid, messageId: 'u1' }
			])
		);
		// Schema 9 adds only these columns; without them this is schema 8.
		db.exec(`${dropNonTextColumns} PRAGMA user_version = 8`);
		db.close();

		const fixture = await serve({}, undefined, { root });

		expect(await shown(fixture)).toEqual({
			...Object.fromEntries(kept.map((message) => [message.id, expected[String(message.id)]])),
			x2: { content_type: 'CHATEVENT' },
			u1: { content_type: 'STICKER' }
		});
		expect(stored(fixture.session.db, 'u1')).toMatchObject(noFields);
	});

	it('are cleared by an unsend', async () => {
		const fixture = await serve();
		const { db } = fixture.session;
		await deliver(
			fixture,
			talk('s1', 'STICKER', { STKTXT: '[Bye]' }),
			talk('e1', 'CHATEVENT', { LOC_KEY: 'C_MJ', LOC_ARGS: newcomer })
		);
		expect(stored(db, 's1')).toMatchObject({ alt_text: '[Bye]' });
		expect(stored(db, 'e1')).toMatchObject({ event: 'joined', event_members: newcomer });

		for (const messageId of ['s1', 'e1']) {
			apply(db, { kind: 'unsend', service: 'talk', chatId: groupMid, messageId });
		}

		expect(stored(db, 's1')).toMatchObject(noFields);
		expect(stored(db, 'e1')).toMatchObject(noFields);
	});

	it('follow the envelope a late decryption writes', async () => {
		const fixture = await serve();
		const { db } = fixture.session;
		const file = talk('d1', 'FILE', { FILE_SIZE: '1234' });
		const [first] = (
			await normalizeOperations({ base: fixture.session.base, selfMid }, [
				{ revision: 1, type: 'RECEIVE_MESSAGE', message: file, createdTime: file.createdTime }
			] as Parameters<typeof normalizeOperations>[1])
		).changes as Extract<Change, { kind: 'message' }>[];
		// Archived before its key arrived, then delivered decrypted with its file name.
		apply(db, {
			kind: 'message',
			row: { ...first!.row, decryptState: 'missing_key', missingKey: 'key' }
		});
		expect(await shown(fixture)).toEqual({ d1: { content_type: 'FILE' } });

		await deliver(fixture, { ...file, contentMetadata: { FILE_NAME: 'report.pdf' } });

		expect(await shown(fixture)).toEqual({
			d1: { content_type: 'FILE', file_name: 'report.pdf' }
		});
		expect(stored(db, 'd1')).toMatchObject({ file_name: 'report.pdf' });
	});

	it('stay with the archived envelope when LINE repeats a message with other metadata', async () => {
		const fixture = await serve();
		const { db } = fixture.session;
		const sticker = talk('s1', 'STICKER', { STKTXT: '[OK]' });
		await deliver(fixture, sticker);
		const read = () => query(fixture.server.port, 'SELECT message_id, alt_text, seq FROM message');
		const before = stored(db, 's1');
		const [first] = await read();

		await deliver(fixture, { ...sticker, contentMetadata: { STKTXT: '[Changed]' } });

		expect(stored(db, 's1')).toEqual(before);
		expect(await read()).toEqual([{ ...first, alt_text: '[OK]' }]);
	});
});
