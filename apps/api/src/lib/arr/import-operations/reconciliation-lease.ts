import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../prisma.js";
import type { ImportFileWitness } from "./file-evidence.js";
import type { OwnedImportAttempt } from "./repository.js";

interface ImportReconcileCursorBase {
	commandFingerprint: string;
	commandId: number;
	commandEndedAt: string;
	sourceIndex: number;
	page: number;
	pageSize: number | null;
	totalRecords: number | null;
	seenRecords: number;
	witnesses: ImportFileWitness[];
	ambiguousFiles: string[];
}
export type ImportReconcileCursor = ImportReconcileCursorBase &
	(
		| { version: 1 }
		| { version: 2; retainedWitnesses: ImportFileWitness[]; retainedAmbiguousFiles: string[] }
	);

export interface FinishImportReconcileLeaseInput {
	cursor: ImportReconcileCursor | null;
	nextCheckAt: Date;
	reason:
		| null
		| "evidence-unavailable"
		| "coverage-incomplete"
		| "budget-yield"
		| "connection-changed";
}

const LEASE_MS = 30_000;
const MAX_NEXT_CHECK_DELAY_MS = 24 * 60 * 60 * 1_000;
const MAX_REVISION = 2_147_483_646;
const HASH_PATTERN = /^v1:[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEASE_STATES = ["submitting", "pending", "unknown", "partial", "failed"] as const;
const FINISH_REASONS = new Set([
	"evidence-unavailable",
	"coverage-incomplete",
	"budget-yield",
	"connection-changed",
]);
const RETRYABLE_CODES = new Set(["P1008", "P2028", "P2034", "SQLITE_BUSY", "SQLITE_LOCKED"]);

type TransactionClient = Prisma.TransactionClient;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isFiniteDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isNonEmptyKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function retryableDatabaseError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (typeof current !== "object") return false;
		const record = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof record.code === "string" && RETRYABLE_CODES.has(record.code)) return true;
		if (
			typeof record.message === "string" &&
			/SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(record.message)
		) {
			return true;
		}
		current = record.cause;
	}
	return false;
}

function pauseForRetry(attempt: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5 * attempt));
}

async function ownedOperation(
	transaction: TransactionClient,
	userId: string,
	operationId: string,
): Promise<OwnedImportAttempt | null> {
	return transaction.arrImportOperation.findFirst({
		where: { id: operationId, userId },
		include: { files: { orderBy: { fileFingerprint: "asc" } } },
	});
}

function leaseIsAvailable(operation: OwnedImportAttempt, now: Date): boolean {
	if (operation.reconcileToken === null && operation.reconcileExpiresAt === null) return true;
	return (
		typeof operation.reconcileToken === "string" &&
		operation.reconcileToken.length > 0 &&
		operation.reconcileExpiresAt instanceof Date &&
		operation.reconcileExpiresAt.getTime() <= now.getTime()
	);
}

function acquisitionWhere(
	operation: OwnedImportAttempt,
	userId: string,
	operationId: string,
	now: Date,
): Prisma.ArrImportOperationWhereInput {
	const oldLease =
		operation.reconcileToken === null
			? { reconcileToken: null, reconcileExpiresAt: null }
			: {
					reconcileToken: operation.reconcileToken,
					reconcileExpiresAt: { lte: now },
				};
	return {
		id: operationId,
		userId,
		revision: operation.revision,
		state: { in: [...LEASE_STATES] },
		submissionStartedAt: { not: null },
		...oldLease,
		OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
	};
}

/** Claims one due submitted attempt for a short, restart-safe reconciliation pass. */
export async function acquireImportReconcileLease(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
	now: Date,
): Promise<{ token: string; expiresAt: Date; operation: OwnedImportAttempt } | null> {
	if (!isNonEmptyKey(userId) || !isNonEmptyKey(operationId) || !isFiniteDate(now)) return null;
	const expiresAt = new Date(now.getTime() + LEASE_MS);
	if (!isFiniteDate(expiresAt)) return null;
	let lastRetryableError: unknown;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await prisma.$transaction(async (transaction) => {
				const operation = await ownedOperation(transaction, userId, operationId);
				if (
					!operation ||
					!Number.isSafeInteger(operation.revision) ||
					operation.revision < 0 ||
					operation.revision > MAX_REVISION ||
					!LEASE_STATES.includes(operation.state as (typeof LEASE_STATES)[number]) ||
					operation.submissionStartedAt === null ||
					(operation.nextCheckAt !== null && operation.nextCheckAt.getTime() > now.getTime()) ||
					!leaseIsAvailable(operation, now)
				) {
					return null;
				}
				const token = randomUUID();
				const claimed = await transaction.arrImportOperation.updateMany({
					where: acquisitionWhere(operation, userId, operationId, now),
					data: {
						reconcileToken: token,
						reconcileExpiresAt: expiresAt,
						revision: { increment: 1 },
					},
				});
				if (claimed.count !== 1) return null;
				const claimedOperation = await ownedOperation(transaction, userId, operationId);
				if (!claimedOperation || claimedOperation.reconcileToken !== token) return null;
				return { token, expiresAt, operation: claimedOperation };
			});
		} catch (error) {
			if (!retryableDatabaseError(error)) throw error;
			lastRetryableError = error;
			if (attempt < 3) await pauseForRetry(attempt);
		}
	}
	throw lastRetryableError;
}

function sourceKeys(operation: OwnedImportAttempt): string[] {
	return [...new Set(operation.files.map((file) => file.downloadKey))].sort();
}

function cursorMatchesOperation(
	cursor: unknown,
	operation: OwnedImportAttempt,
	userNow: Date,
): cursor is ImportReconcileCursor {
	if (
		!isRecord(cursor) ||
		!hasExactKeys(cursor, [
			"version",
			"commandFingerprint",
			"commandId",
			"commandEndedAt",
			"sourceIndex",
			"page",
			"pageSize",
			"totalRecords",
			"seenRecords",
			"witnesses",
			"ambiguousFiles",
			...(cursor.version === 2 ? ["retainedWitnesses", "retainedAmbiguousFiles"] : []),
		])
	) {
		return false;
	}
	const pageSize = cursor.pageSize;
	const totalRecords = cursor.totalRecords;
	const witnesses = cursor.witnesses;
	const ambiguousFiles = cursor.ambiguousFiles;
	if (
		(cursor.version !== 1 && cursor.version !== 2) ||
		!HASH_PATTERN.test(operation.commandFingerprint) ||
		cursor.commandFingerprint !== operation.commandFingerprint ||
		!isPositiveInteger(cursor.commandId) ||
		operation.commandId !== cursor.commandId ||
		typeof cursor.commandEndedAt !== "string" ||
		!isNonNegativeInteger(cursor.sourceIndex) ||
		!Number.isSafeInteger(cursor.page) ||
		(cursor.page as number) < 1 ||
		(cursor.page as number) > 1_000_000 ||
		!(
			pageSize === null ||
			(typeof pageSize === "number" &&
				Number.isSafeInteger(pageSize) &&
				pageSize >= 1 &&
				pageSize <= 1000)
		) ||
		!(totalRecords === null || isNonNegativeInteger(totalRecords)) ||
		!isNonNegativeInteger(cursor.seenRecords) ||
		!Array.isArray(witnesses) ||
		witnesses.length > 1000 ||
		!Array.isArray(ambiguousFiles) ||
		ambiguousFiles.length > 1000 ||
		operation.submissionStartedAt === null
	) {
		return false;
	}
	const endedAt = new Date(cursor.commandEndedAt);
	if (
		!Number.isFinite(endedAt.getTime()) ||
		endedAt.toISOString() !== cursor.commandEndedAt ||
		endedAt.getTime() < operation.submissionStartedAt.getTime() ||
		endedAt.getTime() > userNow.getTime()
	) {
		return false;
	}
	if ((pageSize === null) !== (totalRecords === null)) return false;
	if (totalRecords !== null && cursor.seenRecords > totalRecords) return false;
	if (pageSize === null && (cursor.page !== 1 || cursor.seenRecords !== 0)) return false;

	const keys = sourceKeys(operation);
	if (keys.length > 32 || cursor.sourceIndex > keys.length) return false;
	const atEnd = cursor.sourceIndex === keys.length;
	if (atEnd && (witnesses.length !== 0 || ambiguousFiles.length !== 0)) return false;
	const currentKey = atEnd ? null : keys[cursor.sourceIndex];
	if (currentKey === undefined) return false;
	const ownedFiles = new Map(
		operation.files
			.filter((file) => file.downloadKey === currentKey)
			.map((file) => [file.fileFingerprint, file]),
	);
	const episodeCoordinates = new Set<string>();
	if (
		!witnessSetMatchesOperation(
			witnesses,
			ambiguousFiles,
			ownedFiles,
			operation.service,
			false,
			episodeCoordinates,
		)
	)
		return false;
	if (
		cursor.version === 2 &&
		!witnessSetMatchesOperation(
			cursor.retainedWitnesses,
			cursor.retainedAmbiguousFiles,
			new Map(operation.files.map((file) => [file.fileFingerprint, file])),
			operation.service,
			true,
			episodeCoordinates,
		)
	)
		return false;
	try {
		return Buffer.byteLength(JSON.stringify(cursor), "utf8") <= 256 * 1024;
	} catch {
		return false;
	}
}

function witnessSetMatchesOperation(
	witnesses: unknown,
	ambiguousFiles: unknown,
	ownedFiles: Map<string, OwnedImportAttempt["files"][number]>,
	service: string,
	canonical = false,
	episodeCoordinates = new Set<string>(),
): boolean {
	if (
		!Array.isArray(witnesses) ||
		witnesses.length > 1000 ||
		!Array.isArray(ambiguousFiles) ||
		ambiguousFiles.length > 1000
	)
		return false;
	const witnessFingerprints = new Set<string>();
	for (const [index, witness] of witnesses.entries()) {
		if (
			!isRecord(witness) ||
			!hasExactKeys(witness, ["fileFingerprint", "fileId", "episodeIds"]) ||
			typeof witness.fileFingerprint !== "string" ||
			!HASH_PATTERN.test(witness.fileFingerprint) ||
			!isPositiveInteger(witness.fileId) ||
			witnessFingerprints.has(witness.fileFingerprint) ||
			(canonical &&
				index > 0 &&
				witnesses[index - 1].fileFingerprint.localeCompare(witness.fileFingerprint) >= 0)
		) {
			return false;
		}
		const episodeIds = witness.episodeIds;
		if (
			!Array.isArray(episodeIds) ||
			episodeIds.some((id) => !isPositiveInteger(id)) ||
			new Set(episodeIds).size !== episodeIds.length ||
			episodeIds.some((id, index) => index > 0 && id <= episodeIds[index - 1]!)
		) {
			return false;
		}
		const ownedFile = ownedFiles.get(witness.fileFingerprint);
		if (!ownedFile) return false;
		const identity = isRecord(ownedFile.identityJson) ? ownedFile.identityJson : null;
		const persistedEpisodes =
			identity && Array.isArray(identity.episodeIds)
				? identity.episodeIds.filter(isPositiveInteger)
				: [];
		if (
			(service !== "SONARR" && episodeIds.length !== 0) ||
			(canonical && service === "SONARR" && episodeIds.length === 0) ||
			episodeIds.some((episodeId) => !persistedEpisodes.includes(episodeId))
		) {
			return false;
		}
		witnessFingerprints.add(witness.fileFingerprint);
		for (const episodeId of episodeIds)
			episodeCoordinates.add(`${witness.fileFingerprint}:${episodeId}`);
		if (episodeCoordinates.size > 10_000) return false;
	}
	const ambiguous = new Set<string>();
	for (const [index, fingerprint] of ambiguousFiles.entries()) {
		if (
			typeof fingerprint !== "string" ||
			!HASH_PATTERN.test(fingerprint) ||
			!ownedFiles.has(fingerprint) ||
			ambiguous.has(fingerprint) ||
			witnessFingerprints.has(fingerprint) ||
			(canonical && index > 0 && ambiguousFiles[index - 1] >= fingerprint)
		) {
			return false;
		}
		ambiguous.add(fingerprint);
	}
	return true;
}

function preservesRetainedEvidence(
	old: ImportReconcileCursor,
	next: ImportReconcileCursor,
): boolean {
	if (old.version === 1) return true;
	if (next.version !== 2 || next.commandEndedAt !== old.commandEndedAt) return false;
	const ambiguous = new Set(next.retainedAmbiguousFiles);
	const witnesses = new Map(
		next.retainedWitnesses.map((witness) => [witness.fileFingerprint, witness]),
	);
	return (
		old.retainedAmbiguousFiles.every((fingerprint) => ambiguous.has(fingerprint)) &&
		old.retainedWitnesses.every((witness) => {
			const retained = witnesses.get(witness.fileFingerprint);
			return (
				ambiguous.has(witness.fileFingerprint) ||
				Boolean(
					retained &&
						retained.fileId === witness.fileId &&
						witness.episodeIds.every((id) => retained.episodeIds.includes(id)),
				)
			);
		})
	);
}

function validFinishInput(value: unknown, now: Date): value is FinishImportReconcileLeaseInput {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["cursor", "nextCheckAt", "reason"]) ||
		!(value.cursor === null || isRecord(value.cursor)) ||
		!isFiniteDate(value.nextCheckAt) ||
		value.nextCheckAt.getTime() <= now.getTime() ||
		value.nextCheckAt.getTime() > now.getTime() + MAX_NEXT_CHECK_DELAY_MS ||
		!(
			value.reason === null ||
			(typeof value.reason === "string" && FINISH_REASONS.has(value.reason))
		)
	) {
		return false;
	}
	return true;
}

/** Parses a persisted cursor against its owning attempt; invalid JSON remains unavailable. */
export function parseImportReconcileCursor(
	operation: OwnedImportAttempt,
	value: unknown,
	now: Date,
): ImportReconcileCursor | null {
	if (!isFiniteDate(now) || !cursorMatchesOperation(value, operation, now)) return null;
	return value;
}

/** Persists only bounded continuation metadata while holding the current lease fence. */
export async function finishImportReconcileLease(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
	token: string,
	expectedRevision: number,
	now: Date,
	input: FinishImportReconcileLeaseInput,
): Promise<boolean> {
	if (
		!isNonEmptyKey(userId) ||
		!isNonEmptyKey(operationId) ||
		typeof token !== "string" ||
		!TOKEN_PATTERN.test(token) ||
		!Number.isSafeInteger(expectedRevision) ||
		expectedRevision < 0 ||
		expectedRevision > MAX_REVISION ||
		!isFiniteDate(now) ||
		!validFinishInput(input, now)
	) {
		return false;
	}
	return prisma.$transaction(async (transaction) => {
		const effectiveNowAtRead = new Date(Math.max(Date.now(), now.getTime()));
		const operation = await transaction.arrImportOperation.findFirst({
			where: {
				id: operationId,
				userId,
				revision: expectedRevision,
				reconcileToken: token,
				reconcileExpiresAt: { gt: effectiveNowAtRead },
			},
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
		if (
			!operation ||
			(input.cursor !== null && !cursorMatchesOperation(input.cursor, operation, now))
		) {
			return false;
		}
		if (input.cursor !== null && operation.reconcileCursor !== null) {
			const old = parseImportReconcileCursor(operation, operation.reconcileCursor, now);
			if (!old || !preservesRetainedEvidence(old, input.cursor)) return false;
		}
		const effectiveNowAtWrite = new Date(Math.max(Date.now(), now.getTime()));
		const changed = await transaction.arrImportOperation.updateMany({
			where: {
				id: operationId,
				userId,
				revision: expectedRevision,
				reconcileToken: token,
				reconcileExpiresAt: { gt: effectiveNowAtWrite },
			},
			data: {
				...(input.cursor === null
					? {}
					: {
							reconcileCursor: input.cursor as unknown as Prisma.InputJsonValue,
						}),
				reason: input.reason,
				lastCheckedAt: now,
				nextCheckAt: input.nextCheckAt,
				reconcileToken: null,
				reconcileExpiresAt: null,
				revision: { increment: 1 },
			},
		});
		return changed.count === 1;
	});
}
