import type { Check } from '../doctor.ts';
import { LineMcpError, mapError } from '../errors.ts';
import type { StatePrivacy } from '../privacy.ts';
import { launchd } from './launchd.ts';
import type { ToolRunner } from './runner.ts';
import { systemd } from './systemd.ts';
import { taskScheduler } from './task-scheduler.ts';

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
	/** How long `stop` waits for the manager to let the service go; 30 s by default, 45 s on Windows. */
	stopTimeoutMs?: number;
	/** How long the Windows `start` waits for the daemon to run and take the lock; 15 s by default. */
	startTimeoutMs?: number;
	/** Keeps the Windows backend's files private; the real checks for `home` and `env` by default. */
	privacy?: StatePrivacy;
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
	/** Whether the backend installs a service; doctor compares its definition only then. */
	readonly supported: boolean;
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
	/**
	 * The installed definition, or undefined when it is missing; on Windows
	 * only after its privacy check passed, rejecting otherwise.
	 */
	readDefinition(): Promise<string | undefined>;
	/** Doctor's read-only checks of the manager's view of the service. */
	diagnose(): Promise<Check[]>;
}

const backends: Partial<Record<NodeJS.Platform, (deps: ServiceDeps) => Service>> = {
	darwin: launchd,
	linux: systemd,
	win32: taskScheduler
};

/** The backend for `platform`; launchd's on a platform without one of its own. */
export function serviceFor(platform: NodeJS.Platform, deps: ServiceDeps): Service {
	return (backends[platform] ?? launchd)(deps);
}

/**
 * Runs `body` with an installed service stopped, then returns the service to
 * its prior state. A failed restore rejects with `service_restore_failed`
 * after `body` printed its own result; when `body` failed too, the message
 * carries its failure as well.
 *
 * `signal` interrupts the handoff, and `body` must settle promptly on it. A
 * stop in progress finishes first, or rolls back on its own failure, and
 * `body` is skipped; a restore in progress finishes too. Once the service is
 * back, an interrupted handoff rejects with `login_cancelled`: "The login was
 * cancelled" when the signal came during the stop or `body` and `body` did
 * not succeed; otherwise its message keeps the login's own result. A stop
 * that leaves the state unknown (`service_state_unknown`) and a failed restore
 * keep their own errors.
 */
export async function withServiceStopped<T>(
	service: Service,
	body: () => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	let restore: Restore | undefined;
	try {
		restore = service.installed() ? await service.stop() : undefined;
	} catch (error) {
		// A failed stop has put the service back, unless its state is unknown.
		const unknown = error instanceof LineMcpError && error.code === 'service_state_unknown';
		if (!signal?.aborted || unknown) throw error;
		throw new LineMcpError(
			'login_cancelled',
			`The login was cancelled. ${mapError(error, 'login').message}`,
			{ cause: error }
		);
	}
	let outcome: { value: T } | { error: unknown };
	try {
		signal?.throwIfAborted();
		outcome = { value: await body() };
	} catch (error) {
		outcome = { error };
	}
	// Fixed once `body` settled: a signal during the restore cancels nothing.
	const cancelled = signal?.aborted === true && 'error' in outcome;
	try {
		await restore?.();
	} catch (error) {
		const also = cancelled
			? ' The login was cancelled.'
			: 'error' in outcome
				? ` The login failed too: ${mapError(outcome.error, 'login').message}`
				: '';
		throw new LineMcpError(
			'service_restore_failed',
			`${service.label} did not return to its state before the login: ` +
				`${mapError(error, 'login').message}. Run line-mcp install to start it.${also}`,
			{ cause: error }
		);
	}
	if (signal?.aborted) {
		throw new LineMcpError(
			'login_cancelled',
			cancelled ? 'The login was cancelled' : interruptedAfter(outcome),
			'error' in outcome ? { cause: outcome.error } : undefined
		);
	}
	if ('error' in outcome) throw outcome.error;
	return outcome.value;
}

/** The message for a signal that came after the login settled on its own. */
function interruptedAfter(outcome: { value: unknown } | { error: unknown }): string {
	// A login that succeeded has printed its result already.
	if ('value' in outcome) return 'Interrupted after the login finished';
	const { code, message } = mapError(outcome.error, 'login');
	return `The login failed with ${code}: ${message}. Interrupted while the service was restored`;
}
