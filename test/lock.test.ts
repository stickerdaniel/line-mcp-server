import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock } from '../src/lock.ts';
import { databasePath } from '../src/paths.ts';
import { login, openSession } from '../src/session.ts';
import {
	fakeUpstream,
	freePort,
	keyPair,
	qrLoginHandlers,
	seedLive,
	selfMid,
	snapshot,
	storedKey,
	tempRoot,
	within
} from './fake-line.ts';

const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** Starts a fixture and resolves once it prints `line` on stdout. */
async function startChild(fixture: string, args: string[], line: string): Promise<ChildProcess> {
	const path = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
	const child = spawn(process.execPath, [path, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
	children.push(child);
	let output = '';
	await within(
		10_000,
		new Promise<void>((resolve, reject) => {
			child.stdout!.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				if (output.split('\n').includes(line)) resolve();
			});
			child.once('exit', () => reject(new Error(`${fixture} exited: ${output}`)));
		}),
		`${fixture} start`
	);
	return child;
}

async function kill(child: ChildProcess): Promise<void> {
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
}

/** Resolves once the server side has closed the connection. */
async function strayConnection(port: number): Promise<void> {
	const socket = connect({ host: '127.0.0.1', port });
	socket.on('error', () => {});
	await within(1000, once(socket, 'close'), 'closing a stray connection');
}

describe('ownership lock', () => {
	it('keeps a second process off the lock port', async () => {
		const port = await freePort();
		await startChild('hold-lock.ts', [String(port)], 'locked');

		await expect(acquireLock(port)).rejects.toMatchObject({ code: 'lock_held' });
	});

	it('fails startup closed when an unrelated process listens on the lock port', async () => {
		const port = await freePort();
		const root = tempRoot();
		const unrelated = createServer();
		await new Promise<void>((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
		const createClient = vi.fn();

		try {
			await expect(openSession({ root, lockPort: port, createClient })).rejects.toMatchObject({
				code: 'lock_held'
			});
			expect(createClient).not.toHaveBeenCalled();
			expect(existsSync(databasePath(root))).toBe(false);
		} finally {
			unrelated.close();
		}
	});

	it('is free for the next start right after the owner is killed, even after a connection', async () => {
		const port = await freePort();
		const owner = await startChild('hold-lock.ts', [String(port)], 'locked');
		await strayConnection(port);

		await kill(owner);

		const lock = await acquireLock(port);
		await lock.release();
	});

	it('closes stray connections and releases without waiting for them', async () => {
		const port = await freePort();
		const lock = await acquireLock(port);
		await strayConnection(port);
		const lingering = connect({ host: '127.0.0.1', port });
		lingering.on('error', () => {});
		await once(lingering, 'connect');

		await within(500, lock.release(), 'release');

		const next = await acquireLock(port);
		await next.release();
		lingering.destroy();
	});

	it('is free for the restarted daemon right after a successful login', async () => {
		const port = await freePort();
		const root = tempRoot();
		const upstream = fakeUpstream(qrLoginHandlers({ mid: selfMid, keys: [keyPair(1)] }));

		await login({
			root,
			lockPort: port,
			createClient: upstream.createClient,
			log: () => {},
			onQrUrl: () => {},
			onPin: () => {}
		});

		const daemon = await acquireLock(port);
		await daemon.release();
	});

	it('leaves the live store unchanged when login is killed after LINEJS wrote keys', async () => {
		const port = await freePort();
		const root = tempRoot();
		seedLive(root, selfMid, { authToken: 'token-old', 'e2eeKeys:1': storedKey(keyPair(1)) });
		const before = snapshot(root);
		const child = await startChild('stalled-login.ts', [root, String(port)], 'stalled');

		await kill(child);

		expect(snapshot(root)).toEqual(before);
		const lock = await acquireLock(port);
		await lock.release();
	});
});
