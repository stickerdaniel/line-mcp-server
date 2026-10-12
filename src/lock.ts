import { connect, createServer } from 'node:net';
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

/**
 * Takes ownership by binding `127.0.0.1:<port>`. The kernel releases the port
 * when the process dies, so there is no lock file and no stale-lock case. Any
 * bind failure fails closed: no fallback port, no guess about the occupant.
 */
export async function acquireLock(port: number = lockPort()): Promise<OwnershipLock> {
	// Nothing is ever exchanged: an accepted connection is destroyed at once,
	// so stray clients cannot hold the listener open during release.
	const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
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
			}))
	};
}
