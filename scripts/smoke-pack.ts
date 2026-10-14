// Installs the npm package as a user would and runs test/cli.test.ts,
// test/cli-tools.test.ts and test/service-e2e.test.ts against its `line-mcp`
// bin, including the daemon serving a cache-only archive and the tool commands
// calling a test server.
//
//   node scripts/smoke-pack.ts [tarball]
//     without a tarball it packs this checkout
//
// Everything runs under a temporary home, npm prefix and state root, with an
// empty npm config (no JSR registry), free ports and the service runner
// fixture in place of the service manager; the real service, archive and LINE
// stay untouched. Only test/service-e2e.test.ts reaches the real launchd, and
// only on a CI runner with LINE_MCP_E2E_SERVICE=1.
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const repo = resolve(import.meta.dirname, '..');

/**
 * Runs `file` with `args`. On Windows it goes through cmd.exe, since npm and
 * the `line-mcp` bin are `.cmd` shims there, which only a shell runs; cmd
 * would expand `%` and end a quoted argument at `"`, so those are refused. A
 * command cmd finds on PATH stays unquoted: quoted, its shim's `%~dp0` names
 * cmd's working directory instead of the shim's, and npm's shim then fails.
 */
function run(file: string, args: string[], options: SpawnSyncOptions = {}) {
	if (!windows) return spawnSync(file, args, { encoding: 'utf-8', ...options });
	const unsafe = [file, ...args].find((word) => /["%\r\n]/.test(word));
	if (unsafe) throw new Error(`cannot pass ${unsafe} through cmd.exe`);
	const command = /[\\/]/.test(file) ? `"${file}"` : file;
	const line = [command, ...args.map((arg) => `"${arg}"`)].join(' ');
	return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
		encoding: 'utf-8',
		windowsVerbatimArguments: true,
		...options
	});
}

/** Runs npm with its output on stderr; fails unless it exits 0. */
function npm(args: string[], options: SpawnSyncOptions = {}): void {
	const result = run('npm', args, { stdio: ['ignore', 2, 2], ...options });
	if (result.status !== 0) {
		throw new Error(`npm ${args[0]} exited ${result.status ?? result.signal ?? result.error}`);
	}
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	await new Promise((done) => server.close(done));
	return port;
}

async function main(tarballArg: string | undefined): Promise<number> {
	const work = mkdtempSync(join(tmpdir(), 'line-mcp-smoke-'));
	try {
		let tarball: string;
		if (tarballArg) tarball = resolve(tarballArg);
		else {
			// Runs prepack, which builds dist/.
			npm(['pack', '--pack-destination', work], { cwd: repo });
			const packed = readdirSync(work).filter((name) => name.endsWith('.tgz'));
			if (packed.length !== 1) throw new Error(`npm pack left ${packed.join(', ') || 'nothing'}`);
			tarball = join(work, packed[0]!);
		}
		const kb = Math.ceil(statSync(tarball).size / 1024);
		console.error(`smoke-pack: ${tarball} (${kb} KB)`);

		const home = join(work, 'home');
		mkdirSync(home);
		const prefix = join(work, 'prefix');
		writeFileSync(join(work, 'npmrc'), '');
		writeFileSync(join(work, 'npmrc-global'), '');
		// os.homedir() reads USERPROFILE on Windows; npm keeps its cache under LOCALAPPDATA there.
		const appData = windows
			? { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }
			: {};
		for (const dir of Object.values(appData)) mkdirSync(dir, { recursive: true });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			...appData,
			npm_config_userconfig: join(work, 'npmrc'),
			npm_config_globalconfig: join(work, 'npmrc-global'),
			LINE_MCP_HOME: join(work, 'state'),
			LINE_MCP_SERVICE_RUNNER: join(repo, 'test', 'fixtures', 'service-runner.ts'),
			LINE_MCP_LOCK_PORT: String(await freePort()),
			LINE_MCP_PORT: String(await freePort())
		};

		npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { env });
		// npm's global layout: `<prefix>/bin` links on Unix, `.cmd` shims in the prefix on Windows.
		const cli = join(
			prefix,
			...(windows ? [] : ['lib']),
			'node_modules',
			'line-mcp-server',
			'dist',
			'cli.js'
		);
		const bin = windows ? join(prefix, 'line-mcp.cmd') : join(prefix, 'bin', 'line-mcp');
		if (!existsSync(cli) || !existsSync(bin)) {
			throw new Error(`npm installed no ${existsSync(cli) ? basename(bin) : cli}`);
		}
		const target = windows ? readFileSync(bin, 'utf-8') : realpathSync(bin);
		const expected = windows ? '\\node_modules\\line-mcp-server\\dist\\cli.js' : realpathSync(cli);
		if (!target.includes(expected)) {
			throw new Error(`${bin} does not run the package's dist/cli.js: ${target}`);
		}

		const help = run(bin, ['--help'], { env });
		if (help.status !== 0) throw new Error(`line-mcp --help exited ${help.status}: ${help.stderr}`);
		// No daemon listens on LINE_MCP_PORT: the packed tool command must say so and exit 1.
		const status = run(bin, ['sync-status'], { env });
		if (status.status !== 1 || !String(status.stderr).includes('"code":"daemon_unreachable"')) {
			throw new Error(`sync-status without a daemon exited ${status.status}: ${status.stderr}`);
		}

		// Tests start the CLI as `node <entry>`: the bin link on Unix, its script on Windows.
		const tests = spawnSync(
			process.execPath,
			[
				join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
				'--run',
				'test/cli.test.ts',
				'test/cli-tools.test.ts',
				'test/service-e2e.test.ts'
			],
			{ cwd: repo, stdio: 'inherit', env: { ...env, LINE_MCP_TEST_CLI: windows ? cli : bin } }
		);
		return tests.status ?? 1;
	} finally {
		rmSync(work, { recursive: true, force: true, maxRetries: 5 });
	}
}

try {
	process.exitCode = await main(process.argv[2]);
} catch (error) {
	console.error(`smoke-pack: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
