import type { Check } from '../doctor.ts';
import { LineMcpError, mapError } from '../errors.ts';
import { launchd } from './launchd.ts';
import type { ToolRunner } from './runner.ts';
import { systemd } from './systemd.ts';

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

/** Returns the service to the state it had before `stop()`. */
export type Restore = () => Promise<void>;

/**
 * The per-user service manager that keeps `line-mcp daemon` running. Every
 * failure rejects; an absent service counts as stopped only when the manager
 * said so.
 */
export interface Service {
	/** The manager's name for the service, as messages show it. */
	readonly label: string;
	/** Doctor's check for the definition. */
	readonly check: string;
	readonly paths: ServicePaths;
	/**
	 * The definition for this Node, CLI entry and the variables `install`
	 * forwards. Rejects values the manager cannot run.
	 */
	render(input: { node: string; cli: string; env: NodeJS.ProcessEnv }): string;
	/** Writes `definition` and restarts the service from it. */
	install(definition: string, options?: DryRun): Promise<void>;
	/** Stops the service and removes its definition. */
	uninstall(options?: DryRun): Promise<void>;
	/**
	 * Stops the service so another process can take the lock. Either the
	 * service ends up stopped, or it rejects having changed nothing.
	 */
	stop(): Promise<Restore>;
	/** Starts the installed service; `install` uses it. */
	start(): Promise<void>;
	/** Whether the definition file exists. */
	installed(): boolean;
	/** Doctor's read-only checks of the manager's view of the service. */
	diagnose(): Promise<Check[]>;
}

const backends: Partial<Record<NodeJS.Platform, (deps: ServiceDeps) => Service>> = {
	darwin: launchd,
	linux: systemd
};

/** The backend for `platform`; until Windows gets its own, launchd's. */
export function serviceFor(platform: NodeJS.Platform, deps: ServiceDeps): Service {
	return (backends[platform] ?? launchd)(deps);
}

/**
 * Runs `body` with an installed service stopped, then returns the service to
 * its prior state. A failed restore rejects with `service_restore_failed`
 * after `body` printed its own result; when `body` failed too, the message
 * carries its failure as well.
 *
 * `signal` cancels the login, and `body` must settle promptly on it. A stop
 * in progress finishes first and `body` is skipped; a restore in progress
 * finishes too. Once the service is back, a handoff whose signal aborted at
 * any point rejects with `login_cancelled`.
 */
export async function withServiceStopped<T>(
	service: Service,
	body: () => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	const restore = service.installed() ? await service.stop() : undefined;
	let outcome: { value: T } | { error: unknown };
	try {
		signal?.throwIfAborted();
		outcome = { value: await body() };
	} catch (error) {
		outcome = { error };
	}
	try {
		await restore?.();
	} catch (error) {
		const also =
			'error' in outcome
				? signal?.aborted
					? ' The login was cancelled.'
					: ` The login failed too: ${mapError(outcome.error, 'login').message}`
				: '';
		throw new LineMcpError(
			'service_restore_failed',
			`${service.label} did not return to its state before the login: ` +
				`${mapError(error, 'login').message}. Run line-mcp install to start it.${also}`,
			{ cause: error }
		);
	}
	if (signal?.aborted) {
		// A login that finished before the abort already printed its result.
		throw new LineMcpError(
			'login_cancelled',
			'value' in outcome ? 'Interrupted after the login finished' : 'The login was cancelled',
			'error' in outcome ? { cause: outcome.error } : undefined
		);
	}
	if ('error' in outcome) throw outcome.error;
	return outcome.value;
}
