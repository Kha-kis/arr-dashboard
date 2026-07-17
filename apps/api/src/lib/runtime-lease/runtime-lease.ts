import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

export const API_RUNTIME_LEASE_NAME = "active-api";
export const DEFAULT_RUNTIME_LEASE_TTL_MS = 90_000;
export const DEFAULT_RUNTIME_LEASE_HEARTBEAT_MS = 20_000;
export const DEFAULT_RUNTIME_LEASE_FAILURE_LIMIT = 3;
export const DEFAULT_RUNTIME_LEASE_OPERATION_TIMEOUT_MS = 10_000;

interface RuntimeLeaseRow {
	name: string;
	ownerId: string;
	acquiredAt: Date;
	heartbeatAt: Date;
}

export interface RuntimeLeaseStore {
	runtimeLease: {
		updateMany(args: {
			where: {
				name: string;
				OR?: Array<{ ownerId: string } | { heartbeatAt: { lt: Date } }>;
				ownerId?: string;
			};
			data: Partial<RuntimeLeaseRow>;
		}): Promise<{ count: number }>;
		create(args: { data: RuntimeLeaseRow }): Promise<RuntimeLeaseRow>;
		deleteMany(args: { where: { name: string; ownerId: string } }): Promise<{ count: number }>;
	};
}

interface RuntimeLeaseOptions {
	leaseName?: string;
	ownerId?: string;
	ttlMs?: number;
	heartbeatMs?: number;
	failureLimit?: number;
	operationTimeoutMs?: number;
	now?: () => Date;
}

export class RuntimeLeaseConflictError extends Error {
	constructor() {
		super(
			"Another arr-dashboard API process already holds the runtime lease for this database. " +
				"Run exactly one API replica per database.",
		);
		this.name = "RuntimeLeaseConflictError";
	}
}

export class RuntimeLeaseOperationTimeoutError extends Error {
	constructor(operation: string, timeoutMs: number) {
		super(`Runtime lease ${operation} did not finish within ${timeoutMs}ms`);
		this.name = "RuntimeLeaseOperationTimeoutError";
	}
}

export class RuntimeLeaseManager {
	readonly ownerId: string;
	private readonly leaseName: string;
	private readonly ttlMs: number;
	private readonly heartbeatMs: number;
	private readonly failureLimit: number;
	private readonly operationTimeoutMs: number;
	private readonly now: () => Date;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatInFlight = false;
	private renewalFailures = 0;
	private held = false;

	constructor(
		private readonly store: RuntimeLeaseStore,
		private readonly log: FastifyBaseLogger,
		options: RuntimeLeaseOptions = {},
	) {
		this.leaseName = options.leaseName ?? API_RUNTIME_LEASE_NAME;
		this.ownerId = options.ownerId ?? randomUUID();
		this.ttlMs = options.ttlMs ?? DEFAULT_RUNTIME_LEASE_TTL_MS;
		this.heartbeatMs = options.heartbeatMs ?? DEFAULT_RUNTIME_LEASE_HEARTBEAT_MS;
		this.failureLimit = options.failureLimit ?? DEFAULT_RUNTIME_LEASE_FAILURE_LIMIT;
		this.operationTimeoutMs =
			options.operationTimeoutMs ?? DEFAULT_RUNTIME_LEASE_OPERATION_TIMEOUT_MS;
		this.now = options.now ?? (() => new Date());
	}

	async acquire(): Promise<void> {
		const now = this.now();
		const staleBefore = new Date(now.getTime() - this.ttlMs);
		const reclaimed = await this.withDeadline(
			this.store.runtimeLease.updateMany({
				where: {
					name: this.leaseName,
					OR: [{ ownerId: this.ownerId }, { heartbeatAt: { lt: staleBefore } }],
				},
				data: { ownerId: this.ownerId, acquiredAt: now, heartbeatAt: now },
			}),
			"acquisition",
		);

		if (reclaimed.count === 1) {
			this.held = true;
			return;
		}

		try {
			await this.withDeadline(
				this.store.runtimeLease.create({
					data: {
						name: this.leaseName,
						ownerId: this.ownerId,
						acquiredAt: now,
						heartbeatAt: now,
					},
				}),
				"creation",
			);
			this.held = true;
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new RuntimeLeaseConflictError();
			}
			throw error;
		}
	}

	start(onLeaseLost: (error: Error) => void | Promise<void>): void {
		if (!this.held || this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.heartbeatInFlight) return;
			this.heartbeatInFlight = true;
			void this.renew()
				.catch(async (error: unknown) => {
					const normalized = error instanceof Error ? error : new Error(String(error));
					if (
						normalized instanceof RuntimeLeaseConflictError ||
						normalized instanceof RuntimeLeaseOperationTimeoutError
					) {
						this.stop();
						await onLeaseLost(normalized);
						return;
					}

					this.renewalFailures += 1;
					this.log.warn(
						{
							err: normalized,
							renewalFailures: this.renewalFailures,
							failureLimit: this.failureLimit,
						},
						"Runtime lease heartbeat failed",
					);
					if (this.renewalFailures >= this.failureLimit) {
						this.stop();
						await onLeaseLost(
							new Error(
								`Runtime lease could not be renewed after ${this.renewalFailures} attempts`,
							),
						);
					}
				})
				.finally(() => {
					this.heartbeatInFlight = false;
				});
		}, this.heartbeatMs);
		this.heartbeatTimer.unref?.();
	}

	async release(): Promise<void> {
		this.stop();
		if (!this.held) return;
		await this.withDeadline(
			this.store.runtimeLease.deleteMany({
				where: { name: this.leaseName, ownerId: this.ownerId },
			}),
			"release",
		);
		this.held = false;
	}

	stop(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async renew(): Promise<void> {
		const renewed = await this.withDeadline(
			this.store.runtimeLease.updateMany({
				where: { name: this.leaseName, ownerId: this.ownerId },
				data: { heartbeatAt: this.now() },
			}),
			"heartbeat",
		);
		if (renewed.count !== 1) {
			this.held = false;
			this.stop();
			throw new RuntimeLeaseConflictError();
		}
		this.renewalFailures = 0;
	}

	private async withDeadline<T>(operation: Promise<T>, operationName: string): Promise<T> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => {
						reject(new RuntimeLeaseOperationTimeoutError(operationName, this.operationTimeoutMs));
					}, this.operationTimeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "P2002"
	);
}
