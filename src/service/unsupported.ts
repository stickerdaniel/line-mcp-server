import { LineMcpError } from '../errors.ts';
import type { Service, ServicePaths } from './index.ts';

const reason =
	'line-mcp has no background service on Windows yet; run line-mcp daemon in the foreground';

const refuse = () => new LineMcpError('service_unsupported', reason);

/**
 * Windows until it gets a backend of its own. Nothing is installed, so a
 * login runs without a handoff and touches no service file; every mutation
 * rejects with `service_unsupported` before it writes or runs anything.
 */
export function unsupported(): Service {
	return {
		supported: false,
		label: 'line-mcp',
		check: 'service',
		// There is no definition or log; doctor skips them when `supported` is false.
		get paths(): ServicePaths {
			throw refuse();
		},
		render() {
			throw refuse();
		},
		install: () => Promise.reject(refuse()),
		uninstall: () => Promise.reject(refuse()),
		start: () => Promise.reject(refuse()),
		// Nothing runs, so nothing stops and the restore has nothing to do.
		stop: async () => async () => {},
		installed: () => false,
		diagnose: async () => [{ name: 'service', ok: true, warning: true, detail: reason }]
	};
}
