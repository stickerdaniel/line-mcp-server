#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archiveStatus } from './archive.ts';
import { type Daemon, startDaemon } from './daemon.ts';
import { openReadOnly, readAccount } from './db.ts';
import { doctor } from './doctor.ts';
import { LineMcpError, mapError } from './errors.ts';
import { acquireLock, lockInUse } from './lock.ts';
import { runLogin } from './login-cli.ts';
import { databasePath, stateRoot } from './paths.ts';
import { statePrivacy } from './privacy.ts';
import { probe } from './probe.ts';
import { serviceFor } from './service/index.ts';
import { selectNode, versionedLayout } from './service/node.ts';
import { toolRunner } from './service/runner.ts';
import { type Log, openSession, stderrLog } from './session.ts';
import { runToolCommand, toolCommands, toolUsage } from './tool-cli.ts';

const usage = `Usage: line-mcp <command>

  login      Log in by QR code as a secondary Android device
  status     Show the bound account, session and sync state
  probe      Read-only live checks [--dm <mid>] [--group <mid>] [--square <mid>]
  daemon     Run the sync daemon (started by the background service)
  install    Install and start the background service [--dry-run] [--node <path>]
  uninstall  Stop and remove the background service; keeps the archive [--dry-run] [--purge]
  doctor     Check the local setup without contacting LINE

Tool commands call the running daemon; line-mcp <command> --help lists the flags:

${toolUsage()}`;

/**
 * The real path of this file: `src/cli.ts` in a clone, `dist/cli.js` in the
 * npm package. Node resolves the global bin symlink for the entry module, so
 * the service definition and `doctor` name the file itself.
 */
const cliPath = fileURLToPath(import.meta.url);

/** This user's service manager, through the test seam when `LINE_MCP_SERVICE_RUNNER` is set. */
const service = () =>
	serviceFor(process.platform, { home: homedir(), env: process.env, runner: toolRunner() });

async function main(command: string | undefined, args: string[]): Promise<number> {
	switch (command) {
		case 'login':
			return await runLogin(service());
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

async function runStatus(): Promise<number> {
	const root = stateRoot();
	const path = databasePath(root);
	const status: Record<string, unknown> = { stateRoot: root, lockHeld: await lockInUse() };
	if (!existsSync(path)) {
		console.log(JSON.stringify({ ...status, account: null }, null, 2));
		return 0;
	}
	await statePrivacy().database(root);
	const db = openReadOnly(root);
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
 * Runs until SIGTERM (launchd bootout, systemctl stop), SIGINT or, when the Windows scheduled
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
	// The service starts in another directory, where a relative root names another archive.
	const home = process.env.LINE_MCP_HOME;
	if (home && !isAbsolute(home)) {
		throw new LineMcpError(
			'invalid_state_root',
			`LINE_MCP_HOME must be an absolute path, not ${home}`
		);
	}
	// npm may clear its npx cache at any time, and the service's CLI with it.
	if (/[\\/]_npx[\\/]/i.test(cliPath)) {
		const reason =
			'line-mcp runs from the npx cache; run npm i -g line-mcp-server, then line-mcp install';
		if (!dryRun) throw new LineMcpError('npx_cache', reason);
		console.error(`warning: install refuses this location: ${reason}`);
	}
	const agent = service();
	const node = selectNode({ override: values.node ?? process.env.LINE_MCP_NODE });
	for (const path of [node.path, cliPath]) {
		const layout = versionedLayout(path);
		if (layout) {
			console.error(
				`warning: ${path} is in a versioned ${layout} directory; the service fails once that version is gone`
			);
		}
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
		// On Windows, a root that is not private (a link, say) is not deleted.
		await statePrivacy().database(root);
		// Windows may hold a file a moment after the daemon closed it (antivirus, indexing).
		const retries = process.platform === 'win32' ? { maxRetries: 10, retryDelay: 200 } : {};
		rmSync(root, { recursive: true, force: true, ...retries });
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
		privacy: statePrivacy(),
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
	// The daemon's stderr is its service log, where every line carries its time.
	if (command === 'daemon') stderrLog({ event: 'daemon_failed', ...mapped });
	else console.error(JSON.stringify(mapped));
	code = 1;
}
// LINEJS keeps HTTP connections alive; exit once the output is flushed.
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
process.exit(code);
