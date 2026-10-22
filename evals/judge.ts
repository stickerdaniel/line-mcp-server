// Grades every run of a batch against its case rubric with headless Claude
// Code as the judge.
//
//   node evals/judge.ts --batch <name|path> [--samples 3] [--parallel 4]
//     [--model claude-opus-5-5]
//
// Writes <batch>/judged.jsonl and skips runs already graded there; a run
// whose grading failed is graded again, and its latest verdict counts. Each
// verdict records the judge model and `--samples`; a call whose settings
// differ from a successful verdict's refuses, exit 1. A judge sample counts only
// when it marks every rubric item exactly once. Each rubric item takes the
// majority of the judge samples, and a run passes when it ended without
// error, every required fact is met and no forbidden claim is made: the
// verdict is computed here from the item marks, never taken from the judge.
// A run with fewer valid samples than `--samples` gets no marks, only
// `judgeError` and `incomplete: true`.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claude, positiveInteger } from './claude.ts';
import { type Rubric, setOf, worldOf } from './sets.ts';
import type { World } from './world-format.ts';

const { values } = parseArgs({
	options: {
		batch: { type: 'string' },
		samples: { type: 'string', default: '3' },
		parallel: { type: 'string', default: '4' },
		model: { type: 'string', default: 'claude-opus-5-5' }
	},
	strict: true
});
if (!values.batch) throw new Error('--batch <name|path> is required');
const wanted = positiveInteger('samples', values.samples);
const parallel = positiveInteger('parallel', values.parallel);
const dir = resolve(import.meta.dirname, 'runs', values.batch);
const out = join(dir, 'judged.jsonl');

/** The fields of a `runs.jsonl` line the judge reads. */
interface Run {
	split: string;
	case: string;
	world: string;
	prompt: string;
	rubric?: Rubric;
	repeat: number;
	anchor: string;
	zone: string;
	answer: string;
	error: string | null;
}

const jsonl = <T>(path: string): T[] =>
	readFileSync(path, 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
const key = (run: { split: string; case: string; repeat: number }) =>
	`${run.split}/${run.case}/${run.repeat}`;

const runs = jsonl<Run>(join(dir, 'runs.jsonl'));
const seen = new Set<string>();
for (const run of runs) {
	if (seen.has(key(run))) throw new Error(`${dir}/runs.jsonl holds ${key(run)} twice`);
	seen.add(key(run));
}
const graded = existsSync(out)
	? jsonl<Run & { judgeError: string | null; judgeModel?: string; samplesRequested?: number }>(
			out
		).filter((verdict) => verdict.judgeError === null)
	: [];
const other = graded.find(
	(verdict) => verdict.judgeModel !== values.model || verdict.samplesRequested !== wanted
);
if (other) {
	console.error(
		`${out} holds verdicts of judge ${other.judgeModel ?? 'unknown'} with ${other.samplesRequested ?? 'unknown'} samples, not ${values.model} with ${wanted}; judge with those settings, or copy runs.jsonl to a new batch`
	);
	process.exit(1);
}
const done = new Set(graded.map(key));

/** Worlds as built at an anchor; the rubric reads them. */
const built = new Map<string, World>();
function worldAt(name: string, anchor: string): World {
	const cacheKey = `${name}/${anchor}`;
	let world = built.get(cacheKey);
	if (!world) {
		world = worldOf(name).build(anchor);
		built.set(cacheKey, world);
	}
	return world;
}

const list = (items: string[]) =>
	items.map((item, i) => `${i + 1}. ${item}`).join('\n') || '(none)';

/** The judge prompt for one answer; `zone` and `anchor` give the user's today. */
function prompt(
	c: { prompt: string },
	rubric: Rubric,
	answer: string,
	anchor: string,
	zone: string
): string {
	// A list check holds the case author's evidence handles, which no answer names.
	const check =
		rubric.check?.kind === 'count'
			? `\nExpected count: ${JSON.stringify(rubric.check.value)}\n`
			: '';
	return `You grade an AI assistant's answer to a user's request about the user's LINE chats. The expected facts below were computed from the user's archive. Today's date in the user's time zone (${zone}) is ${anchor}.

USER REQUEST:
<<<
${c.prompt}
>>>

REQUIRED FACTS (each must be stated or unambiguously implied by the answer; accept equivalent wording, paraphrase, translation into any language, and times within any stated tolerance):
${list(rubric.required)}

FORBIDDEN CLAIMS (the answer must not assert any of these):
${list(rubric.forbidden)}
${check}
ANSWER TO GRADE:
<<<
${answer}
>>>

Grade only the answer text. Extra correct detail is fine and is not a forbidden claim unless it matches one. A forbidden claim about out-of-scope or superseded content is made only when the answer presents that content as part of its answer to the request; accurate context the answer clearly marks as outside the request is not a forbidden claim. A required fact the answer leaves out, gets wrong, or only hedges about is not met. Reply with JSON only, no prose:
{"required":[{"i":1,"met":true,"why":"short reason"}],"forbidden":[{"i":1,"violated":false,"why":"short reason"}]}`;
}

/** One judge call; returns its text reply. */
async function ask(text: string): Promise<string> {
	const { stdout } = await claude(
		text,
		() => [
			'--model',
			values.model,
			'--tools',
			'',
			'--strict-mcp-config',
			'--output-format',
			'json',
			'--no-session-persistence'
		],
		10 * 60_000
	);
	const line = stdout
		.split('\n')
		.toReversed()
		.find((l) => l.startsWith('{"'));
	if (!line) throw new Error('judge gave no JSON result');
	const result = JSON.parse(line) as { result?: string; is_error?: boolean };
	if (result.is_error || typeof result.result !== 'string') throw new Error('judge failed');
	return result.result;
}

/** True when more than half the votes are. */
const majority = (votes: boolean[]) => votes.filter(Boolean).length * 2 > votes.length;

interface Marks {
	required: { i: number; met: boolean; why: string }[];
	forbidden: { i: number; violated: boolean; why: string }[];
}

/** True when `marks` holds exactly one entry for each index 1..`count`, each with a boolean `flag`. */
function marksAll(marks: unknown, count: number, flag: 'met' | 'violated'): boolean {
	if (!Array.isArray(marks) || marks.length !== count) return false;
	const entries = marks as ({ i?: unknown } & Record<string, unknown>)[];
	const indices = new Set(entries.map((mark) => mark?.i));
	return (
		indices.size === count &&
		Array.from({ length: count }, (_, k) => k + 1).every((i) => indices.has(i)) &&
		entries.every((mark) => typeof mark?.[flag] === 'boolean')
	);
}

async function grade(run: Run) {
	const rubric =
		run.rubric ?? setOf(run.split).rubric(run.case, worldAt(run.world, run.anchor), run.anchor);
	// Independent judge samples, each tried twice; each item takes the majority.
	const samples: Marks[] = [];
	let failure: string | undefined;
	for (let s = 0; s < wanted; s++) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const reply = await ask(prompt(run, rubric, run.answer, run.anchor, run.zone));
				const sample = JSON.parse(
					reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
				) as Marks;
				if (
					!marksAll(sample.required, rubric.required.length, 'met') ||
					!marksAll(sample.forbidden, rubric.forbidden.length, 'violated')
				) {
					throw new Error('judge did not mark every rubric item once');
				}
				samples.push(sample);
				break;
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		}
	}
	const complete = samples.length === wanted;
	const marks: Marks | undefined = complete
		? {
				required: rubric.required.map((_, k) => ({
					i: k + 1,
					met: majority(samples.map((m) => m.required.find((x) => x.i === k + 1)?.met === true)),
					why: samples.map((m) => m.required.find((x) => x.i === k + 1)?.why ?? '').join(' / ')
				})),
				forbidden: rubric.forbidden.map((_, k) => ({
					i: k + 1,
					violated: majority(
						samples.map((m) => m.forbidden.find((x) => x.i === k + 1)?.violated === true)
					),
					why: samples.map((m) => m.forbidden.find((x) => x.i === k + 1)?.why ?? '').join(' / ')
				}))
			}
		: undefined;
	const met = marks ? marks.required.every((m) => m.met) : false;
	const clean = marks ? !marks.forbidden.some((m) => m.violated) : false;
	return {
		split: run.split,
		case: run.case,
		repeat: run.repeat,
		version: 'g3',
		judgeModel: values.model,
		samplesRequested: wanted,
		samples: samples.length,
		incomplete: !complete,
		pass: run.error === null && met && clean,
		met,
		clean,
		requiredMissed: marks ? marks.required.filter((m) => !m.met).map((m) => m.i) : null,
		forbiddenHit: marks ? marks.forbidden.filter((m) => m.violated).map((m) => m.i) : null,
		marks,
		judgeError: complete ? null : `${samples.length} of ${wanted} samples: ${failure ?? 'unknown'}`
	};
}

const todo = runs.filter((run) => !done.has(key(run)));
let next = 0;
await Promise.all(
	Array.from({ length: parallel }, async () => {
		while (next < todo.length) {
			const run = todo[next++]!;
			const verdict = await grade(run);
			appendFileSync(out, `${JSON.stringify(verdict)}\n`);
			console.error(
				`${run.case} #${run.repeat}: ${verdict.pass ? 'pass' : 'fail'}${verdict.judgeError ? ' (judge error)' : ''}`
			);
		}
	})
);
console.error(`done: ${out}`);
