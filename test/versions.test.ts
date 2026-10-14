import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempRoot } from './fake-line.ts';

const repo = join(import.meta.dirname, '..');
const manifests = [
	'package.json',
	'plugins/line-mcp-server/.codex-plugin/plugin.json',
	'plugins/line-mcp-server/.claude-plugin/plugin.json'
];
const version = (text: string) => (JSON.parse(text) as { version: string }).version;

it('package.json and both plugin manifests carry the same version', () => {
	const versions = manifests.map((file) => version(readFileSync(join(repo, file), 'utf-8')));
	expect(versions).toEqual(manifests.map(() => versions[0]));
});

/** A copy of the scripts and the three manifests at `from`; returns their texts by path. */
function checkout(from: string): { dir: string; texts: Map<string, string> } {
	const dir = tempRoot();
	cpSync(join(repo, 'scripts'), join(dir, 'scripts'), { recursive: true });
	const texts = new Map<string, string>();
	for (const file of manifests) {
		const text = readFileSync(join(repo, file), 'utf-8').replace(
			/"version": "[^"]*"/,
			`"version": "${from}"`
		);
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
		texts.set(file, text);
	}
	return { dir, texts };
}

const bump = (dir: string, target: string) =>
	promisify(execFile)(process.execPath, [join(dir, 'scripts', 'bump.ts'), target]);

describe('bump.ts', () => {
	it.each([
		['patch', '1.9.4'],
		['minor', '1.10.0'],
		['major', '2.0.0'],
		['1.10.0', '1.10.0']
	])('%s raises 1.9.3 to %s in every manifest and changes nothing else', async (target, next) => {
		const { dir, texts } = checkout('1.9.3');
		const { stdout } = await bump(dir, target);
		expect(stdout).toBe(`1.9.3 -> ${next}\n`);
		for (const [file, before] of texts) {
			expect(readFileSync(join(dir, file), 'utf-8')).toBe(
				before.replace('"version": "1.9.3"', `"version": "${next}"`)
			);
		}
	});

	it.each(['1.9.3', '1.9.2', '0.20.0', '2.0.0-rc.1', 'v2.0.0', 'next'])(
		'refuses %s and leaves the manifests alone',
		async (target) => {
			const { dir, texts } = checkout('1.9.3');
			await expect(bump(dir, target)).rejects.toMatchObject({ code: 1 });
			for (const [file, before] of texts) {
				expect(readFileSync(join(dir, file), 'utf-8')).toBe(before);
			}
		}
	);
});
