// Sets the next release version in package.json and both plugin manifests,
// which test/versions.test.ts keeps equal. Merging the change to main
// publishes it (.github/workflows/release.yml).
// Usage: node scripts/bump.ts <major|minor|patch|x.y.z>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, parseVersion } from './release-plan.ts';

const root = join(import.meta.dirname, '..');
const files = [
	'package.json',
	'plugins/line-mcp-server/.codex-plugin/plugin.json',
	'plugins/line-mcp-server/.claude-plugin/plugin.json'
].map((file) => join(root, file));
// The top-level "version" field. Replacing only its value keeps the rest of
// each file, including prettier's formatting, byte for byte.
const field = /^\t"version": "([^"]*)"/m;

/** Writes the version `target` names into every manifest; returns `old -> new`. */
function bump(target = ''): string {
	const manifests = files.map((file) => ({ file, text: readFileSync(file, 'utf-8') }));
	const current = field.exec(manifests[0]?.text ?? '')?.[1] ?? '';
	const [major, minor, patch] = parseVersion(current);
	const next =
		new Map([
			['major', `${major + 1}.0.0`],
			['minor', `${major}.${minor + 1}.0`],
			['patch', `${major}.${minor}.${patch + 1}`]
		]).get(target) ?? target;
	if (compareVersions(next, current) <= 0) {
		throw new Error(`${next} is not greater than ${current}`);
	}
	for (const { file, text } of manifests) {
		if (!field.test(text)) throw new Error(`${file} has no top-level "version"`);
	}
	for (const { file, text } of manifests) {
		writeFileSync(file, text.replace(field, `\t"version": "${next}"`));
	}
	return `${current} -> ${next}`;
}

try {
	console.log(bump(process.argv[2]));
} catch (error) {
	console.error(`bump: ${error instanceof Error ? error.message : String(error)}`);
	console.error('usage: bump.ts <major|minor|patch|x.y.z>');
	process.exitCode = 1;
}
