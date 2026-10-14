// Windows access control for line-mcp's state: confinement to the user's
// profile, a read-only check of owners and access lists, and the protected
// access list of a directory line-mcp creates (architecture, Private state on
// Windows). Nothing here repairs an access list.
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';
import { LineMcpError } from './errors.ts';
import type { ToolRunner } from './service/runner.ts';

/** What the Windows checks may touch: the user's profile, the environment and the tool runner. */
export interface AclDeps {
	/** `%USERPROFILE%`; line-mcp keeps its state inside it. */
	home: string;
	/** The environment PowerShell and icacls start from. */
	env: NodeJS.ProcessEnv;
	runner: ToolRunner;
}

/** Why an object is not private. */
export type Exposure =
	| { kind: 'reparse' }
	| { kind: 'owner'; sid: string }
	| { kind: 'no_dacl' }
	/** An entry of a type other than allow or deny. */
	| { kind: 'ace_type'; ace: string }
	/** An allow entry for an account outside the trusted set. */
	| { kind: 'grant'; ace: string; sid: string; inherited: boolean };

export interface Inspected {
	path: string;
	exists: boolean;
	/** Empty when the object is private or does not exist. */
	exposures: Exposure[];
}

export interface Inspection {
	/** The SID of the user running line-mcp. */
	user: string;
	/** One per path, in the order given. */
	objects: Inspected[];
}

/** How long PowerShell may take; its first start for a user took 2.8 s on a CI runner. */
export const checkTimeoutMs = 30_000;

/** The `\\?\` form names the same file; the checks and icacls get the plain one. */
function plain(path: string): string {
	if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
	if (path.startsWith('\\\\?\\')) return path.slice(4);
	return path;
}

export interface Confined {
	/** The entries from the profile down to the root, outermost first; they need not exist yet. */
	chain: string[];
	/**
	 * The profile entry of `chain`, as written there, which alone gets the
	 * anchor exception (`exposuresOf`); absent when the root is the profile
	 * itself, which keeps the strict rule of a root.
	 */
	anchor?: string;
}

/**
 * Confines `root` to the user's profile. Walking up from `root`, the first
 * existing entry whose real path is the profile's is the anchor; real paths
 * make short names and case compare equal. Every existing entry below the
 * anchor must not be a link (Node reports junctions as links), so containment
 * by text is containment on disk. Throws `insecure_directory` when no
 * ancestor is the profile or an entry is a link.
 */
export function confine(root: string, home: string): Confined {
	const target = resolve(plain(root));
	let profile: string;
	try {
		profile = realpathSync.native(home);
	} catch (error) {
		throw new LineMcpError('insecure_directory', `Your user profile ${home} does not resolve`, {
			cause: error
		});
	}
	const chain: string[] = [];
	for (let entry = target; ;) {
		chain.unshift(entry);
		const stat = lstatSync(entry, { throwIfNoEntry: false });
		if (stat?.isSymbolicLink()) {
			throw new LineMcpError(
				'insecure_directory',
				`${entry} is a link; line-mcp keeps its state in real directories inside your user profile`
			);
		}
		if (stat && realpathSync.native(entry) === profile) {
			return entry === target ? { chain } : { chain, anchor: entry };
		}
		const parent = dirname(entry);
		if (parent === entry) {
			throw new LineMcpError(
				'insecure_directory',
				`${target} must be inside your user profile ${home}; set LINE_MCP_HOME to a directory inside it`
			);
		}
		entry = parent;
	}
}

/**
 * Prints `sid\t<user SID>`, then for each path of LINE_MCP_ACL_PATHS (joined
 * by line feeds) `<index>\t<exists 0|1>\t<reparse 0|1>\t<owner and DACL as
 * SDDL, or ->`, every line ending in a line feed. Only ASCII leaves it, so no
 * code page matters. Attributes are those of the entry itself, so a link
 * counts as a reparse point even when its target is missing. Exits 3 under
 * Constrained Language Mode, which blocks these .NET calls, and non-zero on
 * any other error.
 */
const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 3 }
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'
$out = [System.Text.StringBuilder]::new()
[void]$out.Append("sid\`t" + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value + "\`n")
$paths = $env:LINE_MCP_ACL_PATHS.Split([char]10)
for ($i = 0; $i -lt $paths.Length; $i++) {
	$attributes = [int][System.IO.FileInfo]::new($paths[$i]).Attributes
	if ($attributes -eq -1) { [void]$out.Append("$i\`t0\`t0\`t-\`n"); continue }
	if ($attributes -band [int][System.IO.FileAttributes]::ReparsePoint) { [void]$out.Append("$i\`t1\`t1\`t-\`n"); continue }
	if ($attributes -band [int][System.IO.FileAttributes]::Directory) { $acl = [System.IO.Directory]::GetAccessControl($paths[$i], $sections) }
	else { $acl = [System.IO.File]::GetAccessControl($paths[$i], $sections) }
	[void]$out.Append("$i\`t1\`t0\`t" + $acl.GetSecurityDescriptorSddlForm($sections) + "\`n")
}
[Console]::Out.Write($out.ToString())
`;

/** The check failed to run or answered unexpectedly, so nothing counts as private. */
const unverified = (cause: string) =>
	new LineMcpError(
		'insecure_directory',
		`line-mcp could not verify that its state is private: ${cause}`
	);

const system32 = (env: NodeJS.ProcessEnv) =>
	win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * Reads the owner and access list of each path in one PowerShell call and
 * judges them (`exposuresOf`); only the path equal to `anchor`, the profile
 * entry `confine` verified, gets the anchor exception. Rejects with
 * `insecure_directory` when the answer is not exactly one well-formed line
 * per path: a timeout, a non-zero exit, Constrained Language Mode, an
 * unreadable object or any other deviation.
 */
export async function checkPrivate(
	paths: string[],
	deps: AclDeps,
	anchor?: string
): Promise<Inspection> {
	const env: NodeJS.ProcessEnv = {};
	// An inherited module path (from PowerShell 7, say) breaks Windows PowerShell.
	for (const [name, value] of Object.entries(deps.env)) {
		if (name.toLowerCase() !== 'psmodulepath') env[name] = value;
	}
	env.LINE_MCP_ACL_PATHS = paths.join('\n');
	const { exit, stdout } = await deps.runner.run(
		win32.join(system32(deps.env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			Buffer.from(script, 'utf16le').toString('base64')
		],
		{ env, timeoutMs: checkTimeoutMs }
	);
	if (exit === 'timeout') {
		throw unverified(`PowerShell did not answer within ${checkTimeoutMs / 1000} s`);
	}
	if (exit === 3) {
		throw unverified('PowerShell runs in Constrained Language Mode, which blocks the check');
	}
	if (exit !== 0) throw unverified(`PowerShell failed (${exit})`);
	const lines = stdout.split('\n');
	const user = /^sid\t(S-1-\d+(?:-\d+)+)$/.exec(lines.shift() ?? '')?.[1];
	// Every line ends in a line feed, so the last element is empty.
	if (!user || lines.pop() !== '' || lines.length !== paths.length) {
		throw unverified('PowerShell gave an unexpected answer');
	}
	const objects = lines.map((line, index): Inspected => {
		const path = paths[index]!;
		const [, at, exists, reparse, sddl] =
			/^(\d+)\t([01])\t([01])\t(-|[\x21-\x7e]+)$/.exec(line) ?? [];
		if (at !== String(index)) throw unverified('PowerShell gave an unexpected answer');
		if (exists === '0' && reparse === '0' && sddl === '-') {
			return { path, exists: false, exposures: [] };
		}
		if (exists === '1' && reparse === '1' && sddl === '-') {
			return { path, exists: true, exposures: [{ kind: 'reparse' }] };
		}
		const exposures =
			exists === '1' && reparse === '0'
				? exposuresOf(sddl!, user, { anchor: path === anchor })
				: undefined;
		if (!exposures) throw unverified(`PowerShell gave an unreadable access list for ${path}`);
		return { path, exists: true, exposures };
	});
	return { user, objects };
}

const sidPattern = String.raw`(?:[A-Z]{2}|S-1-\d+(?:-\d+)+)`;
const descriptorPattern = new RegExp(
	String.raw`^O:(${sidPattern})(?:D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)((?:\([^()]*\))*))?$`
);
const acePattern = new RegExp(
	String.raw`^([A-Z]+);((?:[A-Z]{2})*);(0x[0-9a-fA-F]+|[A-Z]+);[^;]*;[^;]*;(${sidPattern})$`
);

/** SDDL access right tokens and their bits. */
const rightBits: Record<string, number> = {
	GA: 0x10000000,
	GR: 0x80000000,
	GW: 0x40000000,
	GX: 0x20000000,
	RC: 0x20000,
	SD: 0x10000,
	WD: 0x40000,
	WO: 0x80000,
	RP: 0x10,
	WP: 0x20,
	CC: 0x1,
	DC: 0x2,
	LC: 0x4,
	SW: 0x8,
	LO: 0x80,
	DT: 0x40,
	CR: 0x100,
	FA: 0x1f01ff,
	FR: 0x120089,
	FW: 0x120116,
	FX: 0x1200a0,
	KA: 0xf003f,
	KR: 0x20019,
	KW: 0x20006,
	KX: 0x20019
};

/**
 * The access mask of an ACE's rights field, from hex (leading zeros allowed)
 * or right tokens; undefined for an unknown token or a value beyond 32 bits.
 */
function accessMask(rights: string): number | undefined {
	if (/^0x[0-9a-fA-F]+$/.test(rights)) {
		const digits = rights.slice(2).replace(/^0+/, '');
		return digits.length <= 8 ? Number.parseInt(digits || '0', 16) : undefined;
	}
	if (!/^(?:[A-Z]{2})+$/.test(rights)) return undefined;
	let mask = 0;
	for (const token of rights.match(/../g)!) {
		const bits = rightBits[token];
		if (bits === undefined) return undefined;
		mask = (mask | bits) >>> 0;
	}
	return mask;
}

/** FILE_TRAVERSE | SYNCHRONIZE: passage through a directory, and nothing else. */
const traverse = 0x100020;

/**
 * Windows Server 2025 (build 26100) gives every profile directory one such
 * entry: traverse for the app isolation capability isolatedWin32-userProfileMinimal.
 * Accepted on the anchor alone: a capability SID (held by app-container
 * tokens, not by accounts), no inheritance flag, and no right beyond
 * `traverse`. Traverse grants passage only; every entry below is checked
 * strictly.
 */
function anchorTraverse(sid: string, flags: string, rights: string): boolean {
	const mask = accessMask(rights);
	return (
		sid.startsWith('S-1-15-3-') &&
		flags === '' &&
		mask !== undefined &&
		(mask & ~traverse) >>> 0 === 0
	);
}

/** SYSTEM, Administrators and the built-in Administrator account, as aliases and SIDs. */
const trustedOwners: ReadonlySet<string> = new Set(['SY', 'BA', 'LA', 'S-1-5-18', 'S-1-5-32-544']);
/**
 * CREATOR OWNER stands for whoever creates a child, and only principals that
 * may create children receive it; the chain check requires those to be trusted.
 */
const trustedGrantees: ReadonlySet<string> = new Set([...trustedOwners, 'CO', 'S-1-3-0']);

/**
 * Why the security descriptor `sddl` (`O:` and `D:` parts) is not private
 * for `user`; undefined when it does not parse. Private means a trusted
 * owner (the user, SYSTEM, Administrators), a DACL, only allow and deny
 * entries, and allow entries only for the user, SYSTEM, Administrators or
 * CREATOR OWNER. Inherit-only entries count, since children receive them.
 * Deny entries expose nothing. With `anchor`, for the profile directory
 * `confine` verified, the traverse entry Windows adds there passes too
 * (`anchorTraverse`).
 */
export function exposuresOf(
	sddl: string,
	user: string,
	{ anchor = false }: { anchor?: boolean } = {}
): Exposure[] | undefined {
	const descriptor = descriptorPattern.exec(sddl);
	if (!descriptor) return undefined;
	const [, owner, flags, aces] = descriptor;
	const exposures: Exposure[] = [];
	if (owner !== user && !trustedOwners.has(owner!)) exposures.push({ kind: 'owner', sid: owner! });
	if (flags === undefined || flags.includes('NO_ACCESS_CONTROL')) {
		exposures.push({ kind: 'no_dacl' });
		return exposures;
	}
	for (const ace of aces!.match(/\([^()]*\)/g) ?? []) {
		const [, type, aceFlags, rights, sid] = acePattern.exec(ace.slice(1, -1)) ?? [];
		if (!type) return undefined;
		if (type === 'D') continue;
		if (type !== 'A') exposures.push({ kind: 'ace_type', ace });
		else if (
			sid !== user &&
			!trustedGrantees.has(sid!) &&
			!(anchor && anchorTraverse(sid!, aceFlags!, rights!))
		) {
			const inherited = aceFlags!.match(/../g)?.includes('ID') ?? false;
			exposures.push({ kind: 'grant', ace, sid: sid!, inherited });
		}
	}
	return exposures;
}

/** One line on why `object` is not private, for an error or doctor. */
export function describeExposure(exposure: Exposure): string {
	switch (exposure.kind) {
		case 'reparse':
			return 'it is a link or another reparse point';
		case 'owner':
			return `its owner ${exposure.sid} is not you, SYSTEM or Administrators`;
		case 'no_dacl':
			return 'it has no access list, so everyone has access';
		case 'ace_type':
			return `it has an access entry line-mcp does not accept: ${exposure.ace}`;
		case 'grant':
			return `it grants ${exposure.sid} access${exposure.inherited ? ' through inheritance' : ''}: ${exposure.ace}`;
	}
}

/**
 * Throws `insecure_directory` for the first object that is not private, naming
 * it and why; doctor shows the fix.
 */
export function refuseExposed({ objects }: Inspection): void {
	for (const { path, exposures } of objects) {
		const [first] = exposures;
		if (first) {
			throw new LineMcpError(
				'insecure_directory',
				`${path} is not private: ${describeExposure(first)}. Run line-mcp doctor for the fix`
			);
		}
	}
}

/** Well-known SDDL aliases icacls accepts only as SIDs. */
const aliasSids: Record<string, string> = {
	WD: 'S-1-1-0',
	CG: 'S-1-3-1',
	NU: 'S-1-5-2',
	IU: 'S-1-5-4',
	SU: 'S-1-5-6',
	AN: 'S-1-5-7',
	AU: 'S-1-5-11',
	RC: 'S-1-5-12',
	LS: 'S-1-5-19',
	NS: 'S-1-5-20',
	BU: 'S-1-5-32-545',
	BG: 'S-1-5-32-546',
	PU: 'S-1-5-32-547',
	RD: 'S-1-5-32-555',
	AC: 'S-1-15-2-1'
};

/** The icacls arguments that give `dir` the protected private access list. */
export function protectArgs(dir: string, user: string): string[] {
	return [
		dir,
		'/inheritance:r',
		'/grant:r',
		`*${user}:(OI)(CI)F`,
		'*S-1-5-18:(OI)(CI)F',
		'*S-1-5-32-544:(OI)(CI)F',
		'/Q'
	];
}

const command = (args: string[]) =>
	['icacls', ...args.map((arg, index) => (index === 0 ? `"${arg}"` : arg))].join(' ');

/**
 * The commands that make `object` private, for doctor. Nothing runs them:
 * line-mcp never changes an access list it did not create.
 */
export function remedy({ path, exposures }: Inspected, user: string): string {
	const steps: string[] = [];
	if (exposures.some((exposure) => exposure.kind === 'reparse')) {
		steps.push('remove it; line-mcp keeps its state in real files and directories');
	}
	if (exposures.some((exposure) => exposure.kind === 'owner')) {
		steps.push(command([path, '/setowner', `*${user}`]));
	}
	const grants = exposures.flatMap((exposure) => (exposure.kind === 'grant' ? [exposure] : []));
	const explicit = [...new Set(grants.filter((grant) => !grant.inherited).map(({ sid }) => sid))];
	if (explicit.length > 0) {
		const sids = explicit.map((sid) => (sid.startsWith('S-') ? sid : aliasSids[sid]));
		if (sids.every((sid) => sid !== undefined)) {
			steps.push(command([path, '/remove:g', ...sids.map((sid) => `*${sid}`)]));
		} else
			steps.push(`remove the entries for ${explicit.join(', ')} with icacls "${path}" /remove:g`);
	}
	if (grants.some((grant) => grant.inherited)) {
		steps.push(`${command(protectArgs(dirname(path), user))}, then ${command([path, '/reset'])}`);
	}
	if (exposures.some((exposure) => exposure.kind === 'no_dacl' || exposure.kind === 'ace_type')) {
		steps.push(command([path, '/reset']));
	}
	return steps.join(', then ');
}

/**
 * Creates `dir`, whose parent exists and was checked, and gives it the
 * protected private access list: full control for the user, SYSTEM and
 * Administrators, inherited by everything created inside.
 */
export async function createPrivate(dir: string, user: string, deps: AclDeps): Promise<void> {
	mkdirSync(dir);
	const { exit } = await deps.runner.run(
		win32.join(system32(deps.env), 'icacls.exe'),
		protectArgs(dir, user)
	);
	if (exit !== 0) {
		throw new LineMcpError(
			'insecure_directory',
			`Could not make ${dir} private: icacls failed (${exit})`
		);
	}
}
