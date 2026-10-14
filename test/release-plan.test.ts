import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { planPublish, planRelease } from '../scripts/release-plan.ts';
import { tempRoot } from './fake-line.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'release-plan.ts');
const sha = 'c5349f43cd66d2aa02d86414c9ed426f71d3ae48';
const otherSha = '38ca56c5bb3bcef3003aeb4cd51c18b7c3555c4b';

describe('planRelease', () => {
	it('releases nothing when the push leaves the version alone', () => {
		expect(planRelease({ previous: '0.1.0', current: '0.1.0', tagSha: '', sha })).toBeUndefined();
	});

	it('releases a raised version, compared numerically', () => {
		expect(planRelease({ previous: '0.9.3', current: '0.10.0', tagSha: '', sha })).toBe('0.10.0');
	});

	it('refuses a lower version or a prerelease', () => {
		expect(() => planRelease({ previous: '0.2.0', current: '0.1.9', tagSha: '', sha })).toThrow(
			'not greater'
		);
		expect(() =>
			planRelease({ previous: '0.1.0', current: '0.2.0-rc.1', tagSha: '', sha })
		).toThrow('not a stable');
	});

	it('continues a rerun whose tag already names the pushed commit', () => {
		expect(planRelease({ previous: '0.1.0', current: '0.2.0', tagSha: sha, sha })).toBe('0.2.0');
	});

	it('refuses a version whose tag names another commit', () => {
		expect(() =>
			planRelease({ previous: '0.1.0', current: '0.2.0', tagSha: otherSha, sha })
		).toThrow(`tag v0.2.0 points at ${otherSha}`);
	});
});

// `npm view <spec> dist.integrity --json` output as npm 11.16 prints it.
const integrity =
	'sha512-skGHTH1Yb9QvaTC4hWnRTzEYtCpApF0UMBPz+t/0ZPzP8ihefo/btKd+QA7pUE0fEwA1SbS/NmhyEcstdXOIdA==';
const npmError = (code: string, summary: string) =>
	JSON.stringify({ error: { code, summary, detail: '' } }, null, 2);

describe('planPublish', () => {
	it('skips a version npm already has with the same tarball', () => {
		expect(planPublish(integrity, `"${integrity}"\n`)).toBe('skip');
	});

	it('refuses a version npm has with another tarball', () => {
		const other = `sha512-${'A'.repeat(86)}==`;
		expect(() => planPublish(integrity, `"${other}"\n`)).toThrow('another');
	});

	it('publishes a version npm reports as missing', () => {
		const missing = npmError('E404', 'No match found for version 0.2.0');
		const unpublished = npmError('E404', 'Unpublished on 2026-03-22T09:35:23.574Z');
		expect(planPublish(integrity, missing)).toBe('publish');
		expect(planPublish(integrity, unpublished)).toBe('publish');
	});

	it('refuses when npm fails any other way', () => {
		expect(() => planPublish(integrity, npmError('ECONNREFUSED', 'FetchError'))).toThrow(
			'ECONNREFUSED'
		);
		expect(() => planPublish(integrity, '')).toThrow('no JSON');
	});
});

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
	promisify(execFile)(process.execPath, [script, ...args], { env });

/**
 * A fake npm first on PATH, as each OS finds it: an executable `npm`, or on
 * Windows the `npm.cmd` shim with the npm entry beside it. It records its
 * arguments in `<dir>/args`, prints NPM_VIEW and exits NPM_EXIT. Returns the
 * environment that finds it.
 */
function fakeNpm(dir: string) {
	const stub = `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(join(dir, 'args'))}, process.argv.slice(2).map((arg) => arg + '\\n').join(''));
process.stdout.write(process.env.NPM_VIEW);
process.exitCode = Number(process.env.NPM_EXIT);
`;
	writeFileSync(join(dir, 'npm'), `#!${process.execPath}\n${stub}`);
	chmodSync(join(dir, 'npm'), 0o755);
	writeFileSync(join(dir, 'npm.cmd'), '@node "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
	mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
	writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), stub);
	// Windows keeps the variable as `Path`; a second `PATH` key would be ambiguous.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')
	);
	return { ...env, PATH: `${dir}${delimiter}${process.env.PATH}` };
}

describe('release-plan.ts', () => {
	it('prints the detect decision as step outputs', async () => {
		const { stdout } = await run(['detect', '0.1.0', '0.2.0', '', sha]);
		expect(stdout).toBe('release=true\nversion=0.2.0\n');
		await expect(run(['detect', '0.2.0', '0.1.0', '', sha])).rejects.toMatchObject({
			code: 1,
			stderr: 'release-plan: version 0.1.0 is not greater than 0.2.0\n'
		});
	});

	it('compares the tarball with the integrity npm has for its version', async () => {
		const dir = tempRoot();
		const tarball = join(dir, 'line-mcp-server-1.2.3.tgz');
		writeFileSync(tarball, 'not really a tarball\n');
		// sha512 of the bytes above, from `openssl dgst -sha512 -binary | openssl base64 -A`.
		const expected =
			'sha512-NcbQ+Su4jXY2rLnuoBnm54xyJR7gxMfEGq2NA3QTdjBbb1gYLXU1hp3aYEW2au+oNOb6sAR4bZruePqGPlU8AQ==';
		const path = fakeNpm(dir);
		const env = (view: string, exit: number) => ({
			...path,
			NPM_VIEW: view,
			NPM_EXIT: String(exit)
		});

		const published = await run(['publish', tarball, '1.2.3'], env(`"${expected}"\n`, 0));
		expect(published.stdout).toBe('publish=false\n');
		expect(readFileSync(join(dir, 'args'), 'utf-8')).toBe(
			'view\nline-mcp-server@1.2.3\ndist.integrity\n--json\n'
		);
		const missing = await run(['publish', tarball, '1.2.3'], env(npmError('E404', 'Not Found'), 1));
		expect(missing.stdout).toBe('publish=true\n');
	});
});
