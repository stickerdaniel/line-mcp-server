#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { archiveStatus } from './archive.ts';
import { type Daemon, startDaemon } from './daemon.ts';
import { readAccount } from './db.ts';
import { doctor } from './doctor.ts';
import { LineMcpError, mapError } from './errors.ts';
import { acquireLock, lockInUse } from './lock.ts';
import { databasePath, stateRoot } from './paths.ts';
import { probe } from './probe.ts';
import { serviceFor } from './service/index.ts';
import { isCellarPath, selectNode } from './service/node.ts';
import { toolRunner } from './service/runner.ts';
import { type Log, login, openSession, stderrLog } from './session.ts';
import { runToolCommand, toolCommands, toolUsage } from './tool-cli.ts';

const usage = `Usage: line-mcp <command>

  login      Log in by QR code as a secondary Android device
  status     Show the bound account, session and sync state
  probe      Read-only live checks [--dm <mid>] [--group <mid>] [--square <mid>]
  daemon     Run the sync daemon (started by the LaunchAgent)
  install    Install and start the LaunchAgent [--dry-run] [--node <path>]
  uninstall  Stop and remove the LaunchAgent; keeps the archive [--dry-run] [--purge]
  doctor     Check the local setup without contacting LINE

Tool commands call the running daemon; line-mcp <command> --help lists the flags:

${toolUsage()}`;

/**
 * The real path of this file: `src/cli.ts` in a clone, `dist/cli.js` in the
 * npm package. Node resolves the global bin symlink for the entry module, so
 * the LaunchAgent and `doctor` name the file itself.
 */
const cliPath = fileURLToPath(import.meta.url);

/** This user's service manager, through the test seam when `LINE_MCP_SERVICE_RUNNER` is set. */
const service = () =>
	serviceFor(process.platform, { home: homedir(), env: process.env, runner: toolRunner() });

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
		default: {
			const tool = toolCommands.get(command ?? '');
			if (tool) return await runToolCommand(tool, args);
			console.error(usage);
			return 2;
		}
	}
}

/**
 * The daemon holds the lock port, so an installed service is stopped first
 * and started again once `login` has released the lock.
 */
async function runLogin(): Promise<number> {
	const agent = service();
	const installed = agent.installed();
	if (installed) await agent.stop();
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
		if (installed) await agent.start();
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

/**
 * Runs until SIGTERM (launchd bootout), SIGINT or, when the Windows scheduled
 * task started it, a stop request over the lock port (`requestStop`); the lock
 * listener keeps the process alive. Each of them also cancels a startup still
 * in progress.
 */
async function runDaemon(): Promise<number> {
	const stop = new AbortController();
	const abort = () => stop.abort();
	process.once('SIGTERM', abort);
	process.once('SIGINT', abort);
	// Only a daemon that the Windows scheduled task started accepts a stop
	// request (its launcher sets LINE_MCP_SERVICE=task), so stopping the service
	// never ends a daemon the user runs by hand.
	const onStopRequest = process.env.LINE_MCP_SERVICE === 'task' ? abort : undefined;
	let daemon: Daemon;
	try {
		daemon = await startDaemon({ signal: stop.signal, onStopRequest });
	} catch (error) {
		if (!(error instanceof LineMcpError && error.code === 'shutting_down')) throw error;
		stderrLog({ event: 'daemon_stopped' });
		return 0;
	}
	stderrLog({ event: 'daemon_started', health: daemon.health() });
	if (!stop.signal.aborted) await once(stop.signal, 'abort');
	await daemon.stop();
	stderrLog({ event: 'daemon_stopped' });
	return 0;
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
	const agent = service();
	const node = selectNode({ override: values.node ?? process.env.LINE_MCP_NODE });
	if (isCellarPath(node.path)) {
		console.error(`warning: ${node.path} is a versioned Cellar path; brew upgrade removes it`);
	}
	const definition = agent.render({ node: node.path, cli: cliPath, env: process.env });
	await agent.install(definition, { dryRun });
	return 0;
}

async function runUninstall(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { 'dry-run': { type: 'boolean' }, purge: { type: 'boolean' } }
	});
	const dryRun = values['dry-run'] === true;
	await service().uninstall({ dryRun });
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
		service: service(),
		env: process.env,
		cli: cliPath
	});
	for (const check of checks) {
		const level = check.ok ? (check.warning ? 'warn' : 'ok  ') : 'FAIL';
		console.log(`${level} ${check.name}: ${check.detail}`);
	}
	return checks.every((check) => check.ok) ? 0 : 1;
}

// A reader that stops early (`line-mcp list-chats | head`) closes the pipe. The
// rest of the output has no reader; the command still finishes and exits with
// its own code.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code !== 'EPIPE') throw error;
});

const [command, ...args] = process.argv.slice(2);
let code: number;
try {
	code = await main(command, args);
} catch (error) {
	const mapped = mapError(error, command ?? 'cli');
	// The daemon's stderr is its launchd log, where every line carries its time.
	if (command === 'daemon') stderrLog({ event: 'daemon_failed', ...mapped });
	else console.error(JSON.stringify(mapped));
	code = 1;
}
// LINEJS keeps HTTP connections alive; exit once the output is flushed.
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
process.exit(code);
