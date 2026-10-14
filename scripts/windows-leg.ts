// The Windows standard-user leg (CI only). scripts/windows-leg.ps1 runs the
// bundle of this file (scripts/build-leg.ts) as the elevated runner user and
// as a new standard account, so line-mcp's checks meet the access lists a
// non-administrator really has. `node leg.js <phase> <out directory> ...`:
//
// - admin (runner user): its own private state, which the standard account
//   must not read;
// - prepare (standard account): its state roots, recorded in prepare.json;
// - plant <account> (runner user): files in those roots owned by <account>,
//   another standard account;
// - assert (standard account): the checks; exits 1 on the first failure.
//
// Each phase prints what it did as one JSON line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkPrivate, confine } from '../src/acl.ts';
import { openDatabase } from '../src/db.ts';
import { databasePath, stateRoot } from '../src/paths.ts';
import { statePrivacy } from '../src/privacy.ts';
import { toolRunner } from '../src/service/runner.ts';
import { openSession } from '../src/session.ts';

interface Prepared {
	sid: string;
	/** A fresh root line-mcp created. */
	fresh: string;
	/** Roots that get a file owned by another account: a database, a journal. */
	owned: string;
	journal: string;
}

const [phase, out, account] = process.argv.slice(2) as [string, string, string | undefined];
const deps = { home: homedir(), env: process.env, runner: toolRunner({}) };
const privacy = statePrivacy('win32', deps);
/** A directory in `%LOCALAPPDATA%`, beside line-mcp's default root. */
const local = (name: string) => join(process.env.LOCALAPPDATA!, name);
const readJson = <T>(name: string) => JSON.parse(readFileSync(join(out, name), 'utf-8')) as T;
const icacls = (...args: string[]) => execFileSync('icacls', args, { stdio: 'ignore' });

/** A new private state root with a database, closed again. */
async function seeded(root: string): Promise<string> {
	await privacy.database(root, { create: true });
	openDatabase(root).close();
	return root;
}

/** Every exposure of `paths`, flattened; empty when all are private. */
async function exposures(paths: string[], anchor?: string) {
	const { objects } = await checkPrivate(paths, deps, anchor);
	return objects.flatMap((object) => object.exposures);
}

/** The exposures of the default root's chain, which Windows creates for every profile. */
async function defaultChain() {
	const { chain, anchor } = confine(stateRoot(process.env, 'win32'), homedir());
	return await exposures(chain, anchor);
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** Fails unless opening the database in `root` is refused with `message`, before SQLite touched `journal`. */
async function refusesOpen(root: string, journal: string, message: string | RegExp) {
	const before = readFileSync(journal);
	await assert.rejects(openSession({ root, lockPort: await freePort() }), {
		code: 'insecure_directory',
		message
	});
	assert.deepEqual(readFileSync(journal), before);
}

const phases: Record<string, () => Promise<Record<string, unknown>>> = {
	async admin() {
		assert.deepEqual(await defaultChain(), []);
		const root = await seeded(local('line-mcp-leg-admin'));
		writeFileSync(join(out, 'admin.json'), JSON.stringify({ database: databasePath(root) }));
		return { root };
	},

	async prepare() {
		const prepared: Prepared = {
			sid: (await checkPrivate([homedir()], deps)).user,
			fresh: await seeded(local('line-mcp-leg-fresh')),
			owned: await seeded(local('line-mcp-leg-owned')),
			journal: await seeded(local('line-mcp-leg-journal'))
		};
		writeFileSync(join(out, 'prepare.json'), JSON.stringify(prepared));
		return { ...prepared };
	},

	async plant() {
		assert(account, 'plant needs the owning account');
		const { owned, journal } = readJson<Prepared>('prepare.json');
		const { PSModulePath: _modules, ...env } = process.env;
		const sid = execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				'[Console]::Out.Write(([System.Security.Principal.NTAccount]$env:ACCOUNT).Translate([System.Security.Principal.SecurityIdentifier]).Value)'
			],
			{ env: { ...env, ACCOUNT: account }, encoding: 'utf-8' }
		);
		// Inside the roots, so the tested account can still read the descriptors.
		const files = [join(owned, 'foreign.txt'), `${databasePath(journal)}-journal`];
		for (const file of files) {
			writeFileSync(file, 'planted');
			icacls(file, '/setowner', account);
		}
		writeFileSync(join(out, 'plant.json'), JSON.stringify({ sid }));
		return { sid, files };
	},

	async assert() {
		const prepared = readJson<Prepared>('prepare.json');
		const { database: adminDatabase } = readJson<{ database: string }>('admin.json');
		const { sid: other } = readJson<{ sid: string }>('plant.json');
		const passed: string[] = [];
		const check = async (name: string, body: () => Promise<void> | void) => {
			await body();
			passed.push(name);
		};

		await check('the default profile chain is private', async () => {
			assert.deepEqual(await defaultChain(), []);
		});
		await check('a fresh root ends private', async () => {
			const { chain, anchor } = confine(prepared.fresh, homedir());
			assert.deepEqual(await exposures([...chain, databasePath(prepared.fresh)], anchor), []);
			await privacy.database(prepared.fresh);
			const { checks, readable } = await privacy.diagnose(prepared.fresh);
			assert.equal(readable, true);
			assert.deepEqual(
				checks.map(({ ok }) => ok),
				[true]
			);
		});
		await check('a root outside the profile fails before anything is written', async () => {
			const outside = join(out, 'outside', 'line-mcp');
			await assert.rejects(privacy.database(outside, { create: true }), {
				code: 'insecure_directory',
				message: /must be inside your user profile/
			});
			assert.equal(existsSync(join(out, 'outside')), false);
		});
		await check('an inherit-only grant to everyone fails, naming it', async () => {
			const root = await seeded(local('line-mcp-leg-inherit-only'));
			icacls(root, '/grant', '*S-1-1-0:(OI)(CI)(IO)(R)');
			await assert.rejects(privacy.database(root), {
				message: `${root} is not private: it grants WD access: (A;OICIIO;FR;;;WD). Run line-mcp doctor for the fix`
			});
		});
		await check('a file another standard account owns fails on its owner', async () => {
			const file = join(prepared.owned, 'foreign.txt');
			assert.notEqual(other, prepared.sid);
			await assert.rejects(privacy.file(file), {
				message: `${file} is not private: its owner ${other} is not you, SYSTEM or Administrators. Run line-mcp doctor for the fix`
			});
		});
		await check('a junction from the root to outside fails as a reparse point', async () => {
			const target = join(out, 'escape');
			mkdirSync(target);
			const root = local('line-mcp-leg-escape');
			symlinkSync(target, root, 'junction');
			await assert.rejects(privacy.database(root, { create: true }), { message: /is a link/ });
			assert.deepEqual(await exposures([root]), [{ kind: 'reparse' }]);
		});
		await check('a junction between two private directories fails as a link', async () => {
			const target = await seeded(local('line-mcp-leg-target'));
			const root = local('line-mcp-leg-inside');
			symlinkSync(target, root, 'junction');
			await assert.rejects(privacy.database(root), {
				message: `${root} is a link; line-mcp keeps its state in real directories inside your user profile`
			});
		});
		await check("reading the runner admin's database gives EPERM", () => {
			assert.throws(() => readFileSync(adminDatabase), { code: 'EPERM' });
		});
		await check('an exposed journal is refused before SQLite touches it', async () => {
			const root = await seeded(local('line-mcp-leg-exposed-journal'));
			const journal = `${databasePath(root)}-journal`;
			writeFileSync(journal, 'hot journal');
			icacls(journal, '/grant', '*S-1-1-0:(R)');
			await refusesOpen(
				root,
				journal,
				`${journal} is not private: it grants WD access: (A;;FR;;;WD). Run line-mcp doctor for the fix`
			);
		});
		await check('a journal another account owns is refused before SQLite touches it', async () => {
			const journal = `${databasePath(prepared.journal)}-journal`;
			await refusesOpen(
				prepared.journal,
				journal,
				`${journal} is not private: its owner ${other} is not you, SYSTEM or Administrators. Run line-mcp doctor for the fix`
			);
		});
		return { passed };
	}
};

const run = phases[phase];
if (!run) throw new Error(`unknown phase ${phase}`);
console.log(JSON.stringify({ phase, ...(await run()) }));
// The session's HTTP agent may keep the process alive.
process.exit(0);
