import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../prisma.js";
import {
	createProviderPublicationAuthority,
	ProviderIdentityGuardError,
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import {
	hasNativeInventoryExternalIds,
	mergeNativeInventoryExternalIds,
	type NativeInventoryDomain,
	NativeInventoryInputError,
	type NativeInventoryRow,
	validateNativeInventoryRow,
} from "./native-inventory.js";

export type NativeInventoryWorkKey = "library" | "episode" | "paired";

const ADMISSION_ATTEMPTS = 3;
// A slice has a hard 60-second budget. Leave another minute for a slow final
// transaction while bounding crash/contention recovery for an abandoned claim.
const CLAIM_LEASE_MS = 2 * 60_000;
const LEASE_OPERATION_ATTEMPTS = 6;
const MAX_NATIVE_PAGE_ITEMS = 2_000;
const NATIVE_PAGE_DB_CHUNK_ITEMS = 500;

function* pageChunks<T>(items: readonly T[]): Generator<readonly T[]> {
	for (let index = 0; index < items.length; index += NATIVE_PAGE_DB_CHUNK_ITEMS) {
		yield items.slice(index, index + NATIVE_PAGE_DB_CHUNK_ITEMS);
	}
}

export type NativeInventoryRunClaim = {
	runId: string;
	workKey: NativeInventoryWorkKey;
	passOrdinal: number;
	token: string;
	leaseUntil: Date;
	connectionGeneration: number;
	identityGeneration: number;
};

export type NativeInventoryClaimResult =
	| { status: "acquired"; claim: NativeInventoryRunClaim }
	| { status: "coalesced" | "superseded" | "retryable" };

export type NativeInventoryPageReceiptInput = {
	domain: NativeInventoryDomain;
	scopeKey: string;
	pageKey: string;
	nextCursor: string | null;
	isLast: boolean;
	expectedRawCount: number;
	rawNativeIds: readonly string[];
	comparisonKeys: readonly (string | null)[];
};

export type NativeInventoryScopeManifest = {
	catalogIdentity: string;
	domains: readonly { domain: NativeInventoryDomain; scopeKeys: readonly string[] }[];
};

class NativeInventoryPageConflictError extends Error {}

function isRetryableAdmissionConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = "code" in error ? error.code : undefined;
	return (
		code === "P1008" ||
		code === "P2002" ||
		code === "P2028" ||
		code === "P2034" ||
		code === "SQLITE_BUSY" ||
		code === "SQLITE_LOCKED"
	);
}

/** Only retained native lock provenance permits a non-failure inventory yield. */
export function isNativeInventoryDatabaseContention(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = "code" in error ? error.code : undefined;
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	if (code !== "P1008" || !("meta" in error)) return false;
	const meta = error.meta;
	if (!meta || typeof meta !== "object" || !("driverAdapterError" in meta)) return false;
	const adapter = meta.driverAdapterError;
	if (!adapter || typeof adapter !== "object" || !("cause" in adapter)) return false;
	const cause = adapter.cause;
	if (!cause || typeof cause !== "object" || !("originalCode" in cause)) return false;
	return cause.originalCode === "SQLITE_BUSY" || cause.originalCode === "SQLITE_LOCKED";
}

function normalizeScopeManifest(
	workKey: NativeInventoryWorkKey,
	manifest: NativeInventoryScopeManifest,
): { scopeManifest: string; scopeDigest: string } | null {
	if (
		!manifest ||
		typeof manifest.catalogIdentity !== "string" ||
		manifest.catalogIdentity.length === 0 ||
		manifest.catalogIdentity.length > 8192 ||
		manifest.catalogIdentity.includes("\0") ||
		!Array.isArray(manifest.domains)
	) {
		return null;
	}
	const expectedDomains = workKey === "paired" ? ["library", "episode"] : [workKey];
	if (manifest.domains.length !== expectedDomains.length) return null;
	const domains = manifest.domains
		.map(({ domain, scopeKeys }) => {
			if (
				!expectedDomains.includes(domain) ||
				!Array.isArray(scopeKeys) ||
				scopeKeys.length > 10_000 ||
				scopeKeys.some(
					(scopeKey) =>
						typeof scopeKey !== "string" ||
						scopeKey.length === 0 ||
						scopeKey.length > 512 ||
						scopeKey.includes("\0"),
				) ||
				new Set(scopeKeys).size !== scopeKeys.length
			) {
				return null;
			}
			return { domain, scopeKeys: [...scopeKeys].sort() };
		})
		.sort((left, right) => (left?.domain ?? "").localeCompare(right?.domain ?? ""));
	if (domains.some((domain) => domain === null)) return null;
	if (new Set(domains.map((domain) => domain?.domain)).size !== expectedDomains.length) return null;
	const scopeManifest = JSON.stringify(domains);
	const scopeDigest = createHash("sha256")
		.update(JSON.stringify([manifest.catalogIdentity, domains]))
		.digest("hex");
	return { scopeManifest, scopeDigest };
}

function manifestContainsScope(
	serialized: string | null,
	domain: NativeInventoryDomain,
	scopeKey: string,
): boolean {
	if (!serialized) return false;
	try {
		const manifest = JSON.parse(serialized) as unknown;
		return (
			Array.isArray(manifest) &&
			manifest.some(
				(entry) =>
					entry &&
					typeof entry === "object" &&
					entry.domain === domain &&
					Array.isArray(entry.scopeKeys) &&
					entry.scopeKeys.includes(scopeKey),
			)
		);
	} catch {
		return false;
	}
}

export async function admitNativeInventoryRun(
	prisma: PrismaClient,
	authority: ProviderPublicationAuthority,
	workKey: NativeInventoryWorkKey,
	now: Date,
): Promise<{ status: "acquired" | "coalesced" | "superseded" | "retryable" }> {
	if (
		!Number.isFinite(now.getTime()) ||
		(workKey === "paired" ? authority.service !== "PLEX" : authority.service === "PLEX")
	) {
		return { status: "superseded" };
	}
	const activeSlotKey = JSON.stringify([authority.id, workKey]);
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const existing = await tx.providerNativeInventoryRun.findUnique({
						where: { activeSlotKey },
						select: { id: true, connectionGeneration: true, identityGeneration: true },
					});
					if (existing) {
						if (
							existing.connectionGeneration === authority.connectionGeneration &&
							existing.identityGeneration === authority.identityGeneration
						) {
							return { status: "coalesced" } as const;
						}
						await tx.providerNativeInventoryRun.update({
							where: { id: existing.id },
							data: {
								state: "superseded",
								activeSlotKey: null,
								claimToken: null,
								leaseUntil: null,
								nextAttemptAt: null,
							},
						});
					}
					await tx.providerNativeInventoryRun.create({
						data: {
							instanceId: authority.id,
							workKey,
							connectionGeneration: authority.connectionGeneration,
							identityGeneration: authority.identityGeneration,
							state: "pending",
							activeSlotKey,
							createdAt: now,
						},
					});
					return { status: "acquired" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Claim a persisted run without taking provider I/O into the transaction. */
export async function claimDueNativeInventoryRun(
	prisma: PrismaClient,
	runId: string,
	now: Date,
): Promise<NativeInventoryClaimResult> {
	if (!runId || !Number.isFinite(now.getTime())) return { status: "superseded" };
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: runId },
				include: { instance: true },
			});
			if (!run) return { status: "superseded" };
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				run.connectionGeneration !== authority.connectionGeneration ||
				run.identityGeneration !== authority.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({ where: { id: runId } });
					if (
						!current ||
						current.connectionGeneration !== authority.connectionGeneration ||
						current.identityGeneration !== authority.identityGeneration ||
						current.activeSlotKey === null
					) {
						return { status: "superseded" } as const;
					}
					if (
						(current.leaseUntil && current.leaseUntil > now) ||
						(current.nextAttemptAt && current.nextAttemptAt > now)
					) {
						return { status: "coalesced" } as const;
					}
					const token = randomUUID();
					const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
					const updated = await tx.providerNativeInventoryRun.updateMany({
						where: {
							id: runId,
							activeSlotKey: current.activeSlotKey,
							claimToken: current.claimToken,
							leaseUntil: current.leaseUntil,
						},
						data: { state: "running", claimToken: token, leaseUntil, nextAttemptAt: null },
					});
					if (updated.count !== 1) return { status: "coalesced" } as const;
					return {
						status: "acquired",
						claim: {
							runId,
							workKey: current.workKey as NativeInventoryWorkKey,
							passOrdinal: current.passOrdinal,
							token,
							leaseUntil,
							connectionGeneration: current.connectionGeneration,
							identityGeneration: current.identityGeneration,
						},
					} as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Extend a live lease without changing its fencing token or pass ordinal. */
export async function renewNativeInventoryRunLease(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	now: Date,
): Promise<
	{ status: "renewed"; claim: NativeInventoryRunClaim } | { status: "superseded" | "retryable" }
> {
	if (!Number.isFinite(now.getTime())) return { status: "retryable" };
	for (let attempt = 1; attempt <= LEASE_OPERATION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						!(current.state === "running" || current.state === "ready") ||
						current.activeSlotKey === null ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
					const updated = await tx.providerNativeInventoryRun.updateMany({
						where: {
							id: claim.runId,
							claimToken: claim.token,
							leaseUntil: current.leaseUntil,
						},
						data: { leaseUntil },
					});
					return updated.count === 1
						? ({ status: "renewed", claim: { ...claim, leaseUntil } } as const)
						: ({ status: "superseded" } as const);
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === LEASE_OPERATION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Release a healthy claim at a page budget boundary for immediate same-pass recovery. */
export async function yieldNativeInventoryRun(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	now: Date,
): Promise<{ status: "yielded" | "superseded" | "retryable" }> {
	if (!Number.isFinite(now.getTime())) return { status: "retryable" };
	for (let attempt = 1; attempt <= LEASE_OPERATION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						!(current.state === "running" || current.state === "ready") ||
						current.activeSlotKey === null ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					await tx.providerNativeInventoryRun.update({
						where: { id: claim.runId },
						data: { state: "pending", claimToken: null, leaseUntil: null, nextAttemptAt: null },
					});
					return { status: "yielded" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === LEASE_OPERATION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

export type NativeInventoryFailureCategory =
	| "provider-unavailable"
	| "coverage-incomplete"
	| "deadline-exceeded"
	| "database-retryable"
	| "budget-exhausted";

/** Release a failed claim but keep every compatible completed page for the next worker. */
export async function failNativeInventoryRun(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	reason: NativeInventoryFailureCategory,
	nextAttemptAt: Date | null,
	now: Date,
): Promise<{ status: "scheduled" | "incomplete" | "superseded" | "retryable" }> {
	if (
		!Number.isFinite(now.getTime()) ||
		(nextAttemptAt !== null &&
			(!Number.isFinite(nextAttemptAt.getTime()) ||
				nextAttemptAt < now ||
				nextAttemptAt.getTime() - now.getTime() > 60 * 60_000)) ||
		![
			"provider-unavailable",
			"coverage-incomplete",
			"deadline-exceeded",
			"database-retryable",
			"budget-exhausted",
		].includes(reason)
	) {
		return { status: "retryable" };
	}
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						!(current.state === "running" || current.state === "ready") ||
						current.activeSlotKey === null ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const retry = nextAttemptAt !== null;
					await tx.providerNativeInventoryRun.update({
						where: { id: claim.runId },
						data: {
							state: retry ? "pending" : "incomplete",
							activeSlotKey: retry ? current.activeSlotKey : null,
							claimToken: null,
							leaseUntil: null,
							nextAttemptAt,
							lastFailureCategory: reason,
							failureCount: { increment: 1 },
						},
					});
					return { status: retry ? "scheduled" : "incomplete" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Persist the exact discovered scopes before admitting any page of this pass. */
export async function beginNativeInventoryPass(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	manifest: NativeInventoryScopeManifest,
	now: Date,
): Promise<{ status: "recorded" | "coalesced" | "superseded" | "retryable" | "contended" }> {
	const normalized = normalizeScopeManifest(claim.workKey, manifest);
	if (!normalized || !Number.isFinite(now.getTime())) return { status: "retryable" };
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						current.state !== "running" ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const existing = await tx.providerNativeInventoryPass.findUnique({
						where: { runId_ordinal: { runId: claim.runId, ordinal: claim.passOrdinal } },
					});
					if (existing) {
						return existing.state === "collecting" &&
							existing.scopeManifest === normalized.scopeManifest &&
							existing.scopeDigest === normalized.scopeDigest
							? ({ status: "coalesced" } as const)
							: ({ status: "retryable" } as const);
					}
					await tx.providerNativeInventoryPass.create({
						data: {
							runId: claim.runId,
							ordinal: claim.passOrdinal,
							scopeManifest: normalized.scopeManifest,
							scopeDigest: normalized.scopeDigest,
						},
					});
					return { status: "recorded" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS)
				return { status: isNativeInventoryDatabaseContention(error) ? "contended" : "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Atomically stage one provider page and its restart receipt under a live claim. */
export async function commitNativeInventoryPage(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	receipt: NativeInventoryPageReceiptInput,
	rows: readonly NativeInventoryRow[],
	now: Date,
): Promise<{
	status: "recorded" | "coalesced" | "superseded" | "retryable" | "contended" | "drifted";
}> {
	const startIndex = Number(receipt.pageKey);
	const rawCount = receipt.rawNativeIds?.length ?? -1;
	const endIndex = startIndex + rawCount;
	if (
		!Number.isFinite(now.getTime()) ||
		!claim.runId ||
		!claim.token ||
		!Number.isSafeInteger(claim.passOrdinal) ||
		claim.passOrdinal < 1 ||
		(receipt.domain !== "library" && receipt.domain !== "episode") ||
		(claim.workKey !== "paired" && claim.workKey !== receipt.domain) ||
		!receipt.scopeKey ||
		!receipt.pageKey ||
		receipt.scopeKey.length > 512 ||
		receipt.pageKey.length > 512 ||
		!Number.isSafeInteger(startIndex) ||
		startIndex < 0 ||
		String(startIndex) !== receipt.pageKey ||
		!Number.isSafeInteger(receipt.expectedRawCount) ||
		receipt.expectedRawCount < 0 ||
		!Array.isArray(receipt.rawNativeIds) ||
		receipt.rawNativeIds.length > MAX_NATIVE_PAGE_ITEMS ||
		!Array.isArray(receipt.comparisonKeys) ||
		receipt.comparisonKeys.length !== receipt.rawNativeIds.length ||
		receipt.comparisonKeys.some(
			(key) =>
				key !== null &&
				(typeof key !== "string" || key.length === 0 || key.length > 2048 || key.includes("\0")),
		) ||
		!Number.isSafeInteger(endIndex) ||
		endIndex > receipt.expectedRawCount ||
		(receipt.isLast ? endIndex !== receipt.expectedRawCount : rawCount === 0) ||
		(!receipt.isLast && receipt.nextCursor !== String(endIndex)) ||
		receipt.rawNativeIds.some(
			(nativeId) => typeof nativeId !== "string" || nativeId.length === 0 || nativeId.length > 1024,
		) ||
		new Set(receipt.rawNativeIds).size !== receipt.rawNativeIds.length ||
		(receipt.nextCursor !== null && receipt.nextCursor.length > 512) ||
		(receipt.isLast && receipt.nextCursor !== null) ||
		!Array.isArray(rows) ||
		rows.length > MAX_NATIVE_PAGE_ITEMS
	) {
		return { status: "retryable" };
	}
	let normalizedRows: NativeInventoryRow[];
	try {
		normalizedRows = rows.map((row) => validateNativeInventoryRow(row, receipt.domain));
		if (normalizedRows.some((row) => !receipt.rawNativeIds.includes(row.nativeId))) {
			return { status: "retryable" };
		}
		if (
			normalizedRows.some(
				(row) => receipt.comparisonKeys[receipt.rawNativeIds.indexOf(row.nativeId)] === null,
			)
		) {
			return { status: "retryable" };
		}
		if (new Set(normalizedRows.map((row) => row.nativeId)).size !== normalizedRows.length) {
			return { status: "retryable" };
		}
		const stagedIds = new Set(normalizedRows.map((row) => row.nativeId));
		if (
			receipt.rawNativeIds.some(
				(nativeId, index) => (receipt.comparisonKeys[index] !== null) !== stagedIds.has(nativeId),
			)
		) {
			return { status: "retryable" };
		}
	} catch (error) {
		if (error instanceof NativeInventoryInputError) return { status: "retryable" };
		throw error;
	}
	const contentHash = createHash("sha256")
		.update(
			JSON.stringify([
				receipt.expectedRawCount,
				receipt.rawNativeIds,
				receipt.comparisonKeys,
				normalizedRows,
			]),
		)
		.digest("hex");
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			if (authority.service !== "JELLYFIN" && rawCount > NATIVE_PAGE_DB_CHUNK_ITEMS) {
				return { status: "retryable" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						current.state !== "running" ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const pass = await tx.providerNativeInventoryPass.findUnique({
						where: { runId_ordinal: { runId: claim.runId, ordinal: claim.passOrdinal } },
					});
					if (
						!pass ||
						pass.state !== "collecting" ||
						!pass.scopeDigest ||
						!manifestContainsScope(pass.scopeManifest, receipt.domain, receipt.scopeKey)
					) {
						return { status: "retryable" } as const;
					}
					const existingReceipt = await tx.providerNativeInventoryPageReceipt.findUnique({
						where: {
							passId_domain_scopeKey_pageKey: {
								passId: pass.id,
								domain: receipt.domain,
								scopeKey: receipt.scopeKey,
								pageKey: receipt.pageKey,
							},
						},
					});
					if (existingReceipt) {
						if (
							existingReceipt.contentHash !== contentHash ||
							existingReceipt.startIndex !== startIndex ||
							existingReceipt.expectedRawCount !== receipt.expectedRawCount ||
							existingReceipt.rawCount !== rawCount ||
							existingReceipt.rowCount !== normalizedRows.length ||
							existingReceipt.nextCursor !== receipt.nextCursor ||
							existingReceipt.isLast !== receipt.isLast
						) {
							throw new NativeInventoryPageConflictError();
						}
						return { status: "coalesced" } as const;
					}
					const priorReceipt = await tx.providerNativeInventoryPageReceipt.findFirst({
						where: { passId: pass.id, domain: receipt.domain, scopeKey: receipt.scopeKey },
						orderBy: { startIndex: "desc" },
					});
					if (
						(priorReceipt === null && startIndex !== 0) ||
						(priorReceipt !== null &&
							(priorReceipt.isLast || priorReceipt.nextCursor !== receipt.pageKey))
					) {
						throw new NativeInventoryPageConflictError();
					}
					if (priorReceipt && priorReceipt.expectedRawCount !== receipt.expectedRawCount) {
						// This pass cannot resume: its committed total belongs to a different
						// inventory. Keep all evidence intact for a fresh, fully verified run.
						return { status: "drifted" } as const;
					}
					for (const nativeIds of pageChunks(receipt.rawNativeIds)) {
						const repeatedRawIds = await tx.providerNativeInventorySeenItem.findMany({
							where: {
								passId: pass.id,
								nativeId: { in: [...nativeIds] },
								...(authority.service === "PLEX"
									? {}
									: { domain: receipt.domain, scopeKey: receipt.scopeKey }),
							},
							select: { id: true },
						});
						if (repeatedRawIds.length) throw new NativeInventoryPageConflictError();
					}
					const existingItems = [];
					for (const nativeIds of pageChunks(normalizedRows.map((row) => row.nativeId))) {
						existingItems.push(
							...(await tx.providerNativeInventoryStageItem.findMany({
								where: {
									passId: pass.id,
									nativeId: { in: [...nativeIds] },
									...(authority.service === "PLEX" ? {} : { domain: receipt.domain }),
								},
							})),
						);
					}
					if (authority.service === "PLEX" && existingItems.length > 0) {
						throw new NativeInventoryPageConflictError();
					}
					const existingByNativeId = new Map(existingItems.map((item) => [item.nativeId, item]));
					const newItems: Array<{
						passId: string;
						domain: NativeInventoryDomain;
						nativeId: string;
						mediaType: NativeInventoryRow["mediaType"];
						libraryIds: string;
						parentNativeId: string | null;
						seasonNumber: number | null;
						episodeNumber: number | null;
						title: string;
						externalIds: string | null;
					}> = [];
					for (const row of normalizedRows) {
						const existing = existingByNativeId.get(row.nativeId);
						const externalIds = row.externalIds ? JSON.stringify(row.externalIds) : null;
						if (existing) {
							if (existing.mediaType !== row.mediaType) {
								throw new NativeInventoryPageConflictError();
							}
							const libraryIds = [
								...new Set([...JSON.parse(existing.libraryIds), ...row.libraryIds]),
							].sort();
							const sameCoordinate =
								existing.parentNativeId === row.parentNativeId &&
								existing.seasonNumber === row.seasonNumber &&
								existing.episodeNumber === row.episodeNumber;
							const mergedExternalIds = mergeNativeInventoryExternalIds(
								existing.externalIds ? JSON.parse(existing.externalIds) : undefined,
								row.externalIds,
							);
							await tx.providerNativeInventoryStageItem.update({
								where: { id: existing.id },
								data: {
									libraryIds: JSON.stringify(libraryIds),
									title: receipt.domain === "episode" ? row.title || existing.title : row.title,
									parentNativeId: sameCoordinate ? existing.parentNativeId : null,
									seasonNumber: sameCoordinate ? existing.seasonNumber : null,
									episodeNumber: sameCoordinate ? existing.episodeNumber : null,
									externalIds: hasNativeInventoryExternalIds(mergedExternalIds)
										? JSON.stringify(mergedExternalIds)
										: null,
								},
							});
						} else {
							newItems.push({
								passId: pass.id,
								domain: receipt.domain,
								nativeId: row.nativeId,
								mediaType: row.mediaType,
								libraryIds: JSON.stringify(row.libraryIds),
								parentNativeId: row.parentNativeId,
								seasonNumber: row.seasonNumber,
								episodeNumber: row.episodeNumber,
								title: row.title,
								externalIds,
							});
						}
					}
					if (newItems.length > 0) {
						for (const chunk of pageChunks(newItems)) {
							const inserted = await tx.providerNativeInventoryStageItem.createMany({
								data: [...chunk],
							});
							if (inserted.count !== chunk.length) throw new NativeInventoryPageConflictError();
						}
					}
					if (receipt.rawNativeIds.length) {
						const seenRows = receipt.rawNativeIds.map((nativeId, index) => ({
							passId: pass.id,
							domain: receipt.domain,
							scopeKey: receipt.scopeKey,
							nativeId,
							comparisonKey: receipt.comparisonKeys[index] ?? null,
						}));
						for (const chunk of pageChunks(seenRows)) {
							const inserted = await tx.providerNativeInventorySeenItem.createMany({
								data: [...chunk],
							});
							if (inserted.count !== chunk.length) throw new NativeInventoryPageConflictError();
						}
					}
					await tx.providerNativeInventoryPageReceipt.create({
						data: {
							passId: pass.id,
							domain: receipt.domain,
							scopeKey: receipt.scopeKey,
							pageKey: receipt.pageKey,
							startIndex,
							nextCursor: receipt.nextCursor,
							isLast: receipt.isLast,
							expectedRawCount: receipt.expectedRawCount,
							rawCount,
							rowCount: normalizedRows.length,
							contentHash,
						},
					});
					const advanced = await tx.providerNativeInventoryPass.updateMany({
						where: { id: pass.id, state: "collecting", pageRevision: pass.pageRevision },
						data: { pageRevision: { increment: 1 } },
					});
					if (advanced.count !== 1) throw new NativeInventoryPageConflictError();
					await tx.providerNativeInventoryRun.update({
						where: { id: claim.runId },
						data: { failureCount: 0, lastFailureCategory: null },
					});
					return { status: "recorded" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (error instanceof NativeInventoryPageConflictError) return { status: "retryable" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS)
				return { status: isNativeInventoryDatabaseContention(error) ? "contended" : "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Verify every manifested scope outside the short authority-guarded completion write. */
export async function completeNativeInventoryPass(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	endCatalogIdentity: string,
	now: Date,
): Promise<{ status: "completed" | "coalesced" | "superseded" | "retryable" | "contended" }> {
	if (
		!Number.isFinite(now.getTime()) ||
		typeof endCatalogIdentity !== "string" ||
		endCatalogIdentity.length === 0 ||
		endCatalogIdentity.length > 8192 ||
		endCatalogIdentity.includes("\0")
	) {
		return { status: "retryable" };
	}
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const pass = await prisma.providerNativeInventoryPass.findUnique({
				where: { runId_ordinal: { runId: claim.runId, ordinal: claim.passOrdinal } },
			});
			if (!pass?.scopeManifest || !pass.scopeDigest) return { status: "retryable" };
			let domains: Array<{ domain: NativeInventoryDomain; scopeKeys: string[] }>;
			try {
				domains = JSON.parse(pass.scopeManifest);
				if (!Array.isArray(domains)) return { status: "retryable" };
			} catch {
				return { status: "retryable" };
			}
			const endDigest = createHash("sha256")
				.update(JSON.stringify([endCatalogIdentity, domains]))
				.digest("hex");
			if (endDigest !== pass.scopeDigest) return { status: "retryable" };
			const comparisonHash = createHash("sha256");
			for (const { domain, scopeKeys } of domains) {
				for (const scopeKey of scopeKeys) {
					comparisonHash.update(JSON.stringify(["scope", domain, scopeKey]));
					const receipts = await prisma.providerNativeInventoryPageReceipt.findMany({
						where: { passId: pass.id, domain, scopeKey },
						orderBy: { startIndex: "asc" },
					});
					if (receipts.length === 0) return { status: "retryable" };
					let cursor = 0;
					let declaredTotal: number | null = null;
					for (const receipt of receipts) {
						if (
							receipt.startIndex !== cursor ||
							(declaredTotal !== null && receipt.expectedRawCount !== declaredTotal)
						) {
							return { status: "retryable" };
						}
						declaredTotal = receipt.expectedRawCount;
						cursor += receipt.rawCount;
						if (
							cursor > declaredTotal ||
							(receipt.isLast ? cursor !== declaredTotal : receipt.nextCursor !== String(cursor))
						) {
							return { status: "retryable" };
						}
					}
					if (!receipts[receipts.length - 1]?.isLast) return { status: "retryable" };
					let seenCount = 0;
					let afterNativeId: string | undefined;
					for (;;) {
						const seen = await prisma.providerNativeInventorySeenItem.findMany({
							where: {
								passId: pass.id,
								domain,
								scopeKey,
								...(afterNativeId ? { nativeId: { gt: afterNativeId } } : {}),
							},
							orderBy: { nativeId: "asc" },
							take: 500,
							select: { nativeId: true, comparisonKey: true },
						});
						for (const item of seen) {
							seenCount++;
							comparisonHash.update(JSON.stringify([item.nativeId, item.comparisonKey]));
						}
						if (seen.length < 500) break;
						afterNativeId = seen[seen.length - 1]?.nativeId;
					}
					if (seenCount !== declaredTotal) return { status: "retryable" };
				}
			}
			const comparisonDigest = comparisonHash.digest("hex");
			const libraryItemCount = domains.some((entry) => entry.domain === "library")
				? await prisma.providerNativeInventoryStageItem.count({
						where: { passId: pass.id, domain: "library" },
					})
				: null;
			const episodeItemCount = domains.some((entry) => entry.domain === "episode")
				? await prisma.providerNativeInventoryStageItem.count({
						where: { passId: pass.id, domain: "episode" },
					})
				: null;
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						current.state !== "running" ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const updated = await tx.providerNativeInventoryPass.updateMany({
						where: {
							id: pass.id,
							state: "collecting",
							pageRevision: pass.pageRevision,
							scopeDigest: pass.scopeDigest,
						},
						data: {
							state: "complete",
							completedAt: now,
							comparisonDigest,
							libraryItemCount,
							episodeItemCount,
						},
					});
					if (updated.count !== 1) return { status: "retryable" } as const;
					const advanced = await tx.providerNativeInventoryRun.updateMany({
						where: {
							id: claim.runId,
							state: "running",
							claimToken: claim.token,
							passOrdinal: claim.passOrdinal,
						},
						data:
							claim.passOrdinal === 1
								? {
										state: "pending",
										passOrdinal: 2,
										claimToken: null,
										leaseUntil: null,
										failureCount: 0,
										lastFailureCategory: null,
									}
								: { state: "ready", failureCount: 0, lastFailureCategory: null },
					});
					if (advanced.count !== 1) throw new NativeInventoryPageConflictError();
					return { status: "completed" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (error instanceof NativeInventoryPageConflictError) return { status: "retryable" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS)
				return { status: isNativeInventoryDatabaseContention(error) ? "contended" : "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

/** Switch published heads only after consecutive complete passes agree. */
export async function publishNativeInventoryRun(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	now: Date,
): Promise<{ status: "published" | "retryable" | "incomplete" | "superseded" }> {
	if (!Number.isFinite(now.getTime()) || claim.passOrdinal < 2 || claim.passOrdinal > 3) {
		return { status: "retryable" };
	}
	for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt++) {
		try {
			const run = await prisma.providerNativeInventoryRun.findUnique({
				where: { id: claim.runId },
				include: { instance: true },
			});
			if (!run || !["PLEX", "JELLYFIN", "EMBY"].includes(run.instance.service)) {
				return { status: "superseded" };
			}
			const authority = createProviderPublicationAuthority(run.instance);
			if (
				authority.connectionGeneration !== claim.connectionGeneration ||
				authority.identityGeneration !== claim.identityGeneration
			) {
				return { status: "superseded" };
			}
			const result = await withCurrentProviderPublicationAuthority(
				prisma,
				authority,
				async (tx) => {
					const current = await tx.providerNativeInventoryRun.findUnique({
						where: { id: claim.runId },
					});
					if (
						!current ||
						!(current.state === "ready" || current.state === "running") ||
						current.activeSlotKey === null ||
						current.claimToken !== claim.token ||
						!current.leaseUntil ||
						current.leaseUntil <= now ||
						current.passOrdinal !== claim.passOrdinal ||
						current.workKey !== claim.workKey ||
						current.connectionGeneration !== claim.connectionGeneration ||
						current.identityGeneration !== claim.identityGeneration
					) {
						return { status: "superseded" } as const;
					}
					const passes = await tx.providerNativeInventoryPass.findMany({
						where: {
							runId: claim.runId,
							ordinal: { in: [claim.passOrdinal - 1, claim.passOrdinal] },
						},
						orderBy: { ordinal: "asc" },
					});
					const [previous, finalPass] = passes;
					if (
						passes.length !== 2 ||
						previous?.ordinal !== claim.passOrdinal - 1 ||
						finalPass?.ordinal !== claim.passOrdinal ||
						previous.state !== "complete" ||
						finalPass.state !== "complete" ||
						!previous.scopeDigest ||
						!finalPass.scopeDigest ||
						!previous.comparisonDigest ||
						!finalPass.comparisonDigest ||
						!finalPass.scopeManifest
					) {
						return { status: "retryable" } as const;
					}
					if (
						previous.scopeDigest !== finalPass.scopeDigest ||
						previous.comparisonDigest !== finalPass.comparisonDigest
					) {
						const thirdAllowed = claim.passOrdinal === 2;
						await tx.providerNativeInventoryRun.update({
							where: { id: claim.runId },
							data: thirdAllowed
								? { state: "pending", passOrdinal: 3, claimToken: null, leaseUntil: null }
								: {
										state: "incomplete",
										activeSlotKey: null,
										claimToken: null,
										leaseUntil: null,
										lastFailureCategory: "coverage-incomplete",
									},
						});
						return { status: thirdAllowed ? "retryable" : "incomplete" } as const;
					}
					let parsedManifest: unknown;
					try {
						parsedManifest = JSON.parse(finalPass.scopeManifest);
					} catch {
						return { status: "retryable" } as const;
					}
					const domains: NativeInventoryDomain[] =
						claim.workKey === "paired" ? ["library", "episode"] : [claim.workKey];
					if (
						!Array.isArray(parsedManifest) ||
						parsedManifest.length !== domains.length ||
						parsedManifest.some(
							(entry) =>
								!entry ||
								typeof entry !== "object" ||
								!domains.includes(entry.domain) ||
								!Array.isArray(entry.scopeKeys) ||
								entry.scopeKeys.length > 10_000 ||
								entry.scopeKeys.some(
									(scopeKey: unknown) =>
										typeof scopeKey !== "string" ||
										scopeKey.length === 0 ||
										scopeKey.length > 512 ||
										scopeKey.includes("\0"),
								) ||
								new Set(entry.scopeKeys).size !== entry.scopeKeys.length,
						) ||
						new Set(parsedManifest.map((entry) => entry.domain)).size !== domains.length
					) {
						return { status: "retryable" } as const;
					}
					const manifest = parsedManifest as Array<{
						domain: NativeInventoryDomain;
						scopeKeys: string[];
					}>;
					const verifiedCounts: Array<{
						domain: NativeInventoryDomain;
						itemCount: number;
						scopeCount: number;
					}> = [];
					for (const domain of domains) {
						const expectedPrevious =
							domain === "library" ? previous.libraryItemCount : previous.episodeItemCount;
						const expectedFinal =
							domain === "library" ? finalPass.libraryItemCount : finalPass.episodeItemCount;
						if (
							expectedPrevious === null ||
							expectedFinal === null ||
							expectedPrevious !== expectedFinal
						) {
							return { status: "retryable" } as const;
						}
						const priorItemCount = await tx.providerNativeInventoryStageItem.count({
							where: { passId: previous.id, domain },
						});
						const itemCount = await tx.providerNativeInventoryStageItem.count({
							where: { passId: finalPass.id, domain },
						});
						if (priorItemCount !== expectedPrevious || itemCount !== expectedFinal) {
							return { status: "retryable" } as const;
						}
						verifiedCounts.push({
							domain,
							itemCount,
							scopeCount: manifest.find((entry) => entry.domain === domain)?.scopeKeys.length ?? 0,
						});
					}
					const generationId = randomUUID();
					for (const { domain, itemCount, scopeCount } of verifiedCounts) {
						const data = {
							generationId,
							publishedPassId: finalPass.id,
							observedAt: now,
							connectionGeneration: claim.connectionGeneration,
							identityGeneration: claim.identityGeneration,
							scopeDigest: finalPass.scopeDigest,
							contentDigest: finalPass.comparisonDigest,
							itemCount,
							scopeCount,
							lastAttemptAt: now,
							lastAttemptToken: null,
							lastAttemptResult: "success",
							lastAttemptReason: null,
						};
						await tx.providerNativeInventorySnapshot.upsert({
							where: { instanceId_domain: { instanceId: authority.id, domain } },
							create: { instanceId: authority.id, domain, ...data },
							update: data,
						});
					}
					await tx.providerNativeInventoryRun.update({
						where: { id: claim.runId },
						data: { state: "published", activeSlotKey: null, claimToken: null, leaseUntil: null },
					});
					return { status: "published" } as const;
				},
			);
			return result.matched ? result.value : { status: "superseded" };
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
			if (!isRetryableAdmissionConflict(error)) throw error;
			if (attempt === ADMISSION_ATTEMPTS) return { status: "retryable" };
			await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
		}
	}
	return { status: "retryable" };
}

export {
	previewNativeInventoryRetention,
	pruneNativeInventoryRetention,
} from "./native-inventory-retention.js";
