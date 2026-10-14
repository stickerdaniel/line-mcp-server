import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
	type AclDeps,
	checkPrivate,
	type Confined,
	confine,
	createPrivate,
	describeExposure,
	type Inspection,
	refuseExposed,
	remedy
} from './acl.ts';
import type { Check } from './doctor.ts';
import { mapError } from './errors.ts';
import { attachmentsDir, databaseFiles, databasePath } from './paths.ts';
import { toolRunner } from './service/runner.ts';

/**
 * Keeps line-mcp's state private before it is read, written or returned. On
 * macOS and Linux file modes do it: `openDatabase` and `directory` set 0700
 * and 0600, so `database` and `file` have nothing to add. On Windows every
 * method confines the path to the user's profile and checks owners and access
 * lists first, rejecting with `insecure_directory` (src/acl.ts).
 */
export interface StatePrivacy {
	/**
	 * Before every database open: the state root, its parents up to the
	 * profile, and each database file that exists. With `create`, which only
	 * the writers (daemon, login, probe) pass, a missing root is created
	 * private first.
	 */
	database(root: string, options?: { create?: boolean }): Promise<void>;
	/** Creates `dir` private when it is missing, then checks it; once per process. */
	directory(dir: string): Promise<void>;
	/** Before a file inside a checked directory is returned. */
	file(path: string): Promise<void>;
	/**
	 * Doctor's checks of the state in `root`, which may not exist yet; creates
	 * nothing. Doctor reads the archive only when it exists and `readable`.
	 * Without a database, macOS and Linux give no check; Windows still checks
	 * the chain, since a first login refuses an exposed one.
	 */
	diagnose(root: string): Promise<{ checks: Check[]; readable: boolean }>;
}

const mode = (path: string) => statSync(path).mode & 0o777;

const posixPrivacy: StatePrivacy = {
	database: async () => {},
	directory: async (dir) => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	},
	file: async () => {},
	diagnose: async (root) => {
		const path = databasePath(root);
		if (!existsSync(path)) return { checks: [], readable: false };
		return {
			checks: [
				{
					name: 'permissions',
					ok: mode(root) === 0o700 && mode(path) === 0o600,
					detail: `state root ${mode(root).toString(8)}, database ${mode(path).toString(8)}`
				}
			],
			readable: true
		};
	}
};

function windowsPrivacy(deps: AclDeps): StatePrivacy {
	/**
	 * Confines `target` and checks its chain and `files`. With `create`, the
	 * missing part of the chain is created private, top down, then checked.
	 */
	async function secure(target: string, files: string[], create: boolean): Promise<void> {
		const { chain, anchor } = confine(target, deps.home);
		const inspection = await checkPrivate([...chain, ...files], deps, anchor);
		refuseExposed(inspection);
		const missing = chain.filter((_, index) => !inspection.objects[index]!.exists);
		if (!create || missing.length === 0) return;
		for (const dir of missing) await createPrivate(dir, inspection.user, deps);
		// New directories only, and never the anchor: no exception applies.
		refuseExposed(await checkPrivate(missing, deps));
	}
	const directories = new Map<string, Promise<void>>();
	return {
		database: (root, { create = false } = {}) => secure(root, databaseFiles(root), create),
		directory: (dir) => {
			let checked = directories.get(dir);
			if (!checked) {
				checked = secure(dir, [], true);
				directories.set(dir, checked);
				// A failed check runs again on the next call.
				checked.catch(() => directories.delete(dir));
			}
			return checked;
		},
		file: (path) => secure(path, [], false),
		diagnose: async (root) => {
			const name = 'privacy';
			let inspection: Inspection;
			let confined: Confined;
			try {
				confined = confine(root, deps.home);
				inspection = await checkPrivate(
					[...confined.chain, ...databaseFiles(root), attachmentsDir(root)],
					deps,
					confined.anchor
				);
			} catch (error) {
				return {
					checks: [{ name, ok: false, detail: mapError(error, 'doctor').message }],
					readable: false
				};
			}
			const exposed = inspection.objects.filter((object) => object.exposures.length > 0);
			if (exposed.length === 0) {
				// The root is the last entry of the chain, which comes first.
				const rootExists = inspection.objects[confined.chain.length - 1]!.exists;
				return {
					checks: [
						{
							name,
							ok: true,
							detail: rootExists
								? `${root}, its parents in your profile, and the database files and attachment cache that exist are private`
								: `${root} does not exist yet; the directories above it in your profile that exist are private`
						}
					],
					readable: true
				};
			}
			return {
				checks: exposed.map((object) => ({
					name,
					ok: false,
					detail:
						`${object.path} is not private: ${object.exposures.map(describeExposure).join('; ')}. ` +
						`Fix (PowerShell): ${remedy(object, inspection.user)}`
				})),
				readable: false
			};
		}
	};
}

/**
 * The privacy guard for `platform`. On Windows its PowerShell and icacls calls
 * run for real, never through the service manager's test seam; tests pass
 * `deps` with a fake runner instead.
 */
export function statePrivacy(
	platform: NodeJS.Platform = process.platform,
	deps: AclDeps = { home: homedir(), env: process.env, runner: toolRunner({}) }
): StatePrivacy {
	return platform === 'win32' ? windowsPrivacy(deps) : posixPrivacy;
}
