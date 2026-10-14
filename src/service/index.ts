import { launchd } from './launchd.ts';
import type { ToolRunner } from './runner.ts';

export interface ServicePaths {
	/** The definition file the service manager reads. */
	definition: string;
	logDir: string;
	log: string;
}

/** What a backend may touch: the user's home, the environment and the manager's tools. */
export interface ServiceDeps {
	home: string;
	env: NodeJS.ProcessEnv;
	runner: ToolRunner;
	/** How long `stop` waits for the manager to let the service go; 30 s by default. */
	stopTimeoutMs?: number;
}

/** A dry run prints every file write and mutating command instead of running it. */
export interface DryRun {
	dryRun?: boolean;
}

/**
 * The per-user service manager that keeps `line-mcp daemon` running. Every
 * failure rejects; an absent service counts as stopped only when the manager
 * said so.
 */
export interface Service {
	/** The manager's name for the service, as messages show it. */
	readonly label: string;
	/** Doctor's check for the definition; `<check>_loaded` checks the manager. */
	readonly check: string;
	readonly paths: ServicePaths;
	/** The definition for this Node, CLI entry and the variables `install` forwards. */
	render(input: { node: string; cli: string; env: NodeJS.ProcessEnv }): string;
	/** Writes `definition` and restarts the service from it. */
	install(definition: string, options?: DryRun): Promise<void>;
	/** Stops the service and removes its definition. */
	uninstall(options?: DryRun): Promise<void>;
	/** Stops the service so another process can take the lock. */
	stop(): Promise<void>;
	/** Starts the installed service again after `stop`. */
	start(): Promise<void>;
	/** Whether the definition file exists. */
	installed(): boolean;
	/** Whether the manager has the service loaded. Read-only. */
	loaded(): Promise<boolean>;
}

const backends: Partial<Record<NodeJS.Platform, (deps: ServiceDeps) => Service>> = {
	darwin: launchd
};

/** The backend for `platform`; until Linux and Windows get their own, launchd's. */
export function serviceFor(platform: NodeJS.Platform, deps: ServiceDeps): Service {
	return (backends[platform] ?? launchd)(deps);
}
