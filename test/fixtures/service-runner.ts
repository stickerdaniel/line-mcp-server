// Stands in for every service manager tool through LINE_MCP_SERVICE_RUNNER:
// `node service-runner.ts <tool> ...args`. Appends `[tool, ...args]` as one
// JSON line to the file LINE_MCP_SERVICE_CALLS names, if set. Exits with the
// code and prints the stdout LINE_MCP_SERVICE_SCRIPT gives for the subcommand
// (the first argument not starting with `-`), as JSON such as
// `{"bootout": {"exit": 3}}`; otherwise 0 and nothing. A list of replies
// answers the subcommand's calls in turn, its last one every call after
// (counted in LINE_MCP_SERVICE_CALLS). `{"hang": true}` never answers (it
// gives up after 60 s), so the runner's timeout ends it. launchctl's `print`
// exits 113 by default, its answer for a service that is not loaded.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

interface Reply {
	exit?: number;
	stdout?: string;
	hang?: boolean;
}

const [tool, ...args] = process.argv.slice(2);
const subcommand = (argv: string[]) => argv.find((arg) => !arg.startsWith('-')) ?? '';
const name = subcommand(args);
const calls = process.env.LINE_MCP_SERVICE_CALLS;
const earlier =
	calls && existsSync(calls)
		? readFileSync(calls, 'utf-8')
				.split('\n')
				.filter((line) => line && subcommand((JSON.parse(line) as string[]).slice(1)) === name)
				.length
		: 0;
if (calls) appendFileSync(calls, `${JSON.stringify([tool, ...args])}\n`);

const script: Record<string, Reply | Reply[]> = {
	print: { exit: 113 },
	...(JSON.parse(process.env.LINE_MCP_SERVICE_SCRIPT ?? '{}') as Record<string, Reply | Reply[]>)
};
const replies = [script[name] ?? {}].flat();
const reply = replies[Math.min(earlier, replies.length - 1)] ?? {};
if (reply.hang) setTimeout(() => {}, 60_000);
else {
	process.stdout.write(reply.stdout ?? '');
	process.exitCode = reply.exit ?? 0;
}
