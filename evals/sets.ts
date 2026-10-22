// The eval's case sets and worlds: each set's case file, world, rubric,
// count rules and validator. `check.ts`, `run.ts`, `judge.ts` and
// `summarize.ts` all resolve sets and worlds here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type LoadedWorld, worldZone } from './load-world.ts';
import { rubric as devRubric, rules as devRules } from './oracles/gen1/oracles.ts';
import { rubric as sealedRubric, rules as sealedRules } from './oracles/gen1/sealed.ts';
import { validate as validate1 } from './oracles/gen1/validate.ts';
import { rubric as rubric2, rules as rules2 } from './oracles/gen2/oracles.ts';
import { validate as validate2 } from './oracles/gen2/validate.ts';
import { rubric as rubric3, rules as countRules3 } from './oracles/gen3/oracles.ts';
import { validate as validate3 } from './oracles/gen3/validate.ts';
import type { At, MessageKind, World } from './world-format.ts';
import w1 from './worlds/w1.ts';
import w2 from './worlds/w2.ts';
import w3 from './worlds/w3.ts';
import w4, { buildWorld as buildW4 } from './worlds/w4.ts';
import w5 from './worlds/w5.ts';
import w6 from './worlds/w6.ts';

/** One eval case as the case files hold it. */
export interface Case {
	id: string;
	/** The set the case belongs to. */
	split: string;
	world: string;
	prompt: string;
	/** Request kind, service, language, message kind, time, size, ambiguity and more. */
	axes: Record<string, string>;
	/** The contrast the case takes part in, `unread-vs-new` for example. */
	contrast: string | null;
	notes: string;
	/** An external case's own rubric; the included sets compute theirs. */
	rubric?: Rubric;
}

/** What the judge grades an answer against. */
export interface Rubric {
	required: string[];
	forbidden: string[];
	/** The expected count, or the evidence handles of a list; no answer names the handles. */
	check?: { kind: 'count' | 'list'; value: number | string[] };
}

/** The message filter of a rule, as the count check in `check.ts` reads it. */
export interface CountFilter {
	chats?: string[];
	keys?: string[];
	from?: string;
	notSelf?: boolean;
	thread?: string | null;
	kinds?: MessageKind[];
	since?: At;
	until?: At;
	contains?: string | string[];
	includeUnsent?: boolean;
	unread?: boolean;
	callType?: 'audio' | 'video';
	callResult?: string;
}

/** A case rule as the count check reads it; `zone` places `since`/`until` when not the world's. */
export interface CountRule {
	filter?: CountFilter;
	zone?: string;
}

/** A world loaded at its anchor through the production write paths, its archive open read-only. */
export interface Archive {
	world: World;
	anchor: string;
	loaded: LoadedWorld;
	db: DatabaseSync;
}

export interface ValidatorInput {
	/** The cases of every set the validator covers, by set name. */
	cases: Record<string, Case[]>;
	/** The sets to check cases of; the others take part in checks across sets only. */
	checked: ReadonlySet<string>;
	/** A world as built at its anchor. */
	world(name: string): { world: World; anchor: string };
	/** A world loaded into an archive, once per world. */
	archive(name: string): Promise<Archive>;
}

/** One checked case: no `error` when its rubric holds. */
export interface CaseResult {
	set: string;
	id: string;
	error?: unknown;
}

/** One generation's validator over the sets its oracles cover. */
export type Validator = (input: ValidatorInput) => Promise<CaseResult[]>;

export interface WorldEntry {
	zone: string;
	/** The world at `anchor`; most worlds are the same on every anchor. */
	build(anchor: string): World;
}

const fixed = (world: World): WorldEntry => ({ zone: worldZone(world), build: () => world });

export const worlds: Record<string, WorldEntry> = {
	w1: fixed(w1),
	w2: fixed(w2),
	w3: fixed(w3),
	// Its filler runs from 2026-02-01 to the anchor.
	w4: { zone: worldZone(w4), build: buildW4 },
	w5: fixed(w5),
	w6: fixed(w6)
};

export interface SetEntry {
	/** The case file, `{ canary, cases }`. */
	file: string;
	world: string;
	rubric(id: string, world: World, anchor: string): Rubric;
	/** Rules by case id, for the count check. */
	rules: Record<string, CountRule>;
	validate: Validator;
}

const caseFile = (name: string) => join(import.meta.dirname, 'cases', `${name}.json`);

export const sets: Record<string, SetEntry> = {
	dev: {
		file: caseFile('dev'),
		world: 'w1',
		rubric: devRubric,
		rules: devRules,
		validate: validate1
	},
	holdout: {
		file: caseFile('holdout'),
		world: 'w1',
		rubric: sealedRubric,
		rules: sealedRules,
		validate: validate1
	},
	ood: {
		file: caseFile('ood'),
		world: 'w2',
		rubric: sealedRubric,
		rules: sealedRules,
		validate: validate1
	},
	holdout2: {
		file: caseFile('holdout2'),
		world: 'w3',
		rubric: rubric2,
		rules: rules2,
		validate: validate2
	},
	ood2: {
		file: caseFile('ood2'),
		world: 'w4',
		rubric: rubric2,
		rules: rules2,
		validate: validate2
	},
	holdout3: {
		file: caseFile('holdout3'),
		world: 'w5',
		rubric: rubric3,
		rules: countRules3,
		validate: validate3
	},
	ood3: {
		file: caseFile('ood3'),
		world: 'w6',
		rubric: rubric3,
		rules: countRules3,
		validate: validate3
	}
};

export function setOf(name: string): SetEntry {
	const entry = sets[name];
	if (!entry) throw new Error(`Unknown set ${name}; the sets are ${Object.keys(sets).join(', ')}`);
	return entry;
}

export function worldOf(name: string): WorldEntry {
	const entry = worlds[name];
	if (!entry) throw new Error(`Unknown world ${name}`);
	return entry;
}

/** The cases of a case file, an included set's or an external one of the same shape. */
export function readCases(file: string): Case[] {
	const { cases } = JSON.parse(readFileSync(file, 'utf-8')) as { cases?: Case[] };
	if (!Array.isArray(cases)) throw new Error(`${file} holds no cases array`);
	return cases;
}

/** Today's date, YYYY-MM-DD, in `timeZone`. */
export const today = (timeZone: string): string =>
	new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
