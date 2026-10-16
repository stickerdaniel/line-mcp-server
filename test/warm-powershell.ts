// Vitest global setup: on Windows, runs the privacy check's PowerShell once
// before any test file starts. On the CI runner the first PowerShell of a run
// took 0.6 to 2.5 s and later ones typically 0.2 to 0.45 s, so the test that
// happened to start it first paid that start-up cost.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statePrivacy } from '../src/privacy.ts';

export default async function warmPowerShell(): Promise<void> {
	if (process.platform !== 'win32') return;
	const dir = mkdtempSync(join(tmpdir(), 'line-mcp-warm-'));
	try {
		// Its checks are not asserted. It starts PowerShell where TEMP lies inside
		// the profile, as on the CI runner: a TEMP outside it, or behind a
		// junction, fails confinement before PowerShell starts, while owner and
		// access list failures come after.
		await statePrivacy().diagnose(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
