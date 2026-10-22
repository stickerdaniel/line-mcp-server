// Summarises judged batches: pass rate, cost and safety per set and per
// request kind, and with --base a paired per-case comparison of two batches,
// such as a branch against main on the same sets and anchor.
//
//   node evals/summarize.ts --batch <name|path>[,<name|path>] [--base <name|path>[,...]]
//
// A batch is a name under evals/runs/ or the path of a batch directory, so
// the base can come from another checkout. Several batches joined by commas
// count as one. Prints aggregates and case IDs only.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		batch: { type: 'string' },
		base: { type: 'string' }
	},
	strict: true
});
if (!values.batch) throw new Error('--batch <name|path> is required');

/** The fields of a `runs.jsonl` line the summary reads. */
interface Run {
	split: string;
	case: string;
	axes: Record<string, string>;
	repeat: number;
	toolCalls: number;
	denied: number;
	mutations: number;
	canaryLeak: boolean;
	error: string | null;
	wallMs: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}
interface Verdict {
	split: string;
	case: string;
	repeat: number;
	pass: boolean;
	judgeError: string | null;
}

const jsonl = <T>(path: string): T[] =>
	readFileSync(path, 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
const runKey = (r: { split: string; case: string; repeat: number }) =>
	`${r.split}/${r.case}/${r.repeat}`;
const caseKey = (r: { split: string; case: string }) => `${r.split}/${r.case}`;

interface Batch {
	label: string;
	runs: Run[];
	verdictOf: Map<string, Verdict>;
}

function readBatch(names: string): Batch {
	const runs: Run[] = [];
	const verdicts: Verdict[] = [];
	for (const name of names.split(',')) {
		const dir = resolve(import.meta.dirname, 'runs', name);
		runs.push(...jsonl<Run>(join(dir, 'runs.jsonl')));
		verdicts.push(...jsonl<Verdict>(join(dir, 'judged.jsonl')));
	}
	return { label: names, runs, verdictOf: new Map(verdicts.map((v) => [runKey(v), v])) };
}

const tokens = (run: Run) =>
	(run.usage?.input_tokens ?? 0) +
	(run.usage?.output_tokens ?? 0) +
	(run.usage?.cache_read_input_tokens ?? 0) +
	(run.usage?.cache_creation_input_tokens ?? 0);
const median = (xs: number[]) => {
	const s = [...xs].toSorted((a, b) => a - b);
	return s.length
		? s.length % 2
			? s[(s.length - 1) / 2]!
			: (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
		: NaN;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

/** Pass share of each case across its judged repeats. */
function caseScores(batch: Batch): Map<string, number> {
	const passes = new Map<string, boolean[]>();
	for (const run of batch.runs) {
		const verdict = batch.verdictOf.get(runKey(run));
		if (!verdict) continue;
		passes.set(caseKey(run), [...(passes.get(caseKey(run)) ?? []), verdict.pass]);
	}
	return new Map(
		[...passes].map(([id, votes]) => [id, votes.filter(Boolean).length / votes.length])
	);
}

function table(batch: Batch): void {
	const scores = caseScores(batch);
	console.log(`\n${batch.label}: ${scores.size} cases, ${batch.runs.length} runs`);
	console.log(
		'group | cases | pass (case mean) | runs passed | median tokens | median calls | median wall s | denied | canary leaks | mutating calls | errors | judge errors'
	);
	const groups = new Map<string, Run[]>([['all', batch.runs]]);
	const add = (group: string, run: Run) => groups.set(group, [...(groups.get(group) ?? []), run]);
	for (const run of batch.runs) add(`set ${run.split}`, run);
	for (const run of batch.runs) add(`kind ${run.axes.kind ?? '-'}`, run);
	for (const [group, runs] of groups) {
		const ids = [...new Set(runs.map(caseKey))];
		const judged = ids.flatMap((id) => scores.get(id) ?? []);
		const verdicts = runs.map((run) => batch.verdictOf.get(runKey(run)));
		console.log(
			[
				group,
				ids.length,
				judged.length ? pct(sum(judged) / judged.length) : '-',
				`${verdicts.filter((v) => v?.pass).length}/${runs.length}`,
				Math.round(median(runs.map(tokens))),
				median(runs.map((r) => r.toolCalls)),
				(median(runs.map((r) => r.wallMs)) / 1000).toFixed(0),
				sum(runs.map((r) => r.denied)),
				runs.filter((r) => r.canaryLeak).length,
				sum(runs.map((r) => r.mutations)),
				runs.filter((r) => r.error).length,
				verdicts.filter((v) => v?.judgeError).length
			].join(' | ')
		);
	}
}

/** Exact two-sided sign test over discordant cases. */
function signTest(wins: number, losses: number): number {
	const n = wins + losses;
	if (n === 0) return 1;
	const k = Math.min(wins, losses);
	let tail = 0;
	let choose = 1;
	for (let i = 0; i <= n; i++) {
		if (i > 0) choose = (choose * (n - i + 1)) / i;
		if (i <= k) tail += choose;
	}
	return Math.min(1, (2 * tail) / 2 ** n);
}

/** Seeded case-level bootstrap of the mean pass difference. */
function bootstrap(diffs: number[], rounds = 10_000): [number, number] {
	let seed = 42;
	const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
	const means: number[] = [];
	for (let r = 0; r < rounds; r++) {
		let total = 0;
		for (let i = 0; i < diffs.length; i++) total += diffs[Math.floor(rand() * diffs.length)]!;
		means.push(total / diffs.length);
	}
	means.toSorted((a, b) => a - b);
	return [means[Math.floor(0.025 * rounds)]!, means[Math.floor(0.975 * rounds)]!];
}

const batch = readBatch(values.batch);
table(batch);
if (values.base) {
	const base = readBatch(values.base);
	table(base);
	const ours = caseScores(batch);
	const theirs = caseScores(base);
	const paired = [...ours]
		.filter(([id]) => theirs.has(id))
		.map(([id, score]) => ({ id, base: theirs.get(id)!, other: score }));
	const diffs = paired.map((p) => p.other - p.base);
	const wins = paired.filter((p) => p.other > p.base);
	const losses = paired.filter((p) => p.other < p.base);
	const [lo, hi] = bootstrap(diffs);
	console.log(
		`\n${batch.label} vs ${base.label}: ${paired.length} paired cases, mean diff ${pct(sum(diffs) / diffs.length)} (95% bootstrap ${pct(lo)} to ${pct(hi)}), better on ${wins.length} [${wins.map((p) => p.id).join(' ')}], worse on ${losses.length} [${losses.map((p) => p.id).join(' ')}], sign test p=${signTest(wins.length, losses.length).toFixed(3)}`
	);
}
