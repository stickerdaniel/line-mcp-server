import { execFile } from 'node:child_process';
import { parse } from 'node:path';

export interface ToolResult {
	/** The exit code, or the error code or signal when the tool did not exit (`ENOENT`, `SIGKILL`). */
	exit: number | string;
	stdout: string;
}

/** Runs the service manager's command-line tools; backends get it injected. */
export interface ToolRunner {
	run(tool: string, args: string[]): Promise<ToolResult>;
	/** The command line `run` would execute, as a dry run prints it. */
	describe(tool: string, args: string[]): string;
}

/**
 * Runs each tool by its absolute path. `LINE_MCP_SERVICE_RUNNER` in `env` is
 * a test seam: with `<file>` set, every call runs as
 * `node <file> <tool name> ...args` instead (test/fixtures/service-runner.ts),
 * so tests never reach the real service manager.
 */
export function toolRunner(env: NodeJS.ProcessEnv = process.env): ToolRunner {
	const fake = env.LINE_MCP_SERVICE_RUNNER;
	const command = (tool: string, args: string[]): [string, string[]] =>
		fake ? [process.execPath, [fake, parse(tool).name, ...args]] : [tool, args];
	return {
		run: (tool, args) =>
			new Promise((resolve) => {
				const [file, argv] = command(tool, args);
				execFile(file, argv, { encoding: 'utf-8' }, (error, stdout) =>
					resolve({ exit: error ? (error.code ?? error.signal ?? 'unknown') : 0, stdout })
				);
			}),
		describe: (tool, args) => command(tool, args).flat().join(' ')
	};
}
