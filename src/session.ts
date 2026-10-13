import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { BaseClient, InternalError } from '@evex/linejs/base';
import type { BaseStorage } from '@evex/linejs/storage';
import {
	type Account,
	bindAccount,
	migrate,
	openDatabase,
	readAccount,
	setAuthState,
	transaction
} from './db.ts';
import { type ErrorCode, isHttpStatus, LineMcpError, mapError } from './errors.ts';
import { acquireLock } from './lock.ts';
import { stateRoot } from './paths.ts';
import { type KvRow, SqliteStorage, type Value } from './storage.ts';

export const device = 'ANDROIDSECONDARY';
export const linejsVersion = '3.5.0';
const tokenKey = 'authToken';

export type SessionState = 'online' | 'needs_login' | 'storage_error';
export type LogEntry = Record<string, string | number | boolean>;
export type Log = (entry: LogEntry) => void;
export type CreateClient = (storage: BaseStorage) => BaseClient;

/** One JSON line per entry, led by the time it was written; launchd adds none. */
export const stderrLog: Log = (entry) => {
	process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
};

export function createClient(storage: BaseStorage): BaseClient {
	return new BaseClient({ device, storage });
}

export interface SessionOptions {
	root?: string;
	lockPort?: number;
	/** Builds the LINEJS client; tests pass a fake upstream here. */
	createClient?: CreateClient;
	log?: Log;
}

export interface Session {
	readonly base: BaseClient;
	readonly db: DatabaseSync;
	readonly account: Account;
	state(): SessionState;
	/**
	 * Enters the terminal `storage_error` state after an archive write failed:
	 * every further upstream dispatch is refused, cached reads stay available.
	 */
	storageFailed(): void;
	/** Refuses every further upstream dispatch, closes the archive and releases the lock. */
	close(): Promise<void>;
}

/**
 * Startup in a fixed order (architecture, Process and lock ownership): ownership
 * lock, database, device and account binding, guards, token handler, then
 * session restore.
 */
export async function openSession(options: SessionOptions = {}): Promise<Session> {
	const log = options.log ?? stderrLog;
	const lock = await acquireLock(options.lockPort);
	let db: DatabaseSync | undefined;
	try {
		const live = (db = openDatabase(options.root ?? stateRoot()));
		const account = readAccount(live);
		if (!account) {
			throw new LineMcpError('not_logged_in', 'No LINE account is bound; run line-mcp login');
		}
		if (account.device !== device) {
			throw new LineMcpError('device_mismatch', `The bound session is not ${device}`);
		}
		const control = new Control(log, () => setAuthState(live, 'needs_login'));
		const storage = new SqliteStorage(live, control.storageFailed);
		const base = (options.createClient ?? createClient)(storage);
		installGuards(base, control, storage);
		registerTokenHandler(base, storage);

		const token = storage.getSync(tokenKey);
		if (typeof token !== 'string') {
			throw new LineMcpError('not_logged_in', 'No stored LINE token; run line-mcp login');
		}
		base.authToken = token;
		if (account.authState === 'needs_login') {
			control.state = 'needs_login';
		} else {
			// A recognized auth loss here leaves the session open in `needs_login`
			// so cached reads keep working; any other failure aborts startup.
			const profile = await base.talk.getProfile().catch((error: unknown) => {
				if (control.state === 'needs_login') return undefined;
				throw error;
			});
			// An answer without the profile verifies nothing.
			if (control.state !== 'needs_login') {
				if (!profile?.mid) {
					throw new LineMcpError('not_logged_in', 'LINE did not return the account profile');
				}
				if (profile.mid !== account.mid) {
					throw new LineMcpError('wrong_account', 'The stored token belongs to another account');
				}
				base.profile = profile;
			}
		}
		return {
			base,
			db: live,
			account,
			state: () => control.state,
			storageFailed: control.storageFailed,
			close: async () => {
				// The guards refuse before the lock goes: a task still running when
				// ownership is released cannot reach LINE any more.
				control.close();
				live.close();
				await lock.release();
			}
		};
	} catch (error) {
		db?.close();
		await lock.release();
		throw error;
	}
}

export interface LoginOptions extends SessionOptions {
	onQrUrl: (url: string) => void;
	onPin: (pin: string) => void;
}

export interface LoginResult {
	mid: string;
	firstLogin: boolean;
	addedKeyGenerations: number;
}

/** Rows a new login replaces; every other row is only ever added. */
const loginOwnedKeys = new Set([tokenKey, 'refreshToken', 'expire', 'qrCert']);

/**
 * QR login into staging storage. LINEJS writes transferred keys before it
 * learns the account MID, so nothing reaches the live store until the MID
 * matches the bound account; then one transaction replaces the token rows and
 * adds new rows without touching existing key generations or key caches.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
	const log = options.log ?? stderrLog;
	const lock = await acquireLock(options.lockPort);
	let live: DatabaseSync | undefined;
	let staging: DatabaseSync | undefined;
	try {
		const liveDb = (live = openDatabase(options.root ?? stateRoot()));
		const stagingDb = (staging = new DatabaseSync(':memory:'));
		migrate(stagingDb);
		copyRows(liveDb, stagingDb, 'replace');

		const control = new Control(log);
		const storage = new SqliteStorage(stagingDb, control.storageFailed);
		const base = (options.createClient ?? createClient)(storage);
		installGuards(base, control, storage);
		registerTokenHandler(base, storage);
		base.on('qrcall', options.onQrUrl);
		base.on('pincall', options.onPin);
		// LINE holds the QR poll open a fixed number of times and answers 410 once
		// nobody scanned; LINEJS retries until the last poll, then rethrows
		// (base/login/mod.ts:709-742).
		const checkQrCodeVerified = base.loginProcess.checkQrCodeVerified.bind(base.loginProcess);
		base.loginProcess.checkQrCodeVerified = async (...args) => {
			try {
				return await checkQrCodeVerified(...args);
			} catch (error) {
				if (!isHttpStatus(error, 410)) throw error;
				throw new LineMcpError(
					'qr_expired',
					'The QR code expired before it was scanned; run line-mcp login again'
				);
			}
		};

		await base.loginProcess.login({ qr: true });
		const mid = base.profile?.mid;
		if (!mid) {
			throw new LineMcpError('not_logged_in', 'LINE did not return the account profile');
		}
		const account = readAccount(liveDb);
		if (account && account.mid !== mid) {
			throw new LineMcpError(
				'wrong_account',
				'The scanned account is not the bound account; the live session is unchanged'
			);
		}
		const addedKeyGenerations = transaction(liveDb, () => {
			const added = copyRows(stagingDb, liveDb, 'merge');
			bindAccount(liveDb, { mid, device, linejsVersion });
			return added;
		});
		return { mid, firstLogin: !account, addedKeyGenerations };
	} finally {
		staging?.close();
		live?.close();
		await lock.release();
	}
}

/** Returns how many new self key generations (`e2eeKeys:<id>`) were added. */
function copyRows(from: DatabaseSync, to: DatabaseSync, mode: 'replace' | 'merge'): number {
	const replace = to.prepare(
		`INSERT INTO line_kv (key, kind, value) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, value = excluded.value`
	);
	const add = to.prepare(
		'INSERT INTO line_kv (key, kind, value) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING'
	);
	let added = 0;
	for (const row of from
		.prepare('SELECT key, kind, value FROM line_kv')
		.all() as unknown as KvRow[]) {
		const statement = mode === 'replace' || loginOwnedKeys.has(row.key) ? replace : add;
		const { changes } = statement.run(row.key, row.kind, row.value);
		if (statement === add && changes > 0 && /^e2eeKeys:\d+$/.test(row.key)) added++;
	}
	return added;
}

class Control {
	state: SessionState = 'online';
	#closed = false;
	readonly #log: Log;
	readonly #persistNeedsLogin: () => void;

	constructor(log: Log, persistNeedsLogin: () => void = () => {}) {
		this.#log = log;
		this.#persistNeedsLogin = persistNeedsLogin;
	}

	readonly storageFailed = (): void => {
		this.#enter('storage_error');
	};

	readonly log = (entry: LogEntry): void => {
		this.#log(entry);
	};

	/** Final: from now on nothing dispatches, whatever the state. */
	close(): void {
		this.#closed = true;
	}

	/** Throws while the state forbids upstream work. */
	assertOnline(): void {
		if (this.#closed) {
			throw new LineMcpError('shutting_down', 'The session is closed; upstream work is stopped');
		}
		if (this.state === 'storage_error') {
			throw new LineMcpError('storage_error', 'Session storage failed; upstream work is stopped');
		}
		if (this.state === 'needs_login') {
			throw new LineMcpError('needs_login', 'LINE ended the session; run line-mcp login');
		}
	}

	needsLogin(): void {
		if (this.state !== 'online') return;
		try {
			this.#persistNeedsLogin();
		} catch {
			this.storageFailed();
			return;
		}
		this.#enter('needs_login');
	}

	#enter(state: SessionState): void {
		if (this.state === state) return;
		this.state = state;
		this.#log({ event: 'session_state', state });
	}
}

/**
 * The dispatch hook of the mutation in progress, if any. Inside `watchDispatch`
 * every request that passed the guards calls it at the transport, after LINEJS
 * built and serialized it and right before it leaves for LINE, so the outbox
 * can tell a failure before LINE could have acted from one after. Talk and
 * Square RPCs, obs uploads and E2EE media all leave through `base.fetch`.
 */
const dispatchHook = new AsyncLocalStorage<() => void>();

/** Runs `body` with `onDispatch` as its dispatch hook; a hook that throws stops the request unsent. */
export function watchDispatch<T>(onDispatch: () => void, body: () => Promise<T>): Promise<T> {
	return dispatchHook.run(onDispatch, body);
}

/**
 * Set only while a send registers the missing shared key of its group, the
 * one registration line-mcp performs (architecture, E2EE key boundaries): LINE drops a group's
 * key on every membership change, and the next sender has to create one.
 */
const groupKeyRegistration = new AsyncLocalStorage<true>();

/**
 * Runs `body` with `registerE2EEGroupKey` and LINEJS's `tryRegisterE2EEGroupKey`
 * allowed. Every other registration stays blocked inside it as well.
 */
export function allowGroupKeyRegistration<T>(body: () => Promise<T>): Promise<T> {
	return groupKeyRegistration.run(true, body);
}

/** RPCs never sent: key registration and read state (architecture, E2EE key boundaries). */
const blockedMethods = new Map<string, ErrorCode>([
	['registerE2EEPublicKey', 'key_registration_blocked'],
	['registerE2EEPublicKeyV2', 'key_registration_blocked'],
	['registerE2EEGroupKey', 'key_registration_blocked'],
	['sendChatChecked', 'read_state_blocked'],
	['markAsRead', 'read_state_blocked'],
	['markChatsAsRead', 'read_state_blocked'],
	['markThreadsAsRead', 'read_state_blocked']
]);

function installGuards(base: BaseClient, control: Control, storage: SqliteStorage): void {
	// LINEJS registers a fresh key pair when QR login decodes no keys
	// (base/login/mod.ts:303-305) and swallows a failed registration, so the
	// guard has to fail the login itself rather than only the RPC.
	base.e2ee.registerE2EEKeyPair = async () => {
		throw new LineMcpError(
			'key_transfer_empty',
			'LINE transferred no E2EE keys and registering a new key pair is disabled'
		);
	};
	// Reached from a NOT_FOUND group key lookup (base/e2ee/mod.ts:240-246), so
	// a read of a keyless group would register one; only a send may.
	const tryRegisterE2EEGroupKey = base.e2ee.tryRegisterE2EEGroupKey.bind(base.e2ee);
	base.e2ee.tryRegisterE2EEGroupKey = async (chatMid) => {
		if (groupKeyRegistration.getStore()) return await tryRegisterE2EEGroupKey(chatMid);
		throw new LineMcpError(
			'missing_key',
			'The group key is not available and group key registration is disabled'
		);
	};

	// Every dispatch, including LINEJS's private retry after a refresh
	// (base/request/mod.ts:265-276) and media requests on `base.fetch`, stops
	// here once the state forbids upstream work. The original transports stay
	// in place, so the Node HTTP/2 dispatchers and the push path are unchanged.
	const { fetch, fetchPush } = base;
	Object.assign(base, {
		fetch: (async (info, init) => {
			control.assertOnline();
			dispatchHook.getStore()?.();
			return await fetch(info, init);
		}) satisfies typeof fetch,
		fetchPush: (async (info, init) => {
			control.assertOnline();
			dispatchHook.getStore()?.();
			return await fetchPush(info, init);
		}) satisfies typeof fetchPush
	});

	// LINEJS resolves a request whose retry after a refresh is told to refresh
	// again with that refusal instead of throwing (base/request/mod.ts:238-278),
	// so its caller would read an empty answer as success. Thrown as LINEJS
	// throws any other refusal, it counts as auth loss below.
	const core = base.request as unknown as { requestCore: RequestCore };
	const requestCore = core.requestCore.bind(base.request);
	core.requestCore = async (...args) => {
		const response = await requestCore(...args);
		if (response.data.e) {
			const [path, , method] = args;
			throw new InternalError(
				'RequestError',
				`Request internal failed, ${String(method)}(${String(path)})`,
				response.data.e as Record<string, unknown>
			);
		}
		return response;
	};

	installRefresh(base, storage);

	// Every LINEJS RPC, including nested refresh calls, passes through here
	// for the method guards and the method log.
	const request = base.request.request.bind(base.request);
	const call = async (args: Parameters<typeof request>, recover: boolean): Promise<unknown> => {
		const method = args[1];
		control.assertOnline();
		const blocked = blockedMethods.get(method);
		const allowed = method === 'registerE2EEGroupKey' && groupKeyRegistration.getStore();
		if (blocked && !allowed) {
			control.log({ event: 'upstream_blocked', method });
			throw new LineMcpError(blocked, `${method} is disabled in line-mcp`);
		}
		control.log({ event: 'upstream_call', method });
		try {
			return await request(...args);
		} catch (error) {
			// A Talk long poll that ends without news answers 410 after about
			// 110 s: LINE's normal idle answer, not a failure.
			if (method === 'sync' && isHttpStatus(error, 410)) {
				control.log({ event: 'long_poll_ended', method });
			} else {
				control.log({ event: 'upstream_error', ...mapError(error, method) });
			}
			if (recover && canRecoverSquareAuth(args, error, storage)) {
				// LINEJS refreshes only on the Talk code, so a Square request whose
				// token expired gets one refresh before it counts as auth loss. A
				// read is retried; a mutation is not resent, since LINE may have
				// acted on it, and its caller keeps this failure. A rejected
				// refresh marks the loss in its own pass through this wrapper.
				await base.auth.tryRefreshToken();
				if (squareReadMethod.test(method)) return await call(args, false);
				throw error;
			}
			if (isTerminalAuthError(error)) control.needsLogin();
			throw error;
		}
	};
	base.request.request = ((...args: Parameters<typeof request>) =>
		call(args, true)) as typeof base.request.request;
}

/** LINEJS's private request step, which returns the parsed answer with its exception. */
type RequestCore = (...args: unknown[]) => Promise<{ data: Record<string, unknown> }>;

const squareReadMethod = /^(get|fetch|search|find)[A-Z]/;

function canRecoverSquareAuth(
	args: Parameters<BaseClient['request']['request']>,
	error: unknown,
	storage: SqliteStorage
): boolean {
	const [, , , , path] = args;
	return (
		path === '/SQ1' &&
		error instanceof InternalError &&
		error.data.errorCode === 'AUTHENTICATION_FAILURE' &&
		typeof storage.getSync('refreshToken') === 'string'
	);
}

/**
 * Replaces LINEJS's `tryRefreshToken` (base/service/auth/mod.ts:21-37), which
 * lets concurrent callers spend the same refresh token and writes the access
 * token, rotated refresh token and expiry separately. One refresh runs at a
 * time and later callers await it; its results commit in one transaction
 * before the new access token is used.
 */
function installRefresh(base: BaseClient, storage: SqliteStorage): void {
	let inflight: Promise<void> | undefined;
	base.auth.tryRefreshToken = () =>
		(inflight ??= refresh(base, storage).finally(() => {
			inflight = undefined;
		}));
}

async function refresh(base: BaseClient, storage: SqliteStorage): Promise<void> {
	const refreshToken = storage.getSync('refreshToken');
	if (typeof refreshToken !== 'string') {
		throw new InternalError('RefreshError', 'refreshToken not found');
	}
	const result = await insideRefresh.run(true, () =>
		base.auth.refresh({ request: { refreshToken } })
	);
	if (typeof result?.accessToken !== 'string') {
		throw new Error('LINE refresh returned no access token');
	}
	const entries: [string, Value][] = [[tokenKey, result.accessToken]];
	if (result.refreshToken) entries.push(['refreshToken', result.refreshToken]);
	entries.push([
		'expire',
		Number(result.tokenIssueTimeEpochSec) + Number(result.durationUntilRefreshInSec)
	]);
	storage.setAllSync(entries);
	base.authToken = result.accessToken;
}

/**
 * True inside the refresh RPC's own async context. LINEJS emits a response's
 * next-access header before reading its body (base/request/mod.ts:170-174), so
 * without this a refresh response's header token would commit alone, ahead of
 * the refresh transaction. The scope follows that one request, not the client.
 */
const insideRefresh = new AsyncLocalStorage<boolean>();

/**
 * The next-access header path emits without assigning the token
 * (base/request/mod.ts:170-173) and the emitter does not await, so the write
 * happens synchronously here. A failed write throws into the request that
 * carried the token and leaves the session in `storage_error`. The refresh
 * response's header is left to the refresh transaction, which wins.
 */
function registerTokenHandler(base: BaseClient, storage: SqliteStorage): void {
	base.on('update:authtoken', (token: string) => {
		if (insideRefresh.getStore()) return;
		storage.setSync(tokenKey, token);
		base.authToken = token;
	});
}

const terminalTalkCodes = new Set([
	'AUTHENTICATION_FAILED',
	'NOT_AUTHENTICATED',
	'NOT_AUTHORIZED_DEVICE',
	'MUST_REFRESH_V3_TOKEN'
]);

/**
 * LINEJS throws these before its own `end` event (base/request/mod.ts:244-262),
 * so they are read from the thrown error data.
 */
export function isTerminalAuthError(error: unknown): boolean {
	if (!(error instanceof InternalError)) return false;
	if (error.type === 'RefreshError') return true;
	const data = error.data as Record<string, unknown>;
	if (typeof data.code === 'string' && terminalTalkCodes.has(data.code)) return true;
	// Square reports a rejected token as SquareException AUTHENTICATION_FAILURE;
	// FORBIDDEN and other permission errors are not auth loss.
	if (data.errorCode === 'AUTHENTICATION_FAILURE') return true;
	const refreshError = data.accessTokenRefreshException as Record<string, unknown> | undefined;
	return refreshError?.errorCode === 'INVALID_REQUEST';
}
