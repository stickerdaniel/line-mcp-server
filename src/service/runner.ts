import { spawn } from 'node:child_process';
import { parse } from 'node:path';

export interface ToolResult {
	/**
	 * The exit code, or the error code or signal when the tool did not exit
	 * (`ENOENT`, `SIGKILL`), or `timeout` when the runner killed it. A timeout
	 * says nothing about what the tool did.
	 */
	exit: number | string;
	stdout: string;
}

export interface RunOptions {
	/** How long the call may take before the runner kills it; 15 s by default. */
	timeoutMs?: number;
	/** The tool's whole environment; this process's by default. */
	env?: NodeJS.ProcessEnv;
}

/** Runs the service manager's command-line tools; backends get it injected. */
export interface ToolRunner {
	run(tool: string, args: string[], options?: RunOptions): Promise<ToolResult>;
	/** The command line `run` would execute, as a dry run prints it. */
	describe(tool: string, args: string[]): string;
}

export const defaultToolTimeoutMs = 15_000;

/**
 * Runs each tool by the path or name the backend gives, with a per-call
 * timeout. Each tool runs in its own session on POSIX, and with a hidden
 * console of its own on Windows, so a Ctrl-C in the terminal reaches only line-mcp, which
 * cancels a login and lets a stop or a restore in progress finish
 * (`runLogin`). `LINE_MCP_SERVICE_RUNNER` in `env`
 * is a test seam: with `<file>` set, every call runs as
 * `node <file> <tool name> ...args` instead (test/fixtures/service-runner.ts),
 * so tests never reach the real service manager.
 */
export function toolRunner(env: NodeJS.ProcessEnv = process.env): ToolRunner {
	const fake = env.LINE_MCP_SERVICE_RUNNER;
	const command = (tool: string, args: string[]): [string, string[]] =>
		fake ? [process.execPath, [fake, parse(tool).name, ...args]] : [tool, args];
	const timed = (tool: string, result: Promise<ToolResult>): Promise<ToolResult> => {
		const started = performance.now();
		return result.then((done) => {
			if (process.env.LINE_MCP_DOCTOR_TIMING) {
				const ms = Math.round(performance.now() - started);
				process.stderr.write(`probe tool ${parse(tool).name} ${ms} ms exit ${done.exit}\n`);
			}
			return done;
		});
	};
	return {
		run: (tool, args, { timeoutMs = defaultToolTimeoutMs, env: toolEnv } = {}) =>
			timed(
				tool,
				new Promise((resolve) => {
					const [file, argv] = command(tool, args);
					// `detached` gives the tool its own session and process group on
					// POSIX. On Windows `windowsHide`, with no inherited stdio, gives it a
					// console of its own without a window (CREATE_NO_WINDOW), so no Ctrl-C
					// on the terminal's console reaches it. `detached` there would leave
					// it without any console (DETACHED_PROCESS), and PowerShell then
					// writes nothing to its stdout.
					const ownGroup = process.platform !== 'win32';
					const child = spawn(file, argv, {
						stdio: ['ignore', 'pipe', 'ignore'],
						detached: ownGroup,
						windowsHide: true,
						env: toolEnv
					});
					let stdout = '';
					let timedOut = false;
					const timer = setTimeout(() => {
						timedOut = true;
						// The whole group, so a wrapper's descendants go too.
						try {
							if (ownGroup && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
							else child.kill('SIGKILL');
						} catch {
							child.kill('SIGKILL');
						}
						// A descendant that left the group may still hold stdout open; `close`
						// must not wait for it.
						child.stdout.destroy();
					}, timeoutMs);
					child.stdout.setEncoding('utf-8').on('data', (chunk: string) => (stdout += chunk));
					// A tool that does not start (ENOENT) emits `error`, and may emit `close` after it.
					child.once('error', (error: NodeJS.ErrnoException) => {
						clearTimeout(timer);
						resolve({ exit: error.code ?? 'unknown', stdout });
					});
					child.once('close', (code, signal) => {
						clearTimeout(timer);
						resolve({ exit: timedOut ? 'timeout' : (code ?? signal ?? 'unknown'), stdout });
					});
				})
			),
		describe: (tool, args) => command(tool, args).flat().join(' ')
	};
}
