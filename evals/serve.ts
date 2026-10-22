// Serves one world of the eval over MCP:
//
//   node evals/serve.ts --world w1 --anchor YYYY-MM-DD --port <n> --events <jsonl>
//     [--root <dir>]
//
// The world loads into `--root` (which must not hold an archive yet) or a
// fresh temporary root, removed on exit. The server runs in the world's time
// zone, as the daemon runs in its owner's, so one process serves one world.
// Prints `ready <url>` once listening; SIGTERM and SIGINT stop it.
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { databasePath } from '../src/paths.ts';
import { stderrLog } from '../src/session.ts';
import { startEvalServer } from './server.ts';
import { worlds } from './sets.ts';

const { values } = parseArgs({
	options: {
		world: { type: 'string' },
		anchor: { type: 'string' },
		port: { type: 'string' },
		events: { type: 'string' },
		root: { type: 'string' }
	},
	strict: true
});

function usage(message: string): never {
	process.stderr.write(
		`${message}\nusage: node evals/serve.ts --world <name> --anchor YYYY-MM-DD --port <n> --events <jsonl> [--root <dir>]\n`
	);
	process.exit(2);
}

if (!values.world || !values.anchor || !values.events || values.port === undefined) {
	usage('--world, --anchor, --port and --events are required');
}
const entry = worlds[values.world];
if (!entry) usage(`--world must be one of ${Object.keys(worlds).join(', ')}`);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) usage('--port must be a TCP port');

const events = resolve(values.events);
// Every time renders in the world's zone, the query runner's too: it inherits
// TZ. No imported module reads the zone while loading, and Node applies a
// changed TZ at once.
process.env.TZ = entry.zone;
const temporary = values.root === undefined;
const root = values.root ? resolve(values.root) : mkdtempSync(join(tmpdir(), 'line-mcp-eval-'));
if (existsSync(databasePath(root))) usage(`${root} already holds an archive`);

const server = await startEvalServer({
	world: entry.build(values.anchor),
	anchor: values.anchor,
	root,
	port,
	record: (event) => appendFileSync(events, `${JSON.stringify(event)}\n`),
	log: stderrLog
});
process.stdout.write(`ready ${server.url}\n`);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await server.close();
	if (temporary) rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
