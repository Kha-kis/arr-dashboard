import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClientInstance } from "../prisma.js";

export const HISTORY_COLLECTION_LEASE_TTL_MS = 5 * 60_000;
export const HISTORY_COLLECTION_LEASE_HEARTBEAT_MS = 30_000;
export const HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES = 256;
export const HISTORY_COLLECTION_LEASE_TOKEN_MAX_BYTES = 128;
export const HISTORY_COLLECTION_LEASE_TRANSACTION_ATTEMPTS = 3;
export const HISTORY_COLLECTION_LEASE_TRANSACTION_TIMEOUT_MS = 10_000;

export type HistoryLeaseDialect = "sqlite" | "postgresql";

export type HistoryCollectionLeaseClaim = {
	userId: string;
	claimToken: string;
	claimedAt: Date;
	heartbeatAt: Date;
	expiresAt: Date;
	nextSourceCursor: string | null;
};

export type HistoryCollectionLeaseOptions = {
	dialect?: HistoryLeaseDialect;
	nextSourceCursor?: string | null;
};

type LeasePrisma = Pick<
	PrismaClientInstance,
	"$executeRawUnsafe" | "$queryRawUnsafe" | "$transaction"
>;
type LeaseTransaction = Prisma.TransactionClient;
type LeaseRow = {
	userId: unknown;
	claimToken: unknown;
	claimedAt: unknown;
	heartbeatAt: unknown;
	expiresAt: unknown;
	nextSourceCursor: unknown;
};

const SELECT_LEASE_SQL = {
	sqlite: `SELECT "userId", "claimToken", "claimedAt", "heartbeatAt", "expiresAt", "nextSourceCursor"
FROM "history_collection_leases" WHERE "userId" = ?`,
	postgresql: `SELECT "userId", "claimToken", "claimedAt", "heartbeatAt", "expiresAt", "nextSourceCursor"
FROM "history_collection_leases" WHERE "userId" = $1`,
} as const;

const INSERT_LEASE_SQL = {
	sqlite: `INSERT OR IGNORE INTO "history_collection_leases" ("userId", "updatedAt")
VALUES (?, CURRENT_TIMESTAMP)`,
	postgresql: `INSERT INTO "history_collection_leases" ("userId", "updatedAt")
VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT ("userId") DO NOTHING`,
} as const;

const ACQUIRE_LEASE_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "claimToken" = ?, "claimedAt" = CURRENT_TIMESTAMP,
    "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = datetime(CURRENT_TIMESTAMP, '+300 seconds'),
    "lastAttemptAt" = CURRENT_TIMESTAMP, "lastAttemptResult" = ?,
    "lastAttemptReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ?
  AND (("claimToken" IS NULL AND "claimedAt" IS NULL AND "heartbeatAt" IS NULL AND "expiresAt" IS NULL)
    OR ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL AND julianday("expiresAt") <= julianday(CURRENT_TIMESTAMP)))`,
	postgresql: `UPDATE "history_collection_leases"
SET "claimToken" = $1, "claimedAt" = CURRENT_TIMESTAMP,
    "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '300 seconds',
    "lastAttemptAt" = CURRENT_TIMESTAMP, "lastAttemptResult" = $2,
    "lastAttemptReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $3
  AND (("claimToken" IS NULL AND "claimedAt" IS NULL AND "heartbeatAt" IS NULL AND "expiresAt" IS NULL)
    OR ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL AND "expiresAt" <= CURRENT_TIMESTAMP))`,
} as const;

const HEARTBEAT_LEASE_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = datetime(CURRENT_TIMESTAMP, '+300 seconds'),
    "nextSourceCursor" = ?, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ? AND "claimToken" = ?
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND julianday("expiresAt") > julianday(CURRENT_TIMESTAMP)`,
	postgresql: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '300 seconds',
    "nextSourceCursor" = $1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $2 AND "claimToken" = $3
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND "expiresAt" > CURRENT_TIMESTAMP`,
} as const;

const HEARTBEAT_PRESERVE_CURSOR_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = datetime(CURRENT_TIMESTAMP, '+300 seconds'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ? AND "claimToken" = ?
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND julianday("expiresAt") > julianday(CURRENT_TIMESTAMP)`,
	postgresql: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '300 seconds',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $1 AND "claimToken" = $2
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND "expiresAt" > CURRENT_TIMESTAMP`,
} as const;

const RELEASE_LEASE_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "claimToken" = NULL, "claimedAt" = NULL, "heartbeatAt" = NULL,
    "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ? AND "claimToken" = ?
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL`,
	postgresql: `UPDATE "history_collection_leases"
SET "claimToken" = NULL, "claimedAt" = NULL, "heartbeatAt" = NULL,
    "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $1 AND "claimToken" = $2
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL`,
} as const;

const FENCE_LEASE_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = datetime(CURRENT_TIMESTAMP, '+300 seconds'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ? AND "claimToken" = ?
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND julianday("expiresAt") > julianday(CURRENT_TIMESTAMP)`,
	postgresql: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '300 seconds',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $1 AND "claimToken" = $2
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND "expiresAt" > CURRENT_TIMESTAMP`,
} as const;

const FENCE_LEASE_WITH_CURSOR_SQL = {
	sqlite: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = datetime(CURRENT_TIMESTAMP, '+300 seconds'),
    "nextSourceCursor" = ?, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = ? AND "claimToken" = ?
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND julianday("expiresAt") > julianday(CURRENT_TIMESTAMP)`,
	postgresql: `UPDATE "history_collection_leases"
SET "heartbeatAt" = CURRENT_TIMESTAMP,
    "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '300 seconds',
    "nextSourceCursor" = $1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" = $2 AND "claimToken" = $3
  AND "claimedAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "expiresAt" IS NOT NULL
  AND "expiresAt" > CURRENT_TIMESTAMP`,
} as const;

class HistoryLeaseMalformedError extends Error {}
class HistoryLeaseLostError extends Error {}
class HistoryLeaseActionError extends Error {
	readonly code: string | undefined;
	readonly retryable: boolean;

	constructor(error: unknown) {
		super("History collection action failed");
		this.name = "HistoryLeaseActionError";
		this.code = findSafeRetryCode(error);
		this.retryable = isRetryableError(error);
	}
}

export async function acquireHistoryCollectionLease(
	prisma: LeasePrisma,
	userId: string,
	options: HistoryCollectionLeaseOptions = {},
): Promise<HistoryCollectionLeaseClaim | null> {
	if (!isSafeIdentifier(userId)) return null;
	const dialect = resolveDialect(options.dialect);
	const claimToken = randomUUID();
	try {
		return await runSerializableTransaction(prisma, async (tx) => {
			await tx.$executeRawUnsafe(INSERT_LEASE_SQL[dialect], userId);
			const changed = await tx.$executeRawUnsafe(
				ACQUIRE_LEASE_SQL[dialect],
				claimToken,
				"in_progress",
				userId,
			);
			if (changed !== 1) return null;
			const rows = await tx.$queryRawUnsafe<LeaseRow[]>(SELECT_LEASE_SQL[dialect], userId);
			const claim = parseClaim(rows[0], userId, claimToken);
			if (!claim) throw new HistoryLeaseMalformedError();
			return claim;
		});
	} catch (error) {
		if (error instanceof HistoryLeaseMalformedError) return null;
		throw safeLeaseDatabaseError(error);
	}
}

export async function heartbeatHistoryCollectionLease(
	prisma: LeasePrisma,
	claim: Pick<HistoryCollectionLeaseClaim, "userId" | "claimToken">,
	nextSourceCursor?: string | null,
	options: HistoryCollectionLeaseOptions = {},
): Promise<boolean> {
	if (
		!isValidClaim(claim) ||
		(nextSourceCursor !== undefined && !isValidCursor(nextSourceCursor))
	) {
		return false;
	}
	const dialect = resolveDialect(options.dialect);
	try {
		const changed =
			nextSourceCursor === undefined
				? await prisma.$executeRawUnsafe(
						HEARTBEAT_PRESERVE_CURSOR_SQL[dialect],
						claim.userId,
						claim.claimToken,
					)
				: await prisma.$executeRawUnsafe(
						HEARTBEAT_LEASE_SQL[dialect],
						nextSourceCursor,
						claim.userId,
						claim.claimToken,
					);
		return changed === 1;
	} catch (error) {
		throw safeLeaseDatabaseError(error);
	}
}

export async function releaseHistoryCollectionLease(
	prisma: LeasePrisma,
	claim: Pick<HistoryCollectionLeaseClaim, "userId" | "claimToken">,
	options: HistoryCollectionLeaseOptions = {},
): Promise<boolean> {
	if (!isValidClaim(claim)) return false;
	const dialect = resolveDialect(options.dialect);
	try {
		const changed = await prisma.$executeRawUnsafe(
			RELEASE_LEASE_SQL[dialect],
			claim.userId,
			claim.claimToken,
		);
		return changed === 1;
	} catch (error) {
		throw safeLeaseDatabaseError(error);
	}
}

export async function withHistoryCollectionLeaseAuthority<T>(
	prisma: LeasePrisma,
	claim: Pick<HistoryCollectionLeaseClaim, "userId" | "claimToken">,
	action: (tx: LeaseTransaction) => Promise<T>,
	options: HistoryCollectionLeaseOptions = {},
): Promise<{ matched: true; value: T } | { matched: false }> {
	if (!isValidClaim(claim)) return { matched: false };
	const dialect = resolveDialect(options.dialect);
	const persistCursor = options.nextSourceCursor !== undefined;
	if (persistCursor && !isValidCursor(options.nextSourceCursor ?? null)) return { matched: false };
	try {
		return await runSerializableTransaction(prisma, async (tx) => {
			const initial = await tx.$executeRawUnsafe(
				FENCE_LEASE_SQL[dialect],
				claim.userId,
				claim.claimToken,
			);
			if (initial !== 1) return { matched: false };
			let value: T;
			try {
				value = await action(tx);
			} catch (error) {
				throw new HistoryLeaseActionError(error);
			}
			const final = persistCursor
				? await tx.$executeRawUnsafe(
						FENCE_LEASE_WITH_CURSOR_SQL[dialect],
						options.nextSourceCursor,
						claim.userId,
						claim.claimToken,
					)
				: await tx.$executeRawUnsafe(FENCE_LEASE_SQL[dialect], claim.userId, claim.claimToken);
			if (final !== 1) throw new HistoryLeaseLostError();
			return { matched: true, value };
		});
	} catch (error) {
		if (error instanceof HistoryLeaseLostError) return { matched: false };
		throw error;
	}
}

async function runSerializableTransaction<T>(
	prisma: LeasePrisma,
	action: (tx: LeaseTransaction) => Promise<T>,
): Promise<T> {
	for (let attempt = 1; attempt <= HISTORY_COLLECTION_LEASE_TRANSACTION_ATTEMPTS; attempt += 1) {
		try {
			return await prisma.$transaction(async (tx) => await action(tx as LeaseTransaction), {
				isolationLevel: "Serializable",
				timeout: HISTORY_COLLECTION_LEASE_TRANSACTION_TIMEOUT_MS,
			});
		} catch (error) {
			if (error instanceof HistoryLeaseMalformedError || error instanceof HistoryLeaseLostError) {
				throw error;
			}
			const retryable =
				error instanceof HistoryLeaseActionError ? error.retryable : isRetryableError(error);
			if (!retryable || attempt === HISTORY_COLLECTION_LEASE_TRANSACTION_ATTEMPTS) {
				throw error instanceof HistoryLeaseActionError ? error : safeLeaseDatabaseError(error);
			}
			await boundedRetryDelay(attempt);
		}
	}
	throw new Error("History lease transaction did not complete");
}

function safeLeaseDatabaseError(error: unknown): Error {
	const safe = new Error("History collection lease database operation failed");
	const code = findSafeRetryCode(error);
	if (code) {
		Object.defineProperty(safe, "code", {
			value: code,
			enumerable: true,
		});
	}
	return safe;
}

async function boundedRetryDelay(attempt: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
}

function parseClaim(
	row: LeaseRow | undefined,
	userId: string,
	claimToken: string,
): HistoryCollectionLeaseClaim | null {
	if (!row || row.userId !== userId || row.claimToken !== claimToken) return null;
	const claimedAt = parseDatabaseDate(row.claimedAt);
	const heartbeatAt = parseDatabaseDate(row.heartbeatAt);
	const expiresAt = parseDatabaseDate(row.expiresAt);
	if (
		!claimedAt ||
		!heartbeatAt ||
		!expiresAt ||
		!isValidCursor(row.nextSourceCursor as string | null)
	)
		return null;
	return {
		userId,
		claimToken,
		claimedAt,
		heartbeatAt,
		expiresAt,
		nextSourceCursor: row.nextSourceCursor as string | null,
	};
}

function parseDatabaseDate(value: unknown): Date | null {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const date = new Date(normalized);
	return Number.isFinite(date.getTime()) ? date : null;
}

function isValidCursor(cursor: string | null): cursor is string | null {
	if (cursor === null) return true;
	if (typeof cursor !== "string" || cursor.length === 0 || containsControl(cursor)) return false;
	return Buffer.byteLength(cursor, "utf8") <= HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES;
}

function isValidClaim(claim: Pick<HistoryCollectionLeaseClaim, "userId" | "claimToken">): boolean {
	return isSafeIdentifier(claim.userId) && isSafeToken(claim.claimToken);
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!containsControl(value) &&
		Buffer.byteLength(value, "utf8") <= HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES
	);
}

function isSafeToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!containsControl(value) &&
		Buffer.byteLength(value, "utf8") <= HISTORY_COLLECTION_LEASE_TOKEN_MAX_BYTES
	);
}

function containsControl(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function resolveDialect(dialect?: HistoryLeaseDialect): HistoryLeaseDialect {
	if (dialect) return dialect;
	return /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL ?? "") ? "postgresql" : "sqlite";
}

function findSafeRetryCode(error: unknown): string | undefined {
	const pending: unknown[] = [error];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
		visited.add(candidate);
		const record = candidate as Record<string, unknown>;
		for (const code of [record.code, record.originalCode, record.sqlState, record.sqlstate]) {
			if (
				code === "P2034" ||
				code === "40001" ||
				code === "SQLITE_BUSY" ||
				code === "SQLITE_LOCKED"
			) {
				return code;
			}
		}
		for (const key of ["cause", "original", "originalError", "error", "errors", "meta"]) {
			const nested = record[key];
			if (Array.isArray(nested)) pending.push(...nested);
			else if (nested && typeof nested === "object") pending.push(nested);
		}
	}
	return undefined;
}

function isRetryableError(error: unknown): boolean {
	if (findSafeRetryCode(error)) return true;
	const pending: unknown[] = [error];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
		visited.add(candidate);
		const record = candidate as Record<string, unknown>;
		const message = [record.message, record.kind]
			.filter((value): value is string => typeof value === "string")
			.join(" ");
		const retryableMessage =
			/\bserialization (?:failure|conflict|error)\b|\bdeadlock(?: detected| found)?\b|\bdatabase(?: is)?[- ]locked\b|\btransaction[- ]write[- ]conflict\b/i.test(
				message,
			);
		const negatedRetryableMessage =
			/\bnot (?:a |an )?(?:serialization (?:failure|conflict|error)|deadlock(?: detected| found)?|database(?: is)?[- ]locked|transaction[- ]write[- ]conflict)\b/i.test(
				message,
			);
		if (retryableMessage && !negatedRetryableMessage) return true;
		for (const key of ["cause", "original", "originalError", "error", "errors", "meta"]) {
			const nested = record[key];
			if (Array.isArray(nested)) pending.push(...nested);
			else if (nested && typeof nested === "object") pending.push(nested);
		}
	}
	return false;
}
