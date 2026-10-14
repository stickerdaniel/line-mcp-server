import { execFile } from 'node:child_process';
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
 * timeout. `LINE_MCP_SERVICE_RUNNER` in `env` is a test seam: with `<file>`
 * set, every call runs as `node <file> <tool name> ...args` instead
 * (test/fixtures/service-runner.ts), so tests never reach the real service
 * manager.
 */
export function toolRunner(env: NodeJS.ProcessEnv = process.env): ToolRunner {
	const fake = env.LINE_MCP_SERVICE_RUNNER;
	const command = (tool: string, args: string[]): [string, string[]] =>
		fake ? [process.execPath, [fake, parse(tool).name, ...args]] : [tool, args];
	return {
		run: (tool, args, { timeoutMs = defaultToolTimeoutMs } = {}) =>
			new Promise((resolve) => {
				const [file, argv] = command(tool, args);
				execFile(
					file,
					argv,
					{ encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL' },
					(error, stdout) => {
						if (!error) return resolve({ exit: 0, stdout });
						// Node kills the child on timeout; on a full buffer it sets a code as well.
						const timedOut = error.killed === true && typeof error.code !== 'string';
						resolve({
							exit: timedOut ? 'timeout' : (error.code ?? error.signal ?? 'unknown'),
							stdout
						});
					}
				);
			}),
		describe: (tool, args) => command(tool, args).flat().join(' ')
	};
}
