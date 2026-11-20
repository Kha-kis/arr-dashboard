import type { Prisma, ServiceInstance } from "../prisma.js";
import { createProviderPublicationAuthority } from "../services/provider-identity-guard.js";
import {
	finishProviderCacheRefreshAttemptSuccess,
	type ProviderCacheRefreshAttempt,
} from "../services/provider-cache-status.js";
import type { NativeWatchCandidate } from "./jellyfin-native-watch-projection.js";

const MAX_ROWS = 25_000;
const CHUNK_SIZE = 500;

function validDate(value: Date | null): boolean {
	return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function validCandidate(candidate: NativeWatchCandidate): boolean {
	return (
		candidate.played === true &&
		/^[0-9a-f]{64}$/.test(candidate.userKeyDigest) &&
		candidate.libraryId.length > 0 &&
		candidate.libraryId.length <= 500 &&
		candidate.jellyfinId.length > 0 &&
		candidate.jellyfinId.length <= 500 &&
		candidate.seriesId.length > 0 &&
		candidate.seriesId.length <= 500 &&
		Number.isSafeInteger(candidate.seasonNumber) &&
		candidate.seasonNumber >= 0 &&
		Number.isSafeInteger(candidate.episodeNumber) &&
		candidate.episodeNumber >= 0 &&
		(candidate.playCount === null ||
			(Number.isSafeInteger(candidate.playCount) && candidate.playCount >= 0)) &&
		validDate(candidate.lastPlayedAt)
	);
}

/** Replace a complete positive-only generation in the same transaction as its status pointer. */
export async function publishJellyfinPositiveWatchGeneration(
	tx: Prisma.TransactionClient,
	input: {
		instance: ServiceInstance;
		attempt: ProviderCacheRefreshAttempt;
		generationId: string;
		observedAt: Date;
		candidates: readonly NativeWatchCandidate[];
	},
): Promise<void> {
	const { instance, attempt, generationId, observedAt, candidates } = input;
	if (
		instance.service !== "JELLYFIN" ||
		!instance.enabled ||
		instance.identityStatus !== "VERIFIED" ||
		!instance.expectedIdentity ||
		!generationId ||
		generationId.length > 500 ||
		!validDate(observedAt) ||
		observedAt.getTime() < attempt.attemptedAt.getTime() ||
		candidates.length > MAX_ROWS
	)
		throw new Error("Jellyfin positive watch publication authority is invalid");
	const keys = new Set<string>();
	for (const candidate of candidates) {
		if (!validCandidate(candidate))
			throw new Error("Jellyfin positive watch publication contains invalid evidence");
		const key = JSON.stringify([
			candidate.userKeyDigest,
			candidate.libraryId,
			candidate.jellyfinId,
		]);
		if (keys.has(key))
			throw new Error("Jellyfin positive watch publication has duplicate evidence");
		keys.add(key);
	}
	const current = await tx.serviceInstance.findFirst({
		where: {
			id: instance.id,
			userId: instance.userId,
			service: "JELLYFIN",
			enabled: true,
			identityStatus: "VERIFIED",
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
	});
	if (!current || current.expectedIdentity !== instance.expectedIdentity)
		throw new Error("Jellyfin positive watch publication was superseded");
	const recorded = await finishProviderCacheRefreshAttemptSuccess(
		tx,
		"jellyfin_episode_positive",
		createProviderPublicationAuthority(instance),
		attempt,
		{ observedAt, itemCount: candidates.length, generationId, generationMetadata: null },
	);
	if (recorded !== "recorded") throw new Error("Jellyfin positive watch attempt was superseded");
	await tx.jellyfinPositiveWatchRow.deleteMany({ where: { instanceId: instance.id } });
	for (let offset = 0; offset < candidates.length; offset += CHUNK_SIZE) {
		await tx.jellyfinPositiveWatchRow.createMany({
			data: candidates.slice(offset, offset + CHUNK_SIZE).map((candidate) => ({
				instanceId: instance.id,
				generationId,
				userKeyDigest: candidate.userKeyDigest,
				libraryId: candidate.libraryId,
				jellyfinId: candidate.jellyfinId,
				seriesId: candidate.seriesId,
				seasonNumber: candidate.seasonNumber,
				episodeNumber: candidate.episodeNumber,
				playCount: candidate.playCount,
				lastPlayedAt: candidate.lastPlayedAt,
				observedAt,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
		});
	}
}
