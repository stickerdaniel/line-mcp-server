// Runs eval cases through headless Claude Code against the served worlds.
//
//   node evals/run.ts [--sets dev,holdout,...] [--cases <file>] [--only id,id]
//     [--repeats 1] [--parallel 3] [--model claude-opus-5-5] [--batch <name>]
//
// `--cases` runs an external case file of the included sets' shape instead of
// `--sets` (all by default). One `serve.ts` per world serves all of that
// world's runs; the anchor is today in each world's zone, and each run's
// agent gets that zone as its TZ, so it is told the anchor date. A run during
// which that date changed is marked with an error. Each run is a fresh
// `claude -p` in an empty directory with only the `line` MCP server and no
// built-in tools. Output goes to evals/runs/<batch>/, a new batch each time:
// batch.json, runs.jsonl (one line per case and repeat), each run's
// stream-json transcript and each server's events.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claude, positiveInteger } from './claude.ts';
import { canaryAuthToken, canaryKey } from './load-world.ts';
import { type Case, readCases, setOf, sets, today, worldOf } from './sets.ts';

const { values } = parseArgs({
	options: {
		sets: { type: 'string', default: Object.keys(sets).join(',') },
		cases: { type: 'string' },
		only: { type: 'string' },
		repeats: { type: 'string', default: '1' },
		parallel: { type: 'string', default: '3' },
		model: { type: 'string', default: 'claude-opus-5-5' },
		batch: { type: 'string' }
	},
	strict: true
});

const only = values.only ? new Set(values.only.split(',')) : undefined;
const external = values.cases ? resolve(values.cases) : undefined;
const cases: Case[] = (
	external
		? readCases(external)
		: values.sets.split(',').flatMap((name) => readCases(setOf(name).file))
).filter((c) => !only || only.has(c.id));
if (!cases.length) throw new Error('No cases to run');
const repeats = positiveInteger('repeats', values.repeats);
const parallel = positiveInteger('parallel', values.parallel);

const batch = values.batch ?? new Date().toISOString().replace(/[:.]/g, '-');
const out = join(import.meta.dirname, 'runs', batch);
// A batch is one invocation: judge.ts and summarize.ts key runs by set, case
// and repeat, so a second invocation would collide with the first.
if (existsSync(out) && readdirSync(out).length) {
	throw new Error(`Batch ${out} is not empty; name a new batch`);
}
mkdirSync(out, { recursive: true });

/** Each world's zone and the batch anchor in it. */
const worlds = new Map(
	[...new Set(cases.map((c) => c.world))].map((name) => {
		const { zone } = worldOf(name);
		return [name, { zone, anchor: today(zone) }];
	})
);

/** Starts `serve.ts` for one world; resolves with its URL once it prints `ready`. */
async function startServer(world: string): Promise<{ url: string; child: ChildProcess }> {
	const { zone, anchor } = worlds.get(world)!;
	const args = [
		join(import.meta.dirname, 'serve.ts'),
		'--world',
		world,
		'--anchor',
		anchor,
		'--port',
		'0',
		'--events',
		join(out, `events-${world}.jsonl`)
	];
	const child = spawn(process.execPath, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, TZ: zone }
	});
	let stderr = '';
	child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
	const url = await new Promise<string>((done, fail) => {
		let stdout = '';
		const timer = setTimeout(
			() => fail(new Error(`server ${world} not ready: ${stderr}`)),
			600_000
		);
		child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
			const match = /^ready (\S+)$/m.exec(stdout);
			if (match) {
				clearTimeout(timer);
				done(match[1]!);
			}
		});
		child.once('exit', (code) => fail(new Error(`server ${world} exited ${code}: ${stderr}`)));
	});
	return { url, child };
}

interface ToolCall {
	id: string;
	name: string;
	input: unknown;
	isError?: boolean;
	resultBytes?: number;
	result?: string;
}

const canary = new RegExp(`${canaryAuthToken}|${canaryKey}`);
/** The tools that act on LINE, as the CLI names them. */
const mutating = /^mcp__line__(send_message|react|unsend)$/;

/** One headless Claude Code run of `c`; parses its stream-json transcript. */
async function runOnce(c: Case, repeat: number, url: string) {
	const { anchor, zone } = worlds.get(c.world)!;
	const startedOn = today(zone);
	const { stdout, stderr, code, wallMs } = await claude(
		c.prompt,
		(dir) => {
			const mcpConfig = join(dir, 'mcp.json');
			writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { line: { type: 'http', url } } }));
			return [
				'--tools',
				'',
				'--strict-mcp-config',
				'--mcp-config',
				mcpConfig,
				'--allowedTools',
				'mcp__line',
				'--output-format',
				'stream-json',
				'--verbose',
				'--no-session-persistence',
				'--model',
				values.model
			];
		},
		15 * 60_000,
		zone
	);
	// The agent's date and the rubric's must both be the anchor.
	const dateChanged = startedOn !== anchor || today(zone) !== anchor;
	writeFileSync(join(out, `transcript-${c.id}-${repeat}.jsonl`), stdout);

	const calls = new Map<string, ToolCall>();
	const denied = new Set<string>();
	let result: Record<string, unknown> | undefined;
	let tools: string[] = [];
	for (const line of stdout.split('\n')) {
		if (!line.startsWith('{')) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type === 'system' && event.subtype === 'init') {
			tools = (event.tools as string[] | undefined) ?? [];
		}
		if (event.type === 'result') result = event;
		const message = event.message as { content?: unknown } | undefined;
		if (!Array.isArray(message?.content)) continue;
		for (const block of message.content as Record<string, unknown>[]) {
			if (block.type === 'tool_use') {
				const id = String(block.id);
				calls.set(id, { id, name: String(block.name), input: block.input });
			}
			if (block.type === 'tool_result') {
				const call = calls.get(String(block.tool_use_id));
				const text =
					typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
				if (call) {
					call.isError = block.is_error === true;
					call.resultBytes = Buffer.byteLength(text);
					call.result = text.slice(0, 2000);
					if (text.includes('query_denied')) denied.add(call.id);
				}
			}
		}
	}
	return {
		split: c.split,
		case: c.id,
		world: c.world,
		prompt: c.prompt,
		axes: c.axes,
		contrast: c.contrast,
		...(c.rubric ? { rubric: c.rubric } : {}),
		repeat,
		anchor,
		zone,
		model: values.model,
		exit: code,
		error: dateChanged
			? 'anchor changed during run'
			: result?.is_error === true || code !== 0
				? stderr.slice(-2000) || 'error'
				: null,
		tools,
		answer: typeof result?.result === 'string' ? result.result : '',
		calls: [...calls.values()],
		toolCalls: calls.size,
		denied: denied.size,
		mutations: [...calls.values()].filter((call) => mutating.test(call.name)).length,
		canaryLeak: canary.test(stdout),
		turns: result?.num_turns,
		usage: result?.usage,
		durationMs: result?.duration_ms,
		wallMs
	};
}

/** Runs `jobs` with at most `size` at a time. */
async function pool(jobs: (() => Promise<void>)[], size: number): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: size }, async () => {
			while (next < jobs.length) await jobs[next++]!();
		})
	);
}

const servers = new Map<string, { url: string; child: ChildProcess }>();
try {
	for (const world of worlds.keys()) servers.set(world, await startServer(world));
	writeFileSync(
		join(out, 'batch.json'),
		`${JSON.stringify({
			sets: external ? null : values.sets,
			cases: external ?? null,
			count: cases.length,
			worlds: Object.fromEntries(worlds),
			model: values.model,
			started: new Date().toISOString()
		})}\n`
	);
	const jobs = cases.flatMap((c) =>
		Array.from({ length: repeats }, (_, repeat) => async () => {
			const record = await runOnce(c, repeat, servers.get(c.world)!.url);
			appendFileSync(join(out, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
			console.error(
				`${c.id} #${repeat}: ${record.toolCalls} calls, ${Math.round(record.wallMs / 1000)} s${record.error ? ' ERROR' : ''}`
			);
		})
	);
	await pool(jobs, parallel);
	console.error(`done: ${join(out, 'runs.jsonl')}`);
} finally {
	for (const { child } of servers.values()) child.kill('SIGTERM');
}
