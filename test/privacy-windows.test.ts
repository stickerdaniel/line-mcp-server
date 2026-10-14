// The Windows privacy checks against the real file system, PowerShell and
// icacls, with test state in the temporary directory inside the profile.
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type AclDeps, checkPrivate, confine, exposuresOf, remedy } from '../src/acl.ts';
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
async function exposures(paths: string[], anchor?: string) {
	const { objects } = await checkPrivate(paths, deps, anchor);
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

		expect(defaultChain.anchor).toBe(homedir());
		expect(await exposures(defaultChain.chain, defaultChain.anchor)).toEqual(
			defaultChain.chain.map(() => [])
		);
		const { chain, anchor } = confine(root, homedir());
		expect(await exposures([...chain, databasePath(root)], anchor)).toEqual(
			[...chain, root].map(() => [])
		);
		// Protected: a grant on its parent does not reach it.
		icacls(join(root, '..'), '/grant', '*S-1-1-0:(OI)(CI)(R)');
		expect(await exposures([root, databasePath(root)])).toEqual([[], []]);
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
		const confined = confine(root, homedir());
		const shortened = confine(short, homedir());
		expect(shortened.chain.at(-1)).toBe(short);
		// The anchor stays the profile, however the input names it; the
		// database check passes only because it keeps the anchor exception.
		expect(realpathSync.native(shortened.anchor!)).toBe(realpathSync.native(homedir()));
		expect(confine(`\\\\?\\${root}`, homedir())).toEqual(confined);
		await statePrivacy().database(short);
		await statePrivacy().database(`\\\\?\\${root}`);
	});

	it('keeps a path with ü and CJK characters intact through the check', async () => {
		const root = join(tempRoot(), 'line-mcp ü 日本語');
		await statePrivacy().database(root, { create: true });
		const file = join(root, 'ü 日本語.txt');
		writeFileSync(file, '');
		icacls(file, '/grant', '*S-1-1-0:(R)');

		expect(await exposures([root, file])).toEqual([
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
		expect(await exposures([junction])).toEqual([[{ kind: 'reparse' }]]);
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

	it.each(['0x100020', '0x00100020'])(
		'reads the profile traverse entry as .NET prints it, from %s',
		(rights) => {
			const capability =
				'S-1-15-3-65536-599108337-2355189375-1353122160-3480128286-3345335107-485756383-4087318168-230526575';
			const profile = `O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)(A;;0x100020;;;${capability})`;
			const { PSModulePath: _modules, ...env } = process.env;
			// An in-memory descriptor: no access list on disk changes.
			const printed = execFileSync(
				'powershell.exe',
				[
					'-NoProfile',
					'-Command',
					"$s = [System.Security.AccessControl.DirectorySecurity]::new(); $s.SetSecurityDescriptorSddlForm($env:SDDL); [Console]::Out.Write($s.GetSecurityDescriptorSddlForm('Owner, Access'))"
				],
				{ env: { ...env, SDDL: profile.replace('0x100020', rights) }, encoding: 'utf-8' }
			);

			expect(printed).toBe(profile);
			// It names no user, so any user SID gives the same answer.
			expect(exposuresOf(printed, 'S-1-5-21-1-2-3-1001', { anchor: true })).toEqual([]);
		}
	);

	it('prints fixes that PowerShell hands to icacls unchanged', () => {
		const dir = tempRoot();
		const path = join(dir, "it's O\u2019Connor\u2018\u201a\u201b $HOME (ü) x", 'line.db');
		const user = 'S-1-5-21-1-2-3-1001';
		const fixes = remedy(
			{
				path,
				exists: true,
				exposures: [
					{ kind: 'owner', sid: 'BU' },
					{ kind: 'grant', ace: '(A;;FR;;;WD)', sid: 'WD', inherited: false },
					{ kind: 'grant', ace: '(A;ID;FR;;;AU)', sid: 'AU', inherited: true }
				]
			},
			user
		);
		// `icacls` resolves to a function that records the arguments it receives.
		const printer = join(dir, 'argv.cjs');
		const received = join(dir, 'argv.jsonl');
		writeFileSync(
			printer,
			"require('node:fs').appendFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');"
		);
		const script = [
			'function icacls { & $env:ARGV_NODE $env:ARGV_PRINTER @args }',
			...fixes.split(', then ')
		].join('\n');
		const { PSModulePath: _modules, ...env } = process.env;
		execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from(script, 'utf16le').toString('base64')
			],
			{ env: { ...env, ARGV_NODE: process.execPath, ARGV_PRINTER: printer, ARGV_OUT: received } }
		);

		const calls = readFileSync(received, 'utf-8')
			.trimEnd()
			.split('\n')
			.map((line): unknown => JSON.parse(line));
		expect(calls).toEqual([
			[path, '/setowner', `*${user}`],
			[path, '/remove:g', '*S-1-1-0'],
			[
				dirname(path),
				'/inheritance:r',
				'/grant:r',
				`*${user}:(OI)(CI)F`,
				'*S-1-5-18:(OI)(CI)F',
				'*S-1-5-32-544:(OI)(CI)F',
				'/Q'
			],
			[path, '/reset']
		]);
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
