import { Buffer } from 'node:buffer';
import { connect, createServer, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { LineMcpError } from './errors.ts';

/** Fixed loopback port whose exclusive bind marks the owner of the LINE session. */
export const defaultLockPort = 47821;

export function lockPort(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.LINE_MCP_LOCK_PORT;
	if (!raw) return defaultLockPort;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('LINE_MCP_LOCK_PORT must be a TCP port number');
	}
	return port;
}

/** Connects to the lock port without binding it, so a check never competes for ownership. */
export function lockInUse(port: number = lockPort()): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

export interface OwnershipLock {
	readonly port: number;
	/** Stops listening and resolves once the port is free again. */
	release(): Promise<void>;
}

/** The one request the lock listener understands, sent as the first line of a connection. */
const stopLine = Buffer.from('line-mcp stop\n');
/** Bytes read from a connection before it is refused; the stop line needs fewer. */
const maxRequestBytes = 64;
/** Time from accept within which a connection must send the stop line. */
const requestDeadlineMs = 1000;

/**
 * Takes ownership by binding `127.0.0.1:<port>`. The kernel releases the port
 * when the process dies, so there is no lock file and no stale-lock case. Any
 * bind failure fails closed: no fallback port, no guess about the occupant.
 *
 * With `onStop`, a connection whose first line is exactly `line-mcp stop` calls
 * it once (`requestStop`). There is no token: anyone who can connect here can
 * also reach the unauthenticated MCP port, which already sends messages, and a
 * browser cannot make a connection start with that line. Without `onStop`
 * (login, probe) nothing is read and the request is ignored.
 */
export async function acquireLock(
	port: number = lockPort(),
	onStop?: () => void
): Promise<OwnershipLock> {
	const sockets = new Set<Socket>();
	let stopRequested = false;
	const server = createServer({ pauseOnConnect: true }, (socket) => {
		// Nothing else is ever exchanged: any other connection is destroyed at
		// once, or at its deadline, and release destroys the rest.
		if (!onStop) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		const deadline = setTimeout(() => socket.destroy(), requestDeadlineMs);
		socket.once('close', () => {
			clearTimeout(deadline);
			sockets.delete(socket);
		});
		socket.on('error', () => {});
		let received = Buffer.alloc(0);
		const read = (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]).subarray(0, maxRequestBytes);
			if (!received.includes('\n') && received.length < maxRequestBytes) return;
			socket.off('data', read);
			// Exactly the line from byte zero: no prefix, no suffix, nothing after it.
			if (!received.equals(stopLine)) {
				socket.destroy();
				return;
			}
			socket.end();
			if (stopRequested) return;
			stopRequested = true;
			onStop();
		};
		socket.on('data', read);
		socket.resume();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ host: '127.0.0.1', port, exclusive: true, reusePort: false }, () => {
				server.off('error', reject);
				resolve();
			});
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			throw new LineMcpError('lock_held', `Another process holds the line-mcp lock port ${port}`);
		}
		throw new LineMcpError('lock_failed', `Could not bind the line-mcp lock port ${port}`, {
			cause: error
		});
	}
	// Accept errors (for example EMFILE) must not crash the owner; the
	// listener keeps the port either way.
	server.on('error', () => {});
	let closed: Promise<void> | undefined;
	return {
		port,
		release: () =>
			(closed ??= new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				// A connection still open would hold the close until its deadline.
				for (const socket of sockets) socket.destroy();
			}))
	};
}

/**
 * Asks the process holding the lock port to stop and waits until the port is
 * free. Resolves `not_running` when nothing listened. Fails with `stop_timeout`
 * when the port is still held at the deadline, for example by a login, which
 * ignores the request. It never kills anything, and it never takes an error
 * other than a refused connection as proof that nothing listens.
 */
export async function requestStop(
	port: number,
	{ deadlineMs }: { deadlineMs: number }
): Promise<'stopped' | 'not_running'> {
	const deadline = Date.now() + deadlineMs;
	const timedOut = () =>
		new LineMcpError('stop_timeout', `The owner of lock port ${port} did not stop in time`);
	// The owner ends the connection once it read the line; a listener that never
	// does is cut off at the deadline, and the loop below then times out.
	const sent = await contact(port, deadlineMs, timedOut, (socket) => socket.end(stopLine));
	if (!sent) return 'not_running';
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0) throw timedOut();
		if (!(await contact(port, left, timedOut, (socket) => socket.destroy()))) return 'stopped';
		await sleep(Math.min(deadline - Date.now(), 50));
	}
}

/**
 * Whether a process holds the lock port. Unlike `lockInUse` it fails closed:
 * only a refused connection means free, and any other error or no answer
 * within `timeoutMs` rejects with `lock_failed`.
 */
export function lockHeld(port: number, { timeoutMs }: { timeoutMs: number }): Promise<boolean> {
	const timedOut = () =>
		new LineMcpError('lock_failed', `The line-mcp lock port ${port} did not answer in time`);
	return contact(port, timeoutMs, timedOut, (socket) => socket.destroy());
}

/**
 * Connects to the lock port and hands the socket to `connected`. Resolves true
 * once a connection was made and has closed, false when it was refused. Any
 * other error rejects, and so does no answer within `timeoutMs` (with
 * `timedOut`): neither proves that the port is free. A refusal can take about
 * 2 s on Windows.
 */
function contact(
	port: number,
	timeoutMs: number,
	timedOut: () => LineMcpError,
	connected: (socket: Socket) => void
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		let made = false;
		let failure: unknown;
		const timer = setTimeout(() => socket.destroy(made ? undefined : timedOut()), timeoutMs);
		socket.once('connect', () => {
			made = true;
			connected(socket);
		});
		socket.on('error', (error) => (failure ??= error));
		socket.once('close', () => {
			clearTimeout(timer);
			if (made) resolve(true);
			else if ((failure as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED')
				resolve(false);
			else if (failure instanceof LineMcpError) reject(failure);
			else
				reject(
					new LineMcpError('lock_failed', `Could not reach the line-mcp lock port ${port}`, {
						cause: failure
					})
				);
		});
	});
}
