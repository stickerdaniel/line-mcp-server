#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { readAccount } from './db.ts';
import { LineMcpError, mapError } from './errors.ts';
import { lockPort } from './lock.ts';
import { databasePath, stateRoot } from './paths.ts';
import { probe } from './probe.ts';
import { type Log, login, openSession, stderrLog } from './session.ts';

const usage = `Usage: line-mcp <command>

  login    Log in by QR code as a secondary Android device
  status   Show the bound account and session state
  probe    Read-only live checks [--dm <mid>] [--group <mid>] [--square <mid>]`;

async function main(command: string | undefined, args: string[]): Promise<number> {
	switch (command) {
		case 'login':
			return await runLogin();
		case 'status':
			return await runStatus();
		case 'probe':
			return await runProbe(args);
		default:
			console.error(usage);
			return 2;
	}
}

async function runLogin(): Promise<number> {
	const result = await login({
		onQrUrl: (url) => {
			console.log('Scan this QR code with LINE on your phone:');
			qrcode.generate(url, { small: true });
			console.log(url);
		},
		onPin: (pin) => console.log(`Enter this PIN in LINE on your phone: ${pin}`)
	});
	console.log(
		`Logged in as ${result.mid} (${result.firstLogin ? 'account bound' : 'bound account'}), ` +
			`${result.addedKeyGenerations} new E2EE key generation(s) stored`
	);
	return 0;
}

async function runStatus(): Promise<number> {
	const root = stateRoot();
	const path = databasePath(root);
	const status: Record<string, unknown> = { stateRoot: root, lockHeld: await lockInUse() };
	if (!existsSync(path)) {
		console.log(JSON.stringify({ ...status, account: null }, null, 2));
		return 0;
	}
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const keys = db
			.prepare('SELECT key FROM line_kv')
			.all()
			.map((row) => String(row.key));
		Object.assign(status, {
			account: readAccount(db) ?? null,
			tokenStored: keys.includes('authToken'),
			refreshTokenStored: keys.includes('refreshToken'),
			keyGenerations: keys.filter((key) => /^e2eeKeys:\d+$/.test(key)).length
		});
	} finally {
		db.close();
	}
	console.log(JSON.stringify(status, null, 2));
	return 0;
}

async function runProbe(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { dm: { type: 'string' }, group: { type: 'string' }, square: { type: 'string' } }
	});
	const methods: string[] = [];
	const log: Log = (entry) => {
		if (entry.event === 'upstream_call' || entry.event === 'upstream_blocked') {
			methods.push(String(entry.method));
		}
		stderrLog(entry);
	};
	const session = await openSession({ log });
	try {
		if (session.state() !== 'online') {
			throw new LineMcpError('needs_login', 'LINE ended the session; run line-mcp login');
		}
		const report = await probe(session, values);
		console.log(
			JSON.stringify(
				{
					...report,
					state: session.state(),
					upstreamMethods: methods,
					registrationCalls: methods.filter((method) => method.startsWith('register')).length
				},
				null,
				2
			)
		);
	} finally {
		await session.close();
	}
	return 0;
}

/** Connects to the lock port without binding it, so status never competes for ownership. */
function lockInUse(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port: lockPort() });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

const [command, ...args] = process.argv.slice(2);
let code: number;
try {
	code = await main(command, args);
} catch (error) {
	console.error(JSON.stringify(mapError(error, command ?? 'cli')));
	code = 1;
}
// LINEJS keeps HTTP connections alive; exit once the output is flushed.
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
process.exit(code);
