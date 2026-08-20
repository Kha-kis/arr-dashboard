import type {
	CacheRefreshStatus,
	PlexCache,
	PlexEpisodeCache,
	Prisma,
	PrismaClientInstance,
} from "../prisma.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import type { PlexCacheRefreshAttempt } from "../services/provider-cache-status.js";

export const PLEX_CACHE_READ_PAGE_SIZE = 500;
export const PLEX_CACHE_WRITE_CHUNK_SIZE = 100;

export class PlexRefreshAttemptSupersededError extends Error {
	constructor() {
		super("Plex cache refresh attempt was superseded");
		this.name = "PlexRefreshAttemptSupersededError";
	}
}

type PlexCacheReader = Pick<PrismaClientInstance, "cacheRefreshStatus" | "plexCache">;
type PlexEpisodeCacheReader = Pick<PrismaClientInstance, "cacheRefreshStatus" | "plexEpisodeCache">;

export type PlexCacheRowSelection =
	| { kind: "authority-only" }
	| { kind: "targets"; targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }> }
	| { kind: "on-deck"; limit: number }
	| { kind: "recently-added"; limit: number }
	| { kind: "label-membership"; label: string };

const PLEX_CACHE_ROW_SELECT = {
	id: true,
	instanceId: true,
	tmdbId: true,
	mediaType: true,
	sectionId: true,
	sectionTitle: true,
	title: true,
	ratingKey: true,
	lastWatchedAt: true,
	watchCount: true,
	watchedByUsers: true,
	onDeck: true,
	userRating: true,
	collections: true,
	labels: true,
	addedAt: true,
	thumb: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const PLEX_EPISODE_CACHE_ROW_SELECT = {
	id: true,
	instanceId: true,
	showTmdbId: true,
	seasonNumber: true,
	episodeNumber: true,
	ratingKey: true,
	title: true,
	watched: true,
	watchedByUsers: true,
	lastWatchedAt: true,
	watchCount: true,
	refreshedAt: true,
	sourceFingerprint: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

export async function readPlexGenerationStatus(
	prisma: PlexCacheReader,
	instanceId: string,
): Promise<CacheRefreshStatus | null> {
	const statuses = await prisma.cacheRefreshStatus.findMany({
		where: { instanceId, cacheType: "plex" },
		take: 2,
	});
	return statuses.length === 1 ? statuses[0]! : null;
}

export async function listPlexCacheRows(
	prisma: PlexCacheReader,
	instanceId: string,
): Promise<PlexCache[]> {
	const rows: PlexCache[] = [];
	let cursor: string | undefined;
	while (true) {
		const batch = await prisma.plexCache.findMany({
			where: { instanceId },
			select: PLEX_CACHE_ROW_SELECT,
			take: PLEX_CACHE_READ_PAGE_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});
		if (batch.length === 0) break;
		rows.push(...batch);
		cursor = batch[batch.length - 1]!.id;
		if (batch.length < PLEX_CACHE_READ_PAGE_SIZE) break;
	}
	return rows;
}

async function listPlexCacheRowsWhere(
	prisma: PlexCacheReader,
	where: Prisma.PlexCacheWhereInput,
	options: { limit?: number; orderBy?: Prisma.PlexCacheOrderByWithRelationInput } = {},
): Promise<PlexCache[]> {
	const rows: PlexCache[] = [];
	let cursor: string | undefined;
	while (options.limit === undefined || rows.length < options.limit) {
		const take = Math.min(
			PLEX_CACHE_READ_PAGE_SIZE,
			options.limit === undefined ? PLEX_CACHE_READ_PAGE_SIZE : options.limit - rows.length,
		);
		if (take <= 0) break;
		const batch = await prisma.plexCache.findMany({
			where,
			select: PLEX_CACHE_ROW_SELECT,
			take,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: options.orderBy ?? { id: "asc" },
		});
		if (batch.length === 0) break;
		rows.push(...batch);
		cursor = batch[batch.length - 1]!.id;
		if (batch.length < take) break;
	}
	return rows;
}

export async function listSelectedPlexCacheRows(
	prisma: PlexCacheReader,
	instanceId: string,
	selection: PlexCacheRowSelection,
): Promise<PlexCache[]> {
	if (selection.kind === "authority-only") return [];
	if (selection.kind === "on-deck") {
		return listPlexCacheRowsWhere(prisma, { instanceId, onDeck: true }, { limit: selection.limit });
	}
	if (selection.kind === "recently-added") {
		return listPlexCacheRowsWhere(
			prisma,
			{ instanceId, addedAt: { not: null } },
			{ limit: selection.limit, orderBy: { addedAt: "desc" } },
		);
	}
	if (selection.kind === "label-membership") {
		return listPlexCacheRowsWhere(prisma, {
			instanceId,
			labels: { contains: JSON.stringify(selection.label) },
		});
	}
	if (selection.targets.length === 0) return [];
	const uniqueTargets = [
		...new Map(
			selection.targets.map((target) => [`${target.mediaType}:${target.tmdbId}`, target]),
		).values(),
	];
	const rows: PlexCache[] = [];
	for (let start = 0; start < uniqueTargets.length; start += 250) {
		const targets = uniqueTargets.slice(start, start + 250);
		rows.push(
			...(await listPlexCacheRowsWhere(prisma, {
				instanceId,
				OR: targets.map((target) => ({
					tmdbId: target.tmdbId,
					mediaType: target.mediaType,
				})),
			})),
		);
	}
	return rows;
}

export async function countPlexCacheRows(
	prisma: PlexCacheReader,
	input: { instanceId: string; connectionGeneration?: number; identityGeneration?: number },
): Promise<number> {
	return prisma.plexCache.count({
		where: {
			instanceId: input.instanceId,
			...(input.connectionGeneration === undefined
				? {}
				: { connectionGeneration: input.connectionGeneration }),
			...(input.identityGeneration === undefined
				? {}
				: { identityGeneration: input.identityGeneration }),
		},
	});
}

export async function readPlexEpisodeGenerationStatus(
	prisma: PlexEpisodeCacheReader,
	instanceId: string,
): Promise<CacheRefreshStatus | null> {
	const statuses = await prisma.cacheRefreshStatus.findMany({
		where: { instanceId, cacheType: "plex_episode" },
		take: 2,
	});
	return statuses.length === 1 ? statuses[0]! : null;
}

export async function listPlexEpisodeCacheRows(
	prisma: PlexEpisodeCacheReader,
	instanceId: string,
): Promise<PlexEpisodeCache[]> {
	const rows: PlexEpisodeCache[] = [];
	let cursor: string | undefined;
	while (true) {
		const batch = await prisma.plexEpisodeCache.findMany({
			where: { instanceId },
			select: PLEX_EPISODE_CACHE_ROW_SELECT,
			take: PLEX_CACHE_READ_PAGE_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});
		if (batch.length === 0) break;
		rows.push(...batch);
		cursor = batch[batch.length - 1]!.id;
		if (batch.length < PLEX_CACHE_READ_PAGE_SIZE) break;
	}
	return rows;
}

export async function countPlexEpisodeCacheRows(
	prisma: PlexEpisodeCacheReader,
	input: { instanceId: string; connectionGeneration?: number; identityGeneration?: number },
): Promise<number> {
	return prisma.plexEpisodeCache.count({
		where: {
			instanceId: input.instanceId,
			...(input.connectionGeneration === undefined
				? {}
				: { connectionGeneration: input.connectionGeneration }),
			...(input.identityGeneration === undefined
				? {}
				: { identityGeneration: input.identityGeneration }),
		},
	});
}

export async function publishAuthoritativePlexCacheGeneration(
	tx: Prisma.TransactionClient,
	input: {
		instance: OwnedProviderPublicationSnapshot;
		rows: Prisma.PlexCacheCreateManyInput[];
		completedAt: Date;
		generationId: string;
		generationMetadata: string;
		attempt: PlexCacheRefreshAttempt;
	},
): Promise<void> {
	const published = await tx.cacheRefreshStatus.updateMany({
		where: {
			instanceId: input.instance.id,
			cacheType: "plex",
			lastAttemptAt: input.attempt.attemptedAt,
			lastAttemptResult: input.attempt.resultMarker,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
		data: {
			lastRefreshedAt: input.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: input.rows.length,
			generationId: input.generationId,
			generationMetadata: input.generationMetadata,
			lastAttemptAt: input.completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
	});
	if (published.count !== 1) throw new PlexRefreshAttemptSupersededError();
	await tx.plexCache.deleteMany({ where: { instanceId: input.instance.id } });
	for (let start = 0; start < input.rows.length; start += PLEX_CACHE_WRITE_CHUNK_SIZE) {
		await tx.plexCache.createMany({
			data: input.rows.slice(start, start + PLEX_CACHE_WRITE_CHUNK_SIZE),
		});
	}
}

export async function publishAuthoritativePlexEpisodeGeneration(
	tx: Prisma.TransactionClient,
	input: {
		instance: OwnedProviderPublicationSnapshot;
		rows: Prisma.PlexEpisodeCacheCreateManyInput[];
		completedAt: Date;
		generationId: string;
		generationMetadata: string;
		attempt: PlexCacheRefreshAttempt;
	},
): Promise<void> {
	const published = await tx.cacheRefreshStatus.updateMany({
		where: {
			instanceId: input.instance.id,
			cacheType: "plex_episode",
			lastAttemptAt: input.attempt.attemptedAt,
			lastAttemptResult: input.attempt.resultMarker,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
		data: {
			lastRefreshedAt: input.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: input.rows.length,
			generationId: input.generationId,
			generationMetadata: input.generationMetadata,
			lastAttemptAt: input.completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
	});
	if (published.count !== 1) throw new PlexRefreshAttemptSupersededError();
	await tx.plexEpisodeCache.deleteMany({ where: { instanceId: input.instance.id } });
	for (let start = 0; start < input.rows.length; start += PLEX_CACHE_WRITE_CHUNK_SIZE) {
		await tx.plexEpisodeCache.createMany({
			data: input.rows.slice(start, start + PLEX_CACHE_WRITE_CHUNK_SIZE),
		});
	}
}

export async function deletePlexCacheRows(
	prisma: Pick<PrismaClientInstance, "plexCache" | "plexEpisodeCache">,
	instanceId: string,
): Promise<void> {
	await prisma.plexCache.deleteMany({ where: { instanceId } });
	await prisma.plexEpisodeCache.deleteMany({ where: { instanceId } });
}

export async function deleteProviderCacheStatuses(
	prisma: Pick<PrismaClientInstance, "cacheRefreshStatus">,
	instanceId: string,
): Promise<void> {
	await prisma.cacheRefreshStatus.deleteMany({ where: { instanceId } });
}
