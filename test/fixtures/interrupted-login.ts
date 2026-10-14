// Child process: `line-mcp login` as the CLI runs it, against a fake upstream
// that stalls at the profile lookup, after LINEJS wrote the token and keys,
// and prints `stalled`. The state root, lock port and service runner come from
// the environment, as for the CLI; the parent sends the signal.
import { homedir } from 'node:os';
import { runLogin } from '../../src/login-cli.ts';
import { serviceFor } from '../../src/service/index.ts';
import { toolRunner } from '../../src/service/runner.ts';
import { fakeUpstream, keyPair, qrLoginHandlers, selfMid } from '../fake-line.ts';

const upstream = fakeUpstream(
	qrLoginHandlers({
		mid: selfMid,
		keys: [keyPair(7)],
		onProfile: () => {
			console.log('stalled');
			return new Promise<never>(() => {});
		}
	})
);
const service = serviceFor(process.platform, {
	home: homedir(),
	env: process.env,
	runner: toolRunner()
});
process.exitCode = await runLogin(service, { createClient: upstream.createClient });
