import { createHash } from "node:crypto";
import {
	type JellyfinEpisodeRow,
	type JellyfinLibraryRow,
	readOwnedJellyfinObservationInTransaction,
	type TransactionReader,
} from "../jellyfin/jellyfin-evidence-repository.js";
import type { PlexAuthorityService } from "../plex/plex-authority-service.js";
import type { Prisma, ServiceInstance } from "../prisma.js";
import type { ProviderFactGrant } from "./types.js";

/** A durable envelope carries only this digest, never the raw provider fact. */
export function providerFactGrantDigest(grants: ProviderFactGrant[]): string {
	const ordered = [...grants]
		.map((grant) => [
			grant.userId,
			grant.provider,
			grant.cacheType,
			grant.instanceId,
			grant.generationId,
			grant.targetKey,
			grant.coordinate,
			grant.domain,
			grant.field,
			grant.operator,
			grant.threshold,
			grant.observedValue,
			grant.basis,
		])
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

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

function jellyfinReader(tx: Prisma.TransactionClient): TransactionReader {
	return {
		serviceInstance: tx.serviceInstance,
		cacheRefreshStatus: tx.cacheRefreshStatus,
		jellyfinCache: tx.jellyfinCache,
		jellyfinEpisodeCache: tx.jellyfinEpisodeCache,
	} as unknown as TransactionReader;
}

function projectJellyfinLibraryRow(row: JellyfinLibraryRow) {
	return {
		id: row.id,
		instanceId: row.instanceId,
		tmdbId: row.tmdbId,
		mediaType: row.mediaType,
		lastWatchedAt: row.lastWatchedAt,
		watchCount: row.watchCount,
		watchedByUsers: row.watchedByUsers,
		onDeck: row.onDeck,
		userRating: row.userRating,
		addedAt: row.addedAt,
		connectionGeneration: row.connectionGeneration,
		identityGeneration: row.identityGeneration,
	};
}

function projectJellyfinEpisodeRow(row: JellyfinEpisodeRow) {
	return {
		id: row.id,
		instanceId: row.instanceId,
		showTmdbId: row.showTmdbId,
		seasonNumber: row.seasonNumber,
		episodeNumber: row.episodeNumber,
		jellyfinId: row.jellyfinId,
		watched: row.watched,
		watchedByUsers: row.watchedByUsers,
		lastWatchedAt: row.lastWatchedAt,
		connectionGeneration: row.connectionGeneration,
		identityGeneration: row.identityGeneration,
	};
}

export async function loadExactProviderCacheRows(
	tx: Prisma.TransactionClient,
	cacheType: ProviderCacheType,
	instanceIds: string[],
	userId?: string,
	instances?: ServiceInstance[],
	plexAuthority?: PlexAuthorityService,
): Promise<Map<string, unknown[]>> {
	switch (cacheType) {
		case "plex": {
			// Plex full-generation authority is scanned through the evidence
			// repository so row fingerprints can be computed without materializing
			// a complete row array. Callers must use that bounded contract.
			return groupProviderRowsByInstance(instanceIds, []);
		}
		case "plex_episode": {
			if (!userId || !instances || !plexAuthority) {
				return groupProviderRowsByInstance(instanceIds, []);
			}
			const rows = [];
			for (const instance of instances.filter((candidate) => instanceIds.includes(candidate.id))) {
				const parent = await plexAuthority.readInstance({
					userId,
					instanceId: instance.id,
					domains: ["membership", "episode-parents"],
				});
				if (!parent.available) return groupProviderRowsByInstance(instanceIds, []);
				const showTmdbIds = [
					...new Set(
						parent.rows.filter((row) => row.mediaType === "series").map((row) => row.tmdbId),
					),
				];
				const evidence = await plexAuthority.readInstanceSelectedEpisodes({
					userId,
					instanceId: instance.id,
					showTmdbIds,
				});
				if (!evidence.available) return groupProviderRowsByInstance(instanceIds, []);
				rows.push(...evidence.rows);
			}
			return groupProviderRowsByInstance(instanceIds, rows);
		}
		case "jellyfin":
		case "jellyfin_episode": {
			if (!userId || !instances || instances.length === 0) {
				return groupProviderRowsByInstance(instanceIds, []);
			}
			const selectedInstances = instanceIds.map((instanceId) =>
				instances.find((instance) => instance.id === instanceId),
			);
			if (
				selectedInstances.some(
					(instance) =>
						!instance || (instance.service !== "JELLYFIN" && instance.service !== "EMBY"),
				)
			) {
				return groupProviderRowsByInstance(instanceIds, []);
			}
			const rows: Array<{ id: string; instanceId: string } & Record<string, unknown>> = [];
			for (const instance of selectedInstances) {
				if (!instance) return groupProviderRowsByInstance(instanceIds, []);
				const observation = await readOwnedJellyfinObservationInTransaction(jellyfinReader(tx), {
					userId,
					instanceId: instance.id,
					cacheType,
					mode: "mutation",
				});
				if (
					!observation ||
					observation.cacheType !== cacheType ||
					observation.service !== instance.service ||
					!observation.available ||
					!observation.mutationAvailable ||
					!observation.authority
				) {
					return groupProviderRowsByInstance(instanceIds, []);
				}
				if (observation.cacheType === "jellyfin") {
					rows.push(...observation.rows.map(projectJellyfinLibraryRow));
				} else {
					rows.push(...observation.rows.map(projectJellyfinEpisodeRow));
				}
			}
			return groupProviderRowsByInstance(instanceIds, rows);
		}
		case "tautulli":
			// B1 containment: Tautulli is not cleanup-authoritative. Returning an
			// empty grouped result makes every exact revalidation fail closed.
			return groupProviderRowsByInstance(instanceIds, []);
	}
}
