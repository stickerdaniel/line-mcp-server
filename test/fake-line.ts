// Fake LINE upstream for tests. Nothing here reaches the network: every
// client gets a fetch that throws, and RPCs are answered by local handlers.
import { Buffer } from 'node:buffer';
import { createCipheriv } from 'node:crypto';
import {
	copyFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BaseClient, InternalError } from '@evex/linejs/base';
import type { BaseStorage } from '@evex/linejs/storage';
import { type NestedArray, Protocols } from '@evex/linejs/thrift';
import { bindAccount, openDatabase } from '../src/db.ts';
import { databasePath } from '../src/paths.ts';
import { SqliteStorage } from '../src/storage.ts';

export const selfMid = `u${'a'.repeat(32)}`;
export const otherMid = `u${'b'.repeat(32)}`;
export const groupMid = `c${'c'.repeat(32)}`;

const refuseFetch = async (): Promise<Response> => {
	throw new Error('tests must not reach the network');
};

/** Used only for key generation and payload crypto on the fake server side. */
const helper = new BaseClient({ device: 'ANDROIDSECONDARY', fetch: refuseFetch });

export type Handler = (value: NestedArray, base: BaseClient) => unknown;

export interface FakeUpstream {
	/** Method names that reached the fake transport, in order. */
	calls: string[];
	createClient: (storage: BaseStorage) => BaseClient;
}

/** Where a faked RPC goes on the transport; never a real host. */
const rpcOrigin = 'https://fake-rpc.invalid';

/**
 * Answers RPCs in place of LINEJS's request step, below the session guards.
 * Each RPC first leaves through `base.fetch`, as LINEJS's own request does
 * (base/request/mod.ts:163-169), so the session's transport guards see it;
 * then its handler answers. Plain HTTP requests (media) go to `fetch`, which
 * refuses them by default.
 */
export function fakeUpstream(
	handlers: Record<string, Handler>,
	fetch: (request: Request) => Promise<Response> = refuseFetch
): FakeUpstream {
	const calls: string[] = [];
	const transport = async (request: Request) =>
		request.url.startsWith(`${rpcOrigin}/`) ? new Response(null) : await fetch(request);
	return {
		calls,
		createClient: (storage) => {
			const base = new BaseClient({ device: 'ANDROIDSECONDARY', storage, fetch: transport });
			Object.assign(base.request, {
				requestCore: async (path: string, value: NestedArray, method: string) => {
					await base.fetch(`${rpcOrigin}${path}`, { method: 'POST' });
					calls.push(method);
					const handler = handlers[method];
					if (!handler) throw new Error(`unexpected upstream call ${method}`);
					return { data: { success: await handler(value, base) } };
				}
			});
			return base;
		}
	};
}

/**
 * Answers at the HTTP layer so the real LINEJS request code runs: it reads the
 * next-access header and parses (or fails to parse) the Thrift body.
 */
export function fakeHttpUpstream(
	routes: Record<string, (request: Request) => Response | Promise<Response>>
): FakeUpstream {
	const calls: string[] = [];
	return {
		calls,
		createClient: (storage) =>
			new BaseClient({
				device: 'ANDROIDSECONDARY',
				storage,
				fetch: async (request: Request) => {
					const body = new Uint8Array(await request.clone().arrayBuffer());
					// Compact protocol header: 0x82, version/type, seqid, name length, name.
					// Requests without a Thrift body (media) are named by their URL path.
					const method = body.length
						? Buffer.from(body.subarray(4, 4 + body[3]!)).toString()
						: new URL(request.url).pathname;
					calls.push(method);
					const route = routes[method];
					if (!route) throw new Error(`unexpected upstream call ${method}`);
					return await route(request);
				}
			})
	};
}

/**
 * The arguments of a Thrift call as LINE receives them, by field id. Binary
 * fields that happen to be valid UTF-8 arrive as strings, as LINEJS reads them.
 */
export async function callArgs(request: Request): Promise<Record<number, unknown>> {
	const body = new Uint8Array(await request.clone().arrayBuffer());
	return helper.thrift.readThrift(body, Protocols[4]).data as Record<number, unknown>;
}

/** A Thrift reply carrying exception struct field 1 with this numeric code. */
export function thriftError(method: string, code: number): Response {
	return thriftReply(method, [[12, 1, [[8, 1, code]]]]);
}

export function thriftReply(
	method: string,
	value: NestedArray,
	headers: Record<string, string> = {}
): Response {
	return new Response(helper.thrift.writeThrift(value, method, Protocols[4]), { headers });
}

export function talkError(code: string): InternalError {
	return new InternalError('RequestError', `Request internal failed -> {"code":"${code}"}`, {
		code,
		reason: 'fake'
	});
}

export interface KeyPair {
	keyId: number;
	privKey: Buffer;
	pubKey: Buffer;
}

export function keyPair(keyId: number): KeyPair {
	const [privKey, pubKey] = helper.e2ee.createSqrSecret(true);
	return { keyId, privKey: Buffer.from(privKey), pubKey: Buffer.from(pubKey, 'base64') };
}

/** The `e2eeKeys:<id>` row LINEJS writes for a transferred key. */
export function storedKey(key: KeyPair): string {
	return JSON.stringify({
		keyId: key.keyId,
		privKey: key.privKey.toString('base64'),
		pubKey: key.pubKey.toString('base64'),
		e2eeVersion: '1'
	});
}

/** Encrypts a key chain for the login secret the way the primary device does. */
function keyChain(clientPublicKey: string, keys: KeyPair[], selectedKeyId: number) {
	const [serverPrivate, serverPublic] = helper.e2ee.createSqrSecret(true);
	const shared = Buffer.from(
		helper.e2ee.generateSharedSecret(
			Buffer.from(serverPrivate),
			Buffer.from(clientPublicKey, 'base64')
		)
	);
	const entries: NestedArray[] = keys.map((key) => [
		[8, 2, key.keyId],
		[11, 4, key.pubKey],
		[11, 5, key.privKey]
	]);
	// writeThrift prefixes a 4-byte message header for an empty method name.
	const struct = Buffer.from(
		helper.thrift.writeThrift([[15, 1, [12, entries]]], '', Protocols[4])
	).subarray(4);
	const plain = Buffer.concat([struct, Buffer.alloc((16 - (struct.length % 16)) % 16)]);
	const cipher = createCipheriv(
		'aes-256-cbc',
		helper.e2ee.getSHA256Sum(shared, 'Key'),
		helper.e2ee.xor(helper.e2ee.getSHA256Sum(shared, 'IV'))
	);
	cipher.setAutoPadding(false);
	return {
		encryptedKeyChain: Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64'),
		keyId: String(selectedKeyId),
		publicKey: serverPublic,
		e2eeVersion: '1'
	};
}

export interface QrLoginOptions {
	mid: string;
	/** Key generations the primary device transfers; none means no key result. */
	keys?: KeyPair[];
	/** Called instead of answering getProfile, to stall the login after key writes. */
	onProfile?: () => Promise<never>;
}

/** The secure QR login (`requestSQR2`) as LINE answers it for ANDROIDSECONDARY. */
export function qrLoginHandlers(options: QrLoginOptions): Record<string, Handler> {
	let secret = '';
	return {
		createSession: (_value, base) => {
			base.on('qrcall', (url: string) => {
				secret = new URL(url).searchParams.get('secret') ?? '';
			});
			return { 1: 'fake-auth-session' };
		},
		createQrCodeForSecure: () => ({ 1: 'https://line.me/R/au/lgn/sq/fake', 2: 1, 3: 1, 4: 'n' }),
		checkQrCodeVerified: () => ({}),
		verifyCertificate: () => ({}),
		qrCodeLoginV2ForSecure: () => ({
			1: 'fake-certificate',
			3: { 1: 'access-new', 2: 'refresh-new', 3: 3600, 6: 1_700_000_000 },
			4: options.mid,
			6: {},
			...(options.keys?.length
				? { 10: keyChain(secret, options.keys, options.keys.at(-1)!.keyId) }
				: {})
		}),
		getE2EEPublicKeys: () => [],
		getProfile: () => options.onProfile?.() ?? { mid: options.mid }
	};
}

export function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'line-mcp-test-'));
}

/**
 * The running Node at `<dir>/node`: a symlink, or on Windows `node.exe` as a
 * hard link (a copy across volumes), since a symlink there needs a privilege.
 */
export function nodeAt(dir: string): string {
	mkdirSync(dir, { recursive: true });
	if (process.platform !== 'win32') {
		const path = join(dir, 'node');
		symlinkSync(process.execPath, path);
		return path;
	}
	const path = join(dir, 'node.exe');
	try {
		linkSync(process.execPath, path);
	} catch {
		copyFileSync(process.execPath, path);
	}
	return path;
}

export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** A live store with a bound account and the given `line_kv` rows. */
export function seedLive(root: string, mid: string, rows: Record<string, string>): void {
	const db = openDatabase(root);
	bindAccount(db, { mid, device: 'ANDROIDSECONDARY', linejsVersion: '3.5.0' }, 'seeded');
	const storage = new SqliteStorage(db);
	for (const [key, value] of Object.entries(rows)) storage.setSync(key, value);
	db.close();
}

/** Every `line_kv` row and the account row, for before/after comparison. */
export function snapshot(root: string): unknown {
	const db = new DatabaseSync(databasePath(root), { readOnly: true });
	try {
		return {
			kv: db.prepare('SELECT key, kind, value FROM line_kv ORDER BY key').all(),
			account: db.prepare('SELECT * FROM account').all()
		};
	} finally {
		db.close();
	}
}

/** Every file under `dir` with its bytes, to show that nothing changed. */
export function tree(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [path, readFileSync(path, 'base64')];
			})
	);
}

export function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
		})
	]).finally(() => clearTimeout(timer));
}
