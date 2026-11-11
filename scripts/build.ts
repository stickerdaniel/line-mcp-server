// Builds dist/cli.js and, beside it, dist/query-runner.js, the process the
// `query` tool runs SQL in, for the npm package. Bun bundles src/ alone; every
// package in `dependencies` stays external, so npm installs it with its own
// license. Fails when a bundle takes in anything outside src/, such as an
// import of a package missing from `dependencies`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Manifest {
	dependencies?: Record<string, string>;
}

interface Metafile {
	inputs: Record<string, unknown>;
}

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

/** Each entry becomes `dist/<name>.js`; `src/paths.ts` finds the runner beside the CLI. */
const entries = ['src/cli.ts', 'src/query-runner.ts'];

const work = mkdtempSync(join(tmpdir(), 'line-mcp-build-'));
const metafile = join(work, 'meta.json');
const external = Object.keys((JSON.parse(read('package.json')) as Manifest).dependencies ?? {});
rmSync(join(root, 'dist'), { recursive: true, force: true });
try {
	execFileSync(
		'bun',
		[
			'build',
			...entries,
			'--target=node',
			'--format=esm',
			'--root=src',
			'--outdir=dist',
			`--metafile=${metafile}`,
			...external.map((name) => `--external=${name}`)
		],
		{ cwd: root, stdio: 'inherit' }
	);
	const { inputs } = JSON.parse(readFileSync(metafile, 'utf-8')) as Metafile;
	const problems = new Set<string>();
	for (const input of Object.keys(inputs)) {
		if (!input.startsWith('src/')) problems.add(`${input} is bundled but lies outside src/`);
	}
	for (const entry of entries) {
		const output = entry.replace(/^src\/(.*)\.ts$/, 'dist/$1.js');
		if (!existsSync(join(root, output))) problems.add(`${output} was not built`);
	}
	if (!read('dist/cli.js').startsWith('#!/usr/bin/env node\n')) {
		problems.add('dist/cli.js lost its shebang');
	}
	if (problems.size > 0) {
		rmSync(join(root, 'dist'), { recursive: true, force: true });
		throw new Error(`build: ${[...problems].join('\n')}`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
