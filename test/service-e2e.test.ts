// The installed package under the real service manager: install, serve the
// cache through the bin, reinstall, uninstall. It registers a real per-user
// service, so it runs only on a CI runner that asks for it
// (CI and LINE_MCP_E2E_SERVICE=1, set by the macOS and Linux package jobs)
// against the package scripts/smoke-pack.ts installed; everywhere else it
// skips. It never logs in and never contacts LINE: the archive's session
// already ended.
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
import { describe, expect, it } from 'vitest';
import { healthKey, writeState } from '../src/archive.ts';
import { openDatabase, setAuthState } from '../src/db.ts';
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
