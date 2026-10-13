// Pull request title check for .github/workflows/pr-title.yml, a port of
// linkedin-mcp-server's scripts/check_pr_title.py. Imports only Node built-ins:
// the workflow runs it from a bare checkout, without node_modules.
//
//   node scripts/check-pr-title.ts --pr-json <file>
//     checks the title of the pull request JSON from the GitHub API
//   PR_TITLE=<title> node scripts/check-pr-title.ts
//     checks a title from the environment
//
// A valid title prints nothing. An invalid one prints one fixed `::error::`
// annotation and a hint, never the title or the file path, and exits 1.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const ALLOWED_TYPES = [
	'feat',
	'fix',
	'docs',
	'style',
	'refactor',
	'test',
	'chore',
	'perf',
	'ci'
] as const;

export const MISSING_TITLE = 'PR title is missing.';
export const INVALID_PR_DATA = 'Unable to read current pull request data.';
export const UNSAFE_CHARACTER = 'PR title contains an unsafe character.';
export const INVALID_SHAPE = 'PR title must use an accepted conventional-commit shape.';
export const UNSUPPORTED_TYPE = 'PR title uses an unsupported type.';
export const INVALID_SCOPE = 'PR title has an invalid scope.';
export const INVALID_SUBJECT = 'PR title has an invalid subject.';
export const FINAL_PERIOD = 'PR title subject must not end with an ASCII period.';
export const SUBJECT_LIMIT = 50;
export const LOWERCASE_SUBJECT = 'PR title subject must start with a capital letter.';
export const LONG_SUBJECT = `PR title subject must be under ${SUBJECT_LIMIT} characters.`;

// Renovate's account. A `[bot]` login is reserved for GitHub Apps, so no user
// account can claim it. Renovate lowercases the first letter of every subject
// after a commit prefix, with no setting to change that, and names packages at
// full length, so its titles are held to the shape alone.
export const RENOVATE = { login: 'renovate[bot]', type: 'Bot' } as const;

export const HINT =
	'Expected: type: Subject, type(scope): Subject, type!: Subject, or ' +
	`type(scope)!: Subject. Allowed types: ${ALLOWED_TYPES.join(', ')}. ` +
	`The subject starts with a capital letter and stays under ${SUBJECT_LIMIT} ` +
	'characters.';

// `[^\n]` is what `.` means in the Python original.
const TITLE = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?: (?<subject>[^\n]*)$/u;
const allowedTypes: ReadonlySet<string> = new Set(ALLOWED_TYPES);
const unsafeCodePoints: ReadonlySet<number> = new Set([
	0x200b, 0x2028, 0x2029, 0x2060, 0xfeff, 0xfffd,
	// Bidirectional formatting.
	0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069
]);
const nonSubstantive = /[\p{C}\p{M}\p{Z}]/u;
const invalidBoundary = /[\p{Cf}\p{Z}]/u;
// What Python's `str.islower` tests for a single character.
const lowercase = /\p{Lowercase}/u;

function isUnsafe(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || unsafeCodePoints.has(codePoint)
	);
}

function lastSubstantive(value: string): string | undefined {
	return Array.from(value).findLast((character) => !nonSubstantive.test(character));
}

function hasInvalidBoundary(value: string): boolean {
	const characters = Array.from(value);
	return [characters[0], characters.at(-1)].some(
		(character) => character !== undefined && invalidBoundary.test(character)
	);
}

/** A fixed diagnostic for a title outside the accepted shape, or undefined. */
export function validateTitle(title: string): string | undefined {
	if (Array.from(title).some(isUnsafe)) return UNSAFE_CHARACTER;

	const groups = TITLE.exec(title)?.groups;
	if (!groups) return INVALID_SHAPE;

	if (!allowedTypes.has(groups.type ?? '')) return UNSUPPORTED_TYPE;

	const { scope, subject = '' } = groups;
	if (scope !== undefined && (lastSubstantive(scope) === undefined || hasInvalidBoundary(scope))) {
		return INVALID_SCOPE;
	}

	const last = lastSubstantive(subject);
	if (last === undefined) return INVALID_SUBJECT;
	if (last === '.') return FINAL_PERIOD;
	if (hasInvalidBoundary(subject)) return INVALID_SUBJECT;

	return undefined;
}

/**
 * A diagnostic for a valid title that breaks the house style, or undefined.
 * Run after `validateTitle`; Renovate's titles skip it, see `RENOVATE`.
 */
export function validateStyle(title: string): string | undefined {
	const subject = TITLE.exec(title)?.groups?.subject;
	if (subject === undefined) return INVALID_SHAPE;
	// Code points, as Python counts them.
	const characters = Array.from(subject);
	if (characters[0] !== undefined && lowercase.test(characters[0])) return LOWERCASE_SUBJECT;
	if (characters.length >= SUBJECT_LIMIT) return LONG_SUBJECT;
	return undefined;
}

/** Whether a pull request's `user` object is Renovate's app account. */
export function isRenovate(user: unknown): boolean {
	return (
		typeof user === 'object' &&
		user !== null &&
		'login' in user &&
		user.login === RENOVATE.login &&
		'type' in user &&
		user.type === RENOVATE.type
	);
}

/** The title and whether Renovate wrote it, or undefined if unreadable. */
function loadPullRequest(path: string): { title: string; byRenovate: boolean } | undefined {
	let data: unknown;
	try {
		// Fatal and BOM-preserving, so bytes Python's strict UTF-8 read or JSON
		// parser refuses are refused here too.
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			readFileSync(path)
		);
		data = JSON.parse(text);
	} catch {
		return undefined;
	}

	if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
	const title = 'title' in data ? data.title : undefined;
	if (typeof title !== 'string' || !title) return undefined;
	return { title, byRenovate: 'user' in data && isRenovate(data.user) };
}

function main(args: string[], env: NodeJS.ProcessEnv): number {
	let prJson: string | undefined;
	try {
		prJson = parseArgs({ args, options: { 'pr-json': { type: 'string' } } }).values['pr-json'];
	} catch {
		console.error('usage: check-pr-title.ts [--pr-json PR_JSON]');
		return 2;
	}

	let diagnostic: string | undefined;
	if (prJson !== undefined) {
		const pullRequest = loadPullRequest(prJson);
		diagnostic =
			pullRequest === undefined
				? INVALID_PR_DATA
				: (validateTitle(pullRequest.title) ??
					(pullRequest.byRenovate ? undefined : validateStyle(pullRequest.title)));
	} else {
		const title = env.PR_TITLE;
		diagnostic = !title ? MISSING_TITLE : (validateTitle(title) ?? validateStyle(title));
	}

	if (diagnostic === undefined) return 0;

	console.log(`::error::${diagnostic}`);
	console.log(HINT);
	return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
