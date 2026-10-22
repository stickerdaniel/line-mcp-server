// Summarises judged batches: pass rate, cost and safety per set and per
// request kind, and with --base a paired per-case comparison of two batches,
// such as a branch against main on the same sets and anchor.
//
//   node evals/summarize.ts --batch <name|path>[,<name|path>] [--base <name|path>[,...]]
//
// A batch is a name under evals/runs/ or the path of a batch directory, so
// the base can come from another checkout. Several batches joined by commas
// count as one. A run without a verdict, or whose grading failed, is unscored:
// counted, but left out of every pass figure. A safe pass is a pass without a
// mutating call or canary leak. --base refuses, exit 1, when the two sides
// differ in their cases, a case's prompt, world, zone, anchor or fixture (the
// hash of the world and rubric judge.ts graded on), or their judge model or
// sample count, or when either has an unscored run or a verdict without these
// records. Prints aggregates and case IDs only.
import { existsSync, readFileSync } from 'node:fs';
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
	world: string;
	prompt: string;
	zone: string;
	anchor: string;
	model: string;
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
	judgeModel?: string;
	samplesRequested?: number;
	fixture?: string;
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

/** The batches' runs, one per key, and the latest verdict of each run; judge.ts may grade a run again. */
function readBatch(names: string): Batch {
	const runs: Run[] = [];
	const verdicts: Verdict[] = [];
	for (const name of names.split(',')) {
		const dir = resolve(import.meta.dirname, 'runs', name);
		runs.push(...jsonl<Run>(join(dir, 'runs.jsonl')));
		if (existsSync(join(dir, 'judged.jsonl'))) {
			verdicts.push(...jsonl<Verdict>(join(dir, 'judged.jsonl')));
		}
	}
	const keys = runs.map(runKey);
	const twice = keys.filter((key, i) => keys.indexOf(key) !== i);
	if (twice.length) throw new Error(`${names} holds runs twice: ${[...new Set(twice)].join(' ')}`);
	return { label: names, runs, verdictOf: new Map(verdicts.map((v) => [runKey(v), v])) };
}

/** The run's verdict, unless it has none or its grading failed. */
const scored = (batch: Batch, run: Run) => {
	const verdict = batch.verdictOf.get(runKey(run));
	return verdict && verdict.judgeError === null ? verdict : undefined;
};
/** The judge settings of the batch's scored runs, such as `claude-opus-5-5, 3 samples`. */
const judges = (batch: Batch) =>
	[
		...new Set(
			batch.runs.flatMap((run) => {
				const verdict = scored(batch, run);
				return verdict
					? [`${verdict.judgeModel ?? 'unknown'}, ${verdict.samplesRequested ?? 'unknown'} samples`]
					: [];
			})
		)
	].toSorted();
const safe = (run: Run) => run.mutations === 0 && !run.canaryLeak;

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

/** Pass share of each case across its scored repeats. */
function caseScores(batch: Batch): Map<string, number> {
	const passes = new Map<string, boolean[]>();
	for (const run of batch.runs) {
		const verdict = scored(batch, run);
		if (!verdict) continue;
		passes.set(caseKey(run), [...(passes.get(caseKey(run)) ?? []), verdict.pass]);
	}
	return new Map(
		[...passes].map(([id, votes]) => [id, votes.filter(Boolean).length / votes.length])
	);
}

function table(batch: Batch): void {
	const scores = caseScores(batch);
	const models = [...new Set(batch.runs.map((run) => run.model))].join(', ');
	const unscored = batch.runs.filter((run) => !scored(batch, run)).length;
	console.log(
		`\n${batch.label}: ${scores.size} cases, ${batch.runs.length} runs, model ${models}, judge ${judges(batch).join('; ') || '-'}${unscored ? `; ${unscored} runs unscored (no verdict or judge error), left out of pass` : ''}`
	);
	console.log(
		'group | cases | pass (case mean) | runs passed | safe passes | median tokens | median calls | median wall s | denied | canary leaks | mutating calls | errors | unscored'
	);
	const groups = new Map<string, Run[]>([['all', batch.runs]]);
	const add = (group: string, run: Run) => groups.set(group, [...(groups.get(group) ?? []), run]);
	for (const run of batch.runs) add(`set ${run.split}`, run);
	for (const run of batch.runs) add(`kind ${run.axes.kind ?? '-'}`, run);
	for (const [group, runs] of groups) {
		const ids = [...new Set(runs.map(caseKey))];
		const judged = ids.flatMap((id) => scores.get(id) ?? []);
		const passed = runs.filter((run) => scored(batch, run)?.pass);
		const count = runs.filter((run) => scored(batch, run)).length;
		console.log(
			[
				group,
				ids.length,
				judged.length ? pct(sum(judged) / judged.length) : '-',
				`${passed.length}/${count}`,
				`${passed.filter(safe).length}/${count}`,
				Math.round(median(runs.map(tokens))),
				median(runs.map((r) => r.toolCalls)),
				(median(runs.map((r) => r.wallMs)) / 1000).toFixed(0),
				sum(runs.map((r) => r.denied)),
				runs.filter((r) => r.canaryLeak).length,
				sum(runs.map((r) => r.mutations)),
				runs.filter((r) => r.error).length,
				runs.length - count
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
	// In 32-bit integer arithmetic: a float product would lose its low bits.
	const rand = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff) / 2 ** 31;
	const means: number[] = [];
	for (let r = 0; r < rounds; r++) {
		let total = 0;
		for (let i = 0; i < diffs.length; i++) total += diffs[Math.floor(rand() * diffs.length)]!;
		means.push(total / diffs.length);
	}
	const sorted = means.toSorted((a, b) => a - b);
	return [sorted[Math.floor(0.025 * rounds)]!, sorted[Math.floor(0.975 * rounds)]!];
}

/** Each case's prompt, world, zone, anchor and fixture, as its runs and verdicts give them. */
function setups(batch: Batch): Map<string, string> {
	const found = new Map<string, Set<string>>();
	for (const run of batch.runs) {
		const setup = JSON.stringify([
			run.prompt,
			run.world,
			run.zone,
			run.anchor,
			scored(batch, run)?.fixture
		]);
		found.set(caseKey(run), (found.get(caseKey(run)) ?? new Set()).add(setup));
	}
	return new Map([...found].map(([id, setup]) => [id, [...setup].toSorted().join('\n')]));
}

/** Why `batch` and `base` cannot be paired; empty when they can. */
function mismatches(batch: Batch, base: Batch): string[] {
	const ours = setups(batch);
	const theirs = setups(base);
	const problems = [batch, base].flatMap((side) => {
		const unscored = side.runs.filter((run) => !scored(side, run)).length;
		return [
			...(unscored ? [`${side.label}: ${unscored} runs unscored`] : []),
			...(judges(side).length > 1 ? [`${side.label}: judged with several settings`] : []),
			...(side.runs.some((run) => {
				const verdict = scored(side, run);
				return verdict && (!verdict.judgeModel || !verdict.samplesRequested || !verdict.fixture);
			})
				? [`${side.label}: verdicts without judge settings or fixture; judge a copy again`]
				: [])
		];
	});
	const ourJudges = judges(batch).join('; ');
	const theirJudges = judges(base).join('; ');
	if (ourJudges !== theirJudges) {
		problems.push(`judge differs: ${ourJudges} in ${batch.label}, ${theirJudges} in ${base.label}`);
	}
	for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
		if (!theirs.has(id)) problems.push(`${id}: only in ${batch.label}`);
		else if (!ours.has(id)) problems.push(`${id}: only in ${base.label}`);
		else if (ours.get(id) !== theirs.get(id))
			problems.push(`${id}: prompt, world, zone, anchor or fixture differs`);
	}
	return problems;
}

const batch = readBatch(values.batch);
const base = values.base ? readBatch(values.base) : undefined;
const problems = base ? mismatches(batch, base) : [];
if (problems.length) {
	console.error(`Cannot pair ${values.batch} with ${values.base}:`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
table(batch);
if (base) {
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
