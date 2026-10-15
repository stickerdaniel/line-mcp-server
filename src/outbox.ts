import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Service } from './archive.ts';
import { LineMcpError, type MappedError, MappedFailure, mapError } from './errors.ts';
import { type Log, watchDispatch } from './session.ts';
import { decodeEnvelope } from './sync/normalize.ts';

// Mutating actions (architecture, Outbox): no duplicate message after a retry, a
// timeout or a crash. Every call carries the caller's idempotency key. Its row
// moves `in_flight -> sent | failed | unknown`; `failed` means LINE never saw
// the request, `unknown` that it may have acted. Nothing is ever resent on
// line-mcp's own initiative.

export type Operation = 'send_message' | 'react' | 'unsend';
export type OutboxState = 'in_flight' | 'sent' | 'failed' | 'unknown';

/** What one mutating call asks for. Its hash binds the idempotency key. */
export interface Payload {
	operation: Operation;
	service: Service;
	chatId: string;
	/** The Square thread the action goes to. */
	threadId: string | null;
	/** `reply_to` of a send, or the message a reaction or unsend targets. */
	targetId: string | null;
	text: string | null;
	reaction: string | null;
	/** SHA-256 of the attached file. */
	attachmentSha256: string | null;
}

/** What the request carries that can tie a synced message to it. */
export interface Correlation {
	/** True when the message went out end-to-end encrypted. */
	e2ee?: boolean;
	/** SHA-256 over the encrypted chunks; their salt and nonce are this request's alone. */
	chunksSha256?: string;
	/** The obs object an upload created its message with. */
	objectId?: string;
}

/** The prepared action: everything before the one request that acts on LINE. */
export interface Plan {
	/** The request sequence number the mutating request carries, if it has one. */
	requestSeq: number | null;
	correlation: Correlation;
	/** Sends the mutating request and reads the new message ID from its answer, if any. */
	dispatch: () => Promise<{ messageId: string | null; objectId?: string }>;
}

/** The result of a call whose action is sent. */
export interface Outcome {
	idempotency_key: string;
	state: 'sent';
	/** True when this call only reported an earlier call's result. */
	replayed: boolean;
	message_id: string | null;
	request_seq: string | null;
	e2ee: boolean | null;
	/** The sync evidence that settled an earlier `unknown`, if any. */
	reconciled_by: string | null;
}

export interface ExecuteOptions {
	/** Aborts when the caller goes away; after dispatch the outcome is then `unknown`. */
	signal: AbortSignal;
	/** Runs the upstream work, in the shared pool. */
	run: <T>(task: () => Promise<T>) => Promise<T>;
}

type Settlement =
	| { state: 'sent'; messageId: string | null; correlation: Correlation }
	| { state: 'unknown' | 'failed'; cause: MappedError };

interface Row {
	key: string;
	operation: Operation;
	service: Service;
	chatId: string;
	threadId: string | null;
	targetId: string | null;
	payloadHash: string;
	state: OutboxState;
	requestSeq: string | null;
	messageId: string | null;
	correlation: Correlation;
	error: MappedError | null;
	reconciledBy: string | null;
	createdAt: number;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The hash over every field that makes two calls the same action, in a fixed order. */
export function payloadHash(payload: Payload): string {
	return sha256(
		JSON.stringify([
			payload.operation,
			payload.service,
			payload.chatId,
			payload.threadId,
			payload.targetId,
			payload.text,
			payload.reaction,
			payload.attachmentSha256
		])
	);
}

/** SHA-256 over E2EE chunks, each prefixed with its length, as sent or as synced. */
export function chunksDigest(chunks: readonly (Uint8Array | string)[]): string {
	const hash = createHash('sha256');
	for (const chunk of chunks) {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.byteLength);
		hash.update(length).update(bytes);
	}
	return hash.digest('hex');
}

/** How far before the call a synced own message may be dated (clock skew). */
const evidenceWindowMs = 10 * 60 * 1000;

/** Resolves like `promise`, or rejects with the signal's reason as soon as it aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				reject(error);
			}
		);
	});
}

export class Outbox {
	readonly #db: DatabaseSync;
	readonly #log: Log;
	readonly #now: () => number;
	/** The attempt in progress per key; a later call with the key waits for it. */
	readonly #held = new Map<string, Promise<void>>();

	/** Opening the outbox is startup: an `in_flight` row left by a stopped process becomes `unknown`. */
	constructor(db: DatabaseSync, options: { log: Log; now?: () => number }) {
		this.#db = db;
		this.#log = options.log;
		this.#now = options.now ?? Date.now;
		const error: MappedError = {
			code: 'interrupted',
			operation: 'outbox',
			message: 'line-mcp stopped while this action was in flight'
		};
		const { changes } = db
			.prepare(
				`UPDATE outbox SET state = 'unknown', error = ?, updated_at = ? WHERE state = 'in_flight'`
			)
			.run(JSON.stringify(error), this.#now());
		if (Number(changes) > 0) this.#log({ event: 'outbox_interrupted', unknown: Number(changes) });
	}

	/** The Square thread of a message this outbox sent, for actions on it before sync has it. */
	sentMessage(
		service: Service,
		chatId: string,
		messageId: string
	): { threadId: string | null } | undefined {
		const row = this.#db
			.prepare(
				`SELECT thread_id FROM outbox
				WHERE service = ? AND chat_id = ? AND message_id = ? AND operation = 'send_message'`
			)
			.get(service, chatId, messageId) as { thread_id: string | null } | undefined;
		return row ? { threadId: row.thread_id } : undefined;
	}

	/**
	 * Runs one mutating action under its idempotency key. A key seen before
	 * with another payload is refused; with the same payload, a `sent` action
	 * reports its result again, an `unknown` one is reconciled against the
	 * archive or reported again, and only a `failed` one (LINE never saw it)
	 * runs again. Calls with one key run one at a time.
	 *
	 * `prepare` does everything before the request that acts on LINE (key
	 * lookups, encryption, uploads that create no message); failures there and
	 * up to the moment the request leaves are `failed`. From then on every
	 * failure, cancellation included, is `unknown`: LINEJS parses the answer and
	 * handles its next token after the server already acted.
	 */
	async execute(
		key: string,
		payload: Payload,
		prepare: () => Promise<Plan>,
		options: ExecuteOptions
	): Promise<Outcome> {
		const { signal } = options;
		const hash = payloadHash(payload);
		const release = await this.#acquire(key, signal);
		let attempt: { settled: Promise<void>; result: Promise<Outcome> } | undefined;
		try {
			const stored = this.#read(key);
			if (stored) {
				if (stored.payloadHash !== hash) {
					throw new LineMcpError(
						'idempotency_conflict',
						'This idempotency key belongs to a different action; use a new key for a new action'
					);
				}
				if (stored.state === 'sent') return outcome(stored, true);
				if (stored.state !== 'failed') {
					// `in_flight` cannot be seen here: the key is held, and startup
					// turned every earlier one into `unknown`.
					const reconciled = this.#reconcile(stored);
					if (reconciled) return outcome(reconciled, true);
					throw unknownFailure(key, stored.operation, stored.requestSeq, stored.error, true);
				}
			}
			signal.throwIfAborted();
			attempt = this.#attempt(key, payload, hash, prepare, options);
			return await attempt.result;
		} finally {
			// The key stays held until the attempt settles, also when its caller
			// went away: a retry then sees the real outcome, never a second send.
			if (attempt) void attempt.settled.then(release);
			else release();
		}
	}

	#attempt(
		key: string,
		payload: Payload,
		hash: string,
		prepare: () => Promise<Plan>,
		{ signal, run }: ExecuteOptions
	) {
		let dispatched = false;
		// Called synchronously right before a request leaves (session guards).
		// Once the caller is gone nothing more is sent; once a request left, the
		// rest of the action follows it.
		const onDispatch = () => {
			if (dispatched) return;
			signal.throwIfAborted();
			dispatched = true;
		};
		let requestSeq: string | null = null;
		const work = run(async () => {
			const plan = await prepare();
			signal.throwIfAborted();
			requestSeq = plan.requestSeq === null ? null : String(plan.requestSeq);
			this.#begin(key, payload, hash, plan);
			const answer = await watchDispatch(onDispatch, plan.dispatch);
			const correlation = answer.objectId
				? { ...plan.correlation, objectId: answer.objectId }
				: plan.correlation;
			return { messageId: answer.messageId, correlation };
		});
		const settle = (settlement: Settlement): Settlement => {
			try {
				this.#record(key, payload, hash, settlement);
			} catch (error) {
				// Also during shutdown, after the archive closed. An `in_flight` row
				// left behind becomes `unknown` at the next start.
				this.#log({ event: 'outbox_write_failed', ...mapError(error, 'outbox') });
			}
			return settlement;
		};
		const settled = work.then(
			(sent): Settlement => settle({ state: 'sent', ...sent }),
			(error: unknown): Settlement =>
				settle({
					state: dispatched ? 'unknown' : 'failed',
					cause: mapError(error, payload.operation)
				})
		);
		const report = (settlement: Settlement): Outcome => {
			if (settlement.state === 'sent') {
				return {
					idempotency_key: key,
					state: 'sent',
					replayed: false,
					message_id: settlement.messageId,
					request_seq: requestSeq,
					e2ee: settlement.correlation.e2ee ?? null,
					reconciled_by: null
				};
			}
			if (settlement.state === 'unknown') {
				throw unknownFailure(key, payload.operation, requestSeq, settlement.cause, false);
			}
			throw failedFailure(key, settlement.cause, false);
		};
		const result = untilAborted(settled, signal).then(report, (reason: unknown) =>
			// The caller went away first. The request may still be answered; the
			// row then moves on from what is written here.
			report(
				settle({
					state: dispatched ? 'unknown' : 'failed',
					cause: mapError(reason, payload.operation)
				})
			)
		);
		return { settled: settled.then(() => {}), result };
	}

	#record(key: string, payload: Payload, hash: string, settlement: Settlement): void {
		const now = this.#now();
		if (settlement.state === 'sent') {
			this.#db
				.prepare(
					`UPDATE outbox SET state = 'sent', message_id = ?, correlation = ?, error = NULL,
						updated_at = ?
					WHERE idempotency_key = ? AND state IN ('in_flight', 'unknown')`
				)
				.run(settlement.messageId, JSON.stringify(settlement.correlation), now, key);
		} else if (settlement.state === 'unknown') {
			this.#db
				.prepare(
					`UPDATE outbox SET state = 'unknown', error = ?, updated_at = ?
					WHERE idempotency_key = ? AND state IN ('in_flight', 'unknown')`
				)
				.run(JSON.stringify(settlement.cause), now, key);
		} else {
			// The key stays bound to its payload, so a retry must be the same action.
			this.#db
				.prepare(
					`INSERT INTO outbox (idempotency_key, operation, service, chat_id, thread_id, target_id,
						payload, payload_hash, state, error, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
					ON CONFLICT (idempotency_key) DO UPDATE SET state = 'failed', error = excluded.error,
						updated_at = excluded.updated_at
					WHERE outbox.state IN ('in_flight', 'failed')`
				)
				.run(
					key,
					payload.operation,
					payload.service,
					payload.chatId,
					payload.threadId,
					payload.targetId,
					frozen(payload),
					hash,
					JSON.stringify(settlement.cause),
					now,
					now
				);
		}
	}

	/** Persists `in_flight` with the request sequence before the request is sent. */
	#begin(key: string, payload: Payload, hash: string, plan: Plan): void {
		const now = this.#now();
		const { changes } = this.#db
			.prepare(
				`INSERT INTO outbox (idempotency_key, operation, service, chat_id, thread_id, target_id,
					payload, payload_hash, state, request_seq, correlation, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?, ?, ?, ?)
				ON CONFLICT (idempotency_key) DO UPDATE SET state = 'in_flight',
					request_seq = excluded.request_seq, correlation = excluded.correlation, error = NULL,
					created_at = excluded.created_at, updated_at = excluded.updated_at
				WHERE outbox.state = 'failed'`
			)
			.run(
				key,
				payload.operation,
				payload.service,
				payload.chatId,
				payload.threadId,
				payload.targetId,
				frozen(payload),
				hash,
				plan.requestSeq === null ? null : String(plan.requestSeq),
				JSON.stringify(plan.correlation),
				now,
				now
			);
		if (Number(changes) !== 1) {
			throw new Error('The outbox row could not be claimed');
		}
	}

	/**
	 * Settles an `unknown` action as `sent` only on evidence that cannot belong
	 * to anything else: a synced message carrying exactly the encrypted chunks
	 * this request sent, or for an unsend its target as a tombstone. Matching
	 * text is no evidence: another device may have sent the same words.
	 */
	#reconcile(row: Row): Row | undefined {
		let messageId = row.messageId;
		let evidence: string | undefined;
		if (row.operation === 'send_message' && row.correlation.chunksSha256) {
			const candidates = this.#db
				.prepare(
					`SELECT message_id, envelope FROM message
					WHERE service = ? AND chat_id = ? AND unsent = 0 AND (sent_at IS NULL OR sent_at >= ?)`
				)
				.all(row.service, row.chatId, row.createdAt - evidenceWindowMs) as {
				message_id: string;
				envelope: string;
			}[];
			const matches = candidates.filter((candidate) => {
				const chunks = decodeEnvelope(candidate.envelope).chunks;
				return chunks?.length && chunksDigest(chunks) === row.correlation.chunksSha256;
			});
			if (matches.length === 1) {
				messageId = matches[0]!.message_id;
				evidence = 'synced_chunks';
			}
		} else if (row.operation === 'unsend' && row.targetId) {
			const target = this.#db
				.prepare(
					`SELECT 1 FROM message WHERE service = ? AND chat_id = ? AND message_id = ? AND unsent = 1`
				)
				.get(row.service, row.chatId, row.targetId);
			if (target) evidence = 'target_unsent';
		}
		if (!evidence) return undefined;
		this.#db
			.prepare(
				`UPDATE outbox SET state = 'sent', message_id = ?, reconciled_by = ?, updated_at = ?
				WHERE idempotency_key = ?`
			)
			.run(messageId, evidence, this.#now(), row.key);
		this.#log({ event: 'outbox_reconciled', operation: row.operation, evidence });
		return this.#read(row.key);
	}

	#read(key: string): Row | undefined {
		const row = this.#db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(key) as
			Record<string, string | number | null> | undefined;
		if (!row) return undefined;
		return {
			key,
			operation: row.operation as Operation,
			service: row.service as Service,
			chatId: String(row.chat_id),
			threadId: nullable(row.thread_id),
			targetId: nullable(row.target_id),
			payloadHash: String(row.payload_hash),
			state: row.state as OutboxState,
			requestSeq: nullable(row.request_seq),
			messageId: nullable(row.message_id),
			correlation: JSON.parse(String(row.correlation)) as Correlation,
			error: row.error === null ? null : (JSON.parse(String(row.error)) as MappedError),
			reconciledBy: nullable(row.reconciled_by),
			createdAt: Number(row.created_at)
		};
	}

	async #acquire(key: string, signal: AbortSignal): Promise<() => void> {
		for (let held = this.#held.get(key); held; held = this.#held.get(key)) {
			await untilAborted(held, signal);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#held.set(key, promise);
		return () => {
			if (this.#held.get(key) === promise) this.#held.delete(key);
			resolve();
		};
	}
}

const nullable = (value: string | number | null | undefined) =>
	value == null ? null : String(value);

/** The payload as stored: the text only as its SHA-256. */
function frozen(payload: Payload): string {
	const { text, ...rest } = payload;
	return JSON.stringify({ ...rest, textSha256: text === null ? null : sha256(text) });
}

function outcome(row: Row, replayed: boolean): Outcome {
	return {
		idempotency_key: row.key,
		state: 'sent',
		replayed,
		message_id: row.messageId,
		request_seq: row.requestSeq,
		e2ee: row.correlation.e2ee ?? null,
		reconciled_by: row.reconciledBy
	};
}

function unknownFailure(
	key: string,
	operation: Operation,
	requestSeq: string | null,
	cause: MappedError | null,
	replayed: boolean
): MappedFailure {
	return new MappedFailure(
		{
			code: 'outcome_unknown',
			operation,
			message:
				'LINE may have acted on this action, so line-mcp does not send it again. Check the chat before doing anything else; a retry with this key only reports the outcome.'
		},
		{ idempotency_key: key, state: 'unknown', replayed, request_seq: requestSeq, cause }
	);
}

function failedFailure(key: string, cause: MappedError, replayed: boolean): MappedFailure {
	return new MappedFailure(cause, { idempotency_key: key, state: 'failed', replayed });
}
