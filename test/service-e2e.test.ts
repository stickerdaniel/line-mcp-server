// The installed package under the real service manager: install, serve the
// cache through the bin, reinstall, uninstall. It registers a real per-user
// service, so it runs only on a CI runner that asks for it
// (CI and LINE_MCP_E2E_SERVICE=1, set by the macOS package job) against the
// package scripts/smoke-pack.ts installed; everywhere else it skips. It never
// logs in and never contacts LINE: the archive's session already ended.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthKey, writeState } from '../src/archive.ts';
import { openDatabase, setAuthState } from '../src/db.ts';
import { freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

const enabled =
	Boolean(process.env.CI) &&
	process.env.LINE_MCP_E2E_SERVICE === '1' &&
	process.platform === 'darwin';
const label = 'io.github.stickerdaniel.line-mcp';
const target = `gui/${userInfo().uid}/${label}`;

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

/** launchd's PID for the agent, or undefined while it has none. */
async function daemonPid(): Promise<number | undefined> {
	const { stdout } = await runFile('/bin/launchctl', ['print', target]);
	const pid = /^\s*pid = (\d+)$/m.exec(stdout)?.[1];
	return pid ? Number(pid) : undefined;
}

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

describe.skipIf(!enabled)('real LaunchAgent (CI with LINE_MCP_E2E_SERVICE=1 on macOS)', () => {
	it('installs, serves the cache through the bin, reinstalls and uninstalls', async () => {
		// The bin npm installed; the sources would not prove the package works.
		const bin = process.env.LINE_MCP_TEST_CLI;
		expect(bin, 'LINE_MCP_TEST_CLI names the installed bin').toBeTruthy();
		const home = tempRoot();
		const state = join(home, 'state');
		seedLive(state, selfMid, { authToken: 'token' });
		const db = openDatabase(state);
		setAuthState(db, 'needs_login');
		writeState(db, healthKey, { state: 'needs_login', since: Date.now() });
		db.close();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			LINE_MCP_HOME: state,
			LINE_MCP_LOCK_PORT: String(await freePort()),
			LINE_MCP_PORT: String(await freePort()),
			// The Node running this test: the runner's Homebrew may hold another one.
			LINE_MCP_NODE: process.execPath
		};
		// The real launchctl, not the fixture smoke-pack.ts sets for the other tests.
		delete env.LINE_MCP_SERVICE_RUNNER;
		const plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
		const line = (args: string[]) => runFile(bin!, args, env);
		/** The daemon's status through the bin, once it answers. */
		const serving = () =>
			eventually(async () => {
				const run = await line(['sync-status']);
				if (run.code !== 0) throw new Error(`sync-status exited ${run.code}: ${run.stderr}`);
				return JSON.parse(run.stdout) as Record<string, unknown>;
			});

		try {
			succeeds(await line(['install']));
			expect(await serving()).toMatchObject({
				health: 'needs_login',
				account: { mid: selfMid, auth_state: 'needs_login' }
			});
			const first = await daemonPid();
			expect(first).toBeTypeOf('number');

			succeeds(await line(['install']));
			const second = await eventually(async () => {
				const pid = await daemonPid();
				if (pid === undefined || pid === first) throw new Error(`daemon PID is ${pid}`);
				return pid;
			});
			expect(second).not.toBe(first);
			expect(await serving()).toMatchObject({ health: 'needs_login' });

			succeeds(await line(['uninstall']));
			// 113: launchd has no such service.
			expect((await runFile('/bin/launchctl', ['print', target])).code).toBe(113);
			expect(existsSync(plist)).toBe(false);
			await eventually(async () => {
				const run = await line(['sync-status']);
				if (!run.stderr.includes('"code":"daemon_unreachable"')) throw new Error(run.stderr);
			});
		} catch (error) {
			const log = join(home, 'Library', 'Logs', 'line-mcp', 'daemon.log');
			if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf-8')}`);
			throw error;
		} finally {
			await runFile('/bin/launchctl', ['bootout', target]);
			rmSync(plist, { force: true });
		}
	}, 120_000);
});
