// Child process: takes the lock port given as argv[2] and keeps it until killed.
import { acquireLock } from '../../src/lock.ts';

try {
	await acquireLock(Number(process.argv[2]));
	console.log('locked');
} catch (error) {
	console.log((error as { code?: string }).code ?? 'error');
	process.exit(1);
}
