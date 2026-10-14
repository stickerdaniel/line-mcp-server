import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serviceFor } from '../src/service/index.ts';
import { type ToolRunner, toolRunner } from '../src/service/runner.ts';

const runner = toolRunner({
	LINE_MCP_SERVICE_RUNNER: fileURLToPath(new URL('fixtures/service-runner.ts', import.meta.url))
});

const exit = (code: number) => ({ exit: code, stdout: '' });

/**
 * Stands in for launchctl and records every call. After a bootout that found
 * the agent (exit 0) launchd keeps it loaded for `unloadPolls` more `print`
 * calls, as while the daemon shuts down, and a bootstrap until then fails
 * with 5, as the real one does.
 */
function fakeLaunchd({ bootout = 0, unloadPolls = 0 }: { bootout?: number; unloadPolls?: number }) {
	const calls: string[][] = [];
	let loadedFor = 0;
	const launchctl: ToolRunner = {
		run: async (tool, args) => {
			calls.push([tool, ...args]);
			switch (args[0]) {
				case 'bootout':
					if (bootout === 0) loadedFor = unloadPolls;
					return exit(bootout);
				case 'print':
					if (loadedFor === 0) return exit(113);
					loadedFor--;
					return exit(0);
				case 'bootstrap':
					return exit(loadedFor > 0 ? 5 : 0);
				default:
					return exit(0);
			}
		},
		describe: (tool, args) => [tool, ...args].join(' ')
	};
	return { calls, launchctl };
}

describe('launchd', () => {
	// doctor compares the installed plist byte for byte, so existing LaunchAgents
	// stay current only while the rendering does. The text is c2e133b's.
	it('renders the LaunchAgent exactly as installed ones expect', () => {
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner });

		const plist = service.render({
			node: '/opt/homebrew/opt/node@24/bin/node',
			cli: '/Users/me/Code/line & "mcp"/dist/cli.js',
			env: {
				LINE_MCP_HOME: '/Users/me/<state>',
				LINE_MCP_PORT: '47900',
				LINE_MCP_NODE: '/elsewhere/node',
				LINE_MCP_SERVICE_RUNNER: '/tmp/service-runner.ts',
				PATH: '/usr/bin:/bin'
			}
		});

		expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>io.github.stickerdaniel.line-mcp</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/opt/node@24/bin/node</string>
		<string>/Users/me/Code/line &amp; &quot;mcp&quot;/dist/cli.js</string>
		<string>daemon</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>LINE_MCP_HOME</key>
		<string>/Users/me/&lt;state&gt;</string>
		<key>LINE_MCP_PORT</key>
		<string>47900</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>/Users/me/Library/Logs/line-mcp/daemon.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/me/Library/Logs/line-mcp/daemon.log</string>
</dict>
</plist>
`);
	});

	const domain = `gui/${userInfo().uid}`;
	const target = `${domain}/io.github.stickerdaniel.line-mcp`;
	const bootstrap = [
		'/bin/launchctl',
		'bootstrap',
		domain,
		'/Users/me/Library/LaunchAgents/io.github.stickerdaniel.line-mcp.plist'
	];

	// A bootout of an agent that is not loaded (3, 113) still counts as stopped.
	it.each([0, 3, 113])(
		'stops for login with bootout (exits %i) and starts with bootstrap',
		async (bootout) => {
			const { calls, launchctl } = fakeLaunchd({ bootout });
			const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: launchctl });

			await service.stop();
			await service.start();

			// `print` only reads, so the mutations are what counts.
			expect(calls.filter((call) => call[1] !== 'print')).toEqual([
				['/bin/launchctl', 'bootout', target],
				bootstrap
			]);
		}
	);

	// bootout returns while the daemon still shuts down; a bootstrap then fails.
	it('waits until launchd has let the agent go before starting it again', async () => {
		const { launchctl } = fakeLaunchd({ unloadPolls: 3 });
		const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: launchctl });

		await service.stop();

		await expect(service.start()).resolves.toBeUndefined();
	});

	it('fails the stop when launchd keeps the agent loaded', async () => {
		const { launchctl } = fakeLaunchd({ unloadPolls: Number.POSITIVE_INFINITY });
		const service = serviceFor('darwin', {
			home: '/Users/me',
			env: {},
			runner: launchctl,
			stopTimeoutMs: 300
		});

		await expect(service.stop()).rejects.toMatchObject({ code: 'launchctl_failed' });
	});
});
