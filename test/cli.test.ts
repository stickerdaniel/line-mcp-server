import { execFile, spawn } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { healthKey, writeState } from '../src/archive.ts';
import { openDatabase, setAuthState } from '../src/db.ts';
import { lockInUse, requestStop } from '../src/lock.ts';
import { selectNode } from '../src/service/node.ts';
import { databasePath } from '../src/paths.ts';
import { freePort, seedLive, selfMid, tempRoot, within } from './fake-line.ts';
import { callTool, cliEntry, type ToolCall } from './mcp-client.ts';

/** The real path of the CLI under test, which `install` writes into the LaunchAgent. */
const cli = realpathSync(cliEntry);

/**
 * A copy of the CLI's package under an npx cache path, sharing its
 * `node_modules`. Node runs an entry from its real path, so only a copy runs
 * from there. Not below `node_modules`: Node strips no types there.
 */
function npxCopy(): string {
	const pkg = dirname(dirname(cli));
	const copy = join(tempRoot(), '_npx', '0a1b2c3d4e5f', 'line-mcp-server');
	for (const part of [relative(pkg, dirname(cli)), 'service', 'package.json']) {
		cpSync(join(pkg, part), join(copy, part), { recursive: true });
	}
	symlinkSync(join(pkg, 'node_modules'), join(copy, 'node_modules'));
	return join(copy, relative(pkg, cli));
}

/** A link to the running Node at `<dir>/node`, standing in for a Homebrew layout. */
function nodeAt(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'node');
	symlinkSync(process.execPath, path);
	return path;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

const serviceRunner = fileURLToPath(new URL('fixtures/service-runner.ts', import.meta.url));

/**
 * Runs the CLI with a temporary HOME and state root. Every launchctl call goes
 * to the service runner fixture, which only records it, so the test proves dry
 * runs execute nothing. It exits 0, except with the code `exits` names for a
 * subcommand; `print` defaults to 113, launchctl's answer for a service that
 * is not loaded.
 */
async function runCli(
	args: string[],
	home = tempRoot(),
	env: NodeJS.ProcessEnv = {},
	exits: Record<string, number> = {},
	script = cliEntry
) {
	const state = join(home, 'state');
	const calls = join(home, 'service-calls');
	const lockPort = await freePort();
	const replies = Object.fromEntries(
		Object.entries(exits).map(([command, exit]) => [command, { exit }])
	);
	const run = await new Promise<Run>((resolve) => {
		execFile(
			process.execPath,
			[script, ...args],
			{
				env: {
					...process.env,
					HOME: home,
					LINE_MCP_HOME: state,
					LINE_MCP_LOCK_PORT: String(lockPort),
					LINE_MCP_SERVICE_RUNNER: serviceRunner,
					LINE_MCP_SERVICE_CALLS: calls,
					LINE_MCP_SERVICE_SCRIPT: JSON.stringify(replies),
					...env
				}
			},
			(error, stdout, stderr) =>
				resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});
	const launched = existsSync(calls)
		? readFileSync(calls, 'utf-8')
				.trimEnd()
				.split('\n')
				.map((line) => JSON.parse(line) as string[])
		: [];
	return { ...run, home, state, launched: launched.length > 0, calls: launched };
}

const domain = `gui/${userInfo().uid}`;
const agent = `${domain}/io.github.stickerdaniel.line-mcp`;
const plistIn = (home: string) =>
	join(home, 'Library', 'LaunchAgents', 'io.github.stickerdaniel.line-mcp.plist');

/** `uninstall` over an installed plist, with launchctl's `bootout` exiting `bootout`. */
async function uninstall(bootout: number) {
	const home = tempRoot();
	const plist = plistIn(home);
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, '');
	const result = await runCli(['uninstall'], home, {}, { bootout });
	return { ...result, plistKept: existsSync(plist) };
}

// Each CLI run is a cold Node start that loads the whole server; under load it can pass 5 s.
describe('install and uninstall', { timeout: 15_000 }, () => {
	it('prints the LaunchAgent and launchctl commands on a dry run and changes nothing', async () => {
		const result = await runCli(['install', '--dry-run'], tempRoot(), { LINE_MCP_PORT: '47900' });

		expect(result.code).toBe(0);
		// Not even a read-only launchctl call, let alone bootout or bootstrap.
		expect(result.calls).toEqual([]);
		expect(readdirSync(result.home)).toEqual([]);
		const plist = result.stdout;
		for (const setting of [
			'<string>io.github.stickerdaniel.line-mcp</string>',
			`<string>${cli}</string>`,
			'<string>daemon</string>',
			'<key>RunAtLoad</key>\n\t<true/>',
			'<key>KeepAlive</key>\n\t<true/>',
			'<key>ThrottleInterval</key>\n\t<integer>30</integer>',
			'<key>Umask</key>\n\t<integer>63</integer>',
			`<key>LINE_MCP_HOME</key>\n\t\t<string>${result.state}</string>`,
			'<key>LINE_MCP_PORT</key>\n\t\t<string>47900</string>',
			join(result.home, 'Library', 'Logs', 'line-mcp', 'daemon.log')
		]) {
			expect(plist).toContain(setting);
		}
		expect(plist).not.toContain('{{');
		// The Node path must survive `brew upgrade`: never a versioned Cellar directory.
		expect(plist).not.toMatch(/<string>[^<]*\/Cellar\/[^<]*<\/string>/);
		const launchctl = `${process.execPath} ${serviceRunner} launchctl`;
		expect(plist).toContain(
			`\nwould run: ${launchctl} bootout ${agent}\n` +
				`would run: ${launchctl} bootstrap ${domain} ${plistIn(result.home)}\n`
		);
	});

	it('installs the real CLI file when started through a global bin symlink', async () => {
		const bin = join(tempRoot(), 'bin', 'line-mcp');
		mkdirSync(dirname(bin));
		symlinkSync(cliEntry, bin);

		const result = await runCli(['install'], tempRoot(), {}, {}, bin);

		expect(result.code).toBe(0);
		expect(readFileSync(plistIn(result.home), 'utf-8')).toContain(
			`<string>${cli}</string>\n\t\t<string>daemon</string>`
		);
		expect(result.calls).toEqual([
			['launchctl', 'bootout', agent],
			['launchctl', 'print', agent],
			['launchctl', 'bootstrap', domain, plistIn(result.home)]
		]);
	});

	it('refuses to install from the npx cache, which npm may delete', async () => {
		const install = await runCli(['install'], tempRoot(), {}, {}, npxCopy());

		expect(install.code).toBe(1);
		expect(install.stderr).toContain('npm i -g line-mcp-server');
		expect(install.launched).toBe(false);
		expect(readdirSync(install.home)).toEqual([]);
	});

	it('still shows the LaunchAgent on a dry run from the npx cache, with the same advice', async () => {
		const copy = npxCopy();

		const dryRun = await runCli(['install', '--dry-run'], tempRoot(), {}, {}, copy);

		expect(dryRun.code).toBe(0);
		expect(dryRun.stderr).toContain('npm i -g line-mcp-server');
		expect(dryRun.stdout).toContain(`<string>${realpathSync(copy)}</string>`);
		expect(dryRun.launched).toBe(false);
	});

	// One CLI process per case: two in one test can outlast the default timeout on a loaded machine.
	it.each(['--node', 'LINE_MCP_NODE'])(
		'writes a validated Node override from %s into the LaunchAgent',
		async (source) => {
			const node = nodeAt(join(tempRoot(), 'bin'));

			const result =
				source === '--node'
					? await runCli(['install', '--dry-run', '--node', node])
					: await runCli(['install', '--dry-run'], tempRoot(), { LINE_MCP_NODE: node });

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				`<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${node}</string>`
			);
		}
	);

	it.each([
		// A working Node, but relative: launchd would resolve it against another directory.
		['relative', () => relative(process.cwd(), nodeAt(join(tempRoot(), 'bin')))],
		[
			'not executable',
			() => {
				const path = join(tempRoot(), 'node');
				writeFileSync(path, '');
				return path;
			}
		]
	])('refuses a Node override that is %s', async (_kind, override) => {
		const result = await runCli(['install', '--dry-run', '--node', override()]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('invalid_node');
		expect(result.stdout).not.toContain('would write');
		expect(result.launched).toBe(false);
	});

	it('uses the Homebrew opt link for a Node running from a versioned Cellar path', () => {
		const prefix = tempRoot();
		const cellar = nodeAt(join(prefix, 'Cellar', 'node@24', '24.18.0', 'bin'));
		const opt = nodeAt(join(prefix, 'opt', 'node@24', 'bin'));

		expect(selectNode({ execPath: cellar, stable: join(prefix, 'missing') })).toEqual({
			path: opt,
			source: 'stable'
		});
	});

	it.each([
		[[], 'kept the archive in'],
		[['--purge'], 'would delete']
	])('changes nothing on an uninstall dry run with %j', async (flags, line) => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['uninstall', '--dry-run', ...flags], home);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${line} ${result.state}`);
		expect(result.launched).toBe(false);
		expect(existsSync(databasePath(result.state))).toBe(true);
	});

	it('runs doctor offline and reports the missing LaunchAgent', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['doctor'], home);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`ok   account: ${selfMid} on ANDROIDSECONDARY, active`);
		expect(result.stdout).toContain(
			`FAIL launch_agent: ${plistIn(home)} missing; run line-mcp install\n` +
				'FAIL launch_agent_loaded: io.github.stickerdaniel.line-mcp is not loaded'
		);
		// Only the read-only `print`: doctor never boots the agent in or out.
		expect(result.calls).toEqual([['launchctl', 'print', agent]]);
	});

	it.each([
		[0, 'ok   launch_agent_loaded: io.github.stickerdaniel.line-mcp is loaded'],
		[113, 'FAIL launch_agent_loaded: io.github.stickerdaniel.line-mcp is not loaded'],
		[5, 'FAIL launch_agent_loaded: launchctl print failed (5)']
	])(
		'reports in doctor whether launchd has the agent loaded (print exits %i)',
		async (print, line) => {
			const home = tempRoot();
			seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

			const result = await runCli(['doctor'], home, {}, { print });

			expect(result.stdout).toContain(line);
		}
	);

	it.each([3, 113])(
		'treats a not-loaded agent as booted out (bootout exits %i)',
		async (bootout) => {
			const result = await uninstall(bootout);

			expect([result.code, result.plistKept]).toEqual([0, false]);
			expect(result.calls).toEqual([['launchctl', 'bootout', agent]]);
		}
	);

	it('surfaces other launchctl errors on uninstall and keeps the plist', async () => {
		const failed = await uninstall(5);

		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain('launchctl bootout failed (5)');
		// A failed bootout may leave the agent running: its plist stays for a retry.
		expect(failed.plistKept).toBe(true);
	});

	it('warns in doctor when the selected Node is a versioned Cellar path', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });
		const node = nodeAt(join(tempRoot(), 'Cellar', 'node@24', '24.18.0', 'bin'));

		const result = await runCli(['doctor'], home, { LINE_MCP_NODE: node });

		expect(result.stdout).toContain(`ok   node: ${node}`);
		expect(result.stdout).toContain(`warn node_path: ${node} is a versioned Cellar path`);
	});
});

// One cold CLI start per test, as above.
describe('commands', { timeout: 15_000 }, () => {
	it('prints the usage on --help and exits 0', async () => {
		const result = await runCli(['--help']);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Usage: line-mcp <command>');
	});

	it('logs a failed daemon start with its time', async () => {
		const holder = createServer();
		const port = await freePort();
		await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
		let result: Awaited<ReturnType<typeof runCli>>;
		try {
			result = await runCli(['daemon'], tempRoot(), { LINE_MCP_LOCK_PORT: String(port) });
		} finally {
			holder.close();
		}

		expect(result.code).toBe(1);
		const lines = result.stderr.trimEnd().split('\n');
		expect(lines).toHaveLength(1);
		const line = JSON.parse(lines[0]!) as { time: string };
		expect(line).toMatchObject({ event: 'daemon_failed', code: 'lock_held', operation: 'daemon' });
		expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	// The timeout covers the 10 s start deadline in serving() plus the 5 s exit wait.
	it('serves a cache-only archive over MCP and stops on SIGTERM', async () => {
		const home = tempRoot();
		const state = join(home, 'state');
		cacheOnly(state);
		const port = await freePort();
		const daemon = spawn(process.execPath, [cliEntry, 'daemon'], {
			env: {
				...process.env,
				HOME: home,
				LINE_MCP_HOME: state,
				LINE_MCP_LOCK_PORT: String(await freePort()),
				LINE_MCP_PORT: String(port)
			},
			stdio: 'ignore'
		});
		const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));

		let status: ToolCall;
		try {
			status = await serving(port);
		} finally {
			daemon.kill('SIGTERM');
		}

		expect(status.data).toMatchObject({
			health: 'needs_login',
			stale: true,
			account: { mid: selfMid, auth_state: 'needs_login' }
		});
		expect(await within(5000, exited, 'the daemon to exit')).toBe(0);
	}, 20_000);

	// No signal reaches a daemon run as a Windows scheduled task; this request
	// does. A daemon the user runs by hand ignores it.
	it.each([
		['started by the scheduled task, stops', 'task'],
		['run by hand, ignores it', undefined]
	])(
		'on a stop request over the lock port, a daemon %s',
		async (_kind, service) => {
			const home = tempRoot();
			const state = join(home, 'state');
			cacheOnly(state);
			const lockPort = await freePort();
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: home,
				LINE_MCP_HOME: state,
				LINE_MCP_LOCK_PORT: String(lockPort),
				LINE_MCP_PORT: String(await freePort())
			};
			delete env.LINE_MCP_SERVICE;
			if (service) env.LINE_MCP_SERVICE = service;
			const daemon = spawn(process.execPath, [cliEntry, 'daemon'], {
				env,
				stdio: ['ignore', 'ignore', 'pipe']
			});
			let stderr = '';
			daemon.stderr.setEncoding('utf-8').on('data', (chunk: string) => (stderr += chunk));
			const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
			try {
				await within(
					10_000,
					(async () => {
						while (!stderr.includes('"daemon_started"')) {
							await new Promise((resolve) => setTimeout(resolve, 50));
						}
					})(),
					'the daemon to start'
				);

				const stopping = requestStop(lockPort, { deadlineMs: 5000 });
				if (!service) {
					await expect(stopping).rejects.toMatchObject({ code: 'stop_timeout' });
					expect(await lockInUse(lockPort)).toBe(true);
					daemon.kill('SIGKILL');
					return;
				}
				await expect(stopping).resolves.toBe('stopped');
			} catch (error) {
				daemon.kill('SIGKILL');
				throw error;
			}

			expect(await within(5000, exited, 'the daemon to exit')).toBe(0);
			expect(stderr).toContain('"event":"daemon_stopped"');
			expect(await lockInUse(lockPort)).toBe(false);
		},
		20_000
	);
});

/**
 * A state root whose session LINE ended before, so the daemon starts without
 * calling LINE and, with the health unchanged, raises no notification.
 */
function cacheOnly(state: string): void {
	seedLive(state, selfMid, { authToken: 'token' });
	const db = openDatabase(state);
	setAuthState(db, 'needs_login');
	writeState(db, healthKey, { state: 'needs_login', since: Date.now() });
	db.close();
}

/** `status` from the daemon on `port` once it listens; gives up after 10 s. */
async function serving(port: number): Promise<ToolCall> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			return await callTool(port, 'status');
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}
