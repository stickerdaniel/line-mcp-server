// The Windows privacy checks against the real file system, PowerShell and
// icacls, with test state in the temporary directory inside the profile.
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type AclDeps, checkPrivate, confine } from '../src/acl.ts';
import { openDatabase, openReadOnly } from '../src/db.ts';
import { databasePath, stateRoot } from '../src/paths.ts';
import { statePrivacy } from '../src/privacy.ts';
import { toolRunner } from '../src/service/runner.ts';
import { openSession } from '../src/session.ts';
import { freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

const windows = process.platform === 'win32';
const deps: AclDeps = { home: homedir(), env: process.env, runner: toolRunner({}) };
const icacls = (...args: string[]) => execFileSync('icacls', args, { stdio: 'ignore' });

/** The exposures of each path, as the real check reports them. */
async function exposures(...paths: string[]) {
	const { objects } = await checkPrivate(paths, deps);
	return objects.map((object) => object.exposures);
}

/** A directory outside the profile, at the root of the temporary directory's drive. */
function outsideProfile(): string {
	const dir = mkdtempSync(join(parse(tmpdir()).root, 'line-mcp-outside-'));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// The first PowerShell start for a user takes seconds.
describe.runIf(windows)('private state on Windows', { timeout: 60_000 }, () => {
	it('passes the default profile chain and creates a fresh root private', async () => {
		const defaultChain = confine(stateRoot(process.env, 'win32'), homedir());
		const root = join(tempRoot(), 'missing', 'line-mcp');

		await statePrivacy().database(root, { create: true });
		openDatabase(root).close();

		expect(await exposures(...defaultChain)).toEqual(defaultChain.map(() => []));
		const chain = confine(root, homedir());
		expect(await exposures(...chain, databasePath(root))).toEqual([...chain, root].map(() => []));
		// Protected: a grant on its parent does not reach it.
		icacls(join(root, '..'), '/grant', '*S-1-1-0:(OI)(CI)(R)');
		expect(await exposures(root, databasePath(root))).toEqual([[], []]);
	});

	it('confines short names and \\\\?\\ paths to the same chain', async () => {
		const root = join(tempRoot(), 'line-mcp');
		mkdirSync(root);
		const { PSModulePath: _modules, ...env } = process.env;
		const short = execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-Command',
				"$fso = [Activator]::CreateInstance([Type]::GetTypeFromProgID('Scripting.FileSystemObject')); [Console]::Out.Write($fso.GetFolder($env:P).ShortPath)"
			],
			{ env: { ...env, P: root }, encoding: 'utf-8' }
		);

		expect(short.toLowerCase()).not.toBe(root.toLowerCase());
		expect(confine(short, homedir()).at(-1)).toBe(short);
		expect(confine(`\\\\?\\${root}`, homedir())).toEqual(confine(root, homedir()));
		await statePrivacy().database(short);
		await statePrivacy().database(`\\\\?\\${root}`);
	});

	it('keeps a path with ü and CJK characters intact through the check', async () => {
		const root = join(tempRoot(), 'line-mcp ü 日本語');
		await statePrivacy().database(root, { create: true });
		const file = join(root, 'ü 日本語.txt');
		writeFileSync(file, '');
		icacls(file, '/grant', '*S-1-1-0:(R)');

		expect(await exposures(root, file)).toEqual([
			[],
			[{ kind: 'grant', ace: '(A;;FR;;;WD)', sid: 'WD', inherited: false }]
		]);
	});

	it('refuses a root outside the profile and writes nothing', async () => {
		const outside = outsideProfile();

		await expect(
			statePrivacy().database(join(outside, 'line-mcp'), { create: true })
		).rejects.toThrow('must be inside your user profile');
		expect(readdirSync(outside)).toEqual([]);
	});

	it.each([
		['out of the profile', outsideProfile],
		['to a private directory inside it', () => join(tempRoot(), 'target')]
	])('refuses a junction %s as a link', async (_kind, target) => {
		const to = target();
		mkdirSync(to, { recursive: true });
		const junction = join(tempRoot(), 'junction');
		symlinkSync(to, junction, 'junction');

		await expect(
			statePrivacy().database(join(junction, 'line-mcp'), { create: true })
		).rejects.toThrow(`${junction} is a link`);
		expect(await exposures(junction)).toEqual([[{ kind: 'reparse' }]]);
		expect(readdirSync(to)).toEqual([]);
	});

	it('refuses an inherit-only grant to everyone, naming it', async () => {
		const root = join(tempRoot(), 'line-mcp');
		await statePrivacy().database(root, { create: true });
		icacls(root, '/grant', '*S-1-1-0:(OI)(CI)(IO)(R)');

		await expect(statePrivacy().database(root)).rejects.toThrow(
			`${root} is not private: it grants WD access: (A;OICIIO;FR;;;WD)`
		);
	});

	it('refuses a file another principal owns', async () => {
		const root = join(tempRoot(), 'line-mcp');
		await statePrivacy().database(root, { create: true });
		writeFileSync(databasePath(root), '');
		// Users: neither the user, SYSTEM nor Administrators.
		icacls(databasePath(root), '/setowner', '*S-1-5-32-545');

		await expect(statePrivacy().database(root)).rejects.toThrow(
			`${databasePath(root)} is not private: its owner BU is not you`
		);
	});

	it.each([
		['grants everyone access', (path: string) => icacls(path, '/grant', '*S-1-1-0:(R)')],
		['belongs to another principal', (path: string) => icacls(path, '/setowner', '*S-1-5-32-545')]
	])('opens no database whose journal %s, and leaves it as it was', async (_kind, expose) => {
		const root = join(tempRoot(), 'line-mcp');
		await statePrivacy().database(root, { create: true });
		seedLive(root, selfMid, { authToken: 'token' });
		const journal = `${databasePath(root)}-journal`;
		writeFileSync(journal, 'hot journal');
		expose(journal);

		await expect(openSession({ root, lockPort: await freePort() })).rejects.toThrow(
			`${journal} is not private`
		);
		expect(readFileSync(journal, 'utf-8')).toBe('hot journal');
	});

	it('keeps SQLite temporary storage in memory', async () => {
		const root = join(tempRoot(), 'line-mcp');
		await statePrivacy().database(root, { create: true });
		const writer = openDatabase(root);
		const reader = openReadOnly(root);

		for (const db of [writer, reader]) {
			expect(db.prepare('PRAGMA temp_store').get()).toEqual({ temp_store: 2 });
			db.close();
		}
	});
});
