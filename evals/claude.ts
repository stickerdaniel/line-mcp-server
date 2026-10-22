// Headless Claude Code for the agent runs (`run.ts`) and the judge
// (`judge.ts`): `claude -p` in a fresh empty directory, with `--bare` so no
// user settings, hooks, skills, plugins or memory take part.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `--bare` authenticates with `ANTHROPIC_API_KEY` or an `apiKeyHelper` only.
 * Without the key, a gateway token in `ANTHROPIC_AUTH_TOKEN` (with
 * `ANTHROPIC_BASE_URL`) reaches the CLI through a helper that prints it.
 */
function authArgs(env: NodeJS.ProcessEnv): string[] {
	if (env.ANTHROPIC_API_KEY || !env.ANTHROPIC_AUTH_TOKEN) return [];
	return ['--settings', JSON.stringify({ apiKeyHelper: 'printenv ANTHROPIC_AUTH_TOKEN' })];
}

export interface ClaudeResult {
	code: number | null;
	stdout: string;
	stderr: string;
	wallMs: number;
}

/**
 * Runs `claude -p <prompt> --bare <args>` in an empty temporary directory,
 * removed afterwards; `args` gets the directory, to write files the
 * arguments name. SIGTERM after `timeoutMs`.
 */
export async function claude(
	prompt: string,
	args: (dir: string) => string[],
	timeoutMs: number
): Promise<ClaudeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'line-mcp-eval-'));
	try {
		const started = Date.now();
		const child = spawn(
			'claude',
			['-p', prompt, '--bare', ...authArgs(process.env), ...args(dir)],
			{
				cwd: dir,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
		const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
		const code = await new Promise<number | null>((done, fail) => {
			child.once('error', fail);
			child.once('close', done);
		}).finally(() => clearTimeout(timer));
		return { code, stdout, stderr, wallMs: Date.now() - started };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
