import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import type { BaseClient } from '@evex/linejs/base';
import { LINEStruct } from '@evex/linejs/thrift';
import type { Message } from '@evex/linejs-types';
import { z } from 'zod';
import { LineMcpError } from '../../errors.ts';
import { type SendingKeys, sendingKeys } from '../../keys.ts';
import { chunksDigest, type Payload, type Plan } from '../../outbox.ts';
import {
	chatId,
	defineTool,
	idempotencyKey,
	messageId,
	service,
	type ServedContext
} from '../tool.ts';
import { answeredId, type ChatKind, chatKind, pooled, targetMessage } from './mutation.ts';
import { maxAttachmentBytes, sniffExtension } from './upstream.ts';

/** LINE's own limit for one text message. */
const maxTextLength = 10_000;

interface Upload {
	bytes: Buffer;
	/** The name LINE shows, from the path. */
	name: string;
	/** Without the dot, as LINEJS puts it into MEDIA_CONTENT_INFO. */
	extension: string;
	kind: 'image' | 'gif' | 'file';
	mime: string;
	sha256: string;
}

const imageTypes: Record<string, { kind: Upload['kind']; mime: string }> = {
	'.jpg': { kind: 'image', mime: 'image/jpeg' },
	'.png': { kind: 'image', mime: 'image/png' },
	'.gif': { kind: 'gif', mime: 'image/gif' }
};

/**
 * Reads a local file to send. Its leading bytes decide whether it goes as an
 * image (JPEG, PNG, GIF) or as a file. Only regular files, up to the
 * attachment limit, are read.
 */
async function readUpload(path: string, limit: number): Promise<Upload> {
	if (!isAbsolute(path)) throw new LineMcpError('invalid_argument', 'file_path must be absolute');
	let bytes: Buffer;
	try {
		const file = await open(path, 'r');
		try {
			const stat = await file.stat();
			if (!stat.isFile()) throw new LineMcpError('file_error', 'file_path is not a regular file');
			if (stat.size > limit) {
				throw new LineMcpError('attachment_too_large', `The file is larger than ${limit} bytes`);
			}
			bytes = await file.readFile();
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof LineMcpError) throw error;
		throw new LineMcpError('file_error', 'The file cannot be read');
	}
	if (bytes.length === 0) throw new LineMcpError('file_error', 'The file is empty');
	if (bytes.length > limit) {
		throw new LineMcpError('attachment_too_large', `The file is larger than ${limit} bytes`);
	}
	const sniffed = sniffExtension(bytes.subarray(0, 16));
	const image = sniffed ? imageTypes[sniffed] : undefined;
	const name = basename(path);
	const extension = (sniffed ?? extname(name)).replace(/^\./, '').toLowerCase() || 'bin';
	return {
		bytes,
		name,
		extension,
		kind: image?.kind ?? 'file',
		mime: image?.mime ?? 'application/octet-stream',
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

interface Send {
	chatId: string;
	kind: ChatKind;
	threadId: string | null;
	replyTo: string | null;
	text: string | null;
	file: Upload | null;
}

type TalkFields = Pick<Message, 'contentType' | 'contentMetadata'> & {
	text?: string;
	chunks?: Buffer[];
};

/** Talk `sendMessage` as LINEJS builds it (base/service/talk/mod.ts:141-171), with our own sequence number. */
async function sendTalk(
	base: BaseClient,
	seq: number,
	to: string,
	fields: TalkFields,
	replyTo: string | null
) {
	const sent = await base.request.request<Message>(
		LINEStruct.sendMessage_args({
			seq,
			message: {
				to,
				createdTime: 0,
				deliveredTime: 0,
				hasContent: false,
				sessionId: 0,
				...fields,
				chunks: fields.chunks as never,
				...(replyTo
					? {
							relatedMessageId: replyTo,
							messageRelationType: 'REPLY',
							relatedMessageServiceCode: 'TALK'
						}
					: {})
			}
		}),
		'sendMessage',
		4,
		true,
		'/S4'
	);
	return { messageId: answeredId(sent?.id) };
}

/** An obs upload that must name the object it stored; it creates no message. */
async function upload(
	base: BaseClient,
	data: Blob,
	obsPath: string,
	params: Record<string, string>
): Promise<string> {
	const { objId } = await base.obs.uploadObjectForService({ data, oType: 'file', obsPath, params });
	if (!objId) throw new LineMcpError('upload_failed', 'LINE storage did not accept the upload');
	return objId;
}

/**
 * E2EE media as LINEJS's `uploadMediaByE2EE` sends it (base/obs/mod.ts:330-457):
 * the encrypted file (and for images its preview) is uploaded first, which
 * creates no message; only the `sendMessage` carrying its key is the action.
 */
async function planE2EEMedia(
	context: ServedContext,
	send: Send & { file: Upload },
	keys: SendingKeys
): Promise<Plan> {
	const { base, selfMid } = context;
	const { file } = send;
	if (send.kind !== 'user' && send.kind !== 'group') {
		throw new LineMcpError(
			'unsupported_action',
			'LINEJS sends E2EE media only to users and groups'
		);
	}
	// obs namespace, and the content type as a number (encryption) and a name (message).
	const [namespace, contentType, typeName] =
		file.kind === 'file' ? (['emf', 14, 'FILE'] as const) : (['emi', 1, 'IMAGE'] as const);
	const { keyMaterial, encryptedData } = await base.e2ee.encryptByKeyMaterial(file.bytes);
	const encrypted = new Blob([new Uint8Array(encryptedData)]);
	const params: Record<string, string> = {
		type: 'file',
		...(file.kind === 'gif' ? { cat: 'original' } : {})
	};
	const objectId = await upload(base, encrypted, `talk/${namespace}/reqid-${randomUUID()}`, params);
	if (file.kind !== 'file') {
		const preview = await upload(
			base,
			encrypted,
			`talk/${namespace}/${objectId}__ud-preview`,
			params
		);
		if (preview !== objectId) {
			throw new LineMcpError('upload_failed', 'LINE storage named another object for the preview');
		}
	}
	const chunks = base.e2ee.encryptE2EEMessageByData(
		keys.senderKeyId,
		keys.receiverKeyId,
		keys.keyData,
		keys.specVersion,
		{ keyMaterial, fileName: file.name },
		send.chatId,
		selfMid,
		contentType
	);
	const contentMetadata: Record<string, string> = {
		SID: namespace,
		OID: objectId,
		FILE_SIZE: String(encrypted.size),
		e2eeVersion: '2',
		...(file.kind === 'file'
			? {}
			: {
					MEDIA_CONTENT_INFO: JSON.stringify({
						category: 'original',
						fileSize: encrypted.size,
						extension: file.extension,
						animated: file.kind === 'gif'
					})
				})
	};
	const seq = await base.getReqseq('talk');
	return {
		requestSeq: seq,
		correlation: { e2ee: true, chunksSha256: chunksDigest(chunks) },
		dispatch: () =>
			sendTalk(
				base,
				seq,
				send.chatId,
				{ contentType: typeName, contentMetadata, chunks },
				send.replyTo
			)
	};
}

/**
 * Plain media the way LINEJS's `uploadObjTalk` sends it without an object ID
 * (base/obs/mod.ts:177-237): LINE creates the message from the upload itself,
 * so the upload is the action, and the message cannot carry a reply.
 */
async function planUpload(context: ServedContext, send: Send & { file: Upload }): Promise<Plan> {
	const { base } = context;
	const { file } = send;
	if (send.replyTo) {
		throw new LineMcpError(
			'unsupported_action',
			'Media LINE creates from an upload cannot be a reply; send the reply as text'
		);
	}
	const reqseq = await base.getReqseq('talk');
	const type = file.kind === 'file' ? 'file' : 'image';
	const params: Record<string, string> = {
		ver: '2.0',
		name: file.name,
		type,
		oid: 'reqseq',
		tomid: send.chatId,
		reqseq: String(reqseq),
		...(file.kind === 'file' ? {} : { cat: 'original' })
	};
	const data = new Blob([new Uint8Array(file.bytes)], { type: file.mime });
	const obsPath = `${send.kind === 'square' ? 'g2' : 'talk'}/m/reqseq`;
	return {
		requestSeq: reqseq,
		correlation: { e2ee: false },
		dispatch: async () => {
			const { objId } = await base.obs.uploadObjectForService({
				data,
				oType: type,
				obsPath,
				filename: file.name,
				params
			});
			if (!objId) throw new LineMcpError('upload_failed', 'LINE storage did not accept the upload');
			return { messageId: null, objectId: objId };
		}
	};
}

/**
 * Talk text or media, end-to-end encrypted whenever the chat is: a contact
 * whose key LINE negotiates, and every group or room. Only a contact without
 * E2EE support gets plain text, as LINEJS decides it.
 */
async function planTalk(context: ServedContext, send: Send): Promise<Plan> {
	const { base, selfMid } = context;
	const keys = await sendingKeys(base, selfMid, send.chatId, context.log);
	if (send.file) {
		const media = { ...send, file: send.file };
		return keys ? await planE2EEMedia(context, media, keys) : await planUpload(context, media);
	}
	const text = send.text!;
	let fields: TalkFields;
	let chunks: Buffer[] | undefined;
	if (keys) {
		chunks = base.e2ee.encryptE2EETextMessage(
			keys.senderKeyId,
			keys.receiverKeyId,
			keys.keyData,
			keys.specVersion,
			text,
			send.chatId,
			selfMid
		);
		fields = {
			contentType: 'NONE',
			contentMetadata: { e2eeVersion: '2', contentType: '0', e2eeMark: '2' },
			chunks
		};
	} else {
		fields = { contentType: 'NONE', contentMetadata: {}, text };
	}
	const seq = await base.getReqseq('talk');
	return {
		requestSeq: seq,
		correlation: chunks ? { e2ee: true, chunksSha256: chunksDigest(chunks) } : { e2ee: false },
		dispatch: () => sendTalk(base, seq, send.chatId, fields, send.replyTo)
	};
}

/**
 * OpenChat text: `sendMessage` in the chat, or `sendSquareThreadMessage` with
 * the thread's `threadMid` in a thread (base/service/square/mod.ts:147-186,
 * client/features/message/square.ts:502-533).
 */
async function planSquare(context: ServedContext, send: Send): Promise<Plan> {
	const { base } = context;
	if (send.file) return await planUpload(context, { ...send, file: send.file });
	const reqSeq = await base.getReqseq('sq');
	const reply = send.replyTo
		? {
				relatedMessageId: send.replyTo,
				relatedMessageServiceCode: 'SQUARE' as const,
				messageRelationType: 'REPLY' as const
			}
		: {};
	const text = send.text!;
	const threadMid = send.threadId;
	if (threadMid) {
		return {
			requestSeq: reqSeq,
			correlation: { e2ee: false },
			dispatch: async () => {
				const response = await base.square.sendSquareThreadMessage({
					request: {
						reqSeq,
						chatMid: send.chatId,
						threadMid,
						threadMessage: {
							message: {
								to: send.chatId,
								text,
								contentType: 'NONE',
								toType: 'SQUARE_THREAD',
								...reply
							}
						}
					}
				});
				return { messageId: answeredId(response?.createdThreadMessage?.message?.id) };
			}
		};
	}
	return {
		requestSeq: reqSeq,
		correlation: { e2ee: false },
		dispatch: async () => {
			const response = await base.request.request<{
				createdSquareMessage?: { message?: { id?: unknown } };
			}>(
				LINEStruct.SquareService_sendMessage_args({
					request: {
						reqSeq,
						squareChatMid: send.chatId,
						squareMessage: {
							squareMessageRevision: 4,
							message: { to: send.chatId, text, contentType: 0, contentMetadata: {}, ...reply }
						}
					}
				}),
				'sendMessage',
				4,
				true,
				'/SQ1'
			);
			return { messageId: answeredId(response?.createdSquareMessage?.message?.id) };
		}
	};
}

export const sendMessage = defineTool({
	name: 'send_message',
	description:
		'Sends a message from the connected LINE account: text, or a local image (JPEG, PNG, GIF) or file, optionally as a reply. Talk messages are end-to-end encrypted wherever the chat is. In OpenChat, a reply to a thread message goes into its thread; media cannot go into a thread or be a reply there. Needs an idempotency_key: a retry with the same key never sends twice. A result with state unknown means LINE may have sent it; check read_messages before anything else.',
	upstream: true,
	mutating: true,
	input: z.object({
		service,
		chat_id: chatId,
		idempotency_key: idempotencyKey,
		text: z
			.string()
			.min(1)
			.max(maxTextLength)
			.optional()
			.describe('Message text; give either text or file_path'),
		file_path: z
			.string()
			.min(1)
			.max(4096)
			.optional()
			.describe(
				'Absolute path of a local image (JPEG, PNG, GIF) or other file to send instead of text'
			),
		reply_to: messageId.optional().describe('Reply to this message of the chat'),
		thread_id: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe('Send into this OpenChat thread (thread_id from read_messages)')
	}),
	run: async (args, context, signal) => {
		const kind = chatKind(args.service, args.chat_id);
		if ((args.text === undefined) === (args.file_path === undefined)) {
			throw new LineMcpError('invalid_argument', 'Give exactly one of text or file_path');
		}
		if (args.thread_id !== undefined && kind !== 'square') {
			throw new LineMcpError('invalid_argument', 'Only OpenChat chats have threads');
		}
		let threadId = args.thread_id ?? null;
		if (args.reply_to) {
			const target = targetMessage(context, args.service, args.chat_id, args.reply_to);
			if (args.thread_id !== undefined && target.threadId !== args.thread_id) {
				throw new LineMcpError('invalid_argument', 'reply_to is not a message of this thread');
			}
			threadId = target.threadId;
		}
		const file = args.file_path
			? await readUpload(args.file_path, context.maxAttachmentBytes ?? maxAttachmentBytes)
			: null;
		// LINEJS has no upload into a thread; media meant for one is refused
		// rather than sent to the parent chat.
		if (file && threadId) {
			throw new LineMcpError('unsupported_action', 'Media cannot be sent into an OpenChat thread');
		}
		if (file && kind === 'square' && file.kind === 'file') {
			throw new LineMcpError(
				'unsupported_action',
				'LINEJS sends no files to OpenChat, only images'
			);
		}
		const send: Send = {
			chatId: args.chat_id,
			kind,
			threadId,
			replyTo: args.reply_to ?? null,
			text: args.text ?? null,
			file
		};
		const payload: Payload = {
			operation: 'send_message',
			service: args.service,
			chatId: args.chat_id,
			threadId,
			targetId: send.replyTo,
			text: send.text,
			reaction: null,
			attachmentSha256: file?.sha256 ?? null
		};
		return await context.outbox.execute(
			args.idempotency_key,
			payload,
			() => (kind === 'square' ? planSquare(context, send) : planTalk(context, send)),
			pooled(context, signal)
		);
	}
});
