#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { archiveStatus } from './archive.ts';
import { startDaemon } from './daemon.ts';
import { readAccount } from './db.ts';
import { doctor } from './doctor.ts';
import { LineMcpError, mapError } from './errors.ts';
import {
	agentPaths,
	bootoutCommand,
	bootstrapCommand,
	type Command,
	describe,
	isCellarPath,
	renderPlist,
	runLaunchctl,
	selectNode
} from './launchd.ts';
import { acquireLock, lockInUse } from './lock.ts';
import { databasePath, stateRoot } from './paths.ts';
import { probe } from './probe.ts';
import { type Log, login, openSession, stderrLog } from './session.ts';

const usage = `Usage: line-mcp <command>

  login      Log in by QR code as a secondary Android device
  status     Show the bound account, session and sync state
  probe      Read-only live checks [--dm <mid>] [--group <mid>] [--square <mid>]
  daemon     Run the sync daemon (started by the LaunchAgent)
  install    Install and start the LaunchAgent [--dry-run] [--node <path>]
  uninstall  Stop and remove the LaunchAgent; keeps the archive [--dry-run] [--purge]
  doctor     Check the local setup without contacting LINE`;

/**
 * The real path of this file: `src/cli.ts` in a clone, `dist/cli.js` in the
 * npm package. Node resolves the global bin symlink for the entry module, so
 * the LaunchAgent and `doctor` name the file itself.
 */
const cliPath = fileURLToPath(import.meta.url);

async function main(command: string | undefined, args: string[]): Promise<number> {
	switch (command) {
		case 'login':
			return await runLogin();
		case 'status':
			return await runStatus();
		case 'probe':
			return await runProbe(args);
		case 'daemon':
			return await runDaemon();
		case 'install':
			return await runInstall(args);
		case 'uninstall':
			return await runUninstall(args);
		case 'doctor':
			return await runDoctor();
		case 'help':
		case '--help':
		case '-h':
			console.log(usage);
			return 0;
		default:
			console.error(usage);
			return 2;
	}
}

/**
 * The daemon holds the lock port, so an installed LaunchAgent is booted out
 * first and bootstrapped again once `login` has released the lock.
 */
async function runLogin(): Promise<number> {
	const { plist } = agentPaths();
	const installed = existsSync(plist);
	if (installed) await runLaunchctl(bootoutCommand());
	try {
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
	} finally {
		if (installed) await runLaunchctl(bootstrapCommand(plist));
	}
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
		const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
			user_version: number;
		};
		if (version >= 2) status.sync = archiveStatus(db);
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

/** Runs until SIGTERM (launchd bootout) or SIGINT; the lock listener keeps the process alive. */
async function runDaemon(): Promise<number> {
	const daemon = await startDaemon();
	stderrLog({ event: 'daemon_started', health: daemon.health() });
	await new Promise<void>((resolve) => {
		process.once('SIGTERM', resolve);
		process.once('SIGINT', resolve);
	});
	await daemon.stop();
	stderrLog({ event: 'daemon_stopped' });
	return 0;
}

async function run(commands: Command[], dryRun: boolean): Promise<void> {
	for (const command of commands) {
		if (dryRun) console.log(`would run: ${describe(command)}`);
		else await runLaunchctl(command);
	}
}

async function runInstall(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { 'dry-run': { type: 'boolean' }, node: { type: 'string' } }
	});
	const dryRun = values['dry-run'] === true;
	// npm may clear its npx cache at any time, and the LaunchAgent's CLI with it.
	if (cliPath.includes('/_npx/')) {
		const reason =
			'line-mcp runs from the npx cache; run npm i -g line-mcp-server, then line-mcp install';
		if (!dryRun) throw new LineMcpError('npx_cache', reason);
		console.error(`warning: install refuses this location: ${reason}`);
	}
	const paths = agentPaths();
	const node = selectNode({ override: values.node ?? process.env.LINE_MCP_NODE });
	if (isCellarPath(node.path)) {
		console.error(`warning: ${node.path} is a versioned Cellar path; brew upgrade removes it`);
	}
	const plist = renderPlist({
		node: node.path,
		cli: cliPath,
		log: paths.log,
		env: process.env
	});
	const commands = [bootoutCommand(), bootstrapCommand(paths.plist)];
	if (dryRun) {
		console.log(`would write ${paths.plist}:\n${plist}`);
		console.log(`would create ${paths.logDir} (0700)`);
	} else {
		mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
		chmodSync(paths.logDir, 0o700);
		mkdirSync(dirname(paths.plist), { recursive: true });
		writeFileSync(paths.plist, plist, { mode: 0o644 });
		console.log(`wrote ${paths.plist}`);
	}
	await run(commands, dryRun);
	return 0;
}

async function runUninstall(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { 'dry-run': { type: 'boolean' }, purge: { type: 'boolean' } }
	});
	const dryRun = values['dry-run'] === true;
	const paths = agentPaths();
	await run([bootoutCommand()], dryRun);
	if (dryRun) console.log(`would remove ${paths.plist}`);
	else rmSync(paths.plist, { force: true });
	const root = stateRoot();
	if (!values.purge) {
		console.log(`kept the archive in ${root}`);
		return 0;
	}
	if (dryRun) {
		console.log(`would delete ${root} once no process holds the lock port`);
		return 0;
	}
	// Taking the lock proves no daemon or login is still using the archive.
	const lock = await acquireLock();
	try {
		rmSync(root, { recursive: true, force: true });
	} finally {
		await lock.release();
	}
	console.log(`deleted ${root}`);
	return 0;
}

async function runDoctor(): Promise<number> {
	const checks = await doctor({
		root: stateRoot(),
		paths: agentPaths(),
		env: process.env,
		cli: cliPath
	});
	for (const check of checks) {
		const level = check.ok ? (check.warning ? 'warn' : 'ok  ') : 'FAIL';
		console.log(`${level} ${check.name}: ${check.detail}`);
	}
	return checks.every((check) => check.ok) ? 0 : 1;
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
