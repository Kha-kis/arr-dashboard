// biome-ignore-all lint/suspicious/noExplicitAny: Prisma's generated transaction delegate is intentionally structural.
import { createHash, randomUUID } from "node:crypto";
import {
	LABEL_SYNC_MUTATION_REASON_CODES,
	LABEL_SYNC_MUTATION_STATUSES,
	LABEL_SYNC_MUTATION_TERMINAL_STATUSES,
	type LabelSyncMutationAttemptRecord,
	type LabelSyncMutationReasonCode,
	type LabelSyncMutationStatus,
	MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
	parseLabelSyncMutationAttempt,
	validateLabelSyncMutationAttemptLifecycle,
	validateLabelSyncMutationTerminalEvidence,
} from "./jellyfin-mutation-state.js";

const MAX_TEXT = 512;
const MAX_FINGERPRINT = 256;
const MAX_TAG = 256;
const MAX_INT = 2_147_483_647;
const MAX_TRANSACTION_ATTEMPTS = 3;
export const MAX_STARTUP_RECOVERY_ROWS = 10_000;

type PrismaLike = {
	$transaction: (fn: (tx: any) => Promise<any>, options?: Record<string, unknown>) => Promise<any>;
};

export type MutationClaimInput = {
	userId: string;
	ruleId: string;
	destinationInstanceId: string;
	provider: "jellyfin" | "emby";
	mediaType: "movie" | "series";
	tmdbId: number;
	connectionGeneration: number;
	identityGeneration: number;
	targetItemId: string;
	libraryId: string;
	intentFingerprint: string;
	ruleFingerprint: string;
	destinationTag: string;
};

export type MutationClaimResult =
	| { kind: "acquired"; id: string; claimToken: string; activeOperationKey: string }
	| { kind: "already-active"; id: string; status: "claimed" | "sending" }
	| {
			kind: "existing-unknown";
			id: string;
			status: "unknown";
			activeOperationKey: string;
			snapshot: StoredMutationSnapshot;
	  };

export type PhysicalMutationClaimResult = MutationClaimResult | { kind: "target-busy" };

export type StoredMutationSnapshot = {
	id: string;
	userId: string;
	ruleId: string;
	destinationInstanceId: string;
	provider: "jellyfin" | "emby";
	mediaType: "movie" | "series";
	tmdbId: number;
	connectionGeneration: number;
	identityGeneration: number;
	targetItemId: string;
	libraryId: string;
	intentFingerprint: string;
	ruleFingerprint: string;
	destinationTag: string;
	activeOperationKey: string;
	sendAttemptCount: number;
	reconcileAttemptCount: number;
	requestStartedAt: Date | null;
	lastObservedAt: Date | null;
	completedAt: Date | null;
	status: "claimed" | "sending" | "unknown" | "verified" | "noop" | "failed" | "blocked";
	reasonCode: LabelSyncMutationReasonCode | null;
};

export type MutationTransitionResult =
	| {
			kind: "applied";
			status: "sending" | "verified" | "noop" | "failed" | "blocked" | "unknown";
			sendAttemptCount?: number;
	  }
	| { kind: "superseded" };

export type ReconciliationAcquireResult =
	| {
			kind: "acquired";
			id: string;
			claimToken: string;
			reconcileAttemptCount: number;
			snapshot: StoredMutationSnapshot;
	  }
	| {
			kind: "attempt-limit";
			id: string;
			reconcileAttemptCount: number;
			snapshot: StoredMutationSnapshot;
	  }
	| { kind: "already-owned" }
	| { kind: "not-reconcilable" };

export type ReconciliationOutcome =
	| { status: "verified"; reasonCode: "applied" }
	| { status: "failed"; reasonCode: "confirmed_absent" }
	| { status: "unknown"; reasonCode: "reconciliation_unavailable" | "attempt_limit" };

export type RepositoryOptions = {
	clock?: () => Date;
	tokenFactory?: () => string;
	databaseProvider?: "sqlite" | "postgresql";
};

export class MutationRepositoryError extends Error {
	readonly statusCode: number;
	readonly category!:
		| "invalid-input"
		| "conflict"
		| "already-active"
		| "invalid-state"
		| "dependency-failure";

	constructor(
		category: MutationRepositoryError["category"],
		message = category === "invalid-input"
			? "Invalid mutation claim input"
			: category === "conflict"
				? "Mutation repository conflict"
				: category === "invalid-state"
					? "Mutation repository invalid state"
					: "Mutation repository dependency failure",
	) {
		super(message);
		this.statusCode = category === "conflict" || category === "already-active" ? 409 : 503;
		this.category = category;
		this.name = "MutationRepositoryError";
	}
}

function invalid(): never {
	throw new MutationRepositoryError("invalid-input");
}

function text(value: unknown, max = MAX_TEXT): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > max ||
		value.trim().length === 0
	)
		return invalid();
	return value;
}

function integer(value: unknown, positive = false): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_INT)
		return invalid();
	if (positive && value < 1) return invalid();
	return value;
}

function sendCount(value: unknown, expected?: number): number {
	const count = integer(value);
	if (expected !== undefined && count !== expected)
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
	return count;
}

function validDate(value: unknown): Date {
	if (
		!(value instanceof Date) ||
		Number.isNaN(value.getTime()) ||
		value.getUTCFullYear() < 1 ||
		value.getUTCFullYear() > 9999
	)
		throw new MutationRepositoryError("invalid-input", "Invalid mutation timestamp");
	return new Date(value.getTime());
}

function now(clock: () => Date): Date {
	return validDate(clock());
}

export function validateMutationClaimInput(value: unknown): MutationClaimInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	const input = value as Record<string, unknown>;
	const fields = [
		"userId",
		"ruleId",
		"destinationInstanceId",
		"provider",
		"mediaType",
		"tmdbId",
		"connectionGeneration",
		"identityGeneration",
		"targetItemId",
		"libraryId",
		"intentFingerprint",
		"ruleFingerprint",
		"destinationTag",
	];
	if (
		Object.keys(input).some((key) => !fields.includes(key)) ||
		Object.keys(input).length !== fields.length
	)
		return invalid();
	const provider = input.provider;
	const mediaType = input.mediaType;
	if (provider !== "jellyfin" && provider !== "emby") return invalid();
	if (mediaType !== "movie" && mediaType !== "series") return invalid();
	return {
		userId: text(input.userId),
		ruleId: text(input.ruleId),
		destinationInstanceId: text(input.destinationInstanceId),
		provider,
		mediaType,
		tmdbId: integer(input.tmdbId, true),
		connectionGeneration: integer(input.connectionGeneration),
		identityGeneration: integer(input.identityGeneration),
		targetItemId: text(input.targetItemId),
		libraryId: text(input.libraryId),
		intentFingerprint: text(input.intentFingerprint, MAX_FINGERPRINT),
		ruleFingerprint: text(input.ruleFingerprint, MAX_FINGERPRINT),
		destinationTag: text(input.destinationTag, MAX_TAG),
	};
}

function encoded(value: string): string {
	return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function deriveActiveOperationKey(value: MutationClaimInput): string {
	const input = validateMutationClaimInput(value);
	const stable = [
		input.userId,
		input.ruleId,
		input.destinationInstanceId,
		input.provider,
		input.mediaType,
		String(input.tmdbId),
		input.destinationTag,
	]
		.map(encoded)
		.join("");
	return `v1:${createHash("sha256").update(stable, "utf8").digest("hex")}`;
}

function row(value: unknown): LabelSyncMutationAttemptRecord {
	try {
		return parseLabelSyncMutationAttempt(value);
	} catch {
		throw new MutationRepositoryError("invalid-state");
	}
}

function snapshotOf(attempt: LabelSyncMutationAttemptRecord): StoredMutationSnapshot {
	if (attempt.activeOperationKey === null) throw new MutationRepositoryError("invalid-state");
	return {
		id: attempt.id,
		userId: attempt.userId,
		ruleId: attempt.ruleId,
		destinationInstanceId: attempt.destinationInstanceId,
		provider: attempt.provider,
		mediaType: attempt.mediaType,
		tmdbId: attempt.tmdbId,
		connectionGeneration: attempt.connectionGeneration,
		identityGeneration: attempt.identityGeneration,
		targetItemId: attempt.targetItemId,
		libraryId: attempt.libraryId,
		intentFingerprint: attempt.intentFingerprint,
		ruleFingerprint: attempt.ruleFingerprint,
		destinationTag: attempt.destinationTag,
		activeOperationKey: attempt.activeOperationKey,
		sendAttemptCount: attempt.sendAttemptCount,
		reconcileAttemptCount: attempt.reconcileAttemptCount,
		requestStartedAt: attempt.requestStartedAt,
		lastObservedAt: attempt.lastObservedAt,
		completedAt: attempt.completedAt,
		status: attempt.status,
		reasonCode: attempt.reasonCode,
	};
}

function stableMatches(
	attempt: LabelSyncMutationAttemptRecord,
	input: MutationClaimInput,
): boolean {
	return (
		attempt.userId === input.userId &&
		attempt.ruleId === input.ruleId &&
		attempt.destinationInstanceId === input.destinationInstanceId &&
		attempt.provider === input.provider &&
		attempt.mediaType === input.mediaType &&
		attempt.tmdbId === input.tmdbId &&
		attempt.destinationTag === input.destinationTag
	);
}

function deriveStoredKey(attempt: LabelSyncMutationAttemptRecord): string {
	return deriveActiveOperationKey({
		userId: attempt.userId,
		ruleId: attempt.ruleId,
		destinationInstanceId: attempt.destinationInstanceId,
		provider: attempt.provider,
		mediaType: attempt.mediaType,
		tmdbId: attempt.tmdbId,
		connectionGeneration: attempt.connectionGeneration,
		identityGeneration: attempt.identityGeneration,
		targetItemId: attempt.targetItemId,
		libraryId: attempt.libraryId,
		intentFingerprint: attempt.intentFingerprint,
		ruleFingerprint: attempt.ruleFingerprint,
		destinationTag: attempt.destinationTag,
	});
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function retryable(error: unknown): boolean {
	const code = errorCode(error);
	if (code === "P2034" || code === "P2002") return true;
	// Prisma's driver adapter can report a commit-time SSI conflict directly,
	// with the SQLSTATE in cause rather than a Prisma code or message.
	if (typeof error === "object" && error !== null && "cause" in error) {
		const cause = error.cause;
		if (typeof cause === "object" && cause !== null && "originalCode" in cause) {
			if (["40001", "40P01", "SQLITE_BUSY"].includes(String(cause.originalCode))) return true;
		}
	}
	if (!(error instanceof Error)) return false;
	return /SQLITE_BUSY|database is locked|could not serialize|deadlock detected|serialization failure/i.test(
		error.message,
	);
}

function generic(error: unknown): MutationRepositoryError {
	if (error instanceof MutationRepositoryError) return error;
	return new MutationRepositoryError("dependency-failure");
}

function terminal(status: string): status is "verified" | "noop" | "failed" | "blocked" {
	return ["verified", "noop", "failed", "blocked"].includes(status);
}

function reason(value: unknown): LabelSyncMutationReasonCode {
	if (
		typeof value !== "string" ||
		!(LABEL_SYNC_MUTATION_REASON_CODES as readonly string[]).includes(value)
	) {
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
	}
	return value as LabelSyncMutationReasonCode;
}

function status(value: unknown): LabelSyncMutationStatus {
	if (
		typeof value !== "string" ||
		!(LABEL_SYNC_MUTATION_STATUSES as readonly string[]).includes(value)
	) {
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
	}
	return value as LabelSyncMutationStatus;
}

function casInput(input: {
	id: string;
	userId: string;
	ruleId: string;
	destinationInstanceId: string;
	activeOperationKey: string;
	claimToken?: string;
}) {
	return {
		id: text(input.id),
		userId: text(input.userId),
		ruleId: text(input.ruleId),
		destinationInstanceId: text(input.destinationInstanceId),
		activeOperationKey: text(input.activeOperationKey),
		...(input.claimToken === undefined ? {} : { claimToken: text(input.claimToken) }),
	};
}

function safeUpdateData(data: Record<string, unknown>): Record<string, unknown> {
	const forbidden = new Set([
		"id",
		"userId",
		"ruleId",
		"destinationInstanceId",
		"createdAt",
		"updatedAt",
	]);
	if (Object.keys(data).some((key) => forbidden.has(key)))
		throw new MutationRepositoryError("invalid-input", "Invalid guarded update");
	return data;
}

function exactKeys(value: unknown, allowed: readonly string[]): void {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
}

const AUTHORITY_REASONS = new Set([
	"identity_changed",
	"rule_changed",
	"destination_changed",
	"generation_changed",
	"target_changed",
	"library_ancestry_changed",
	"target_missing",
	"target_ambiguous",
]);

function validateTerminalEvidence(input: {
	status: LabelSyncMutationStatus;
	reasonCode: LabelSyncMutationReasonCode;
	sendAttemptCount: number;
	reconcileAttemptCount: number;
	requestStartedAt: Date | null;
	lastObservedAt: Date | null;
}): void {
	try {
		validateLabelSyncMutationTerminalEvidence(input);
	} catch {
		throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
	}
}

function validateReconciliationOutcome(value: unknown): ReconciliationOutcome {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
	const outcome = value as Record<string, unknown>;
	exactKeys(outcome, ["status", "reasonCode"]);
	if (outcome.status === "verified") {
		if (outcome.reasonCode !== "applied")
			throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
		return { status: "verified", reasonCode: "applied" };
	}
	if (outcome.status === "failed") {
		if (outcome.reasonCode !== "confirmed_absent")
			throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
		return { status: "failed", reasonCode: "confirmed_absent" };
	}
	if (outcome.status === "unknown") {
		if (
			outcome.reasonCode !== "reconciliation_unavailable" &&
			outcome.reasonCode !== "attempt_limit"
		)
			throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
		return { status: "unknown", reasonCode: outcome.reasonCode };
	}
	if (
		outcome.status === "blocked" &&
		typeof outcome.reasonCode === "string" &&
		AUTHORITY_REASONS.has(outcome.reasonCode)
	)
		throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
	throw new MutationRepositoryError("invalid-input", "Invalid reconciliation outcome");
}

export class JellyfinMutationRepository {
	private readonly clock: () => Date;
	private readonly tokenFactory: () => string;
	private readonly databaseProvider: "sqlite" | "postgresql";

	constructor(
		private readonly prisma: PrismaLike,
		options: RepositoryOptions = {},
	) {
		if (!prisma || typeof prisma.$transaction !== "function") {
			throw new MutationRepositoryError(
				"dependency-failure",
				"Invalid mutation repository dependency",
			);
		}
		this.clock = options.clock ?? (() => new Date());
		this.tokenFactory = options.tokenFactory ?? randomUUID;
		this.databaseProvider =
			options.databaseProvider ??
			(/^(postgres|postgresql):/i.test(process.env.DATABASE_URL ?? "") ? "postgresql" : "sqlite");
	}

	private token(): string {
		return text(this.tokenFactory());
	}

	private async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
		let last: unknown;
		for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
			try {
				return await this.prisma.$transaction(work, {
					isolationLevel: "Serializable",
					maxWait: 5_000,
					timeout: 10_000,
				});
			} catch (error) {
				last = error;
				if (!retryable(error) || attempt + 1 >= MAX_TRANSACTION_ATTEMPTS) throw generic(error);
			}
		}
		throw generic(last);
	}

	private async lockParents(
		tx: any,
		input: Pick<MutationClaimInput, "userId"> &
			Partial<Pick<MutationClaimInput, "ruleId" | "destinationInstanceId">>,
	) {
		if (this.databaseProvider !== "postgresql" || typeof tx.$queryRawUnsafe !== "function") return;
		await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE', input.userId);
		if (input.ruleId !== undefined)
			await tx.$queryRawUnsafe(
				'SELECT "id" FROM "label_sync_rules" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE',
				input.ruleId,
				input.userId,
			);
		if (input.destinationInstanceId !== undefined)
			await tx.$queryRawUnsafe(
				'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE',
				input.destinationInstanceId,
				input.userId,
			);
	}

	private async authorize(tx: any, input: MutationClaimInput): Promise<void> {
		const owner = await tx.user.findFirst({ where: { id: input.userId } });
		const rule = await tx.labelSyncRule.findFirst({
			where: { id: input.ruleId, userId: input.userId },
		});
		const destination = await tx.serviceInstance.findFirst({
			where: { id: input.destinationInstanceId, userId: input.userId },
		});
		if (!owner || !rule || !destination) throw new MutationRepositoryError("conflict");
		if (
			rule.enabled !== true ||
			rule.userId !== input.userId ||
			rule.destInstanceId !== input.destinationInstanceId ||
			rule.destService !== input.provider
		)
			throw new MutationRepositoryError("conflict");
		if (
			destination.userId !== input.userId ||
			destination.enabled !== true ||
			destination.service !== input.provider.toUpperCase() ||
			destination.connectionGeneration !== input.connectionGeneration ||
			destination.identityGeneration !== input.identityGeneration
		)
			throw new MutationRepositoryError("conflict");
	}

	async claim(rawInput: unknown): Promise<MutationClaimResult> {
		return this.claimInternal(rawInput) as Promise<MutationClaimResult>;
	}

	/** Production send admission; the logical claim API alone does not fence aliases. */
	async claimPhysicalTarget(
		rawInput: unknown,
		expectedServerIdentity: string,
	): Promise<PhysicalMutationClaimResult> {
		return this.claimInternal(rawInput, text(expectedServerIdentity));
	}

	private async claimInternal(
		rawInput: unknown,
		expectedServerIdentity?: string,
	): Promise<PhysicalMutationClaimResult> {
		const input = validateMutationClaimInput(rawInput);
		const activeOperationKey = deriveActiveOperationKey(input);
		return await this.transaction(async (tx) => {
			await this.lockParents(tx, input);
			await this.authorize(tx, input);
			if (expectedServerIdentity !== undefined) {
				const destination = await tx.serviceInstance.findFirst({
					where: {
						id: input.destinationInstanceId,
						userId: input.userId,
						expectedIdentity: expectedServerIdentity,
						identityStatus: "VERIFIED",
						identityKind: input.provider === "jellyfin" ? "JELLYFIN_SERVER_ID" : "EMBY_SERVER_ID",
					},
					select: { id: true },
				});
				if (!destination) throw new MutationRepositoryError("conflict");
			}
			const existingRaw = await tx.labelSyncMutationAttempt.findFirst({
				where: { userId: input.userId, activeOperationKey },
			});
			if (existingRaw) {
				const existing = row(existingRaw);
				if (
					!stableMatches(existing, input) ||
					existing.activeOperationKey !== activeOperationKey ||
					deriveStoredKey(existing) !== existing.activeOperationKey
				)
					throw new MutationRepositoryError("invalid-state");
				if (existing.status === "unknown")
					return {
						kind: "existing-unknown",
						id: existing.id,
						status: "unknown",
						activeOperationKey,
						snapshot: snapshotOf(existing),
					};
				if (existing.status === "claimed" || existing.status === "sending")
					return { kind: "already-active", id: existing.id, status: existing.status };
				throw new MutationRepositoryError("invalid-state");
			}
			if (expectedServerIdentity !== undefined) {
				// This existence-only predicate is internal global concurrency control:
				// two owners may enroll the same server. Resource authorization above
				// remains owner scoped; no other owner's row or identifier is returned.
				// Keep the predicate and insert inside this Serializable transaction so
				// PostgreSQL SSI (or SQLite's writer lock) fences simultaneous empty reads.
				const aliases = await tx.labelSyncMutationAttempt.count({
					where: {
						provider: input.provider,
						targetItemId: input.targetItemId,
						status: { in: ["claimed", "sending", "unknown"] },
						destination: { expectedIdentity: expectedServerIdentity },
					},
				});
				if (!Number.isSafeInteger(aliases) || aliases < 0)
					throw new MutationRepositoryError("invalid-state");
				if (aliases > 0) return { kind: "target-busy" };
			}
			const claimToken = this.token();
			const timestamp = now(this.clock);
			const created = await tx.labelSyncMutationAttempt.create({
				data: {
					userId: input.userId,
					ruleId: input.ruleId,
					destinationInstanceId: input.destinationInstanceId,
					provider: input.provider,
					mediaType: input.mediaType,
					tmdbId: input.tmdbId,
					connectionGeneration: input.connectionGeneration,
					identityGeneration: input.identityGeneration,
					targetItemId: input.targetItemId,
					libraryId: input.libraryId,
					intentFingerprint: input.intentFingerprint,
					ruleFingerprint: input.ruleFingerprint,
					destinationTag: input.destinationTag,
					activeOperationKey,
					claimToken,
					sendAttemptCount: 0,
					reconcileAttemptCount: 0,
					status: "claimed",
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			});
			return { kind: "acquired", id: created.id, claimToken, activeOperationKey };
		});
	}

	private async cas(
		tx: any,
		where: Record<string, unknown>,
		data: Record<string, unknown>,
	): Promise<boolean> {
		const result = await tx.labelSyncMutationAttempt.updateMany({ where, data });
		if (result?.count !== 1) return false;
		return true;
	}

	private identityWhere(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
	}) {
		return casInput(input);
	}

	async markSending(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
		claimToken: string;
		sendAttemptCount: number;
		requestStartedAt?: Date;
	}): Promise<MutationTransitionResult> {
		exactKeys(input, [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"activeOperationKey",
			"claimToken",
			"sendAttemptCount",
			"requestStartedAt",
		]);
		sendCount(input.sendAttemptCount, 0);
		const startedAt = validDate(input.requestStartedAt ?? now(this.clock));
		const count = await this.transaction(async (tx) => {
			const ok = await this.cas(
				tx,
				{
					...this.identityWhere(input),
					status: "claimed",
					claimToken: text(input.claimToken),
					sendAttemptCount: 0,
					requestStartedAt: null,
				},
				{ status: "sending", requestStartedAt: startedAt, sendAttemptCount: { increment: 1 } },
			);
			if (!ok) return false;
			return true;
		});
		return count
			? { kind: "applied", status: "sending", sendAttemptCount: input.sendAttemptCount + 1 }
			: { kind: "superseded" };
	}

	async completePreSend(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
		claimToken: string;
		sendAttemptCount: number;
		status: "noop" | "failed" | "blocked";
		reasonCode: LabelSyncMutationReasonCode;
		completedAt?: Date;
		lastObservedAt?: Date;
	}): Promise<MutationTransitionResult> {
		exactKeys(input, [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"activeOperationKey",
			"claimToken",
			"sendAttemptCount",
			"status",
			"reasonCode",
			"completedAt",
			"lastObservedAt",
		]);
		const envelope = casInput(input);
		sendCount(input.sendAttemptCount, 0);
		const statusValue = status(input.status);
		if (!terminal(statusValue) || statusValue === "verified")
			throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
		const reasonValue = reason(input.reasonCode);
		const completedAt = validDate(input.completedAt ?? now(this.clock));
		const observedAt =
			input.lastObservedAt === undefined ? undefined : validDate(input.lastObservedAt);
		validateTerminalEvidence({
			status: statusValue,
			reasonCode: reasonValue,
			sendAttemptCount: 0,
			reconcileAttemptCount: 0,
			requestStartedAt: null,
			lastObservedAt: observedAt ?? null,
		});
		const ok = await this.transaction(
			async (tx) =>
				await this.cas(
					tx,
					{
						...envelope,
						status: "claimed",
						claimToken: text(input.claimToken),
						sendAttemptCount: 0,
						requestStartedAt: null,
						reconcileAttemptCount: 0,
						lastObservedAt: null,
					},
					{
						status: statusValue,
						reasonCode: reasonValue,
						activeOperationKey: null,
						claimToken: null,
						completedAt,
						...(observedAt ? { lastObservedAt: observedAt } : {}),
					},
				),
		);
		return ok ? { kind: "applied", status: statusValue } : { kind: "superseded" };
	}

	async completeSend(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
		claimToken: string;
		sendAttemptCount: number;
		status: "verified" | "failed" | "unknown";
		reasonCode?: LabelSyncMutationReasonCode;
		lastObservedAt?: Date;
		completedAt?: Date;
	}): Promise<MutationTransitionResult> {
		exactKeys(input, [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"activeOperationKey",
			"claimToken",
			"sendAttemptCount",
			"status",
			"reasonCode",
			"completedAt",
			"lastObservedAt",
		]);
		const envelope = casInput(input);
		const exactSendCount = sendCount(input.sendAttemptCount);
		if (exactSendCount < 1)
			throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
		if (input.status === "unknown") {
			if (input.reasonCode !== undefined && input.reasonCode !== "uncertain_send")
				throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
			return await this.markUnknown({
				id: input.id,
				userId: input.userId,
				ruleId: input.ruleId,
				destinationInstanceId: input.destinationInstanceId,
				activeOperationKey: input.activeOperationKey,
				claimToken: input.claimToken,
				sendAttemptCount: input.sendAttemptCount,
				lastObservedAt: input.lastObservedAt,
			});
		}
		const statusValue = status(input.status);
		if (!terminal(statusValue))
			throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
		const reasonValue = reason(
			input.reasonCode ?? (statusValue === "verified" ? "applied" : "internal_failure"),
		);
		const completedAt = validDate(input.completedAt ?? now(this.clock));
		const observedAt =
			input.lastObservedAt === undefined ? undefined : validDate(input.lastObservedAt);
		validateTerminalEvidence({
			status: statusValue,
			reasonCode: reasonValue,
			sendAttemptCount: exactSendCount,
			reconcileAttemptCount: 0,
			requestStartedAt: new Date(0),
			lastObservedAt: observedAt ?? null,
		});
		const ok = await this.transaction(
			async (tx) =>
				await this.cas(
					tx,
					{
						...envelope,
						status: "sending",
						claimToken: text(input.claimToken),
						sendAttemptCount: exactSendCount,
						requestStartedAt: { not: null },
						reconcileAttemptCount: 0,
					},
					{
						status: statusValue,
						reasonCode: reasonValue,
						activeOperationKey: null,
						claimToken: null,
						completedAt,
						...(observedAt ? { lastObservedAt: observedAt } : {}),
					},
				),
		);
		return ok ? { kind: "applied", status: statusValue } : { kind: "superseded" };
	}

	private async markUnknown(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
		claimToken: string;
		sendAttemptCount: number;
		lastObservedAt?: Date;
	}): Promise<MutationTransitionResult> {
		exactKeys(input, [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"activeOperationKey",
			"claimToken",
			"sendAttemptCount",
			"lastObservedAt",
		]);
		const exactSendCount = sendCount(input.sendAttemptCount);
		if (exactSendCount < 1)
			throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
		const observedAt =
			input.lastObservedAt === undefined ? undefined : validDate(input.lastObservedAt);
		const ok = await this.transaction(
			async (tx) =>
				await this.cas(
					tx,
					{
						...this.identityWhere(input),
						status: "sending",
						claimToken: text(input.claimToken),
						sendAttemptCount: exactSendCount,
					},
					{
						status: "unknown",
						reasonCode: "uncertain_send",
						claimToken: null,
						completedAt: null,
						...(observedAt ? { lastObservedAt: observedAt } : {}),
					},
				),
		);
		return ok ? { kind: "applied", status: "unknown" as never } : { kind: "superseded" };
	}

	async acquireReconciliation(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
	}): Promise<ReconciliationAcquireResult> {
		return await this.transaction(async (tx) => {
			const current = await tx.labelSyncMutationAttempt.findFirst({
				where: { ...this.identityWhere(input), status: "unknown" },
			});
			if (!current) return { kind: "not-reconcilable" };
			const parsed = row(current);
			if (parsed.claimToken !== null) return { kind: "already-owned" };
			if (parsed.reconcileAttemptCount === MAX_LABEL_SYNC_MUTATION_ATTEMPTS) {
				const ok = await this.cas(
					tx,
					{
						...this.identityWhere(input),
						status: "unknown",
						claimToken: null,
						reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
					},
					{ status: "unknown", reasonCode: "attempt_limit", claimToken: null },
				);
				if (ok) {
					return {
						kind: "attempt-limit",
						id: parsed.id,
						reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
						snapshot: {
							...snapshotOf(parsed),
							reasonCode: "attempt_limit",
						},
					};
				}
				const latestRaw = await tx.labelSyncMutationAttempt.findFirst({
					where: { ...this.identityWhere(input), status: "unknown" },
				});
				if (!latestRaw) return { kind: "not-reconcilable" };
				const latest = row(latestRaw);
				if (latest.claimToken !== null) return { kind: "already-owned" };
				if (
					latest.status !== "unknown" ||
					latest.reconcileAttemptCount !== MAX_LABEL_SYNC_MUTATION_ATTEMPTS ||
					latest.reasonCode !== "attempt_limit"
				)
					return { kind: "not-reconcilable" };
				return {
					kind: "attempt-limit",
					id: latest.id,
					reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
					snapshot: {
						...snapshotOf(latest),
						reasonCode: "attempt_limit",
					},
				};
			}
			const token = this.token();
			const next = parsed.reconcileAttemptCount + 1;
			const ok = await this.cas(
				tx,
				{
					...this.identityWhere(input),
					status: "unknown",
					claimToken: null,
					reconcileAttemptCount: parsed.reconcileAttemptCount,
				},
				{ claimToken: token, reconcileAttemptCount: { increment: 1 } },
			);
			return ok
				? {
						kind: "acquired",
						id: parsed.id,
						claimToken: token,
						reconcileAttemptCount: next,
						snapshot: { ...snapshotOf(parsed), reconcileAttemptCount: next },
					}
				: { kind: "already-owned" };
		});
	}

	async completeReconciliation(input: {
		id: string;
		userId: string;
		ruleId: string;
		destinationInstanceId: string;
		activeOperationKey: string;
		claimToken: string;
		reconcileAttemptCount: number;
		outcome: ReconciliationOutcome;
		lastObservedAt?: Date;
		completedAt?: Date;
	}): Promise<MutationTransitionResult> {
		exactKeys(input, [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"activeOperationKey",
			"claimToken",
			"reconcileAttemptCount",
			"outcome",
			"lastObservedAt",
			"completedAt",
		]);
		const envelope = casInput(input);
		const exactReconcileCount = integer(input.reconcileAttemptCount, true);
		if (exactReconcileCount > MAX_LABEL_SYNC_MUTATION_ATTEMPTS)
			throw new MutationRepositoryError("invalid-input", "Invalid mutation transition");
		const outcome = validateReconciliationOutcome(input.outcome);
		const observedAt =
			input.lastObservedAt === undefined ? undefined : validDate(input.lastObservedAt);
		const completedAt =
			outcome.status === "unknown" ? null : validDate(input.completedAt ?? now(this.clock));
		const reasonCode = reason(outcome.reasonCode);
		if (outcome.status === "verified" || outcome.status === "failed")
			validateTerminalEvidence({
				status: outcome.status,
				reasonCode,
				sendAttemptCount: 1,
				reconcileAttemptCount: exactReconcileCount,
				requestStartedAt: new Date(0),
				lastObservedAt: observedAt ?? null,
			});
		const ok = await this.transaction(
			async (tx) =>
				await this.cas(
					tx,
					{
						...envelope,
						status: "unknown",
						claimToken: text(input.claimToken),
						reconcileAttemptCount: exactReconcileCount,
						sendAttemptCount: 1,
						requestStartedAt: { not: null },
						completedAt: null,
					},
					{
						status: outcome.status,
						reasonCode,
						claimToken: null,
						completedAt,
						...(outcome.status === "unknown" ? {} : { activeOperationKey: null }),
						...(observedAt ? { lastObservedAt: observedAt } : {}),
					},
				),
		);
		return ok ? { kind: "applied", status: outcome.status } : { kind: "superseded" };
	}

	private async terminalIds(
		tx: any,
		userId: string,
		where: Record<string, unknown>,
	): Promise<string[]> {
		const rows = await tx.labelSyncMutationAttempt.findMany({ where: { userId, ...where } });
		const ids: string[] = [];
		for (const candidate of rows) {
			let parsed: LabelSyncMutationAttemptRecord;
			try {
				parsed = row(candidate);
			} catch {
				throw new MutationRepositoryError("conflict");
			}
			if (["claimed", "sending", "unknown"].includes(parsed.status))
				throw new MutationRepositoryError("conflict");
			ids.push(parsed.id);
		}
		return ids;
	}

	private async blockers(tx: any, userId: string, where: Record<string, unknown>): Promise<void> {
		await this.terminalIds(tx, userId, where);
	}

	private async deleteTerminalRows(
		tx: any,
		userId: string,
		where: Record<string, unknown>,
	): Promise<void> {
		const ids = await this.terminalIds(tx, userId, where);
		if (ids.length === 0) return;
		const deleted = await tx.labelSyncMutationAttempt.deleteMany({
			where: { userId, id: { in: ids } },
		});
		if (deleted.count !== ids.length) throw new MutationRepositoryError("conflict");
	}

	async guardRuleUpdate(input: {
		userId: string;
		ruleId: string;
		data: Record<string, unknown>;
	}): Promise<void> {
		await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				ruleId: input.ruleId,
			});
			const parent = await tx.labelSyncRule.findFirst({
				where: { id: input.ruleId, userId: input.userId },
			});
			if (!parent) throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { ruleId: input.ruleId });
			const result = await tx.labelSyncRule.updateMany({
				where: { id: input.ruleId, userId: input.userId },
				data: safeUpdateData(input.data),
			});
			if (result.count !== 1) throw new MutationRepositoryError("conflict");
		});
	}

	/** Transaction-scoped seam for callers that need to perform their own rule write. */
	async withGuardedRuleUpdate<T>(
		input: { userId: string; ruleId: string },
		callback: (tx: any) => Promise<T>,
	): Promise<T> {
		return await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				ruleId: input.ruleId,
			});
			if (
				!(await tx.labelSyncRule.findFirst({ where: { id: input.ruleId, userId: input.userId } }))
			)
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { ruleId: input.ruleId });
			return await callback(tx);
		});
	}

	async guardDestinationUpdate(input: {
		userId: string;
		destinationInstanceId: string;
		data: Record<string, unknown>;
	}): Promise<void> {
		await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
			});
			const parent = await tx.serviceInstance.findFirst({
				where: { id: input.destinationInstanceId, userId: input.userId },
			});
			if (!parent) throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { destinationInstanceId: input.destinationInstanceId });
			const result = await tx.serviceInstance.updateMany({
				where: { id: input.destinationInstanceId, userId: input.userId },
				data: safeUpdateData(input.data),
			});
			if (result.count !== 1) throw new MutationRepositoryError("conflict");
		});
	}

	/** Transaction-scoped seam for callers that need to perform their own destination write. */
	async guardDestinationInTransaction(
		tx: any,
		input: { userId: string; destinationInstanceId: string; deleteTerminalRows?: boolean },
	): Promise<void> {
		await this.lockParents(tx, input);
		if (
			!(await tx.serviceInstance.findFirst({
				where: { id: input.destinationInstanceId, userId: input.userId },
			}))
		)
			throw new MutationRepositoryError("conflict");
		const scope = { destinationInstanceId: input.destinationInstanceId };
		if (input.deleteTerminalRows) await this.deleteTerminalRows(tx, input.userId, scope);
		else await this.blockers(tx, input.userId, scope);
	}

	/** Open a transaction when the caller does not already own one. */
	async withGuardedDestinationUpdate<T>(
		input: { userId: string; destinationInstanceId: string },
		callback: (tx: any) => Promise<T>,
	): Promise<T> {
		return await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
			});
			if (
				!(await tx.serviceInstance.findFirst({
					where: { id: input.destinationInstanceId, userId: input.userId },
				}))
			)
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { destinationInstanceId: input.destinationInstanceId });
			return await callback(tx);
		});
	}

	async deleteRuleGuarded(input: {
		userId: string;
		ruleId: string;
		deleteParent?: (tx: any) => Promise<void>;
	}): Promise<void> {
		await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				ruleId: input.ruleId,
			});
			if (
				!(await tx.labelSyncRule.findFirst({ where: { id: input.ruleId, userId: input.userId } }))
			)
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { ruleId: input.ruleId });
			await this.deleteTerminalRows(tx, input.userId, { ruleId: input.ruleId });
			if (input.deleteParent) await input.deleteParent(tx);
			else {
				const deleted = await tx.labelSyncRule.deleteMany({
					where: { id: input.ruleId, userId: input.userId },
				});
				if (deleted.count !== 1) throw new MutationRepositoryError("conflict");
			}
		});
	}

	async deleteDestinationGuarded(input: {
		userId: string;
		destinationInstanceId: string;
		deleteParent?: (tx: any) => Promise<void>;
	}): Promise<void> {
		await this.transaction(async (tx) => {
			await this.lockParents(tx, {
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
			});
			if (
				!(await tx.serviceInstance.findFirst({
					where: { id: input.destinationInstanceId, userId: input.userId },
				}))
			)
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, { destinationInstanceId: input.destinationInstanceId });
			await this.deleteTerminalRows(tx, input.userId, {
				destinationInstanceId: input.destinationInstanceId,
			});
			if (input.deleteParent) await input.deleteParent(tx);
			else {
				const deleted = await tx.serviceInstance.deleteMany({
					where: { id: input.destinationInstanceId, userId: input.userId },
				});
				if (deleted.count !== 1) throw new MutationRepositoryError("conflict");
			}
		});
	}

	async deleteAccountGuarded(input: {
		userId: string;
		deleteParent: (tx: any) => Promise<void>;
	}): Promise<void> {
		await this.transaction(async (tx) => {
			if (this.databaseProvider === "postgresql" && typeof tx.$queryRawUnsafe === "function")
				await tx.$queryRawUnsafe(
					'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
					input.userId,
				);
			if (!(await tx.user.findFirst({ where: { id: input.userId } })))
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, {});
			await this.deleteTerminalRows(tx, input.userId, {});
			await input.deleteParent(tx);
		});
	}

	async withGuardedAccountDeletion<T>(
		input: { userId: string },
		callback: (tx: any) => Promise<T>,
	): Promise<T> {
		return await this.transaction(async (tx) => {
			if (this.databaseProvider === "postgresql" && typeof tx.$queryRawUnsafe === "function")
				await tx.$queryRawUnsafe(
					'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
					input.userId,
				);
			if (!(await tx.user.findFirst({ where: { id: input.userId } })))
				throw new MutationRepositoryError("conflict");
			await this.blockers(tx, input.userId, {});
			await tx.labelSyncMutationAttempt.deleteMany({
				where: { userId: input.userId, status: { in: ["verified", "noop", "failed", "blocked"] } },
			});
			return await callback(tx);
		});
	}
}

export function createJellyfinMutationRepository(
	prisma: PrismaLike,
	options?: RepositoryOptions,
): JellyfinMutationRepository {
	return new JellyfinMutationRepository(prisma, options);
}

function recoveryTimestamp(value: unknown, nullable: boolean): Date | null {
	if (value === null && nullable) return null;
	if (!(value instanceof Date) || Number.isNaN(value.getTime()))
		throw new MutationRepositoryError("dependency-failure");
	const year = value.getUTCFullYear();
	if (year < 1 || year > 9999) throw new MutationRepositoryError("dependency-failure");
	return new Date(value.getTime());
}

function validateRecoveryRow(value: unknown): LabelSyncMutationAttemptRecord {
	try {
		const parsed = parseLabelSyncMutationAttempt(value);
		validateLabelSyncMutationAttemptLifecycle(parsed);
		if (parsed.status === "claimed" || parsed.status === "sending") {
			if (
				parsed.reasonCode !== null ||
				parsed.reconcileAttemptCount !== 0 ||
				(parsed.status === "sending" && parsed.sendAttemptCount !== 1)
			)
				throw new Error("unreachable active state");
		} else if (parsed.status === "unknown") {
			if (
				parsed.sendAttemptCount !== 1 ||
				(parsed.reasonCode !== null &&
					parsed.reasonCode !== "uncertain_send" &&
					parsed.reasonCode !== "reconciliation_unavailable" &&
					parsed.reasonCode !== "attempt_limit")
			)
				throw new Error("unreachable unknown state");
		}
		if (parsed.activeOperationKey !== null && deriveStoredKey(parsed) !== parsed.activeOperationKey)
			throw new Error("key mismatch");
		for (const timestamp of [
			parsed.createdAt,
			parsed.updatedAt,
			parsed.requestStartedAt,
			parsed.lastObservedAt,
			parsed.completedAt,
		])
			recoveryTimestamp(timestamp, timestamp === null);
		return parsed;
	} catch {
		throw new MutationRepositoryError("dependency-failure");
	}
}

function recoveryWhere(parsed: LabelSyncMutationAttemptRecord): Record<string, unknown> {
	return { ...parsed };
}

/**
 * Reconcile inherited active mutation claims without contacting a provider.
 * Every row is parsed and identity-checked before the first CAS update so a
 * malformed or future row cannot leave a partially recovered prefix.
 */
export async function recoverLabelSyncMutationAttempts(
	prisma: PrismaLike,
	clock: () => Date = () => new Date(),
): Promise<number> {
	const timestamp = recoveryTimestamp(clock(), false);
	if (!timestamp) throw new MutationRepositoryError("dependency-failure");
	try {
		return await prisma.$transaction(
			async (tx) => {
				const rows = await tx.labelSyncMutationAttempt.findMany({
					where: { status: { notIn: [...LABEL_SYNC_MUTATION_TERMINAL_STATUSES] } },
					orderBy: { id: "asc" },
					take: MAX_STARTUP_RECOVERY_ROWS + 1,
				});
				if (!Array.isArray(rows) || rows.length > MAX_STARTUP_RECOVERY_ROWS)
					throw new MutationRepositoryError("dependency-failure");
				const parsedRows = rows.map(validateRecoveryRow);
				let changed = 0;
				for (const parsed of parsedRows) {
					if (parsed.status === "claimed") {
						const result = await tx.labelSyncMutationAttempt.updateMany({
							where: recoveryWhere(parsed),
							data: {
								status: "failed",
								reasonCode: "startup_before_send",
								activeOperationKey: null,
								claimToken: null,
								completedAt: timestamp,
							},
						});
						if (result?.count !== 1) throw new MutationRepositoryError("dependency-failure");
						changed += 1;
					} else if (parsed.status === "sending") {
						const result = await tx.labelSyncMutationAttempt.updateMany({
							where: recoveryWhere(parsed),
							data: {
								status: "unknown",
								reasonCode: "uncertain_send",
								claimToken: null,
								completedAt: null,
							},
						});
						if (result?.count !== 1) throw new MutationRepositoryError("dependency-failure");
						changed += 1;
					} else if (parsed.status === "unknown" && parsed.claimToken !== null) {
						const result = await tx.labelSyncMutationAttempt.updateMany({
							where: recoveryWhere(parsed),
							data: { claimToken: null },
						});
						if (result?.count !== 1) throw new MutationRepositoryError("dependency-failure");
						changed += 1;
					}
				}
				return changed;
			},
			{ isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
		);
	} catch {
		throw new MutationRepositoryError("dependency-failure");
	}
}

export const MAX_JELLYFIN_MUTATION_TRANSACTION_ATTEMPTS = MAX_TRANSACTION_ATTEMPTS;
