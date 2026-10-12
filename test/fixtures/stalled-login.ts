// Child process: QR login into the state root argv[2] with lock port argv[3].
// The fake upstream transfers keys, then stalls at the profile lookup, where
// LINEJS has already written the token and keys, until the parent kills it.
import { login } from '../../src/session.ts';
import { fakeUpstream, keyPair, qrLoginHandlers, selfMid } from '../fake-line.ts';

const upstream = fakeUpstream(
	qrLoginHandlers({
		mid: selfMid,
		keys: [keyPair(7), keyPair(8)],
		onProfile: () => {
			console.log('stalled');
			return new Promise<never>(() => {});
		}
	})
);
await login({
	root: process.argv[2],
	lockPort: Number(process.argv[3]),
	createClient: upstream.createClient,
	log: () => {},
	onQrUrl: () => {},
	onPin: () => {}
});
