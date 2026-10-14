// Stands in for every service manager tool through LINE_MCP_SERVICE_RUNNER:
// `node service-runner.ts <tool> ...args`. Appends `[tool, ...args]` as one
// JSON line to the file LINE_MCP_SERVICE_CALLS names, if set. Exits with the
// code and prints the stdout LINE_MCP_SERVICE_SCRIPT gives for the subcommand
// (the first argument not starting with `-`), as JSON such as
// `{"bootout": {"exit": 3}}`; otherwise 0 and nothing. launchctl's `print`
// exits 113 by default, its answer for a service that is not loaded.
import { appendFileSync } from 'node:fs';

interface Reply {
	exit?: number;
	stdout?: string;
}

const [tool, ...args] = process.argv.slice(2);
const calls = process.env.LINE_MCP_SERVICE_CALLS;
if (calls) appendFileSync(calls, `${JSON.stringify([tool, ...args])}\n`);

const script: Record<string, Reply> = {
	print: { exit: 113 },
	...(JSON.parse(process.env.LINE_MCP_SERVICE_SCRIPT ?? '{}') as Record<string, Reply>)
};
const reply = script[args.find((arg) => !arg.startsWith('-')) ?? ''] ?? {};
process.stdout.write(reply.stdout ?? '');
process.exitCode = reply.exit ?? 0;
