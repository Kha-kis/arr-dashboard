import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "../prisma.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import {
	ProviderIdentityGuardError,
	type OwnedProviderPublicationSnapshot,
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import {
	beginNativeInventoryAttemptInTransaction,
	failNativeInventoryAttemptInTransaction,
	type NativeInventoryAttempt,
	type NativeInventoryDomain,
	type NativeInventoryFailureReason,
	type NativeInventorySnapshotInput,
	publishNativeInventoriesInTransaction,
} from "./native-inventory.js";

const NATIVE_INVENTORY_PUBLICATION_TIMEOUT_MS = 60_000;

export type NativeInventoryCollectionResult =
	| { complete: true; snapshots: readonly NativeInventorySnapshotInput[] }
	| { complete: false; reason: "coverage-incomplete" | "provider-unavailable" };

export type NativeInventoryRefreshResult =
	| { status: "published" }
	| { status: "failed" }
	| { status: "superseded" };

export type NativeInventoryRefreshContext = {
	prisma: Pick<PrismaClient, "$transaction">;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
	cacheType: "plex" | "jellyfin";
	attempt: ProviderCacheRefreshAttempt;
	domains: readonly NativeInventoryDomain[];
	collect: (
		instance: OwnedProviderPublicationSnapshot,
		attempt: ProviderCacheRefreshAttempt,
	) => Promise<NativeInventoryCollectionResult>;
	cleanupRunClaimToken?: string;
};

/**
 * Refresh native presence as a companion to an already claimed canonical
 * provider refresh. Native rows have their own generation and attempt marker;
 * this helper never completes or otherwise mutates the canonical cache claim.
 */
export async function refreshNativeInventory(
	context: NativeInventoryRefreshContext,
): Promise<NativeInventoryRefreshResult> {
	if (!isValidContext(context)) return { status: "superseded" };

	const options =
		context.cleanupRunClaimToken !== undefined
			? {
					cleanupRunClaimToken: context.cleanupRunClaimToken,
					timeout: NATIVE_INVENTORY_PUBLICATION_TIMEOUT_MS,
				}
			: { timeout: NATIVE_INVENTORY_PUBLICATION_TIMEOUT_MS };

	let nativeAttempt: NativeInventoryAttempt;
	let nativeAuthority: ProviderPublicationAuthority;
	try {
		const admission = await withCurrentProviderPublicationAuthority(
			context.prisma,
			context.instance,
			async (tx) => {
				if (!(await hasCurrentCanonicalClaim(tx, context))) return null;
				const begun = await beginNativeInventoryAttemptInTransaction(tx, {
					userId: context.instance.userId,
					instance: publicationAuthority(context.instance),
					domains: context.domains,
					now: context.attempt.attemptedAt,
				});
				if (begun.status !== "acquired") return begun;
				return begun;
			},
			options,
		);
		if (!admission.matched || !admission.value || admission.value.status !== "acquired") {
			return { status: "superseded" };
		}
		nativeAttempt = admission.value.attempt;
		nativeAuthority = admission.value.authority;
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
		warnRefreshFailure(context.log, context.cacheType, "native_attempt_begin_failed");
		return { status: "failed" };
	}

	try {
		return await withGuardedProviderPublication(
			context.prisma,
			context.instance,
			context.log,
			async () => await context.collect(context.instance, context.attempt),
			async (tx, collected) => {
				if (!(await hasCurrentCanonicalClaim(tx, context))) {
					return { status: "superseded" };
				}
				if (!collected.complete) {
					return await recordFailureInTransaction(
						tx,
						context,
						nativeAuthority,
						nativeAttempt,
						collected.reason,
					);
				}
				const published = await publishNativeInventoriesInTransaction(tx, {
					userId: context.instance.userId,
					authority: nativeAuthority,
					attempt: nativeAttempt,
					snapshots: collected.snapshots,
				});
				return published.status === "published"
					? { status: "published" }
					: { status: "superseded" };
			},
			options,
		);
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") {
			return { status: "superseded" };
		}
		const reason: NativeInventoryFailureReason =
			error instanceof ProviderIdentityGuardError && error.code === "IDENTITY_MISMATCH"
				? "identity-changed"
				: "provider-unavailable";
		const failure = await recordNativeFailure(
			context,
			nativeAuthority,
			nativeAttempt,
			reason,
			options,
		);
		if (failure === "failed") {
			warnRefreshFailure(context.log, context.cacheType, "native_publication_failed");
		}
		return { status: failure };
	}
}

async function recordNativeFailure(
	context: NativeInventoryRefreshContext,
	authority: ProviderPublicationAuthority,
	attempt: NativeInventoryAttempt,
	reason: NativeInventoryFailureReason,
	options: { cleanupRunClaimToken?: string; timeout: number },
): Promise<"failed" | "superseded"> {
	try {
		const result = await withCurrentProviderPublicationAuthority(
			context.prisma,
			authority,
			async (tx) => {
				if (!(await hasCurrentCanonicalClaim(tx, context)))
					return { status: "superseded" } as const;
				return await failNativeInventoryAttemptInTransaction(tx, {
					userId: context.instance.userId,
					authority,
					attempt,
					reason,
				});
			},
			options,
		);
		if (!result.matched || !result.value || result.value.status !== "recorded") {
			return "superseded";
		}
		return "failed";
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError) return "superseded";
		return "failed";
	}
}

async function recordFailureInTransaction(
	tx: Prisma.TransactionClient,
	context: NativeInventoryRefreshContext,
	authority: ProviderPublicationAuthority,
	attempt: NativeInventoryAttempt,
	reason: NativeInventoryFailureReason,
): Promise<NativeInventoryRefreshResult> {
	const failure = await failNativeInventoryAttemptInTransaction(tx, {
		userId: context.instance.userId,
		authority,
		attempt,
		reason,
	});
	return failure.status === "recorded" ? { status: "failed" } : { status: "superseded" };
}

async function hasCurrentCanonicalClaim(
	tx: Prisma.TransactionClient,
	context: NativeInventoryRefreshContext,
): Promise<boolean> {
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: {
				instanceId: context.instance.id,
				cacheType: context.cacheType,
			},
		},
		select: {
			lastAttemptAt: true,
			lastAttemptResult: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	return (
		status !== null &&
		!!status.lastAttemptResult?.startsWith("in_progress:") &&
		status.lastAttemptResult === context.attempt.resultMarker &&
		status.lastAttemptAt?.getTime() === context.attempt.attemptedAt.getTime() &&
		status.connectionGeneration === context.instance.connectionGeneration &&
		status.identityGeneration === context.instance.identityGeneration
	);
}

function isValidContext(context: NativeInventoryRefreshContext): boolean {
	if (
		!context ||
		(context.cacheType !== "plex" && context.cacheType !== "jellyfin") ||
		(context.cacheType === "plex" && context.instance.service !== "PLEX") ||
		(context.cacheType === "jellyfin" &&
			context.instance.service !== "JELLYFIN" &&
			context.instance.service !== "EMBY") ||
		!Array.isArray(context.domains) ||
		context.domains.length === 0 ||
		new Set(context.domains).size !== context.domains.length ||
		context.domains.some((domain) => domain !== "library" && domain !== "episode") ||
		!(context.attempt.attemptedAt instanceof Date) ||
		!Number.isFinite(context.attempt.attemptedAt.getTime()) ||
		typeof context.attempt.resultMarker !== "string" ||
		context.attempt.resultMarker.length === 0
	) {
		return false;
	}
	return true;
}

function publicationAuthority(
	instance: OwnedProviderPublicationSnapshot,
): ProviderPublicationAuthority {
	return {
		id: instance.id,
		userId: instance.userId,
		service: instance.service,
		baseUrl: instance.baseUrl,
		enabled: instance.enabled,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
		expectedIdentity: instance.expectedIdentity,
		identityStatus: instance.identityStatus,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	};
}

function warnRefreshFailure(
	log: FastifyBaseLogger,
	cacheType: NativeInventoryRefreshContext["cacheType"],
	reasonCode: string,
): void {
	try {
		log.warn({ cacheType, reasonCode }, "Native inventory refresh did not publish");
	} catch {
		// Logging must never turn a bounded refresh result into an exception.
	}
}
