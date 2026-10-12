import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type BaseClient, InternalError } from '@evex/linejs/base';
import type { Message } from '@evex/linejs-types';
import { z } from 'zod';
import { findMessage, readEnvelope, type Service } from '../../archive.ts';
import { LineMcpError } from '../../errors.ts';
import { decryptMessage } from '../../keys.ts';
import { decimal } from '../../probe.ts';
import { describeMessage, findChat, personName, renderTime } from '../../queries.ts';
import { decodeEnvelope, millis } from '../../sync/normalize.ts';
import { chatId, defineTool, messageId, service, type ToolContext } from '../tool.ts';

// Tools that may ask LINE. Every request runs in the session's bounded pool
// and through its guards; failures reach the caller only through the mapper.

const mediaTypes = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']);
/** Largest attachment `get_attachment` downloads; LINE's own file limit is far higher. */
export const maxAttachmentBytes = 100 * 1024 * 1024;

const integerId = (value: unknown): string | null => {
	try {
		return value === undefined || value === null ? null : decimal(value as string);
	} catch {
		return null;
	}
};

const text = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

function attachmentInfo(message: Message) {
	const metadata = message.contentMetadata ?? {};
	const size = Number(metadata.FILE_SIZE);
	const duration = Number(metadata.DURATION);
	return {
		file_name: text(metadata.FILE_NAME),
		file_size: Number.isSafeInteger(size) && size >= 0 ? size : null,
		duration_ms: Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
		e2ee: Boolean(message.chunks?.length)
	};
}

/** The extension of `fileName` when it is plain, such as `.jpg`. */
function plainExtension(fileName: string | null | undefined): string | null {
	const extension = extname(fileName ?? '').toLowerCase();
	return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : null;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
	Buffer.from(bytes.subarray(start, end)).toString('latin1');

/** ISO base media brands (`ftyp`) with an extension of their own; the rest are MP4. */
const brands: Record<string, string> = {
	'M4A ': '.m4a',
	'M4B ': '.m4a',
	'qt  ': '.mov',
	heic: '.heic',
	heix: '.heic',
	mif1: '.heic',
	avif: '.avif',
	'3gp4': '.3gp',
	'3gp5': '.3gp',
	'3gp6': '.3gp'
};

/** The extension the leading bytes of a file announce, for media LINE sends without a name. */
export function sniffExtension(head: Uint8Array): string | null {
	const [first, second] = head;
	if (first === 0xff && second === 0xd8 && head[2] === 0xff) return '.jpg';
	if (ascii(head, 0, 8) === '\x89PNG\r\n\x1a\n') return '.png';
	if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return '.gif';
	if (ascii(head, 0, 4) === 'RIFF') {
		const kind = ascii(head, 8, 12);
		if (kind === 'WEBP') return '.webp';
		if (kind === 'WAVE') return '.wav';
		if (kind === 'AVI ') return '.avi';
	}
	if (ascii(head, 4, 8) === 'ftyp') return brands[ascii(head, 8, 12)] ?? '.mp4';
	if (ascii(head, 0, 5) === '%PDF-') return '.pdf';
	if (ascii(head, 0, 4) === 'OggS') return '.ogg';
	if (ascii(head, 0, 4) === 'fLaC') return '.flac';
	if (ascii(head, 0, 3) === 'ID3') return '.mp3';
	if (first === 0xff && second !== undefined && (second & 0xf6) === 0xf0) return '.aac';
	if (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0) return '.mp3';
	if (ascii(head, 0, 4) === '\x1aE\xdf\xa3') return '.webm';
	if (ascii(head, 0, 4) === 'PK\x03\x04') return '.zip';
	return null;
}

/** Leading bytes kept from a download to recognise its type. */
const headBytes = 16;

/**
 * Cached files are `<service>-<message id>-<random>[.ext]`: only safe
 * characters, so the path stays inside the cache directory, and not derivable
 * from the message alone. Partial files start with a dot and never match.
 */
function cacheStem(where: Service, id: string): string {
	return `${where}-${id}-`;
}

function findCached(directory: string, stem: string): string | null {
	const name = readdirSync(directory).find((entry) => entry.startsWith(stem));
	return name === undefined ? null : join(directory, name);
}

interface Downloaded {
	size: number;
	head: Uint8Array;
	/** The file name LINE keeps inside the E2EE payload, if any. */
	name?: string;
}

function tooLarge(limit: number): LineMcpError {
	return new LineMcpError('attachment_too_large', `The attachment is larger than ${limit} bytes`);
}

/** True when a response announces more than `limit` bytes. */
function announcesMore(response: Response, limit: number): boolean {
	const length = Number(response.headers.get('content-length'));
	return Number.isFinite(length) && length > limit;
}

/**
 * The byte limit and cancellation of the obs download in progress, if any.
 * LINEJS reads an E2EE download whole into a Blob and decrypts it in one piece
 * (base/obs/mod.ts:304-328, :459-488: an HMAC over the whole ciphertext), so
 * the only bound below that Blob is on the response: `boundObsFetch` refuses
 * it by Content-Length and errors its body once more than the limit arrived.
 */
const obsLimit = new AsyncLocalStorage<{
	limit: number;
	exceeded: boolean;
	signal: AbortSignal;
}>();
/** The HMAC-SHA256 trailer after the AES-CTR ciphertext of an E2EE file. */
const e2eeTrailerBytes = 32;
const boundClients = new WeakSet<BaseClient>();

/**
 * Wraps the session's guarded `fetch` once, so obs responses read inside
 * `obsLimit.run` stay within its limit. Requests outside it, and every
 * non-obs request (the key lookups of the same download), pass unchanged.
 */
function boundObsFetch(base: BaseClient): void {
	if (boundClients.has(base)) return;
	boundClients.add(base);
	const { fetch } = base;
	Object.assign(base, {
		fetch: (async (info, init) => {
			const bound = obsLimit.getStore();
			const url = typeof info === 'string' ? info : info instanceof URL ? info.href : info.url;
			if (!bound || !url.startsWith(base.obs.prefix)) return await fetch(info, init);
			const response = await fetch(info, { ...init, signal: bound.signal });
			if (!response.body) return response;
			if (announcesMore(response, bound.limit)) {
				bound.exceeded = true;
				await response.body.cancel();
				throw tooLarge(bound.limit);
			}
			let received = 0;
			const counted = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						received += chunk.byteLength;
						if (received > bound.limit) {
							bound.exceeded = true;
							controller.error(tooLarge(bound.limit));
							return;
						}
						controller.enqueue(chunk);
					}
				})
			);
			return new Response(counted, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}) satisfies typeof fetch
	});
}

/**
 * Plain media: the same request LINEJS's `downloadMessageData` sends
 * (base/obs/mod.ts:107-145), streamed to `partial` and stopped as soon as it
 * passes `limit`, so an oversized file never sits in memory or on disk.
 */
async function streamPlain(
	context: ToolContext,
	where: Service,
	message: Message,
	partial: string,
	limit: number,
	signal: AbortSignal
): Promise<Downloaded> {
	const { base } = context;
	const response = await base.fetch(
		base.obs.getMessageDataUrl(String(message.id), false, where === 'square'),
		{
			headers: {
				accept: 'application/json, text/plain, */*',
				'x-line-application': base.request.systemType,
				'x-Line-access': base.authToken ?? ''
			},
			signal
		}
	);
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		// The body is left out: obs error pages embed signed URLs.
		throw new InternalError('ObsError', `Message data download failed: HTTP ${response.status}`, {
			status: response.status
		});
	}
	if (announcesMore(response, limit)) {
		await response.body.cancel();
		throw tooLarge(limit);
	}
	const file = await open(partial, 'w', 0o600);
	let received = 0;
	let head: Uint8Array = new Uint8Array(0);
	try {
		for await (const chunk of response.body) {
			received += chunk.byteLength;
			if (received > limit) throw tooLarge(limit);
			if (head.length < headBytes) head = Buffer.concat([head, chunk]).subarray(0, headBytes);
			await writeAll(file, chunk);
		}
	} finally {
		await file.close();
	}
	return { size: received, head };
}

/** `write` may persist only part of a chunk, for example near a size limit. */
export async function writeAll(file: Pick<FileHandle, 'write'>, chunk: Uint8Array): Promise<void> {
	for (let offset = 0; offset < chunk.byteLength;) {
		const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
		if (bytesWritten <= 0) throw new Error('Writing the attachment made no progress');
		offset += bytesWritten;
	}
}

/** E2EE media through LINEJS, bounded on the encrypted response; returns the decrypted size. */
async function downloadE2EE(
	context: ToolContext,
	message: Message,
	decryptState: string,
	partial: string,
	limit: number,
	signal: AbortSignal
): Promise<Downloaded> {
	const { base } = context;
	// The row only reaches `ok` once the exact key generations its envelope
	// names were verified (architecture, E2EE key boundaries); LINEJS then decrypts the file
	// key from the same envelope (base/obs/mod.ts:459-468).
	if (decryptState !== 'ok') {
		throw new LineMcpError('missing_key', 'The keys for this E2EE message are not available');
	}
	const verified = await decryptMessage(base, context.selfMid, message);
	if (verified.state !== 'ok') {
		throw new LineMcpError('missing_key', 'The keys for this E2EE message are not available');
	}
	boundObsFetch(base);
	// A file of exactly `limit` bytes arrives as `limit` plus the trailer.
	const bound = { limit: limit + e2eeTrailerBytes, exceeded: false, signal };
	let file: File | null;
	try {
		file = await obsLimit.run(bound, () => base.obs.downloadMediaByE2EE(message));
	} catch (error) {
		// Blob reading may wrap the stream's error; the flag says what happened.
		if (bound.exceeded) throw tooLarge(limit);
		throw error;
	}
	if (!file) throw new LineMcpError('no_attachment', 'This message has no attachment');
	if (file.size > limit) throw tooLarge(limit);
	const bytes = Buffer.from(await file.arrayBuffer());
	writeFileSync(partial, bytes, { mode: 0o600 });
	return { size: file.size, head: bytes.subarray(0, headBytes), name: file.name };
}

export const getAttachment = defineTool({
	name: 'get_attachment',
	description:
		'Attachment of an image, video, audio or file message: metadata, or with download true the file saved to a private cache and its local path. Refused for unsent messages.',
	upstream: true,
	input: z.object({
		service,
		chat_id: chatId,
		message_id: messageId,
		download: z.boolean().optional().describe('Download the file and return its local path')
	}),
	run: async (args, context, signal) => {
		const { db } = context;
		const found = findMessage(db, {
			service: args.service,
			chatId: args.chat_id,
			messageId: args.message_id
		});
		if (!found) throw new LineMcpError('not_found', 'No such message in this chat');
		// Unsend cleared the envelope (architecture, Tombstones); nothing of it is served.
		if (found.unsent) throw new LineMcpError('message_unsent', 'The message was unsent');
		const message = decodeEnvelope(readEnvelope(db, found.rowId)!);
		if (!mediaTypes.has(found.contentType ?? '')) {
			throw new LineMcpError('no_attachment', 'This message has no attachment');
		}
		const info = attachmentInfo(message);
		const result = { message: describeMessage(db, context.selfMid, found), attachment: info };
		if (!args.download) return { ...result, path: null };
		if (message.contentMetadata?.DOWNLOAD_URL && !message.contentMetadata?.OID) {
			throw new LineMcpError('no_attachment', 'The file is hosted outside LINE storage');
		}
		const limit = context.maxAttachmentBytes ?? maxAttachmentBytes;
		// FILE_SIZE comes from the sender, so this only spares a request; the
		// download itself enforces the limit on the bytes that arrive. For E2EE
		// media it counts the ciphertext with its HMAC trailer.
		const announced = limit + (info.e2ee ? e2eeTrailerBytes : 0);
		if (info.file_size !== null && info.file_size > announced) throw tooLarge(limit);
		mkdirSync(context.attachments, { recursive: true, mode: 0o700 });
		chmodSync(context.attachments, 0o700);
		const stem = cacheStem(args.service, found.messageId);
		const cached = findCached(context.attachments, stem);
		if (cached) return { ...result, path: cached, cached: true };
		// Written under a temporary name, so a reader never sees half a file.
		const random = randomBytes(12).toString('hex');
		const partial = join(context.attachments, `.${stem}${random}.partial`);
		try {
			const file = await context.pool.run(
				() =>
					info.e2ee
						? downloadE2EE(context, message, found.decryptState, partial, limit, signal)
						: streamPlain(context, args.service, message, partial, limit, signal),
				signal
			);
			const extension =
				plainExtension(info.file_name) ?? plainExtension(file.name) ?? sniffExtension(file.head);
			const path = join(context.attachments, `${stem}${random}${extension ?? ''}`);
			renameSync(partial, path);
			return { ...result, attachment: { ...info, file_size: file.size }, path, cached: false };
		} finally {
			rmSync(partial, { force: true });
		}
	}
});

export const getAnnouncements = defineTool({
	name: 'get_announcements',
	description:
		'Pinned announcements of a group, room or OpenChat chat, asked from LINE. One-to-one chats have none.',
	upstream: true,
	input: z.object({ service, chat_id: chatId }),
	run: async (args, context, signal) => {
		const { base, db, pool } = context;
		const chat = findChat(db, args.service, args.chat_id);
		if (args.service === 'square') {
			const response = await pool.run(
				() =>
					base.square.getSquareChatAnnouncements({
						getSquareChatAnnouncementsRequest: { squareChatMid: args.chat_id }
					}),
				signal
			);
			return {
				chat,
				announcements: (response?.announcements ?? []).map((announcement) => {
					const contents = announcement.contents?.textMessageAnnouncementContents;
					const sender = text(contents?.senderSquareMemberMid) ?? text(announcement.creator);
					return {
						seq: integerId(announcement.announcementSeq),
						text: text(contents?.text),
						message_id: integerId(contents?.messageId),
						creator_id: sender,
						creator_name: personName(db, 'square', sender),
						created_at: renderTime(millis(announcement.createdAt))
					};
				})
			};
		}
		if (!/^[cr]/.test(args.chat_id)) {
			throw new LineMcpError('invalid_argument', 'Only groups and rooms have announcements');
		}
		const announcements = await pool.run(
			() => base.talk.getChatRoomAnnouncements({ chatRoomMid: args.chat_id }),
			signal
		);
		return {
			chat,
			announcements: (announcements ?? []).map((announcement) => {
				const creator = text(announcement.creatorMid);
				return {
					seq: integerId(announcement.announcementSeq),
					text: text(announcement.contents?.text),
					link: text(announcement.contents?.link),
					creator_id: creator,
					creator_name: personName(db, 'talk', creator),
					created_at: renderTime(millis(announcement.createdTime))
				};
			})
		};
	}
});

export const getProfile = defineTool({
	name: 'get_profile',
	description:
		'Profile from LINE: without id the connected LINE account; a Talk user MID; or with service square an OpenChat member ID (starting with p).',
	upstream: true,
	input: z.object({
		service: service.optional().describe('Default talk'),
		id: z
			.string()
			.regex(/^[a-z][0-9a-f]{32}$/)
			.optional()
			.describe('User MID (Talk) or member ID (Square); omit for the connected account')
	}),
	run: async (args, context, signal) => {
		const { base, db, pool, selfMid } = context;
		const where = args.service ?? 'talk';
		if (where === 'square') {
			if (!args.id) throw new LineMcpError('invalid_argument', 'Square needs a member id');
			const id = args.id;
			const response = await pool.run(
				() => base.square.getSquareMember({ squareMemberMid: id }),
				signal
			);
			const member = response?.squareMember;
			if (!member) throw new LineMcpError('not_found', 'LINE returned no member');
			return {
				profile: {
					service: 'square',
					id: text(member.squareMemberMid) ?? id,
					display_name: text(member.displayName),
					square_id: text(member.squareMid),
					membership: text(member.membershipState),
					role: text(member.role),
					archived_name: personName(db, 'square', id)
				}
			};
		}
		const id = args.id ?? selfMid;
		if (id === selfMid) {
			const profile = await pool.run(() => base.talk.getProfile(), signal);
			return {
				profile: {
					service: 'talk',
					id: text(profile?.mid) ?? id,
					self: true,
					display_name: text(profile?.displayName),
					status_message: text(profile?.statusMessage)
				}
			};
		}
		const response = await pool.run(() => base.talk.getContactsV2({ mids: [id] }), signal);
		const contact = response?.contacts?.[id]?.contact;
		if (!contact) throw new LineMcpError('not_found', 'LINE returned no contact');
		return {
			profile: {
				service: 'talk',
				id,
				self: false,
				display_name: text(contact.displayName),
				display_name_overridden: text(contact.displayNameOverridden),
				status_message: text(contact.statusMessage),
				archived_name: personName(db, 'talk', id)
			}
		};
	}
});
