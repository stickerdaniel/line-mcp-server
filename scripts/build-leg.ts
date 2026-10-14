// Bundles the Windows standard-user leg (scripts/windows-leg.ts) into
// dist-leg/leg.js with every dependency inlined, so another account runs it
// from a copy without node_modules. CI only; the package build is
// scripts/build.ts, whose external dependencies this does not change.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

execFileSync(
	'bun',
	['build', 'scripts/windows-leg.ts', '--target=node', '--format=esm', '--outfile=dist-leg/leg.js'],
	{ cwd: join(import.meta.dirname, '..'), stdio: 'inherit' }
);
