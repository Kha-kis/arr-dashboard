import type { Prisma, PrismaClient } from "../prisma.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
} from "../provider-observation/observation-run-types.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import {
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import { JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS } from "./jellyfin-cache-refresher.js";

type JellyfinEpisodeAttemptRecoveryInput = {
	prisma: PrismaClient;
	authority: ProviderPublicationAuthority;
	attempt: ProviderCacheRefreshAttempt;
	runId: string;
	now?: Date;
	cleanupRunClaimToken?: string;
	/** Test-only fault injection; production callers never provide this hook. */
	testHooks?: {
		afterStageCount?: (tx: Prisma.TransactionClient) => void | Promise<void>;
	};
};

const ATTEMPT_MARKER =
	/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Atomically revoke one Jellyfin/Emby episode attempt without touching its
 * previously published cache. The caller's outer marker is the first write;
 * every subsequent mutation is counted and any count loss aborts the
 * transaction so a stale recovery cannot partially invalidate another run.
 */
export async function invalidateJellyfinEpisodeAttempt(
	input: JellyfinEpisodeAttemptRecoveryInput,
): Promise<"recorded" | "superseded"> {
	if (
		(input.authority.service !== "JELLYFIN" && input.authority.service !== "EMBY") ||
		typeof input.runId !== "string" ||
		input.runId.trim() === "" ||
		!isValidDate(input.attempt.attemptedAt) ||
		!isValidAttemptMarker(input.attempt.resultMarker)
	) {
		return "superseded";
	}
	const now = input.now ?? new Date();
	if (!isValidDate(now)) return "superseded";
	if (input.attempt.attemptedAt.getTime() > now.getTime()) return "superseded";

	const guardOptions =
		input.cleanupRunClaimToken === undefined
			? { timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS }
			: {
					cleanupRunClaimToken: input.cleanupRunClaimToken,
					timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
				};
	const result = await withCurrentProviderPublicationAuthority(
		input.prisma,
		input.authority,
		async (tx) => {
			const run = await tx.providerObservationRun.findFirst({
				where: {
					id: input.runId,
					instanceId: input.authority.id,
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					state: { in: ["running", "failed"] },
					activeSlotKey: { not: null },
				},
				select: {
					id: true,
					instanceId: true,
					provider: true,
					cacheType: true,
					authorityKey: true,
					activeSlotKey: true,
					parentGenerationId: true,
					targetDigest: true,
					connectionGeneration: true,
					identityGeneration: true,
					state: true,
				},
			});
			if (!run) return "superseded" as const;
			let expectedAuthorityKey: string;
			let expectedSlotKey: string;
			try {
				expectedAuthorityKey = buildObservationAuthorityKey({
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					instanceId: run.instanceId,
					parentGenerationId: run.parentGenerationId,
					targetDigest: run.targetDigest,
					connectionGeneration: run.connectionGeneration,
					identityGeneration: run.identityGeneration,
				});
				expectedSlotKey = buildObservationActiveSlotKey({
					instanceId: run.instanceId,
					cacheType: "jellyfin_episode",
				});
			} catch {
				return "superseded" as const;
			}
			if (
				run.authorityKey !== expectedAuthorityKey ||
				run.activeSlotKey !== expectedSlotKey ||
				run.connectionGeneration !== input.authority.connectionGeneration ||
				run.identityGeneration !== input.authority.identityGeneration
			)
				return "superseded" as const;

			const status = await tx.cacheRefreshStatus.findUnique({
				where: {
					instanceId_cacheType: {
						instanceId: input.authority.id,
						cacheType: "jellyfin_episode",
					},
				},
				select: {
					lastAttemptAt: true,
					lastAttemptResult: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
			if (
				!status ||
				status.lastAttemptAt === null ||
				status.lastAttemptAt.getTime() !== input.attempt.attemptedAt.getTime() ||
				status.lastAttemptResult !== input.attempt.resultMarker ||
				status.connectionGeneration !== input.authority.connectionGeneration ||
				status.identityGeneration !== input.authority.identityGeneration
			)
				return "superseded" as const;

			const claimedUnits = await tx.providerObservationUnit.count({
				where: {
					runId: run.id,
					OR: [{ state: "running" }, { claimToken: { not: null } }],
				},
			});
			if (claimedUnits !== 0) return "superseded" as const;

			// This CAS is deliberately the first mutation in the transaction.
			const marker = await tx.cacheRefreshStatus.updateMany({
				where: {
					instanceId: input.authority.id,
					cacheType: "jellyfin_episode",
					lastAttemptAt: input.attempt.attemptedAt,
					lastAttemptResult: input.attempt.resultMarker,
					connectionGeneration: input.authority.connectionGeneration,
					identityGeneration: input.authority.identityGeneration,
				},
				data: {
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "coverage-incomplete",
				},
			});
			if (marker.count !== 1) return "superseded" as const;

			const stagedCount = await tx.jellyfinEpisodeObservationStage.count({
				where: { runId: run.id },
			});
			await input.testHooks?.afterStageCount?.(tx);
			const deletedStages = await tx.jellyfinEpisodeObservationStage.deleteMany({
				where: { runId: run.id },
			});
			if (deletedStages.count !== stagedCount) {
				throw new Error("Jellyfin episode attempt staging invalidation count changed");
			}

			const invalidatableUnits = await tx.providerObservationUnit.count({
				where: { runId: run.id, state: { not: "invalidated" } },
			});
			const invalidatedUnits = await tx.providerObservationUnit.updateMany({
				where: { runId: run.id, state: { not: "invalidated" } },
				data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
			});
			if (invalidatedUnits.count !== invalidatableUnits) {
				throw new Error("Jellyfin episode attempt unit invalidation count changed");
			}

			const invalidatedRun = await tx.providerObservationRun.updateMany({
				where: {
					id: run.id,
					instanceId: input.authority.id,
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					state: { in: ["running", "failed"] },
					activeSlotKey: run.activeSlotKey,
					authorityKey: run.authorityKey,
					connectionGeneration: input.authority.connectionGeneration,
					identityGeneration: input.authority.identityGeneration,
				},
				data: {
					state: "invalidated",
					activeSlotKey: null,
					nextAttemptAt: null,
					completedAt: now,
					lastReasonCode: "coverage-incomplete",
				},
			});
			if (invalidatedRun.count !== 1) {
				throw new Error("Jellyfin episode attempt run invalidation count changed");
			}
			return "recorded" as const;
		},
		guardOptions,
	);
	return result.matched ? result.value : "superseded";
}

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isValidAttemptMarker(value: unknown): value is string {
	return typeof value === "string" && ATTEMPT_MARKER.test(value);
}
