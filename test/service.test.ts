import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serviceFor } from '../src/service/index.ts';
import { type ToolRunner, toolRunner } from '../src/service/runner.ts';

const runner = toolRunner({
	LINE_MCP_SERVICE_RUNNER: fileURLToPath(new URL('fixtures/service-runner.ts', import.meta.url))
});

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

	// A bootout of an agent that is not loaded (3, 113) still counts as stopped.
	it.each([0, 3, 113])(
		'stops for login with bootout (exits %i) and starts with bootstrap',
		async (bootout) => {
			const calls: string[][] = [];
			const scripted: ToolRunner = {
				run: async (tool, args) => {
					calls.push([tool, ...args]);
					return { exit: args[0] === 'bootout' ? bootout : 0, stdout: '' };
				},
				describe: (tool, args) => [tool, ...args].join(' ')
			};
			const service = serviceFor('darwin', { home: '/Users/me', env: {}, runner: scripted });

			await service.stop();
			await service.start();

			const domain = `gui/${userInfo().uid}`;
			expect(calls).toEqual([
				['/bin/launchctl', 'bootout', `${domain}/io.github.stickerdaniel.line-mcp`],
				[
					'/bin/launchctl',
					'bootstrap',
					domain,
					'/Users/me/Library/LaunchAgents/io.github.stickerdaniel.line-mcp.plist'
				]
			]);
		}
	);
});
