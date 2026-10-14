// Stands in for every service manager tool through LINE_MCP_SERVICE_RUNNER:
// `node service-runner.ts <tool> ...args`. Appends `[tool, ...args]` as one
// JSON line to the file LINE_MCP_SERVICE_CALLS names, if set. Exits with the
// code and prints the stdout LINE_MCP_SERVICE_SCRIPT gives for the subcommand
// (the first argument not starting with `-`), as JSON such as
// `{"bootout": {"exit": 3}}`, or for every call of a tool under its name, such
// as `{"cscript": {...}}`; otherwise 0 and nothing. A list of replies answers
// the calls in turn, its last one every call after (counted in
// LINE_MCP_SERVICE_CALLS). `{"hang": true}` never answers (it
// gives up after 60 s), so the runner's timeout ends it; `{"delayMs": 500}`
// answers that much later. `{"descendant": true}` first starts a child that
// inherits stdout and lives 60 s, as a wrapper script's child would, and
// prints `descendant <pid>`. launchctl's `print` exits 113 by default, its
// answer for a service that is not loaded.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

interface Reply {
	exit?: number;
	stdout?: string;
	hang?: boolean;
	delayMs?: number;
	descendant?: boolean;
}

const [tool = '', ...args] = process.argv.slice(2);
const script: Record<string, Reply | Reply[]> = {
	print: { exit: 113 },
	...(JSON.parse(process.env.LINE_MCP_SERVICE_SCRIPT ?? '{}') as Record<string, Reply | Reply[]>)
};
/** What a call `[tool, ...args]` is answered by: its tool's own entry, or its subcommand's. */
const keyOf = ([called = '', ...argv]: string[]) =>
	Object.hasOwn(script, called) ? called : (argv.find((arg) => !arg.startsWith('-')) ?? '');
const key = keyOf([tool, ...args]);
const calls = process.env.LINE_MCP_SERVICE_CALLS;
const earlier =
	calls && existsSync(calls)
		? readFileSync(calls, 'utf-8')
				.split('\n')
				.filter((line) => line && keyOf(JSON.parse(line) as string[]) === key).length
		: 0;
if (calls) appendFileSync(calls, `${JSON.stringify([tool, ...args])}\n`);

const replies = [script[key] ?? {}].flat();
const reply = replies[Math.min(earlier, replies.length - 1)] ?? {};
if (reply.descendant) {
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
		stdio: ['ignore', 'inherit', 'ignore']
	});
	process.stdout.write(`descendant ${child.pid}\n`);
}
if (reply.hang) setTimeout(() => {}, 60_000);
else {
	await sleep(reply.delayMs ?? 0);
	process.stdout.write(reply.stdout ?? '');
	process.exitCode = reply.exit ?? 0;
}
