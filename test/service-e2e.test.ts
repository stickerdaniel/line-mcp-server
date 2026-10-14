// The installed package under the real service manager: install, serve the
// cache through the bin, reinstall, uninstall. It registers a real per-user
// service, so it runs only on a CI runner that asks for it
// (CI and LINE_MCP_E2E_SERVICE=1, set by the package jobs) against the
// package scripts/smoke-pack.ts installed; everywhere else it skips. It never
// logs in and never contacts LINE: the archive's session already ended. On
// Windows the Task Scheduler backend also runs from the sources, with a
// stand-in daemon (test/fixtures/task-daemon.ts).
import { execFile } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { healthKey, writeState } from '../src/archive.ts';
import { openDatabase, setAuthState } from '../src/db.ts';
import { acquireLock, lockInUse, requestStop } from '../src/lock.ts';
import { toolRunner } from '../src/service/runner.ts';
import { taskScheduler } from '../src/service/task-scheduler.ts';
import { freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

const linux = process.platform === 'linux';
const enabled =
	Boolean(process.env.CI) &&
	process.env.LINE_MCP_E2E_SERVICE === '1' &&
	(process.platform === 'darwin' || linux);
const label = 'io.github.stickerdaniel.line-mcp';
const target = `gui/${userInfo().uid}/${label}`;
const unit = 'line-mcp.service';
// The home the user manager runs with; smoke-pack.ts points HOME elsewhere.
const userHome = userInfo().homedir;

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

const runFile = (file: string, args: string[], env?: NodeJS.ProcessEnv) =>
	new Promise<Run>((resolve) => {
		execFile(file, args, { env, encoding: 'utf-8', timeout: 60_000 }, (error, stdout, stderr) =>
			resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});

/** Fails with the command's output unless it exited 0. */
function succeeds(run: Run): void {
	if (run.code !== 0) throw new Error(`exited ${run.code}: ${run.stderr}${run.stdout}`);
}

/** One property of the unit from the real user manager. */
async function unitProperty(name: string): Promise<string> {
	const run = await runFile('systemctl', ['--user', 'show', unit, `--property=${name}`, '--value']);
	succeeds(run);
	return run.stdout.trim();
}

/**
 * The real service manager on this OS: where the definition goes for `home`,
 * the daemon's PID, whether the service is gone, and a cleanup that never
 * fails. The systemd unit must go where the user manager reads it, the real
 * `~/.config`, so only launchd gets a temporary home; systemd runs keep
 * their state and logs in temporary XDG directories instead.
 */
const manager = linux
	? {
			definition: () => join(userHome, '.config', 'systemd', 'user', unit),
			pid: async () => Number(await unitProperty('MainPID')) || undefined,
			gone: async () => (await unitProperty('LoadState')) === 'not-found',
			cleanup: async () => {
				await runFile('systemctl', ['--user', 'stop', unit]);
				await runFile('systemctl', ['--user', 'disable', unit]);
				rmSync(join(userHome, '.config', 'systemd', 'user', unit), { force: true });
				await runFile('systemctl', ['--user', 'daemon-reload']);
			}
		}
	: {
			definition: (home: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`),
			pid: async () => {
				const { stdout } = await runFile('/bin/launchctl', ['print', target]);
				const pid = /^\s*pid = (\d+)$/m.exec(stdout)?.[1];
				return pid ? Number(pid) : undefined;
			},
			// 113: launchd has no such service.
			gone: async () => (await runFile('/bin/launchctl', ['print', target])).code === 113,
			cleanup: async (home: string) => {
				await runFile('/bin/launchctl', ['bootout', target]);
				rmSync(join(home, 'Library', 'LaunchAgents', `${label}.plist`), { force: true });
			}
		};

/** Retries `check` every 250 ms until it passes; rethrows its last failure after 30 s. */
async function eventually<T>(check: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			return await check();
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

/** An archive whose session LINE already ended, so the daemon serves it without calling LINE. */
function cacheOnly(state: string): void {
	seedLive(state, selfMid, { authToken: 'token' });
	const db = openDatabase(state);
	setAuthState(db, 'needs_login');
	writeState(db, healthKey, { state: 'needs_login', since: Date.now() });
	db.close();
}

/**
 * The environment of a `line-mcp` command under test: free ports, the Node
 * running this test (the runner's Homebrew may hold another one) and the real
 * service manager, not the fixture smoke-pack.ts sets for the other tests.
 * Of the state root and the XDG directories, only those in `vars` are set.
 */
async function testEnv(vars: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LINE_MCP_LOCK_PORT: String(await freePort()),
		LINE_MCP_PORT: String(await freePort()),
		LINE_MCP_NODE: process.execPath
	};
	for (const name of [
		'LINE_MCP_SERVICE_RUNNER',
		'LINE_MCP_HOME',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'XDG_STATE_HOME'
	]) {
		delete env[name];
	}
	return { ...env, ...(linux ? { HOME: userHome } : {}), ...vars };
}

/** The daemon's status through `line-mcp`, once it answers. */
const serving = (line: (args: string[]) => Promise<Run>) =>
	eventually(async () => {
		const run = await line(['sync-status']);
		if (run.code !== 0) throw new Error(`sync-status exited ${run.code}: ${run.stderr}`);
		return JSON.parse(run.stdout) as Record<string, unknown>;
	});

describe.skipIf(!enabled)('real service manager (CI with LINE_MCP_E2E_SERVICE=1)', () => {
	// The bin npm installed; the sources would not prove the package works.
	const bin = process.env.LINE_MCP_TEST_CLI;

	it('installs, serves the cache through the bin, reinstalls and uninstalls', async () => {
		expect(bin, 'LINE_MCP_TEST_CLI names the installed bin').toBeTruthy();
		// The service manager must take the space in the definition, log and state paths.
		const home = join(tempRoot(), 'a home');
		mkdirSync(home);
		// On Linux the root comes from an XDG_DATA_HOME only this shell sets, so
		// the unit must carry it to the daemon.
		const state = linux ? join(home, 'data', 'line-mcp') : join(home, 'state');
		cacheOnly(state);
		const env = await testEnv(
			linux
				? { XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'logs') }
				: { HOME: home, LINE_MCP_HOME: state }
		);
		const definition = manager.definition(home);
		const log = linux
			? join(home, 'logs', 'line-mcp', 'daemon.log')
			: join(home, 'Library', 'Logs', 'line-mcp', 'daemon.log');
		const line = (args: string[]) => runFile(bin!, args, env);

		try {
			succeeds(await line(['install']));
			expect(await serving(line)).toMatchObject({
				health: 'needs_login',
				account: { mid: selfMid, auth_state: 'needs_login' }
			});
			const first = await manager.pid();
			expect(first).toBeTypeOf('number');

			succeeds(await line(['install']));
			const second = await eventually(async () => {
				const pid = await manager.pid();
				if (pid === undefined || pid === first) throw new Error(`daemon PID is ${pid}`);
				return pid;
			});
			expect(second).not.toBe(first);
			expect(await serving(line)).toMatchObject({ health: 'needs_login' });

			succeeds(await line(['uninstall']));
			expect(await manager.gone()).toBe(true);
			expect(existsSync(definition)).toBe(false);
			await eventually(async () => {
				const run = await line(['sync-status']);
				if (!run.stderr.includes('"code":"daemon_unreachable"')) throw new Error(run.stderr);
			});
		} catch (error) {
			if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
			throw error;
		} finally {
			await manager.cleanup(home);
		}
	}, 120_000);

	// systemd reads `%`, `$`, `"` and `\` differently per directive; the daemon
	// must still see every path exactly as install resolved it.
	it.runIf(linux)(
		'runs a Node, CLI, state root and log under paths systemd would expand',
		async () => {
			const base = tempRoot();
			const dir = join(base, 'probe $HOME %p ${X} dir');
			mkdirSync(dir);
			// A copy, not a link: the daemon's own execPath must be this path.
			const node = join(dir, 'node');
			copyFileSync(process.execPath, node);
			chmodSync(node, 0o755);
			const pkg = join(dir, 'line-mcp-server');
			cpSync(dirname(dirname(realpathSync(bin!))), pkg, { recursive: true });
			const cli = join(pkg, 'dist', 'cli.js');
			const state = join(base, 'state "q" \\ %h $X ${Y}');
			cacheOnly(state);
			const logs = join(base, 'logs %i $Z');
			const env = await testEnv({
				LINE_MCP_HOME: state,
				LINE_MCP_NODE: node,
				XDG_STATE_HOME: logs
			});
			const line = (args: string[]) => runFile(node, [cli, ...args], env);
			const log = join(logs, 'line-mcp', 'daemon.log');

			try {
				succeeds(await line(['install']));
				expect(await serving(line)).toMatchObject({ health: 'needs_login' });
				const pid = await manager.pid();
				expect(pid).toBeTypeOf('number');

				// process.execPath. systemd runs the path as written, but derives argv[0]
				// from the same word with `${X}` expanded (measured on systemd 255);
				// Node ignores argv[0], so only the arguments after it count.
				expect(readlinkSync(`/proc/${pid}/exe`)).toBe(node);
				const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').slice(1, -1);
				expect(argv).toEqual([cli, 'daemon']);
				const environ = readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0');
				expect(environ).toContain(`LINE_MCP_HOME=${state}`);
				expect(readFileSync(log, 'utf-8')).toContain('"event":"daemon_started"');

				succeeds(await line(['uninstall']));
				expect(await manager.gone()).toBe(true);
			} catch (error) {
				if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
				throw error;
			} finally {
				await manager.cleanup(base);
			}
		},
		120_000
	);

	// A unit written where the user manager does not look must not stay behind.
	it.runIf(linux)('refuses a unit directory the user manager does not read', async () => {
		const home = tempRoot();
		const config = join(home, 'config');
		const env = await testEnv({
			LINE_MCP_HOME: join(home, 'state'),
			XDG_CONFIG_HOME: config,
			XDG_STATE_HOME: join(home, 'logs')
		});

		try {
			const run = await runFile(bin!, ['install'], env);

			expect(run.code).toBe(1);
			expect(run.stderr).toContain('"code":"unit_not_found"');
			expect(existsSync(join(config, 'systemd', 'user', unit))).toBe(false);
			expect(await manager.gone()).toBe(true);
		} finally {
			await manager.cleanup(home);
		}
	});
});

const windowsEnabled =
	Boolean(process.env.CI) &&
	process.env.LINE_MCP_E2E_SERVICE === '1' &&
	process.platform === 'win32';
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const schtasks = join(system32, 'schtasks.exe');
const taskStateScript = fileURLToPath(new URL('../service/task-state.js', import.meta.url));
const taskDaemon = fileURLToPath(new URL('fixtures/task-daemon.ts', import.meta.url));

/** The scheduled task's name for the runner user, as the backend derives it. */
async function taskName(): Promise<string> {
	const run = await runFile(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
	succeeds(run);
	const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(run.stdout)?.[1];
	if (!sid) throw new Error(`whoami printed no SID: ${run.stdout}`);
	return `line-mcp-${sid}`;
}

/** The task as service/task-state.js reads it through Schedule.Service. */
async function taskState(): Promise<Record<string, unknown>> {
	const run = await runFile(join(system32, 'cscript.exe'), [
		'//Nologo',
		'//E:JScript',
		taskStateScript,
		await taskName()
	]);
	return JSON.parse(run.stdout) as Record<string, unknown>;
}

/** Waits until the task runs an instance. */
const running = () =>
	eventually(async () => {
		const task = await taskState();
		if (task.instances !== 1) throw new Error(`the task is ${JSON.stringify(task)}`);
	});

/** The PID listening on the loopback lock port: the daemon's. */
async function lockOwner(port: number): Promise<number | undefined> {
	const run = await runFile(join(system32, 'netstat.exe'), ['-ano', '-p', 'TCP']);
	const owner = new RegExp(
		`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`,
		'm'
	);
	const pid = owner.exec(run.stdout)?.[1];
	return pid ? Number(pid) : undefined;
}

/**
 * Removes the task without /End, and never fails: disables it, asks a daemon
 * on `port` to stop, then deletes it.
 */
async function removeTask(port: number): Promise<void> {
	try {
		const name = await taskName();
		await runFile(schtasks, ['/Change', '/TN', name, '/Disable']);
		await requestStop(port, { deadlineMs: 10_000 }).catch(() => {});
		await runFile(schtasks, ['/Delete', '/TN', name, '/F']);
	} catch (error) {
		console.error(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Runs the `.cmd` shim npm installed through cmd.exe, as a terminal does. */
const shim = (bin: string, args: string[], env: NodeJS.ProcessEnv) =>
	new Promise<Run>((resolve) => {
		execFile(
			'cmd.exe',
			['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`],
			{ env, encoding: 'utf-8', timeout: 90_000, windowsVerbatimArguments: true },
			(error, stdout, stderr) =>
				resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});

describe.runIf(windowsEnabled)('real Task Scheduler (CI with LINE_MCP_E2E_SERVICE=1)', () => {
	// A space, `&`, `(`, `)`, `!` and a non-ASCII letter, which cmd.exe and
	// Windows Script Host must both pass through unchanged.
	const odd = 'a home & (x) ! \u00fc';

	/**
	 * A cache-only state root, the launcher, the task XML and the log in a home
	 * named `odd`, with the environment of a `line-mcp` command run in it.
	 */
	async function oddHome(vars: NodeJS.ProcessEnv = {}) {
		const home = join(tempRoot(), odd);
		const state = join(home, 'state');
		cacheOnly(state);
		const env = await testEnv({
			HOME: home,
			USERPROFILE: home,
			LOCALAPPDATA: join(home, 'AppData', 'Local'),
			LINE_MCP_HOME: state,
			...vars
		});
		const service = join(home, 'AppData', 'Local', 'line-mcp', 'service');
		return {
			env,
			port: Number(env.LINE_MCP_LOCK_PORT),
			files: [join(service, 'line-mcp.js'), join(service, 'line-mcp.xml')],
			log: join(home, 'AppData', 'Local', 'line-mcp', 'logs', 'daemon.log')
		};
	}

	it('installs, serves the cache through the shim, reinstalls and uninstalls', async () => {
		const bin = process.env.LINE_MCP_TEST_BIN;
		expect(bin, 'LINE_MCP_TEST_BIN names the installed shim').toMatch(/line-mcp\.cmd$/);
		const { env, port, files, log } = await oddHome();
		const line = (args: string[]) => shim(bin!, args, env);

		try {
			succeeds(await line(['install']));
			expect(await taskState()).toMatchObject({ exists: true, enabled: true, instances: 1 });
			expect(await serving(line)).toMatchObject({
				health: 'needs_login',
				account: { mid: selfMid, auth_state: 'needs_login' }
			});
			const first = await lockOwner(port);
			expect(first).toBeTypeOf('number');

			succeeds(await line(['install']));
			const second = await eventually(async () => {
				const pid = await lockOwner(port);
				if (pid === undefined || pid === first) throw new Error(`daemon PID is ${pid}`);
				return pid;
			});
			expect(second).not.toBe(first);
			expect(await serving(line)).toMatchObject({ health: 'needs_login' });

			succeeds(await line(['uninstall']));
			expect(await taskState()).toEqual({ exists: false });
			expect(files.filter((file) => existsSync(file))).toEqual([]);
			expect(await lockInUse(port)).toBe(false);
		} catch (error) {
			if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
			throw error;
		} finally {
			await removeTask(port);
		}
	}, 180_000);

	it('runs a Node and a CLI under such a path', async () => {
		const dir = join(tempRoot(), `probe ${odd}`);
		mkdirSync(dir);
		// A copy, not a link: the daemon's own executable must be this path.
		const node = join(dir, 'node.exe');
		copyFileSync(process.execPath, node);
		const pkg = join(dir, 'line-mcp-server');
		cpSync(dirname(dirname(process.env.LINE_MCP_TEST_CLI!)), pkg, { recursive: true });
		const cli = join(pkg, 'dist', 'cli.js');
		const { env, port, log } = await oddHome({ LINE_MCP_NODE: node });
		const line = (args: string[]) => runFile(node, [cli, ...args], env);

		try {
			succeeds(await line(['install']));
			expect(await serving(line)).toMatchObject({ health: 'needs_login' });
			const pid = await lockOwner(port);
			// An inherited module path (from PowerShell 7) breaks Windows PowerShell.
			const { PSModulePath: _modules, ...shell } = process.env;
			const path = await runFile(
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`[Console]::Out.Write((Get-Process -Id ${pid}).Path)`
				],
				shell
			);
			expect(path.stdout).toBe(node);
			expect(readFileSync(log, 'utf-8')).toContain('"event":"daemon_started"');

			succeeds(await line(['uninstall']));
			expect(await taskState()).toEqual({ exists: false });
		} catch (error) {
			if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
			throw error;
		} finally {
			await removeTask(port);
		}
	}, 180_000);

	// From the sources, with test/fixtures/task-daemon.ts as the daemon, which binds 3 s after it starts.
	it('stops and starts the task across its pre-bind window and a login-held lock', async () => {
		const home = tempRoot();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LOCALAPPDATA: join(home, 'AppData', 'Local'),
			LINE_MCP_HOME: join(home, 'state'),
			LINE_MCP_LOCK_PORT: String(await freePort())
		};
		const port = Number(env.LINE_MCP_LOCK_PORT);
		const deps = { home, env, runner: toolRunner({}) };
		const service = taskScheduler(deps);
		const name = await taskName();
		const log = join(home, 'AppData', 'Local', 'line-mcp', 'logs', 'daemon.log');
		/** Enables and runs the task behind the backend's back, as a trigger would. */
		const trigger = async () => {
			succeeds(await runFile(schtasks, ['/Change', '/TN', name, '/Enable']));
			succeeds(await runFile(schtasks, ['/Run', '/TN', name]));
			await running();
		};

		try {
			// start() waits through the 3 s before the bind.
			await service.install(service.render({ node: process.execPath, cli: taskDaemon, env }));
			expect(await lockInUse(port)).toBe(true);

			let restore = await service.stop();
			expect(await taskState()).toMatchObject({ state: 1, enabled: false, instances: 0 });
			expect(await lockInUse(port)).toBe(false);
			await restore();
			expect(await taskState()).toMatchObject({ enabled: true, instances: 1 });
			expect(await lockInUse(port)).toBe(true);

			// Stopped before its daemon binds: the stop waits for the bind, then asks.
			await service.stop();
			const ran = Date.now();
			await trigger();
			expect(Date.now() - ran).toBeLessThan(3000);
			restore = await service.stop();
			expect(await taskState()).toMatchObject({ state: 1, enabled: false, instances: 0 });
			expect(await lockInUse(port)).toBe(false);
			await restore();
			expect(await lockInUse(port)).toBe(true);

			// A login holds the lock, so the task's daemon waits, and no stop request reaches it.
			await service.stop();
			const login = await acquireLock(port);
			try {
				await trigger();
				const quick = taskScheduler({ ...deps, stopTimeoutMs: 8000 });
				await expect(quick.stop()).rejects.toMatchObject({ code: 'stop_timeout' });
				expect(await taskState()).toMatchObject({ enabled: true, instances: 1 });
			} finally {
				await login.release();
			}

			await service.uninstall();
			expect(await taskState()).toEqual({ exists: false });
			expect(await lockInUse(port)).toBe(false);
		} catch (error) {
			if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
			throw error;
		} finally {
			await removeTask(port);
		}
	}, 240_000);
});
