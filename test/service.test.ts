import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LineMcpError } from '../src/errors.ts';
import { type Service, serviceFor, withServiceStopped } from '../src/service/index.ts';
import { versionedLayout } from '../src/service/node.ts';
import { type ToolResult, type ToolRunner, toolRunner } from '../src/service/runner.ts';
import { tempRoot, tree, within } from './fake-line.ts';

const runner = toolRunner({
	LINE_MCP_SERVICE_RUNNER: fileURLToPath(new URL('fixtures/service-runner.ts', import.meta.url))
});

const exit = (code: ToolResult['exit']) => ({ exit: code, stdout: '' });

/**
 * Stands in for launchctl and records every call. After a bootout that found
 * the agent, launchd keeps it loaded for `unloadPolls` more `print` calls, as
 * while the daemon shuts down, and a bootstrap until then fails with 5, as the
 * real one does. Only 3 and 113 mean it was not loaded; a bootout exiting
 * anything else still takes effect. A bootstrap that succeeds loads it again.
 * `print`, when given, is the exit of every `print`, whatever launchd holds.
 */
function fakeLaunchd({
	bootout = 0,
	unloadPolls = 0,
	print
}: {
	bootout?: ToolResult['exit'];
	unloadPolls?: number;
	print?: ToolResult['exit'];
}) {
	const calls: string[][] = [];
	let loadedFor = 0;
	const launchctl: ToolRunner = {
		run: async (tool, args) => {
			calls.push([tool, ...args]);
			switch (args[0]) {
				case 'bootout':
					if (bootout !== 3 && bootout !== 113) loadedFor = unloadPolls;
					return exit(bootout);
				case 'print':
					if (print !== undefined) return exit(print);
					if (loadedFor === 0) return exit(113);
					loadedFor--;
					return exit(0);
				case 'bootstrap':
					if (loadedFor > 0) return exit(5);
					loadedFor = Number.POSITIVE_INFINITY;
					return exit(0);
				default:
					return exit(0);
			}
		},
		describe: (tool, args) => [tool, ...args].join(' ')
	};
	return { calls, launchctl, loaded: () => loadedFor > 0 };
}

const windows = process.platform === 'win32';

describe('launchd', () => {
	// doctor compares the installed plist byte for byte, so existing LaunchAgents
	// stay current only while the rendering does. The text is c2e133b's.
	it('renders the LaunchAgent exactly as installed ones expect', () => {
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner });

		const plist = service.render({
			node: '/opt/homebrew/opt/node@24/bin/node',
			cli: '/Users/me/Code/line & "mcp"/dist/cli.js',
			env: {
				LINE_MCP_HOME: '/Users/me/<state>',
				LINE_MCP_PORT: '47900',
				LINE_MCP_NODE: '/elsewhere/node',
				LINE_MCP_SERVICE_RUNNER: '/tmp/service-runner.ts',
				PATH: '/usr/bin:/bin'
			}
		});

		expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>io.github.stickerdaniel.line-mcp</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/opt/node@24/bin/node</string>
		<string>/Users/me/Code/line &amp; &quot;mcp&quot;/dist/cli.js</string>
		<string>daemon</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>LINE_MCP_HOME</key>
		<string>/Users/me/&lt;state&gt;</string>
		<key>LINE_MCP_PORT</key>
		<string>47900</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>/Users/me/Library/Logs/line-mcp/daemon.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/me/Library/Logs/line-mcp/daemon.log</string>
</dict>
</plist>
`);
	});

	it("keeps $& and $' in paths as they are", () => {
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner });

		const plist = service.render({
			node: '/Users/me/$&/node',
			cli: "/Users/me/$'/cli.js",
			env: { LINE_MCP_HOME: '/Users/me/$`' }
		});

		expect(plist).toContain('<string>/Users/me/$&amp;/node</string>');
		expect(plist).toContain("<string>/Users/me/$'/cli.js</string>");
		expect(plist).toContain('<string>/Users/me/$`</string>');
	});

	const domain = `gui/${userInfo().uid}`;
	const target = `${domain}/io.github.stickerdaniel.line-mcp`;

	// A bootout of an agent that is not loaded (3, 113) still counts as stopped.
	it.each([0, 3, 113])(
		'stops for login with bootout (exits %i) and restores with bootstrap',
		async (bootout) => {
			const { calls, launchctl } = fakeLaunchd({ bootout });
			const home = tempRoot();
			const service = serviceFor('darwin', { home, env: {}, runner: launchctl });
			mkdirSync(posix.dirname(service.paths.definition), { recursive: true });
			writeFileSync(service.paths.definition, '');

			const restore = await service.stop();
			await restore();

			// `print` only reads, so the mutations are what counts.
			expect(calls.filter((call) => call[1] !== 'print')).toEqual([
				['/bin/launchctl', 'bootout', target],
				['/bin/launchctl', 'bootstrap', domain, service.paths.definition]
			]);
		}
	);

	// bootout returns while the daemon still shuts down; a bootstrap then fails.
	it('waits until launchd has let the agent go before starting it again', async () => {
		const { launchctl } = fakeLaunchd({ unloadPolls: 3 });
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: launchctl });

		await service.stop();

		await expect(service.start()).resolves.toBeUndefined();
	});

	it('fails the stop when launchd keeps the agent loaded', async () => {
		const { launchctl } = fakeLaunchd({ unloadPolls: Number.POSITIVE_INFINITY });
		const service = serviceFor('darwin', {
			home: '/Users/me',
			env: {},
			runner: launchctl,
			stopTimeoutMs: 300
		});

		await expect(service.stop()).rejects.toMatchObject({ code: 'launchctl_failed' });
	});

	// launchd may unload the agent although launchctl failed or the runner gave up on it.
	it('counts a bootout that failed but took effect as stopped', async () => {
		const { launchctl } = fakeLaunchd({ bootout: 'timeout', unloadPolls: 2 });
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: launchctl });

		await service.stop();

		await expect(service.start()).resolves.toBeUndefined();
	});

	it('loads the agent again when launchd cannot say whether it stopped', async () => {
		const fake = fakeLaunchd({ print: 5 });
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: fake.launchctl });

		await expect(service.stop()).rejects.toMatchObject({
			code: 'launchctl_failed',
			message: expect.stringContaining('loaded it again')
		});
		expect(fake.loaded()).toBe(true);
	});

	it('reports a cancel when the bootout it interrupted is rolled back', async () => {
		const fake = fakeLaunchd({ print: 5 });
		const cancel = new AbortController();
		const interrupting: ToolRunner = {
			run: async (tool, args) => {
				if (args[0] === 'bootout') cancel.abort();
				return await fake.launchctl.run(tool, args);
			},
			describe: fake.launchctl.describe
		};
		const service = serviceFor('darwin', { home: tempRoot(), env: {}, runner: interrupting });
		mkdirSync(posix.dirname(service.paths.definition), { recursive: true });
		writeFileSync(service.paths.definition, '');

		const handoff = withServiceStopped(service, async () => 'logged in', cancel.signal);

		await expect(handoff).rejects.toMatchObject({
			code: 'login_cancelled',
			message: expect.stringContaining('loaded it again')
		});
		expect(fake.loaded()).toBe(true);
	});

	it('fails as unknown when launchd cannot say and the agent does not load again', async () => {
		const fake = fakeLaunchd({ unloadPolls: Number.POSITIVE_INFINITY, print: 5 });
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: fake.launchctl });

		await expect(service.stop()).rejects.toMatchObject({
			code: 'service_state_unknown',
			message: expect.stringContaining('launchctl print failed (5)')
		});
	});

	it('fails the stop when a failed bootout leaves the agent loaded', async () => {
		const { launchctl } = fakeLaunchd({
			bootout: 'timeout',
			unloadPolls: Number.POSITIVE_INFINITY
		});
		const service = serviceFor('darwin', {
			home: '/Users/me',
			env: {},
			runner: launchctl,
			stopTimeoutMs: 300
		});

		await expect(service.stop()).rejects.toMatchObject({
			code: 'launchctl_failed',
			message: expect.stringContaining('after launchctl bootout failed (timeout)')
		});
	});
});

/** Runs `systemctl --user stop` through the fixture with `reply` and a 2 s timeout. */
async function stopWith(reply: Record<string, unknown>) {
	// The fixture reads its script from the environment it inherits.
	const saved = process.env.LINE_MCP_SERVICE_SCRIPT;
	process.env.LINE_MCP_SERVICE_SCRIPT = JSON.stringify({ stop: reply });
	try {
		return await within(
			5000,
			runner.run('systemctl', ['--user', 'stop', 'line-mcp.service'], { timeoutMs: 2000 }),
			'the call to end'
		);
	} finally {
		if (saved === undefined) delete process.env.LINE_MCP_SERVICE_SCRIPT;
		else process.env.LINE_MCP_SERVICE_SCRIPT = saved;
	}
}

describe('tool runner', () => {
	// A hung systemctl must not hang install or login; the kill is not "stopped".
	it('kills a call that outlives its timeout and reports it as a timeout', async () => {
		expect((await stopWith({ hang: true })).exit).toBe('timeout');
	});

	// A wrapper script on PATH may leave a child that holds the output open.
	it(
		'ends a timed-out call whose descendant still holds its output',
		{ timeout: 10_000 },
		async () => {
			const result = await stopWith({ hang: true, descendant: true });
			const pid = Number(/descendant (\d+)/.exec(result.stdout)?.[1]);
			onTestFinished(() => {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {}
			});

			expect(result.exit).toBe('timeout');
			expect(pid).toBeGreaterThan(0);
			// Windows has no process groups: there the descendant outlives the call.
			if (windows) return;
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 2000, interval: 20 });
		}
	);
});

type UnitState = Record<
	'LoadState' | 'ActiveState' | 'UnitFileState' | 'FragmentPath' | 'NeedDaemonReload',
	string
>;

const absentUnit: UnitState = {
	LoadState: 'not-found',
	ActiveState: 'inactive',
	UnitFileState: '',
	FragmentPath: '',
	NeedDaemonReload: 'no'
};

interface Fault {
	exit: ToolResult['exit'];
	/** Whether the call took effect even though it reported the failure. */
	landed?: boolean;
	/** The `ActiveState` a failed call leaves, as a stop job still running does. */
	leaves?: string;
}

/**
 * A systemd user manager behind the runner seam. `show` prints the unit's
 * state as systemctl does; each mutation changes it the way systemd would.
 * `fault` makes the nth call of a subcommand (from 0) fail instead.
 * `daemon-reload` loads the unit from `reads`, the path the manager reads.
 */
function fakeManager(
	initial: Partial<UnitState> = {},
	{
		reads,
		fault = () => undefined
	}: { reads?: string; fault?: (subcommand: string, call: number) => Fault | undefined } = {}
) {
	const state: UnitState = { ...absentUnit, ...initial };
	const calls: string[][] = [];
	const counts = new Map<string, number>();
	const effects: Record<string, () => void> = {
		stop: () => (state.ActiveState = 'inactive'),
		start: () => (state.ActiveState = 'active'),
		enable: () => (state.UnitFileState = 'enabled'),
		disable: () => (state.UnitFileState = 'disabled'),
		'daemon-reload': () => {
			const found = reads !== undefined && existsSync(reads);
			Object.assign(state, {
				LoadState: found ? 'loaded' : 'not-found',
				FragmentPath: found ? reads : '',
				UnitFileState: found ? state.UnitFileState || 'disabled' : '',
				NeedDaemonReload: 'no'
			});
		}
	};
	const fake: ToolRunner = {
		run: async (tool, args) => {
			calls.push([tool, ...args]);
			const subcommand = args.find((arg) => !arg.startsWith('-')) ?? '';
			const call = counts.get(subcommand) ?? 0;
			counts.set(subcommand, call + 1);
			const failed = fault(subcommand, call);
			if (subcommand === 'show') {
				if (failed) return { exit: failed.exit, stdout: '' };
				const lines = Object.entries(state).map(([name, value]) => `${name}=${value}\n`);
				return { exit: 0, stdout: lines.join('') };
			}
			if (!failed || failed.landed) effects[subcommand]?.();
			if (failed?.leaves) state.ActiveState = failed.leaves;
			return { exit: failed?.exit ?? 0, stdout: '' };
		},
		describe: (tool, args) => [tool, ...args].join(' ')
	};
	/** The subcommands called, in order; `show` included. */
	const subcommands = () =>
		calls.map(([, ...args]) => args.find((arg) => !arg.startsWith('-')) ?? '');
	return { state, runner: fake, calls, subcommands };
}

function systemdIn(home: string, manager: ReturnType<typeof fakeManager>): Service {
	return serviceFor('linux', { home, env: {}, runner: manager.runner });
}

/** The unit path under `home` with the default XDG_CONFIG_HOME. */
const unitIn = (home: string) => posix.join(home, '.config', 'systemd', 'user', 'line-mcp.service');

/** An installed, running unit under a fresh home. */
function installed(fault?: (subcommand: string, call: number) => Fault | undefined) {
	const home = tempRoot();
	mkdirSync(posix.dirname(unitIn(home)), { recursive: true });
	writeFileSync(unitIn(home), '[Unit]\n');
	const manager = fakeManager(
		{ LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled' },
		{ fault }
	);
	return { manager, service: systemdIn(home, manager) };
}

/** An installed, running unit whose manager cancels the login handoff on each `abortOn` call. */
function cancelledOn(abortOn: string, fault?: (subcommand: string) => Fault | undefined) {
	const cancel = new AbortController();
	const unit = installed((name) => {
		if (name === abortOn) cancel.abort();
		return fault?.(name);
	});
	return { ...unit, cancel };
}

const node = '/usr/bin/node';
const cli = '/home/me/.local/lib/node_modules/line-mcp-server/dist/cli.js';

describe('systemd', () => {
	// doctor compares the installed unit byte for byte; this pins every escape.
	it('renders the unit with each directive escaped as systemd reads it', () => {
		const service = serviceFor('linux', {
			home: '/home/me',
			env: { XDG_STATE_HOME: '/home/me/state %i $Y' },
			runner
		});

		const definition = service.render({
			node: '/opt/probe $HOME %p ${X} dir/node',
			cli: '/home/me/q "b" \\c %h $X ${Y}/dist/cli.js',
			env: {
				LINE_MCP_HOME: '/home/me/a "b" \\c %h $X ${Y}',
				LINE_MCP_PORT: '47900',
				LINE_MCP_NODE: '/elsewhere/node',
				LINE_MCP_SERVICE_RUNNER: '/tmp/service-runner.ts',
				PATH: '/usr/bin:/bin'
			}
		});

		expect(definition).toBe(
			[
				'[Unit]',
				'Description=line-mcp daemon',
				'',
				'[Service]',
				'Type=exec',
				'WorkingDirectory=%h',
				// The executable path: `%` doubles, `$` stays (measured: `$$` there is 203/EXEC).
				// Arguments: `$` doubles as well.
				'ExecStart="/opt/probe $HOME %%p ${X} dir/node" "/home/me/q \\"b\\" \\\\c %%h $$X $${Y}/dist/cli.js" daemon',
				// Environment= substitutes no `$`.
				'Environment="LINE_MCP_HOME=/home/me/a \\"b\\" \\\\c %%h $X ${Y}"',
				'Environment="LINE_MCP_PORT=47900"',
				'Restart=always',
				'RestartSec=30s',
				'UMask=0077',
				'TimeoutStopSec=10s',
				// Unquoted: spaces and `$` stay.
				'StandardOutput=append:/home/me/state %%i $Y/line-mcp/daemon.log',
				'StandardError=inherit',
				'',
				'[Install]',
				'WantedBy=default.target',
				''
			].join('\n')
		);
	});

	it('keeps state, logs and the unit in the XDG directories, ignoring relative ones', () => {
		const service = serviceFor('linux', {
			home: '/home/me',
			env: { XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: '/var/me/state' },
			runner
		});

		const definition = service.render({
			node,
			cli,
			env: { XDG_DATA_HOME: '/var/me/data' }
		});

		expect(service.paths).toEqual({
			definition: '/home/me/.config/systemd/user/line-mcp.service',
			logDir: '/var/me/state/line-mcp',
			log: '/var/me/state/line-mcp/daemon.log'
		});
		// The service manager may see other XDG values; the unit names the root.
		expect(definition).toContain('\nEnvironment="LINE_MCP_HOME=/var/me/data/line-mcp"\n');
		expect(
			serviceFor('linux', { home: '/home/me', env: {}, runner }).render({ node, cli, env: {} })
		).toContain('\nEnvironment="LINE_MCP_HOME=/home/me/.local/share/line-mcp"\n');
	});

	it.each([
		['a relative Node', { node: 'bin/node' }],
		['a Node path with a quote', { node: '/opt/a"b/node' }],
		['a Node path with an apostrophe', { node: "/opt/owner's node/node" }],
		['a Node path with a backslash', { node: '/opt/a\\b/node' }],
		['a Node path with a tab', { node: '/opt/a\tb/node' }],
		['a CLI path with a line break', { cli: '/opt/a\nb/cli.js' }],
		['a state root with a line break', { env: { LINE_MCP_HOME: '/state\n[Service]' } }]
	])('refuses to render %s', (_kind, input) => {
		const service = serviceFor('linux', { home: '/home/me', env: {}, runner });

		expect(() => service.render({ node, cli, env: {}, ...input })).toThrow(
			expect.objectContaining({ code: 'unsupported_path' })
		);
	});

	it('installs an existing unit again: stop, write, reload, check, enable, start', async () => {
		const home = tempRoot();
		const manager = fakeManager(
			{
				LoadState: 'loaded',
				ActiveState: 'active',
				UnitFileState: 'enabled',
				FragmentPath: unitIn(home)
			},
			{ reads: unitIn(home) }
		);
		const service = systemdIn(home, manager);

		await service.install('[Unit]\n');

		expect(manager.calls).toEqual([
			['systemctl', '--user', 'show', 'line-mcp.service', expect.any(String)],
			['systemctl', '--user', 'stop', 'line-mcp.service'],
			['systemctl', '--user', 'daemon-reload'],
			['systemctl', '--user', 'show', 'line-mcp.service', expect.any(String)],
			['systemctl', '--user', 'enable', 'line-mcp.service'],
			['systemctl', '--user', 'start', 'line-mcp.service']
		]);
		expect(readFileSync(unitIn(home), 'utf-8')).toBe('[Unit]\n');
		expect(existsSync(service.paths.log)).toBe(true);
	});

	// Windows has no POSIX modes.
	it.skipIf(windows)('creates the log directory 0700 and the log 0600', async () => {
		const home = tempRoot();
		const service = systemdIn(home, fakeManager({}, { reads: unitIn(home) }));

		await service.install('[Unit]\n');

		expect(statSync(service.paths.logDir).mode & 0o777).toBe(0o700);
		expect(statSync(service.paths.log).mode & 0o777).toBe(0o600);
	});

	it('keeps the old unit running and unchanged when the stop of a reinstall fails', async () => {
		const { manager, service } = installed((name) =>
			name === 'stop' ? { exit: 'timeout', leaves: 'deactivating' } : undefined
		);

		await expect(service.install('[Unit]\nDescription=new\n')).rejects.toMatchObject({
			code: 'systemctl_failed',
			message: expect.stringContaining('nothing was changed')
		});
		expect(manager.state.ActiveState).toBe('active');
		expect(readFileSync(service.paths.definition, 'utf-8')).toBe('[Unit]\n');
	});

	it('stops nothing on a first install', async () => {
		const home = tempRoot();
		const manager = fakeManager({}, { reads: unitIn(home) });

		await systemdIn(home, manager).install('[Unit]\n');

		expect(manager.subcommands()).toEqual(['show', 'daemon-reload', 'show', 'enable', 'start']);
		expect(manager.state).toMatchObject({ ActiveState: 'active', UnitFileState: 'enabled' });
	});

	it.each([
		['ENOENT', 'systemd_unavailable', 'line-mcp daemon in the foreground'],
		[1, 'systemd_unreachable', `XDG_RUNTIME_DIR=/run/user/${userInfo().uid}`],
		['timeout', 'systemd_unreachable', 'enable-linger']
	])('fails before writing anything when show exits %s', async (status, code, remedy) => {
		const home = tempRoot();
		const manager = fakeManager(
			{},
			{ fault: (name) => (name === 'show' ? { exit: status } : undefined) }
		);

		const install = systemdIn(home, manager).install('[Unit]\n');

		await expect(install).rejects.toMatchObject({
			code,
			message: expect.stringContaining(remedy)
		});
		expect(manager.subcommands()).toEqual(['show']);
		expect(readdirSync(home)).toEqual([]);
	});

	it('removes the written unit when the service manager loads another', async () => {
		const home = tempRoot();
		// The manager reads another directory, as with an XDG_CONFIG_HOME set only in the shell.
		const manager = fakeManager({}, { reads: posix.join(tempRoot(), 'line-mcp.service') });

		const install = systemdIn(home, manager).install('[Unit]\n');

		await expect(install).rejects.toMatchObject({
			code: 'unit_not_found',
			message: expect.stringContaining('XDG_CONFIG_HOME')
		});
		expect(existsSync(unitIn(home))).toBe(false);
		expect(manager.subcommands()).toEqual(['show', 'daemon-reload', 'show']);
	});

	it('uninstalls: stop, disable, remove the unit, reload', async () => {
		const home = tempRoot();
		mkdirSync(posix.dirname(unitIn(home)), { recursive: true });
		writeFileSync(unitIn(home), '[Unit]\n');
		const manager = fakeManager(
			{
				LoadState: 'loaded',
				ActiveState: 'active',
				UnitFileState: 'enabled',
				FragmentPath: unitIn(home)
			},
			{ reads: unitIn(home) }
		);

		await systemdIn(home, manager).uninstall();

		expect(manager.subcommands()).toEqual(['show', 'stop', 'disable', 'daemon-reload']);
		expect(existsSync(unitIn(home))).toBe(false);
		expect(manager.state.LoadState).toBe('not-found');
	});

	it('prints every step of a dry run and calls nothing', async () => {
		const home = tempRoot();
		const manager = fakeManager();
		const lines: string[] = [];
		const log = console.log;
		console.log = (line: string) => lines.push(line);
		try {
			await systemdIn(home, manager).install('[Unit]\n', { dryRun: true });
			await systemdIn(home, manager).uninstall({ dryRun: true });
		} finally {
			console.log = log;
		}

		expect(manager.calls).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
		expect(lines.filter((line) => line.startsWith('would run: '))).toEqual(
			[
				'stop line-mcp.service',
				'daemon-reload',
				'enable line-mcp.service',
				'start line-mcp.service',
				'stop line-mcp.service',
				'disable line-mcp.service',
				'daemon-reload'
			].map((args) => `would run: systemctl --user ${args}`)
		);
	});

	describe('after a mutation fails or times out', () => {
		it('continues when the unit reached the target state', async () => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{ fault: (name) => (name === 'stop' ? { exit: 'timeout', landed: true } : undefined) }
			);

			await systemdIn(tempRoot(), manager).stop();

			expect(manager.subcommands()).toEqual(['show', 'stop', 'show']);
			expect(manager.state.ActiveState).toBe('inactive');
		});

		it('fails with the step and a remedy when it did not', async () => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{ fault: (name) => (name === 'stop' ? { exit: 'timeout' } : undefined) }
			);

			await expect(systemdIn(tempRoot(), manager).stop()).rejects.toMatchObject({
				code: 'systemctl_failed',
				message: expect.stringContaining('systemctl --user stop line-mcp.service failed (timeout)')
			});
		});

		// The stop job may still finish after systemctl gave up on it.
		it('starts a unit that ran again when its stop fails, then fails', async () => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{
					fault: (name) =>
						name === 'stop' ? { exit: 'timeout', leaves: 'deactivating' } : undefined
				}
			);

			await expect(systemdIn(tempRoot(), manager).stop()).rejects.toMatchObject({
				code: 'systemctl_failed',
				message: expect.stringContaining('the service is unchanged')
			});
			expect(manager.state.ActiveState).toBe('active');
		});

		it('fails as unknown when the unit does not start again either', async () => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{
					fault: (name) =>
						name === 'stop'
							? { exit: 'timeout', leaves: 'deactivating' }
							: name === 'start'
								? { exit: 1, leaves: 'failed' }
								: undefined
				}
			);

			await expect(systemdIn(tempRoot(), manager).stop()).rejects.toMatchObject({
				code: 'service_state_unknown',
				message: expect.stringContaining('Starting line-mcp.service again failed too')
			});
		});

		it('fails as unknown when the state query fails too', async () => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{
					fault: (name, call) =>
						name === 'stop' || (name === 'show' && call > 0) ? { exit: 'timeout' } : undefined
				}
			);

			await expect(systemdIn(tempRoot(), manager).stop()).rejects.toMatchObject({
				code: 'service_state_unknown',
				message: expect.stringContaining('line-mcp doctor')
			});
		});
	});

	describe('stop for login and restore', () => {
		// The systemd column of the restore table.
		it.each([
			['active', 'enabled', ['show', 'stop', 'start'], 'active'],
			['activating', 'enabled', ['show', 'stop', 'start'], 'active'],
			['reloading', 'enabled', ['show', 'stop', 'start'], 'active'],
			['active', 'disabled', ['show', 'stop', 'start'], 'active'],
			['inactive', 'enabled', ['show', 'stop'], 'inactive'],
			['failed', 'disabled', ['show', 'stop'], 'inactive']
		])(
			'runs a unit that was %s and %s again only if it ran',
			async (active, file, subcommands, after) => {
				const manager = fakeManager({
					LoadState: 'loaded',
					ActiveState: active,
					UnitFileState: file
				});

				const restore = await systemdIn(tempRoot(), manager).stop();
				expect(manager.state.ActiveState).not.toMatch(/^(active|activating|reloading)$/);
				await restore();

				expect(manager.subcommands()).toEqual(subcommands);
				expect(manager.state).toMatchObject({ ActiveState: after, UnitFileState: file });
			}
		);

		it('leaves an absent unit alone', async () => {
			const manager = fakeManager();

			const restore = await systemdIn(tempRoot(), manager).stop();
			await restore();

			expect(manager.subcommands()).toEqual(['show']);
		});

		// Only `not-found` with nothing running is absent.
		it.each([
			['whose file is gone', 'not-found'],
			['that failed to load', 'bad-setting']
		])('stops a running unit %s', async (_kind, load) => {
			const manager = fakeManager({ LoadState: load, ActiveState: 'active' });

			const restore = await systemdIn(tempRoot(), manager).stop();
			await restore();

			expect(manager.subcommands()).toEqual(['show', 'stop', 'start']);
		});

		it('never takes a show without a state as absent', async () => {
			const manager = fakeManager();
			const silent: ToolRunner = {
				run: async (tool, args) =>
					args.includes('show') ? { exit: 0, stdout: '' } : manager.runner.run(tool, args),
				describe: manager.runner.describe
			};
			const service = serviceFor('linux', { home: tempRoot(), env: {}, runner: silent });

			await expect(service.stop()).rejects.toMatchObject({ code: 'systemctl_failed' });
			expect(manager.calls).toEqual([]);
		});

		it.each([
			['exits 1', { exit: 1 }],
			['times out', { exit: 'timeout' }]
		])('never takes a show that %s as absent', async (_kind, failure: Fault) => {
			const manager = fakeManager(
				{ LoadState: 'loaded', ActiveState: 'active' },
				{ fault: (name) => (name === 'show' ? failure : undefined) }
			);

			await expect(systemdIn(tempRoot(), manager).stop()).rejects.toMatchObject({
				code: 'systemd_unreachable'
			});
			expect(manager.subcommands()).toEqual(['show']);
		});
	});

	describe('the login handoff', () => {
		it('runs the login with the unit stopped and starts it again', async () => {
			const { manager, service } = installed();
			let during = '';

			const result = await withServiceStopped(service, async () => {
				during = manager.state.ActiveState;
				return 'logged in';
			});

			expect([result, during, manager.state.ActiveState]).toEqual([
				'logged in',
				'inactive',
				'active'
			]);
		});

		it('restores the unit after a failed login and keeps its error', async () => {
			const { manager, service } = installed();

			const handoff = withServiceStopped(service, async () => {
				throw new Error('login failed');
			});

			await expect(handoff).rejects.toThrow('login failed');
			expect(manager.state.ActiveState).toBe('active');
		});

		it('fails with service_restore_failed when the unit does not start again', async () => {
			const { service } = installed((name) => (name === 'start' ? { exit: 1 } : undefined));
			const printed: string[] = [];

			const handoff = withServiceStopped(service, async () => {
				printed.push('Logged in');
			});

			await expect(handoff).rejects.toMatchObject({
				code: 'service_restore_failed',
				message: expect.stringContaining('Run line-mcp install')
			});
			expect(printed).toEqual(['Logged in']);
		});

		it('names both failures when the login and the restore fail', async () => {
			const { service } = installed((name) => (name === 'start' ? { exit: 1 } : undefined));

			const handoff = withServiceStopped(service, async () => {
				throw new Error('login failed');
			});

			await expect(handoff).rejects.toMatchObject({
				code: 'service_restore_failed',
				message: expect.stringContaining('The login failed too')
			});
		});

		it('does not start the login when the stop fails', async () => {
			const { service } = installed((name) => (name === 'stop' ? { exit: 1 } : undefined));
			let ran = false;

			const handoff = withServiceStopped(service, async () => {
				ran = true;
			});

			await expect(handoff).rejects.toMatchObject({ code: 'systemctl_failed' });
			expect(ran).toBe(false);
		});

		it('finishes a stop that a cancel interrupts, skips the login and starts the unit', async () => {
			const { manager, service, cancel } = cancelledOn('stop');
			let ran = false;

			const handoff = withServiceStopped(
				service,
				async () => {
					ran = true;
				},
				cancel.signal
			);

			await expect(handoff).rejects.toMatchObject({ code: 'login_cancelled' });
			expect(ran).toBe(false);
			expect(manager.subcommands().filter((name) => name !== 'show')).toEqual(['stop', 'start']);
			expect(manager.state.ActiveState).toBe('active');
		});

		it('starts the unit again when the login is cancelled', async () => {
			const { manager, service } = installed();
			const cancel = new AbortController();

			const handoff = withServiceStopped(
				service,
				async () => {
					cancel.abort();
					throw new Error('login stopped');
				},
				cancel.signal
			);

			await expect(handoff).rejects.toMatchObject({ code: 'login_cancelled' });
			expect(manager.state.ActiveState).toBe('active');
		});

		it('finishes a restore that a signal interrupts after the login finished', async () => {
			const { manager, service, cancel } = cancelledOn('start');

			const handoff = withServiceStopped(service, async () => 'logged in', cancel.signal);

			await expect(handoff).rejects.toMatchObject({
				code: 'login_cancelled',
				message: 'Interrupted after the login finished'
			});
			expect(manager.state.ActiveState).toBe('active');
		});

		// The login settled before the signal, so its own failure is the result.
		it('keeps a failed login in the result when a signal interrupts the restore', async () => {
			const { manager, service, cancel } = cancelledOn('start');

			const handoff = withServiceStopped(
				service,
				async () => {
					throw new LineMcpError('wrong_account', 'The scanned account is not the bound account');
				},
				cancel.signal
			);

			await expect(handoff).rejects.toMatchObject({
				code: 'login_cancelled',
				message: expect.stringMatching(
					/^The login failed with wrong_account: The scanned account is not the bound account\./
				)
			});
			expect(manager.state.ActiveState).toBe('active');
		});

		it('names a failed login when a signal interrupts a restore that fails', async () => {
			const { service, cancel } = cancelledOn('start', (name) =>
				name === 'start' ? { exit: 1 } : undefined
			);

			const handoff = withServiceStopped(
				service,
				async () => {
					throw new LineMcpError('wrong_account', 'The scanned account is not the bound account');
				},
				cancel.signal
			);

			await expect(handoff).rejects.toMatchObject({
				code: 'service_restore_failed',
				message: expect.stringContaining(
					'The login failed too: The scanned account is not the bound account'
				)
			});
		});

		// systemd starts a unit whose stop failed again before it rejects.
		it('reports a cancel when the stop it interrupted fails and is rolled back', async () => {
			const { manager, service, cancel } = cancelledOn('stop', (name) =>
				name === 'stop' ? { exit: 'timeout', leaves: 'deactivating' } : undefined
			);
			let ran = false;

			const handoff = withServiceStopped(
				service,
				async () => {
					ran = true;
				},
				cancel.signal
			);

			await expect(handoff).rejects.toMatchObject({
				code: 'login_cancelled',
				message: expect.stringMatching(/^The login was cancelled\. .*the service is unchanged/)
			});
			expect(ran).toBe(false);
			expect(manager.state.ActiveState).toBe('active');
		});

		it('keeps an unknown state after a cancel during a stop that fails', async () => {
			const { service, cancel } = cancelledOn('stop', (name) =>
				name === 'stop'
					? { exit: 'timeout', leaves: 'deactivating' }
					: name === 'start'
						? { exit: 1, leaves: 'failed' }
						: undefined
			);

			const handoff = withServiceStopped(service, async () => 'logged in', cancel.signal);

			await expect(handoff).rejects.toMatchObject({ code: 'service_state_unknown' });
		});

		it('names the cancel when the unit does not start again', async () => {
			const { service, cancel } = cancelledOn('stop', (name) =>
				name === 'start' ? { exit: 1 } : undefined
			);

			const handoff = withServiceStopped(service, async () => 'logged in', cancel.signal);

			await expect(handoff).rejects.toMatchObject({
				code: 'service_restore_failed',
				message: expect.stringContaining('The login was cancelled.')
			});
		});
	});

	describe('doctor', () => {
		it('reports where the unit loads from, whether it runs and lingering', async () => {
			const home = tempRoot();
			const manager = fakeManager({
				LoadState: 'loaded',
				ActiveState: 'failed',
				FragmentPath: '/etc/systemd/user/line-mcp.service'
			});
			const linger: ToolRunner = {
				run: async (tool, args) =>
					tool === 'loginctl' ? { exit: 0, stdout: 'Linger=no\n' } : manager.runner.run(tool, args),
				describe: manager.runner.describe
			};

			const checks = await serviceFor('linux', { home, env: {}, runner: linger }).diagnose();

			expect(checks).toEqual([
				{
					name: 'systemd_unit_loaded',
					ok: false,
					detail: expect.stringContaining('from /etc/systemd/user/line-mcp.service')
				},
				{ name: 'systemd_unit_active', ok: false, detail: expect.stringContaining('failed') },
				{
					name: 'linger',
					ok: true,
					warning: true,
					detail: expect.stringContaining('enable-linger')
				}
			]);
		});
	});
});

/** A home with a stray LaunchAgent and systemd unit, and a runner that only records. */
function stray() {
	const home = tempRoot();
	for (const definition of [
		posix.join(home, 'Library', 'LaunchAgents', 'io.github.stickerdaniel.line-mcp.plist'),
		unitIn(home)
	]) {
		mkdirSync(posix.dirname(definition), { recursive: true });
		writeFileSync(definition, 'stray');
	}
	const calls: string[][] = [];
	const recording: ToolRunner = {
		run: async (tool, args) => {
			calls.push([tool, ...args]);
			return exit(0);
		},
		describe: (tool, args) => [tool, ...args].join(' ')
	};
	return { home, calls, service: serviceFor('win32', { home, env: {}, runner: recording }) };
}

describe('a platform without a backend (Windows)', () => {
	it('refuses every change before it writes, prints or runs anything', async () => {
		const { home, calls, service } = stray();
		const before = tree(home);
		const log = vi.spyOn(console, 'log');
		onTestFinished(() => log.mockRestore());
		const unsupported = expect.objectContaining({
			code: 'service_unsupported',
			message: expect.stringContaining('run line-mcp daemon in the foreground')
		});

		expect(service.supported).toBe(false);
		expect(() => service.render({ node: '/usr/bin/node', cli: '/cli.js', env: {} })).toThrow(
			unsupported
		);
		for (const change of [
			() => service.install('definition'),
			() => service.install('definition', { dryRun: true }),
			() => service.uninstall(),
			() => service.uninstall({ dryRun: true }),
			() => service.start()
		]) {
			await expect(change()).rejects.toEqual(unsupported);
		}

		expect(service.installed()).toBe(false);
		expect(await service.diagnose()).toEqual([
			{ name: 'service', ok: true, warning: true, detail: expect.stringContaining('Windows') }
		]);
		expect(calls).toEqual([]);
		expect(log).not.toHaveBeenCalled();
		expect(tree(home)).toEqual(before);
	});

	it('runs a login without stopping or restoring anything', async () => {
		const { calls, service } = stray();

		expect(await withServiceStopped(service, async () => 'logged in')).toBe('logged in');
		await (
			await service.stop()
		)();
		expect(calls).toEqual([]);
	});
});

describe('versioned Node layouts', () => {
	// Each of these directories goes away with its version, and the service with it.
	it.each([
		['/opt/homebrew/Cellar/node@24/24.18.0/bin/node', 'Homebrew Cellar'],
		['/home/me/.nvm/versions/node/v24.18.0/bin/node', 'nvm'],
		['/home/me/.local/share/fnm/node-versions/v24.18.0/installation/bin/node', 'fnm'],
		['/run/user/1000/fnm_multishells/123_456/bin/node', 'fnm'],
		['/home/me/.volta/tools/image/node/24.18.0/bin/node', 'Volta'],
		['/home/me/.asdf/installs/nodejs/24.18.0/bin/node', 'asdf'],
		['/snap/node/9876/bin/node', 'snap'],
		['C:\\Users\\me\\.nvm\\versions\\node\\v24.18.0\\bin\\node.exe', 'nvm'],
		['/usr/bin/node', undefined],
		['/snap/bin/node', undefined],
		['/opt/homebrew/opt/node@24/bin/node', undefined]
	])('finds %s in %s', (path, layout) => {
		expect(versionedLayout(path)).toBe(layout);
	});
});
