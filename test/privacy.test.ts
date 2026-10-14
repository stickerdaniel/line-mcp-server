// The Windows privacy checks through a fake PowerShell and icacls, on every
// OS; test/privacy-windows.test.ts runs them against the real ones.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AclDeps, checkPrivate, confine, exposuresOf } from '../src/acl.ts';
import { doctor } from '../src/doctor.ts';
import { databasePath } from '../src/paths.ts';
import { statePrivacy } from '../src/privacy.ts';
import { serviceFor } from '../src/service/index.ts';
import type { RunOptions, ToolResult, ToolRunner } from '../src/service/runner.ts';
import { openSession } from '../src/session.ts';
import { freePort, seedLive, selfMid, tempRoot } from './fake-line.ts';

const user = 'S-1-5-21-1-2-3-1001';
const other = 'S-1-5-21-1-2-3-1002';
/** What icacls leaves on a directory line-mcp created. */
const protectedDir = `O:${user}D:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;

interface Call {
	tool: string;
	args: string[];
	/** The paths a PowerShell check was given. */
	paths?: string[];
	env?: NodeJS.ProcessEnv;
}

/**
 * PowerShell and icacls as the Windows checks call them. PowerShell answers
 * from the real file system for each path: missing, a link (a reparse point),
 * or the descriptor `sddl` gives, private by default. `reply` replaces a
 * tool's answer, by its file name.
 */
function fakeWindows(
	sddl: (path: string) => string = () => protectedDir,
	reply: Partial<Record<'powershell.exe' | 'icacls.exe', ToolResult>> = {}
) {
	const calls: Call[] = [];
	const runner: ToolRunner = {
		run: async (tool: string, args: string[], options: RunOptions = {}) => {
			const name = parse(tool.replaceAll('\\', '/')).base as 'powershell.exe' | 'icacls.exe';
			const paths = options.env?.LINE_MCP_ACL_PATHS?.split('\n');
			calls.push({ tool: name, args, paths, env: options.env });
			if (reply[name]) return reply[name];
			if (name === 'icacls.exe') return { exit: 0, stdout: '' };
			const lines = (paths ?? []).map((path, index) => {
				const stat = lstatSync(path, { throwIfNoEntry: false });
				if (!stat) return `${index}\t0\t0\t-\n`;
				if (stat.isSymbolicLink()) return `${index}\t1\t1\t-\n`;
				return `${index}\t1\t0\t${sddl(path)}\n`;
			});
			return { exit: 0, stdout: `sid\t${user}\n${lines.join('')}` };
		},
		describe: (tool, args) => [tool, ...args].join(' ')
	};
	return { runner, calls };
}

/** A profile under the temporary directory, as `%USERPROFILE%` in the checks. */
function profile(): string {
	return realpathSync(tempRoot());
}

const depsFor = (home: string, runner: ToolRunner): AclDeps => ({ home, env: {}, runner });

describe('the private predicate', () => {
	it.each([
		['a directory line-mcp created', protectedDir],
		['a file inheriting it', `O:${user}D:AI(A;ID;FA;;;${user})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`],
		[
			'the built-in Administrator as owner and grantee',
			'O:LAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)'
		],
		['CREATOR OWNER, inherit-only', `O:BAD:(A;OICIIO;GA;;;CO)(A;OICI;FA;;;${user})`],
		['a deny entry for everyone', `O:SYD:P(D;;0x100116;;;WD)(A;;FA;;;${user})`],
		['an empty access list', 'O:BAD:PAI'],
		['SIDs instead of aliases', 'O:S-1-5-18D:P(A;;FA;;;S-1-5-32-544)(A;;FA;;;S-1-3-0)']
	])('accepts %s', (_kind, sddl) => {
		expect(exposuresOf(sddl, user)).toEqual([]);
	});

	it.each([
		['another account as owner', `O:${other}D:P(A;;FA;;;${user})`, [{ kind: 'owner', sid: other }]],
		['no access list', 'O:BA', [{ kind: 'no_dacl' }]],
		['a null access list', 'O:BAD:PAINO_ACCESS_CONTROL', [{ kind: 'no_dacl' }]],
		[
			'an inherit-only grant to everyone',
			`O:${user}D:PAI(A;OICIIO;FR;;;WD)(A;OICI;FA;;;${user})`,
			[{ kind: 'grant', ace: '(A;OICIIO;FR;;;WD)', sid: 'WD', inherited: false }]
		],
		[
			'an inherited grant to Users',
			`O:${user}D:AI(A;ID;0x1200a9;;;BU)`,
			[{ kind: 'grant', ace: '(A;ID;0x1200a9;;;BU)', sid: 'BU', inherited: true }]
		],
		[
			'a grant to another account',
			`O:${user}D:P(A;;FA;;;${other})`,
			[{ kind: 'grant', ace: `(A;;FA;;;${other})`, sid: other, inherited: false }]
		],
		[
			'an object entry',
			`O:${user}D:P(OA;;CC;bf967aba-0de6-11d0-a285-00aa003049e2;;${user})`,
			[{ kind: 'ace_type', ace: `(OA;;CC;bf967aba-0de6-11d0-a285-00aa003049e2;;${user})` }]
		]
	])('refuses %s', (_kind, sddl, exposures) => {
		expect(exposuresOf(sddl, user)).toEqual(exposures);
	});

	it.each([
		['a conditional entry', `O:${user}D:P(XA;;FA;;;WD;(Member_of {SID(BA)}))`],
		['a group part', `O:${user}G:BAD:P(A;;FA;;;${user})`],
		['an entry with a field missing', `O:${user}D:P(A;;FA;;${user})`],
		['text around it', ` O:${user}D:P`]
	])('cannot read %s, so nothing counts as private', (_kind, sddl) => {
		expect(exposuresOf(sddl, user)).toBeUndefined();
	});
});

describe('checkPrivate', () => {
	it('sends the paths through one variable to PowerShell without a module path', async () => {
		const home = profile();
		const fake = fakeWindows();
		const paths = [home, join(home, 'missing ü 日本')];

		const inspection = await checkPrivate(paths, {
			home,
			env: { PSModulePath: 'C:\\pwsh', SystemRoot: 'D:\\Win', KEEP: '1' },
			runner: fake.runner
		});

		expect(inspection).toEqual({
			user,
			objects: [
				{ path: home, exists: true, exposures: [] },
				{ path: paths[1], exists: false, exposures: [] }
			]
		});
		const [call] = fake.calls;
		expect(call?.paths).toEqual(paths);
		expect(call?.env).toMatchObject({ KEEP: '1' });
		expect(call?.env).not.toHaveProperty('PSModulePath');
		expect(call?.args.slice(0, 5)).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand'
		]);
	});

	it('reports a link as a reparse point', async () => {
		const home = profile();
		symlinkSync(join(home, 'nowhere'), join(home, 'link'));

		const { objects } = await checkPrivate(
			[join(home, 'link')],
			depsFor(home, fakeWindows().runner)
		);

		expect(objects).toEqual([
			{ path: join(home, 'link'), exists: true, exposures: [{ kind: 'reparse' }] }
		]);
	});

	const valid = (paths: number) =>
		`sid\t${user}\n${Array.from({ length: paths }, (_, index) => `${index}\t1\t0\t${protectedDir}\n`).join('')}`;

	it.each([
		['a timeout', { exit: 'timeout', stdout: valid(2) }, 'did not answer within 30 s'],
		['a failure', { exit: 1, stdout: valid(2) }, 'PowerShell failed (1)'],
		['a missing PowerShell', { exit: 'ENOENT', stdout: '' }, 'PowerShell failed (ENOENT)'],
		['Constrained Language Mode', { exit: 3, stdout: '' }, 'Constrained Language Mode'],
		['no user', { exit: 0, stdout: valid(2).replace(/^sid\t\S+\n/, '') }, 'unexpected answer'],
		['one line short', { exit: 0, stdout: valid(1) }, 'unexpected answer'],
		['one line more', { exit: 0, stdout: valid(3) }, 'unexpected answer'],
		['a partial last line', { exit: 0, stdout: valid(2).slice(0, -1) }, 'unexpected answer'],
		[
			'Windows line ends',
			{ exit: 0, stdout: valid(2).replaceAll('\n', '\r\n') },
			'unexpected answer'
		],
		[
			'lines out of order',
			{ exit: 0, stdout: `sid\t${user}\n1\t1\t0\t${protectedDir}\n0\t1\t0\t${protectedDir}\n` },
			'unexpected answer'
		],
		[
			'an existing object without a descriptor',
			{ exit: 0, stdout: `sid\t${user}\n0\t1\t0\t-\n1\t0\t0\t-\n` },
			'unreadable access list'
		],
		[
			'a reparse point with a descriptor',
			{ exit: 0, stdout: `sid\t${user}\n0\t1\t1\t${protectedDir}\n1\t0\t0\t-\n` },
			'unreadable access list'
		],
		[
			'a descriptor that does not parse',
			{ exit: 0, stdout: `sid\t${user}\n0\t1\t0\tO:BA D:P\n1\t0\t0\t-\n` },
			'unexpected answer'
		]
	] satisfies [string, ToolResult, string][])(
		'fails closed on %s',
		async (_kind, answer, message) => {
			const home = profile();

			const check = checkPrivate(
				[home, join(home, 'line.db')],
				depsFor(home, fakeWindows(undefined, { 'powershell.exe': answer }).runner)
			);

			await expect(check).rejects.toMatchObject({ code: 'insecure_directory' });
			await expect(check).rejects.toThrow(message);
		}
	);
});

describe('confine', () => {
	it('gives the chain from the profile down to a root that need not exist', () => {
		const home = profile();
		mkdirSync(join(home, 'a'));

		expect(confine(join(home, 'a', 'b', 'c'), home)).toEqual([
			home,
			join(home, 'a'),
			join(home, 'a', 'b'),
			join(home, 'a', 'b', 'c')
		]);
	});

	it('refuses a root outside the profile', () => {
		const home = profile();

		expect(() => confine(join(dirname(home), 'elsewhere', 'line-mcp'), home)).toThrow(
			expect.objectContaining({
				code: 'insecure_directory',
				message: expect.stringContaining('must be inside your user profile')
			})
		);
	});

	it.each(['the root', 'a parent'])('refuses a link as %s, even to inside the profile', (which) => {
		const home = profile();
		mkdirSync(join(home, 'real'));
		// A junction on Windows, where a directory symlink needs a privilege; ignored elsewhere.
		symlinkSync(join(home, 'real'), join(home, 'link'), 'junction');
		const root = which === 'the root' ? join(home, 'link') : join(home, 'link', 'line-mcp');

		expect(() => confine(root, home)).toThrow(`${join(home, 'link')} is a link`);
	});
});

describe('the Windows state guard', () => {
	it('creates a missing root private, top down, after checking what exists', async () => {
		const home = profile();
		const fake = fakeWindows();
		const root = join(home, 'AppData', 'line-mcp');
		const files = ['', '-wal', '-shm', '-journal'].map((end) => `${databasePath(root)}${end}`);

		await statePrivacy('win32', depsFor(home, fake.runner)).database(root, { create: true });

		expect(lstatSync(root).isDirectory()).toBe(true);
		expect(fake.calls.map(({ tool, args, paths }) => [tool, paths ?? args[0]])).toEqual([
			['powershell.exe', [home, join(home, 'AppData'), root, ...files]],
			['icacls.exe', join(home, 'AppData')],
			['icacls.exe', root],
			['powershell.exe', [join(home, 'AppData'), root]]
		]);
		expect(fake.calls[1]?.args).toEqual([
			join(home, 'AppData'),
			'/inheritance:r',
			'/grant:r',
			`*${user}:(OI)(CI)F`,
			'*S-1-5-18:(OI)(CI)F',
			'*S-1-5-32-544:(OI)(CI)F',
			'/Q'
		]);
	});

	it('creates nothing under a parent that is not private', async () => {
		const home = profile();
		const fake = fakeWindows((path) =>
			path === home ? `O:${user}D:(A;OICI;FR;;;WD)(A;OICI;FA;;;${user})` : protectedDir
		);
		const root = join(home, 'line-mcp');

		const opened = statePrivacy('win32', depsFor(home, fake.runner)).database(root, {
			create: true
		});

		await expect(opened).rejects.toMatchObject({
			code: 'insecure_directory',
			message: `${home} is not private: it grants WD access: (A;OICI;FR;;;WD). Run line-mcp doctor for the fix`
		});
		expect(existsSync(root)).toBe(false);
		expect(fake.calls.map(({ tool }) => tool)).toEqual(['powershell.exe']);
	});

	it('fails when icacls cannot protect a new directory', async () => {
		const home = profile();
		const fake = fakeWindows(undefined, { 'icacls.exe': { exit: 5, stdout: '' } });

		const opened = statePrivacy('win32', depsFor(home, fake.runner)).database(
			join(home, 'line-mcp'),
			{ create: true }
		);

		await expect(opened).rejects.toThrow(`Could not make ${join(home, 'line-mcp')} private`);
	});

	it('lets a reader through without creating a missing root', async () => {
		const home = profile();
		const fake = fakeWindows();

		await statePrivacy('win32', depsFor(home, fake.runner)).database(join(home, 'line-mcp'));

		expect(existsSync(join(home, 'line-mcp'))).toBe(false);
		expect(fake.calls.map(({ tool }) => tool)).toEqual(['powershell.exe']);
	});

	it('checks a directory once per process and every file it returns', async () => {
		const home = profile();
		const fake = fakeWindows((path) =>
			path.endsWith('exposed.png') ? `O:${user}D:AI(A;;FR;;;AU)(A;ID;FA;;;${user})` : protectedDir
		);
		const privacy = statePrivacy('win32', depsFor(home, fake.runner));
		const dir = join(home, 'attachments');

		await Promise.all([privacy.directory(dir), privacy.directory(dir)]);
		await privacy.directory(dir);
		writeFileSync(join(dir, 'private.png'), '');
		writeFileSync(join(dir, 'exposed.png'), '');

		await privacy.file(join(dir, 'private.png'));
		await expect(privacy.file(join(dir, 'exposed.png'))).rejects.toThrow(
			`${join(dir, 'exposed.png')} is not private: it grants AU access: (A;;FR;;;AU)`
		);
		expect(fake.calls.map(({ tool }) => tool)).toEqual([
			'powershell.exe',
			'icacls.exe',
			'powershell.exe',
			'powershell.exe',
			'powershell.exe'
		]);
	});

	it('refuses to open a database whose journal is not private and leaves it untouched', async () => {
		const home = profile();
		const root = join(home, 'line-mcp');
		seedLive(root, selfMid, { authToken: 'token' });
		const journal = `${databasePath(root)}-journal`;
		writeFileSync(journal, 'hot journal');
		const fake = fakeWindows((path) =>
			path === journal ? `O:${other}D:AI(A;ID;FA;;;${user})` : protectedDir
		);

		const opened = openSession({
			root,
			lockPort: await freePort(),
			privacy: statePrivacy('win32', depsFor(home, fake.runner))
		});

		await expect(opened).rejects.toThrow(
			`${journal} is not private: its owner ${other} is not you, SYSTEM or Administrators`
		);
		expect(readFileSync(journal, 'utf-8')).toBe('hot journal');
		expect(existsSync(`${databasePath(root)}-wal`)).toBe(false);
	});

	it('gives doctor one remedy per object that is not private, and reads no archive', async () => {
		const home = profile();
		const root = join(home, 'line-mcp');
		seedLive(root, selfMid, { authToken: 'token' });
		const db = databasePath(root);
		const fake = fakeWindows((path) => {
			if (path === root) return `O:${other}D:PAI(A;OICI;FA;;;${user})(A;OICIIO;FR;;;WD)`;
			if (path === db) return `O:${user}D:AI(A;ID;FR;;;WD)(A;ID;FA;;;${user})`;
			return protectedDir;
		});

		const checks = await doctor({
			root,
			service: serviceFor('win32', { home, env: {}, runner: fake.runner }),
			privacy: statePrivacy('win32', depsFor(home, fake.runner)),
			env: {},
			cli: '/opt/line-mcp/dist/cli.js',
			node: process.execPath,
			nodeVersion: '24.18.0'
		});

		const protect = (dir: string) =>
			`icacls "${dir}" /inheritance:r /grant:r *${user}:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /Q`;
		expect(checks.filter(({ name }) => name === 'privacy')).toEqual([
			{
				name: 'privacy',
				ok: false,
				detail:
					`${root} is not private: its owner ${other} is not you, SYSTEM or Administrators; ` +
					'it grants WD access: (A;OICIIO;FR;;;WD). ' +
					`Fix: icacls "${root}" /setowner *${user}, then icacls "${root}" /remove:g *S-1-1-0`
			},
			{
				name: 'privacy',
				ok: false,
				detail:
					`${db} is not private: it grants WD access through inheritance: (A;ID;FR;;;WD). ` +
					`Fix: ${protect(root)}, then icacls "${db}" /reset`
			}
		]);
		expect(checks.map(({ name }) => name)).not.toContain('account');
		// Only the privacy check ran a tool: no service manager call.
		expect(new Set(fake.calls.map(({ tool }) => tool))).toEqual(new Set(['powershell.exe']));
	});
});
