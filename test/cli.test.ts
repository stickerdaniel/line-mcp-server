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
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { healthKey, writeState } from '../src/archive.ts';
import { openDatabase, setAuthState } from '../src/db.ts';
import { lockInUse, requestStop } from '../src/lock.ts';
import { selectNode } from '../src/service/node.ts';
import { databasePath } from '../src/paths.ts';
import { freePort, nodeAt, seedLive, selfMid, tempRoot, within } from './fake-line.ts';
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
	// A junction on Windows, where a directory symlink needs a privilege; ignored elsewhere.
	symlinkSync(join(pkg, 'node_modules'), join(copy, 'node_modules'), 'junction');
	return join(copy, relative(pkg, cli));
}

const windows = process.platform === 'win32';
const linux = process.platform === 'linux';

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

const serviceRunner = fileURLToPath(new URL('fixtures/service-runner.ts', import.meta.url));

interface Reply {
	exit?: number;
	stdout?: string;
}

interface RunOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Exit codes of the fake service manager tools by subcommand. */
	exits?: Record<string, number>;
	/** Full replies by subcommand, a list for successive calls (test/fixtures/service-runner.ts). */
	replies?: Record<string, Reply | Reply[]>;
	/** The CLI entry to run; the CLI under test by default. */
	script?: string;
	cwd?: string;
}

/**
 * Runs the CLI with a temporary home and state root. Every service manager
 * call goes to the service runner fixture, which only records it, so the test
 * proves dry runs execute nothing. It exits 0, except with the code `exits`
 * names for a subcommand or the reply `replies` gives; `print` defaults to
 * 113, launchctl's answer for a service that is not loaded. XDG directories
 * default to the temporary home.
 */
async function runCli(
	args: string[],
	{ home = tempRoot(), env = {}, exits = {}, replies = {}, script = cliEntry, cwd }: RunOptions = {}
) {
	const state = join(home, 'state');
	const calls = join(home, 'service-calls');
	const lockPort = await freePort();
	const serviceScript = {
		...Object.fromEntries(Object.entries(exits).map(([command, exit]) => [command, { exit }])),
		...replies
	};
	const base: NodeJS.ProcessEnv = { ...process.env };
	for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) delete base[name];
	const run = await new Promise<Run>((resolve) => {
		execFile(
			process.execPath,
			[script, ...args],
			{
				cwd,
				env: {
					...base,
					// os.homedir() reads USERPROFILE on Windows.
					HOME: home,
					USERPROFILE: home,
					LINE_MCP_HOME: state,
					LINE_MCP_LOCK_PORT: String(lockPort),
					LINE_MCP_SERVICE_RUNNER: serviceRunner,
					LINE_MCP_SERVICE_CALLS: calls,
					LINE_MCP_SERVICE_SCRIPT: JSON.stringify(serviceScript),
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
// The launchd backend joins its paths with `/` on every OS.
const plistIn = (home: string) =>
	posix.join(home, 'Library', 'LaunchAgents', 'io.github.stickerdaniel.line-mcp.plist');
const unitIn = (home: string) => posix.join(home, '.config', 'systemd', 'user', 'line-mcp.service');

/** `systemctl --user show` output for the unit. */
function unitState(load: string, active: string, fragment = ''): Reply {
	return {
		stdout:
			`LoadState=${load}\nActiveState=${active}\nUnitFileState=\n` +
			`FragmentPath=${fragment}\nNeedDaemonReload=no\n`
	};
}

/**
 * The CLI's service manager on this OS: systemd on Linux, launchd everywhere
 * else until Windows gets its own backend. Each gives the definition path,
 * the text that runs a Node and a CLI, and the fixture replies and calls of an
 * install under `home`.
 */
const host = linux
	? {
			definitionIn: unitIn,
			starts: (node: string) => `\nExecStart="${node}" `,
			runs: (entry: string) => ` "${entry}" daemon\n`,
			install: (home: string) => ({
				replies: {
					show: [unitState('not-found', 'inactive'), unitState('loaded', 'inactive', unitIn(home))]
				},
				calls: [
					['systemctl', '--user', 'show', 'line-mcp.service', expect.any(String)],
					['systemctl', '--user', 'daemon-reload'],
					['systemctl', '--user', 'show', 'line-mcp.service', expect.any(String)],
					['systemctl', '--user', 'enable', 'line-mcp.service'],
					['systemctl', '--user', 'start', 'line-mcp.service']
				]
			})
		}
	: {
			definitionIn: plistIn,
			starts: (node: string) =>
				`<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${node}</string>`,
			runs: (entry: string) => `<string>${entry}</string>\n\t\t<string>daemon</string>`,
			install: (home: string) => ({
				replies: {},
				calls: [
					['launchctl', 'bootout', agent],
					['launchctl', 'bootstrap', domain, plistIn(home)]
				]
			})
		};

/** `uninstall` over an installed plist, with launchctl subcommands exiting as `exits` says. */
async function uninstall(exits: Record<string, number>) {
	const home = tempRoot();
	const plist = plistIn(home);
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, '');
	const result = await runCli(['uninstall'], { home, exits });
	return { ...result, plistKept: existsSync(plist) };
}

// Each CLI run is a cold Node start that loads the whole server; under load it can pass 5 s.
describe('install and uninstall', { timeout: 15_000 }, () => {
	// launchd is the backend on every OS but Linux until Windows gets its own.
	it.skipIf(linux)(
		'prints the LaunchAgent and launchctl commands on a dry run and changes nothing',
		async () => {
			const result = await runCli(['install', '--dry-run'], { env: { LINE_MCP_PORT: '47900' } });

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
				posix.join(result.home, 'Library', 'Logs', 'line-mcp', 'daemon.log')
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
		}
	);

	it.runIf(linux)(
		'prints the unit and systemctl commands on a dry run and changes nothing',
		async () => {
			const result = await runCli(['install', '--dry-run'], { env: { LINE_MCP_PORT: '47900' } });

			expect(result.code).toBe(0);
			// Not even the read-only show.
			expect(result.calls).toEqual([]);
			expect(readdirSync(result.home)).toEqual([]);
			const log = posix.join(result.home, '.local', 'state', 'line-mcp', 'daemon.log');
			for (const line of [
				`would write ${unitIn(result.home)}:\n[Unit]\n`,
				`\nExecStart="${process.execPath}" "${cli}" daemon\n`,
				`\nEnvironment="LINE_MCP_HOME=${result.state}"\n`,
				'\nEnvironment="LINE_MCP_PORT=47900"\n',
				`\nStandardOutput=append:${log}\n`,
				'\nRestart=always\n',
				'\nUMask=0077\n'
			]) {
				expect(result.stdout).toContain(line);
			}
			const systemctl = `${process.execPath} ${serviceRunner} systemctl --user`;
			expect(result.stdout).toContain(
				`would run: ${systemctl} stop line-mcp.service\n` +
					`would run: ${systemctl} daemon-reload\n` +
					`would run: ${systemctl} enable line-mcp.service\n` +
					`would run: ${systemctl} start line-mcp.service\n`
			);
		}
	);

	// The service starts in another directory, where a relative root names another archive.
	it('refuses a relative LINE_MCP_HOME', async () => {
		const result = await runCli(['install', '--dry-run'], {
			env: { LINE_MCP_HOME: join('relative', 'state') }
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"code":"invalid_state_root"');
		expect(result.stdout).not.toContain('would write');
		expect(result.launched).toBe(false);
	});

	// npm installs global bins on Windows as .cmd shims, and a symlink there needs a privilege.
	it.skipIf(windows)(
		'installs the real CLI file when started through a global bin symlink',
		async () => {
			const home = tempRoot();
			const bin = join(tempRoot(), 'bin', 'line-mcp');
			mkdirSync(dirname(bin));
			symlinkSync(cliEntry, bin);
			const { replies, calls } = host.install(home);

			const result = await runCli(['install'], { home, script: bin, replies });

			expect(result.code).toBe(0);
			expect(readFileSync(host.definitionIn(home), 'utf-8')).toContain(host.runs(cli));
			// launchd's `print` only reads, so the mutations are what counts.
			expect(result.calls.filter(([, command]) => command !== 'print')).toEqual(calls);
		}
	);

	it('refuses to install from the npx cache, which npm may delete', async () => {
		const install = await runCli(['install'], { script: npxCopy() });

		expect(install.code).toBe(1);
		expect(install.stderr).toContain('npm i -g line-mcp-server');
		expect(install.launched).toBe(false);
		expect(readdirSync(install.home)).toEqual([]);
	});

	it('still shows the service definition on a dry run from the npx cache, with the same advice', async () => {
		const copy = npxCopy();

		const dryRun = await runCli(['install', '--dry-run'], { script: copy });

		expect(dryRun.code).toBe(0);
		expect(dryRun.stderr).toContain('npm i -g line-mcp-server');
		expect(dryRun.stdout).toContain(host.runs(realpathSync(copy)));
		expect(dryRun.launched).toBe(false);
	});

	// One CLI process per case: two in one test can outlast the default timeout on a loaded machine.
	it.each(['--node', 'LINE_MCP_NODE'])(
		'writes a validated Node override from %s into the service definition',
		async (source) => {
			const node = nodeAt(join(tempRoot(), 'bin'));

			const result =
				source === '--node'
					? await runCli(['install', '--dry-run', '--node', node])
					: await runCli(['install', '--dry-run'], { env: { LINE_MCP_NODE: node } });

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(host.starts(node));
		}
	);

	it.each([
		// A working Node from the CLI's directory, but relative: launchd would
		// resolve it against another directory.
		[
			'relative',
			() => {
				const cwd = tempRoot();
				return { cwd, node: relative(cwd, nodeAt(join(cwd, 'bin'))) };
			}
		],
		[
			'not executable',
			() => {
				const node = join(tempRoot(), 'node');
				writeFileSync(node, '');
				return { node, cwd: process.cwd() };
			}
		]
	])('refuses a Node override that is %s', async (_kind, override) => {
		const { node, cwd } = override();
		const result = await runCli(['install', '--dry-run', '--node', node], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('invalid_node');
		expect(result.stdout).not.toContain('would write');
		expect(result.launched).toBe(false);
	});

	// Homebrew layouts exist only on macOS and Linux.
	it.skipIf(windows)(
		'uses the Homebrew opt link for a Node running from a versioned Cellar path',
		() => {
			const prefix = tempRoot();
			const cellar = nodeAt(join(prefix, 'Cellar', 'node@24', '24.18.0', 'bin'));
			const opt = nodeAt(join(prefix, 'opt', 'node@24', 'bin'));

			expect(selectNode({ execPath: cellar, stable: join(prefix, 'missing') })).toEqual({
				path: opt,
				source: 'stable'
			});
		}
	);

	it.each([
		[[], 'kept the archive in'],
		[['--purge'], 'would delete']
	])('changes nothing on an uninstall dry run with %j', async (flags, line) => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['uninstall', '--dry-run', ...flags], { home });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${line} ${result.state}`);
		expect(result.launched).toBe(false);
		expect(existsSync(databasePath(result.state))).toBe(true);
	});

	it.runIf(linux)('runs doctor offline and reports the missing unit', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['doctor'], {
			home,
			replies: {
				show: unitState('not-found', 'inactive'),
				'show-user': { stdout: 'Linger=yes\n' }
			}
		});

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(
			`FAIL systemd_unit: ${unitIn(home)} missing; run line-mcp install\n` +
				'FAIL systemd_unit_loaded: line-mcp.service is not-found; run line-mcp install\n' +
				'FAIL systemd_unit_active: line-mcp.service is inactive'
		);
		expect(result.stdout).toContain('ok   linger: on');
		// Only queries: doctor never starts, stops or reloads anything.
		expect(result.calls.map((call) => call.slice(0, 3))).toEqual([
			['systemctl', '--user', 'show'],
			['loginctl', 'show-user', String(userInfo().uid)]
		]);
	});

	it.skipIf(linux)('runs doctor offline and reports the missing LaunchAgent', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

		const result = await runCli(['doctor'], { home });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`ok   account: ${selfMid} on ANDROIDSECONDARY, active`);
		expect(result.stdout).toContain(
			`FAIL launch_agent: ${plistIn(home)} missing; run line-mcp install\n` +
				'FAIL launch_agent_loaded: io.github.stickerdaniel.line-mcp is not loaded'
		);
		// Only the read-only `print`: doctor never boots the agent in or out.
		expect(result.calls).toEqual([['launchctl', 'print', agent]]);
	});

	it.skipIf(linux).each([
		[0, 'ok   launch_agent_loaded: io.github.stickerdaniel.line-mcp is loaded'],
		[113, 'FAIL launch_agent_loaded: io.github.stickerdaniel.line-mcp is not loaded'],
		[5, 'FAIL launch_agent_loaded: launchctl print failed (5)']
	])(
		'reports in doctor whether launchd has the agent loaded (print exits %i)',
		async (print, line) => {
			const home = tempRoot();
			seedLive(join(home, 'state'), selfMid, { authToken: 'token' });

			const result = await runCli(['doctor'], { home, exits: { print } });

			expect(result.stdout).toContain(line);
		}
	);

	it.skipIf(linux).each([3, 113])(
		'treats a not-loaded agent as booted out (bootout exits %i)',
		async (bootout) => {
			const result = await uninstall({ bootout });

			expect([result.code, result.plistKept]).toEqual([0, false]);
			expect(result.calls).toEqual([['launchctl', 'bootout', agent]]);
		}
	);

	it.skipIf(linux)('surfaces other launchctl errors on uninstall and keeps the plist', async () => {
		const failed = await uninstall({ bootout: 5, print: 5 });

		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain('launchctl bootout failed (5)');
		// launchd cannot say whether the agent is gone, so its plist stays for a retry.
		expect(failed.plistKept).toBe(true);
	});

	it('warns in doctor when the selected Node is in a versioned directory', async () => {
		const home = tempRoot();
		seedLive(join(home, 'state'), selfMid, { authToken: 'token' });
		const node = nodeAt(join(tempRoot(), '.nvm', 'versions', 'node', 'v24.18.0', 'bin'));

		const result = await runCli(['doctor'], { home, env: { LINE_MCP_NODE: node } });

		expect(result.stdout).toContain(`ok   node: ${node}`);
		expect(result.stdout).toContain(`warn node_path: ${node} is in a versioned nvm directory`);
	});

	it.each([
		['installed', true],
		['not installed', false]
	])('hands the lock over around a login while the service is %s', async (_kind, installed) => {
		const home = tempRoot();
		if (installed) {
			mkdirSync(dirname(host.definitionIn(home)), { recursive: true });
			writeFileSync(host.definitionIn(home), '');
		}
		// A held lock fails the login before it reaches LINE.
		const holder = createServer();
		const port = await freePort();
		await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
		let result: Awaited<ReturnType<typeof runCli>>;
		try {
			result = await runCli(['login'], {
				home,
				env: { LINE_MCP_LOCK_PORT: String(port) },
				replies: { show: unitState('loaded', 'active', unitIn(home)) }
			});
		} finally {
			holder.close();
		}

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"code":"lock_held"');
		const stopAndRestore = linux
			? [
					['systemctl', '--user', 'show', 'line-mcp.service', expect.any(String)],
					['systemctl', '--user', 'stop', 'line-mcp.service'],
					['systemctl', '--user', 'start', 'line-mcp.service']
				]
			: [
					['launchctl', 'bootout', agent],
					['launchctl', 'bootstrap', domain, plistIn(home)]
				];
		expect(result.calls.filter(([, command]) => command !== 'print')).toEqual(
			installed ? stopAndRestore : []
		);
	});

	it('fails with service_restore_failed when the service does not come back', async () => {
		const home = tempRoot();
		mkdirSync(dirname(host.definitionIn(home)), { recursive: true });
		writeFileSync(host.definitionIn(home), '');
		const holder = createServer();
		const port = await freePort();
		await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
		let result: Awaited<ReturnType<typeof runCli>>;
		try {
			result = await runCli(['login'], {
				home,
				env: { LINE_MCP_LOCK_PORT: String(port) },
				// systemd: active before the stop, still inactive after the failed start.
				replies: {
					show: [unitState('loaded', 'active', unitIn(home)), unitState('loaded', 'inactive')],
					start: { exit: 1 },
					bootstrap: { exit: 5 }
				}
			});
		} finally {
			holder.close();
		}

		expect(result.code).toBe(1);
		const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!) as Record<string, string>;
		expect(error.code).toBe('service_restore_failed');
		expect(error.message).toContain('Run line-mcp install');
		expect(error.message).toContain(
			'The login failed too: Another process holds the line-mcp lock port'
		);
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
			result = await runCli(['daemon'], { env: { LINE_MCP_LOCK_PORT: String(port) } });
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
	it('serves a cache-only archive over MCP', async () => {
		const daemon = await cacheOnlyDaemon();
		try {
			expect((await serving(daemon.port)).data).toMatchObject({
				health: 'needs_login',
				stale: true,
				account: { mid: selfMid, auth_state: 'needs_login' }
			});
		} finally {
			daemon.child.kill();
		}
	}, 20_000);

	// Windows has no SIGTERM: kill() there terminates the process at once.
	it.skipIf(windows)(
		'stops on SIGTERM and exits 0',
		async () => {
			const daemon = await cacheOnlyDaemon();
			const exited = new Promise<number | null>((resolve) => daemon.child.once('exit', resolve));
			try {
				await serving(daemon.port);
			} finally {
				daemon.child.kill('SIGTERM');
			}

			expect(await within(5000, exited, 'the daemon to exit')).toBe(0);
		},
		20_000
	);

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
				USERPROFILE: home,
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

/** `line-mcp daemon` over a `cacheOnly` state root, on a free MCP port. */
async function cacheOnlyDaemon() {
	const home = tempRoot();
	const state = join(home, 'state');
	cacheOnly(state);
	const port = await freePort();
	const child = spawn(process.execPath, [cliEntry, 'daemon'], {
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			LINE_MCP_HOME: state,
			LINE_MCP_LOCK_PORT: String(await freePort()),
			LINE_MCP_PORT: String(port)
		},
		stdio: 'ignore'
	});
	return { child, port };
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
