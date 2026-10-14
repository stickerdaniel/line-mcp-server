import qrcode from 'qrcode-terminal';
import { LineMcpError, mapError } from './errors.ts';
import { type Service, withServiceStopped } from './service/index.ts';
import { login, type LoginOptions } from './session.ts';

/**
 * `line-mcp login`; returns the exit code. The daemon holds the lock port, so
 * an installed service is stopped first and returned to its prior state once
 * the login has released the lock.
 *
 * From before the stop until the restore has finished, SIGINT (Ctrl-C, which
 * Node also raises on Windows) and SIGTERM cancel the login instead of ending
 * the process, so the service is never left stopped. A cancelled login prints
 * `login_cancelled` and exits 130. A second signal changes nothing: the
 * restore always runs to the end, bounded by the service manager's timeouts.
 * Tests pass a fake upstream as `createClient`.
 */
export async function runLogin(
	service: Service,
	client: Pick<LoginOptions, 'createClient'> = {}
): Promise<number> {
	const interrupt = new AbortController();
	const cancel = () => interrupt.abort();
	process.on('SIGINT', cancel);
	process.on('SIGTERM', cancel);
	try {
		await withServiceStopped(
			service,
			async () => {
				const result = await login({
					...client,
					signal: interrupt.signal,
					onQrUrl: (url) => {
						console.log('Scan this QR code with LINE on your phone:');
						qrcode.generate(url, { small: true });
						console.log(url);
					},
					onPin: (pin) => console.log(`Enter this PIN in LINE on your phone: ${pin}`)
				});
				console.log(
					`Logged in as ${result.mid} (${result.firstLogin ? 'account bound' : 'bound account'}), ` +
						`${result.addedKeyGenerations} new E2EE key generation(s) stored`
				);
			},
			interrupt.signal
		);
		return 0;
	} catch (error) {
		if (!(error instanceof LineMcpError && error.code === 'login_cancelled')) throw error;
		console.error(JSON.stringify(mapError(error, 'login')));
		return 130;
	} finally {
		process.off('SIGINT', cancel);
		process.off('SIGTERM', cancel);
	}
}
