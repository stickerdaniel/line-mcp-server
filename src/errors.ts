import { InternalError } from '@evex/linejs/base';
import { enums } from '@evex/linejs-types';

export type ErrorCode =
	| 'lock_held'
	| 'lock_failed'
	| 'storage_error'
	| 'needs_login'
	| 'not_logged_in'
	| 'wrong_account'
	| 'device_mismatch'
	| 'key_registration_blocked'
	| 'read_state_blocked'
	| 'key_transfer_empty'
	| 'missing_key'
	| 'launchctl_failed'
	| 'systemctl_failed'
	| 'systemd_unavailable'
	| 'systemd_unreachable'
	| 'unit_not_found'
	| 'service_state_unknown'
	| 'service_restore_failed'
	| 'unsupported_path'
	| 'invalid_state_root'
	| 'qr_expired'
	| 'invalid_node'
	| 'npx_cache'
	| 'mcp_port_in_use'
	| 'mcp_port_failed'
	| 'daemon_unreachable'
	| 'request_failed'
	| 'invalid_argument'
	| 'invalid_cursor'
	| 'not_found'
	| 'message_unsent'
	| 'no_attachment'
	| 'attachment_too_large'
	| 'cancelled'
	| 'login_cancelled'
	| 'shutting_down'
	| 'stop_timeout'
	| 'idempotency_conflict'
	| 'outcome_unknown'
	| 'unsupported_action'
	| 'file_error'
	| 'upload_failed';

/**
 * An error raised by line-mcp itself. Its message is fixed text written in this
 * repository and never carries upstream data, so it is safe to log and return.
 */
export class LineMcpError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'LineMcpError';
		this.code = code;
	}
}

export interface MappedError {
	code: string;
	operation: string;
	message: string;
}

/**
 * A failure that already went through the mapper, with fields for the caller
 * beyond the error itself (the outbox state of a mutating call). Every field
 * is line-mcp's own.
 */
export class MappedFailure extends Error {
	readonly mapped: MappedError;
	readonly details: Record<string, unknown>;

	constructor(mapped: MappedError, details: Record<string, unknown>) {
		super(mapped.message);
		this.name = 'MappedFailure';
		this.mapped = mapped;
		this.details = details;
	}
}

/**
 * The only path from a failure to a log line or a tool result. Upstream text is
 * never copied: LINEJS parse errors embed response headers (including the next
 * access token) and body bytes, and exception reasons can quote message data.
 * Only codes from the published LINE enums pass through.
 */
export function mapError(error: unknown, operation: string): MappedError {
	if (error instanceof MappedFailure) return { ...error.mapped, operation };
	if (error instanceof LineMcpError) {
		return { code: error.code, operation, message: error.message };
	}
	if (error instanceof InternalError) {
		if (error.type === 'TimeoutError') {
			return timeout(operation);
		}
		const code = upstreamCode(error.data);
		if (code) {
			return { code, operation, message: `LINE rejected ${operation} with ${code}` };
		}
		return { code: 'upstream_error', operation, message: `LINE request ${operation} failed` };
	}
	if (error instanceof Error) {
		if (error.name === 'TimeoutError' || error.name === 'AbortError') {
			return timeout(operation);
		}
		const status = httpStatus(error);
		if (status !== undefined) {
			return {
				code: 'upstream_parse_error',
				operation,
				message: `LINE returned an unreadable response to ${operation} (HTTP ${status})`
			};
		}
		if (error.name === 'TypeError' && error.message === 'fetch failed') {
			return { code: 'network_error', operation, message: `Network failure during ${operation}` };
		}
	}
	return { code: 'internal_error', operation, message: `Unexpected failure during ${operation}` };
}

/**
 * The HTTP status of a response LINEJS could not parse as Thrift. LINEJS throws
 * a plain Error naming it (base/request/mod.ts:183-190); a long poll that ends
 * without an answer arrives this way as 410.
 */
export function isHttpStatus(error: unknown, status: number): boolean {
	return httpStatus(error) === status;
}

function httpStatus(error: unknown): number | undefined {
	if (!(error instanceof Error) || error instanceof InternalError) return undefined;
	const match = /^Request internal failed: status=(\d{3}) /.exec(error.message);
	return match ? Number(match[1]) : undefined;
}

function timeout(operation: string): MappedError {
	return { code: 'upstream_timeout', operation, message: `${operation} timed out` };
}

const allowedCodes: ReadonlySet<string> = new Set([
	...Object.keys(enums.ErrorCode),
	...Object.keys(enums.SquareErrorCode),
	...Object.keys(enums.P70_g)
]);

/** Reads the exception code from TalkException, SquareException or a refresh failure. */
export function upstreamCode(data: unknown): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const record = data as Record<string, unknown>;
	const refresh = record.accessTokenRefreshException;
	const candidates = [
		record.code,
		record.errorCode,
		typeof refresh === 'object' && refresh !== null
			? (refresh as Record<string, unknown>).errorCode
			: undefined
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && allowedCodes.has(candidate)) return candidate;
	}
	return undefined;
}
