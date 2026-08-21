import type { Prisma, ServiceInstance } from "../prisma.js";
import { loadInstanceEpisodeEvidence } from "../plex/plex-evidence-repository.js";

export const PROVIDER_CACHE_ROW_SELECTS = {
	plex: {
		id: true,
		instanceId: true,
		tmdbId: true,
		mediaType: true,
		sectionId: true,
		sectionTitle: true,
		lastWatchedAt: true,
		watchCount: true,
		watchedByUsers: true,
		onDeck: true,
		userRating: true,
		collections: true,
		labels: true,
		addedAt: true,
		connectionGeneration: true,
		identityGeneration: true,
	},
	plex_episode: {
		id: true,
		instanceId: true,
		showTmdbId: true,
		seasonNumber: true,
		episodeNumber: true,
		ratingKey: true,
		watched: true,
		watchedByUsers: true,
		lastWatchedAt: true,
		watchCount: true,
		refreshedAt: true,
		sourceFingerprint: true,
		connectionGeneration: true,
		identityGeneration: true,
	},
	jellyfin: {
		id: true,
		instanceId: true,
		tmdbId: true,
		mediaType: true,
		lastWatchedAt: true,
		watchCount: true,
		watchedByUsers: true,
		onDeck: true,
		userRating: true,
		addedAt: true,
		connectionGeneration: true,
		identityGeneration: true,
	},
	jellyfin_episode: {
		id: true,
		instanceId: true,
		showTmdbId: true,
		seasonNumber: true,
		episodeNumber: true,
		jellyfinId: true,
		watched: true,
		watchedByUsers: true,
		lastWatchedAt: true,
		connectionGeneration: true,
		identityGeneration: true,
	},
	tautulli: {
		id: true,
		instanceId: true,
		tmdbId: true,
		mediaType: true,
		lastWatchedAt: true,
		watchCount: true,
		watchedByUsers: true,
		connectionGeneration: true,
		identityGeneration: true,
	},
} as const;

export type ProviderCacheType = keyof typeof PROVIDER_CACHE_ROW_SELECTS;
export type ProviderCacheService = "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";

export function providerCacheServicesForDependencies(
	dependencies: string[],
): ProviderCacheService[] | undefined {
	const services = new Set<ProviderCacheService>();
	for (const dependency of dependencies) {
		if (dependency === "plex" || dependency === "plex_episode") services.add("PLEX");
		else if (dependency === "tautulli") services.add("TAUTULLI");
		else if (dependency === "jellyfin" || dependency === "jellyfin_episode") {
			services.add("JELLYFIN");
			services.add("EMBY");
		} else return undefined;
	}
	return [...services].sort();
}

export function providerServiceUsesCacheType(
	service: ProviderCacheService,
	cacheType: ProviderCacheType,
): boolean {
	if (service === "PLEX") return cacheType === "plex" || cacheType === "plex_episode";
	if (service === "TAUTULLI") return cacheType === "tautulli";
	return cacheType === "jellyfin" || cacheType === "jellyfin_episode";
}

export function isProviderCacheType(value: string): value is ProviderCacheType {
	return value in PROVIDER_CACHE_ROW_SELECTS;
}

function groupProviderRowsByInstance(
	instanceIds: string[],
	rows: Array<{ id: string; instanceId: string }>,
): Map<string, unknown[]> {
	const grouped = new Map<string, unknown[]>(instanceIds.map((instanceId) => [instanceId, []]));
	for (const row of rows) grouped.get(row.instanceId)?.push(row);
	return grouped;
}

export async function loadExactProviderCacheRows(
	tx: Prisma.TransactionClient,
	cacheType: ProviderCacheType,
	instanceIds: string[],
	userId?: string,
	instances?: ServiceInstance[],
): Promise<Map<string, unknown[]>> {
	const where = { instanceId: { in: instanceIds } };
	switch (cacheType) {
		case "plex": {
			// Plex full-generation authority is scanned through the evidence
			// repository so row fingerprints can be computed without materializing
			// a complete row array. Callers must use that bounded contract.
			return groupProviderRowsByInstance(instanceIds, []);
		}
		case "plex_episode": {
			if (!userId || !instances) return groupProviderRowsByInstance(instanceIds, []);
			const rows = [];
			for (const instance of instances.filter((candidate) => instanceIds.includes(candidate.id))) {
				const evidence = await loadInstanceEpisodeEvidence(tx as never, {
					userId,
					instanceId: instance.id,
					instance,
				});
				if (!evidence.available) return groupProviderRowsByInstance(instanceIds, []);
				rows.push(...evidence.rows);
			}
			return groupProviderRowsByInstance(instanceIds, rows);
		}
		case "jellyfin":
			return groupProviderRowsByInstance(
				instanceIds,
				await tx.jellyfinCache.findMany({
					where,
					select: PROVIDER_CACHE_ROW_SELECTS.jellyfin,
					orderBy: { id: "asc" },
				}),
			);
		case "jellyfin_episode":
			return groupProviderRowsByInstance(
				instanceIds,
				await tx.jellyfinEpisodeCache.findMany({
					where,
					select: PROVIDER_CACHE_ROW_SELECTS.jellyfin_episode,
					orderBy: { id: "asc" },
				}),
			);
		case "tautulli":
			return groupProviderRowsByInstance(
				instanceIds,
				await tx.tautulliCache.findMany({
					where,
					select: PROVIDER_CACHE_ROW_SELECTS.tautulli,
					orderBy: { id: "asc" },
				}),
			);
	}
}
