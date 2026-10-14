// Release decisions for .github/workflows/release.yml. Imports only Node
// built-ins: the npm publish job checks out just this file, without
// node_modules.
//
//   node scripts/release-plan.ts detect <previous> <current> <tag sha or ''> <sha>
//     prints `release=true` and `version=<current>`, or `release=false`
//   node scripts/release-plan.ts publish <tarball> <version>
//     asks npm for the published integrity, prints `publish=true|false`
//
// A refused release prints the reason and exits 1.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parses a stable `x.y.z`; prereleases and build metadata are refused. */
export function parseVersion(version: string): [number, number, number] {
	const match = stable.exec(version);
	if (!match) throw new Error(`${version || '(empty)'} is not a stable x.y.z version`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive as `a` is lower than, equal to or greater than `b`. */
export function compareVersions(a: string, b: string): number {
	const [x, y] = [parseVersion(a), parseVersion(b)];
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

interface Push {
	/** package.json version before and after the push. */
	previous: string;
	current: string;
	/** Commit the remote tag `v<current>` points at, or '' when there is none. */
	tagSha: string;
	/** The pushed commit. */
	sha: string;
}

/**
 * The version a push to main releases, or undefined when it left the version
 * alone. Throws for a version that is not a stable increase, or whose tag
 * already names another commit. An existing tag at `sha` is a rerun, not a skip.
 */
export function planRelease({ previous, current, tagSha, sha }: Push): string | undefined {
	if (current === previous) return undefined;
	if (compareVersions(current, previous) <= 0) {
		throw new Error(`version ${current} is not greater than ${previous}`);
	}
	if (tagSha && tagSha !== sha) throw new Error(`tag v${current} points at ${tagSha}, not ${sha}`);
	return current;
}

/** `npm view <spec> dist.integrity --json` output: the integrity or an error. */
type NpmView = string | { error?: { code?: unknown } } | null;

/**
 * Whether to publish a tarball with `integrity`, given what npm printed for its
 * version. The same tarball already published is a rerun and skips; another
 * tarball under that version, or any failure except E404, throws.
 */
export function planPublish(integrity: string, npmView: string): 'publish' | 'skip' {
	let view: NpmView;
	try {
		view = JSON.parse(npmView) as NpmView;
	} catch {
		throw new Error(`npm view printed no JSON: ${npmView.trim() || '(nothing)'}`);
	}
	if (typeof view === 'string') {
		if (view === integrity) return 'skip';
		throw new Error(`npm has this version from another tarball: ${view}, not ${integrity}`);
	}
	if (view?.error?.code === 'E404') return 'publish';
	throw new Error(`npm view failed: ${npmView.trim()}`);
}

/**
 * Runs npm. On Windows `npm` is a `.cmd` shim, which spawn runs only through
 * a shell; Node runs the npm entry the shim would, from beside it on PATH.
 */
function npm(args: string[]) {
	if (process.platform !== 'win32') return spawnSync('npm', args, { encoding: 'utf-8' });
	const dir = (process.env.PATH ?? '')
		.split(delimiter)
		.find((entry) => entry && existsSync(join(entry, 'npm.cmd')));
	if (!dir) throw new Error('npm.cmd is not on PATH');
	const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
	return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8' });
}

/** The `sha512-<base64>` integrity npm records for a tarball. */
function tarballIntegrity(path: string): string {
	return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

function main(command: string | undefined, args: string[]): string {
	if (command === 'detect' && args.length === 4) {
		const [previous = '', current = '', tagSha = '', sha = ''] = args;
		const version = planRelease({ previous, current, tagSha, sha });
		return version ? `release=true\nversion=${version}` : 'release=false';
	}
	if (command === 'publish' && args.length === 2) {
		const [tarball = '', version = ''] = args;
		const spec = `line-mcp-server@${version}`;
		const view = npm(['view', spec, 'dist.integrity', '--json']);
		return `publish=${planPublish(tarballIntegrity(tarball), view.stdout ?? '') === 'publish'}`;
	}
	throw new Error('usage: release-plan.ts detect|publish <args>, see the header');
}

if (import.meta.main) {
	try {
		console.log(main(process.argv[2], process.argv.slice(3)));
	} catch (error) {
		console.error(`release-plan: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
