import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	FINAL_PERIOD,
	INVALID_PR_DATA,
	INVALID_SCOPE,
	INVALID_SHAPE,
	INVALID_SUBJECT,
	LONG_SUBJECT,
	LOWERCASE_SUBJECT,
	MISSING_TITLE,
	RENOVATE,
	UNSAFE_CHARACTER,
	UNSUPPORTED_TYPE,
	validateStyle,
	validateTitle
} from '../scripts/check-pr-title.ts';
import { tempRoot } from './fake-line.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'check-pr-title.ts');
const char = (codePoint: number) => String.fromCodePoint(codePoint);
/** `[name, character]` rows named `U+00AD`, for `it.each`. */
const characters = (codePoints: number[]) =>
	codePoints.map(
		(codePoint) =>
			[`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`, char(codePoint)] as const
	);

/** Runs the CLI with `PR_TITLE` set to `title`, or unset, and optional `--pr-json`. */
function runCli(title: string | undefined, prJson?: string) {
	const env = { ...process.env };
	if (title === undefined) delete env.PR_TITLE;
	else env.PR_TITLE = title;
	const args = prJson === undefined ? [script] : [script, '--pr-json', prJson];
	const result = spawnSync('node', args, { env, encoding: 'utf-8' });
	return { ...result, output: result.stdout + result.stderr };
}

/** Writes `contents` as the PR JSON in a fresh temp dir and runs the CLI on it. */
function runWithPrJson(contents: string, envTitle?: string) {
	const dir = tempRoot();
	try {
		const prJson = join(dir, 'pull-request.json');
		writeFileSync(prJson, contents);
		return runCli(envTitle, prJson);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const errorLines = (output: string) =>
	output.split('\n').filter((line) => line.startsWith('::error::'));

describe('validateTitle', () => {
	it.each([
		'feat: Add title validation',
		'fix(parser): Reject an invalid title',
		'docs!: Rewrite the guide',
		'refactor(release workflow)!: Restore required checks'
	])('accepts %s', (title) => {
		expect(validateTitle(title)).toBeUndefined();
	});

	// linkedin-mcp-server's list, written out so a type dropped from the checker fails here.
	it.each(['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci'])(
		'accepts the type %s',
		(type) => {
			expect(validateTitle(`${type}: Accept this title`)).toBeUndefined();
		}
	);

	it.each(['build', 'revert'])('rejects the type %s', (type) => {
		expect(validateTitle(`${type}: Package the release`)).toBe(UNSUPPORTED_TYPE);
	});

	it.each([
		['fix:Add spacing', INVALID_SHAPE],
		['fix:  Add spacing', INVALID_SUBJECT],
		['fix : Add spacing', INVALID_SHAPE],
		[' fix: Add spacing', INVALID_SHAPE],
		['fix(scope) : Add spacing', INVALID_SHAPE],
		['fix(scope)! : Add spacing', INVALID_SHAPE],
		['fix(scope)!!: Add spacing', INVALID_SHAPE],
		['fix!!: Add spacing', INVALID_SHAPE],
		['fix!extra: Add spacing', INVALID_SHAPE],
		['fix(): Add spacing', INVALID_SCOPE],
		['fix( scope): Add spacing', INVALID_SCOPE],
		['fix(scope ): Add spacing', INVALID_SCOPE],
		['fix: ', INVALID_SUBJECT],
		['fix:  ', INVALID_SUBJECT],
		['fix: Add spacing ', INVALID_SUBJECT],
		['fix: Add spacing.', FINAL_PERIOD]
	])('returns a fixed diagnostic for %j', (title, diagnostic) => {
		expect(validateTitle(title)).toBe(diagnostic);
	});

	// Separators (Z) and format characters (Cf) at either end of scope or subject.
	it.each(characters([0x20, 0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000, 0xad, 0x200d]))(
		'rejects %s at a boundary',
		(_, c) => {
			expect(validateTitle(`fix(${c}scope): Keep boundaries`)).toBe(INVALID_SCOPE);
			expect(validateTitle(`fix(scope${c}): Keep boundaries`)).toBe(INVALID_SCOPE);
			expect(validateTitle(`fix: ${c}Keep boundaries`)).toBe(INVALID_SUBJECT);
			expect(validateTitle(`fix: Keep boundaries${c}`)).toBe(INVALID_SUBJECT);
		}
	);

	it.each(
		characters([
			0x00, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x9f, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029,
			0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfffd
		])
	)('rejects %s anywhere, before any other diagnostic', (_, c) => {
		for (const title of [`fix: Before${c}after`, `fix(${c}): Subject`, `build: Invalid.${c}`]) {
			expect(validateTitle(title)).toBe(UNSAFE_CHARACTER);
		}
	});

	it('requires substantive scope and subject content', () => {
		expect(validateTitle(`fix(${char(0x301)}): Subject`)).toBe(INVALID_SCOPE);
		expect(validateTitle(`fix: ${char(0x301)}`)).toBe(INVALID_SUBJECT);
	});

	it.each(characters([0xad, 0x301]))('finds a final period behind %s', (_, c) => {
		expect(validateTitle(`fix: Do not hide.${c}`)).toBe(FINAL_PERIOD);
	});

	it.each([
		`fix(cafe${char(0x301)}): Handle resume${char(0x301)}`,
		`fix: Support 👩${char(0x200d)}💻 profiles`,
		'feat(HTTP/API v2): Preserve internal punctuation',
		'fix: Handle déjà vu safely',
		'docs: Explain 日本語 titles',
		'test: Permit commas, semicolons; and question marks?',
		'chore: Permit a Unicode full stop。',
		'perf(scope! #42): Permit punctuation in scope'
	])('accepts Unicode and internal punctuation: %s', (title) => {
		expect(validateTitle(title)).toBeUndefined();
	});
});

describe('validateStyle', () => {
	it.each([
		['fix: Keep this one', undefined],
		['fix: keep this one', LOWERCASE_SUBJECT],
		['fix(tools): `get_feed` keeps its cap', undefined],
		['fix: 2 retries are enough', undefined],
		['fix: Ünïcode capitals count', undefined],
		[`fix: ${'A'.repeat(49)}`, undefined],
		[`fix: ${'A'.repeat(50)}`, LONG_SUBJECT],
		// Code points, not UTF-16 units: 49 emoji are 98 units.
		[`fix: ${'😀'.repeat(49)}`, undefined]
	])('%j gives %j', (title, diagnostic) => {
		expect(validateTitle(title)).toBeUndefined();
		expect(validateStyle(title)).toBe(diagnostic);
	});
});

const pr = (title: string, user: unknown) => JSON.stringify({ title, user });

describe('check-pr-title.ts', () => {
	const person = { login: 'a', type: 'User' };

	it.each(['chore(deps): lock file maintenance', `chore(deps): ${'a'.repeat(60)}`])(
		'holds Renovate to the shape only, and a person to the style too: %s',
		(title) => {
			const renovate = runWithPrJson(pr(title, RENOVATE));
			expect(renovate.status).toBe(0);
			expect(renovate.output).toBe('');

			const human = runWithPrJson(pr(title, person));
			expect(human.status).toBe(1);
			expect(human.stdout.startsWith(`::error::${validateStyle(title)}\n`)).toBe(true);
		}
	);

	it.each([{ login: 'renovate[bot]', type: 'User' }, { login: 'renovate', type: 'Bot' }, null])(
		'exempts only the exact Renovate app identity, not %j',
		(user) => {
			const result = runWithPrJson(pr('chore(deps): lock file maintenance', user));
			expect(result.stdout.startsWith(`::error::${LOWERCASE_SUBJECT}\n`)).toBe(true);
		}
	);

	it('still checks the shape of a Renovate title', () => {
		const result = runWithPrJson(pr('build(deps): Update oxlint', RENOVATE));
		expect(result.stdout.startsWith(`::error::${UNSUPPORTED_TYPE}\n`)).toBe(true);
	});

	it('style-checks a title from the environment', () => {
		const result = runCli('fix: lowercase subject');
		expect(result.status).toBe(1);
		expect(result.stdout.startsWith(`::error::${LOWERCASE_SUBJECT}\n`)).toBe(true);
	});

	it.each([
		'build: payload%0A::warning::leaked',
		'build: ::warning:: forged annotation',
		'fix: actual\rcontrol',
		'fix: actual\ncontrol',
		`fix: Subject.${char(0x200b)}`
	])('prints one safe annotation for %j', (title) => {
		const result = runCli(title);
		expect(result.status).toBe(1);
		expect(errorLines(result.output)).toHaveLength(1);
		expect(result.output).toContain('Expected: type: Subject');
		expect(result.output).not.toContain(title);
		expect(result.output).not.toContain('::warning::');
	});

	it('reports a missing title', () => {
		for (const title of [undefined, '']) {
			const result = runCli(title);
			expect(result.status).toBe(1);
			expect(errorLines(result.output)).toEqual([`::error::${MISSING_TITLE}`]);
		}
	});

	it('exits silently for a valid title', () => {
		const result = runCli('fix(cli): Accept safe input');
		expect(result.status).toBe(0);
		expect(result.output).toBe('');
	});

	it('reads the current title from the PR JSON over the environment', () => {
		const result = runWithPrJson(
			JSON.stringify({ title: 'fix(cli): Read current API data' }),
			'build: Ignore stale event data'
		);
		expect(result.status).toBe(0);
		expect(result.output).toBe('');
	});

	it.each(['{', '{}', '{"title": null}', '{"title": ""}', '[]', '\uFEFF{"title": "fix: Ok"}'])(
		'refuses malformed PR JSON %j without echoing it',
		(contents) => {
			const result = runWithPrJson(contents, 'fix: Stale event title');
			expect(result.status).toBe(1);
			expect(errorLines(result.output)).toEqual([`::error::${INVALID_PR_DATA}`]);
			expect(result.output).not.toContain(contents);
			expect(result.output).not.toContain('Stale event title');
		}
	);

	it('refuses a missing PR JSON file without echoing its path', () => {
		const dir = tempRoot();
		const result = runCli('fix: Stale event title', join(dir, 'missing.json'));
		rmSync(dir, { recursive: true, force: true });
		expect(result.status).toBe(1);
		expect(errorLines(result.output)).toEqual([`::error::${INVALID_PR_DATA}`]);
		expect(result.output).not.toContain('missing.json');
	});
});
