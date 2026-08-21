import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import {
	beginPlexCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	type PlexCacheRefreshAttempt,
	type PlexCacheRefreshType,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type ProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import {
	createOwnedPlexPublicationSnapshot,
	type PlexCacheRefreshResult,
	type PlexPublicationContext,
	refreshPlexCacheWithAttempt,
} from "./plex-cache-refresher.js";
import {
	type PlexEpisodeRefreshResult,
	refreshPlexEpisodeCacheWithAttempt,
} from "./plex-episode-cache-refresher.js";

export type OwnedPlexRefreshContext = {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
};

const PREPARATION_FAILURE_MESSAGE = "Plex refresh preparation failed before publication";

function attemptOptions(context: OwnedPlexRefreshContext) {
	return context.cleanupRunClaimToken === undefined
		? {}
		: { cleanupRunClaimToken: context.cleanupRunClaimToken };
}

function plexPreparationFailure(): PlexCacheRefreshResult {
	return {
		upserted: 0,
		errors: 1,
		errorMessages: [PREPARATION_FAILURE_MESSAGE],
		complete: false,
	};
}

function plexEpisodePreparationFailure(): PlexEpisodeRefreshResult {
	return {
		upserted: 0,
		errors: 1,
		errorMessages: [PREPARATION_FAILURE_MESSAGE],
		eligibleShows: 0,
		refreshedShows: 0,
		coverageIncomplete: true,
		capacityDegraded: false,
		complete: false,
	};
}

function plexPreparationSuperseded(): PlexCacheRefreshResult {
	return {
		upserted: 0,
		errors: 0,
		errorMessages: [],
		complete: false,
		superseded: true,
	};
}

function plexEpisodePreparationSuperseded(): PlexEpisodeRefreshResult {
	return {
		upserted: 0,
		errors: 0,
		errorMessages: [],
		eligibleShows: 0,
		refreshedShows: 0,
		coverageIncomplete: true,
		capacityDegraded: false,
		complete: false,
		superseded: true,
	};
}

/**
 * Acquire durable cache authority before any decryptable Plex preparation.
 * This is deliberately private: callers use the two cache-specific wrappers
 * below rather than selecting arbitrary refresh functions after acquiring a
 * token.
 */
async function refreshWithOwnedPlexAttempt<TResult>(
	context: OwnedPlexRefreshContext,
	cacheType: PlexCacheRefreshType,
	run: (
		publicationContext: PlexPublicationContext,
		attempt: PlexCacheRefreshAttempt,
	) => Promise<TResult>,
	failure: () => TResult,
	superseded: () => TResult,
): Promise<TResult> {
	let authority: ProviderPublicationAuthority;
	let attempt: PlexCacheRefreshAttempt | null;
	const options = attemptOptions(context);
	try {
		authority = createProviderPublicationAuthority(context.instance);
		attempt = await beginPlexCacheRefreshAttempt(context.prisma, cacheType, authority, options);
	} catch {
		context.log.error({ instanceId: context.instance.id, cacheType }, PREPARATION_FAILURE_MESSAGE);
		return failure();
	}
	if (!attempt) return superseded();

	try {
		const publicationContext: PlexPublicationContext = {
			prisma: context.prisma,
			instance: createOwnedPlexPublicationSnapshot(context.encryptor, context.instance),
			log: context.log,
			...(context.cleanupRunClaimToken === undefined
				? {}
				: { cleanupRunClaimToken: context.cleanupRunClaimToken }),
		};
		return await run(publicationContext, attempt);
	} catch {
		const finished = await finishPlexCacheRefreshAttemptFailure(
			context.prisma,
			cacheType,
			PREPARATION_FAILURE_MESSAGE,
			authority,
			attempt,
			context.log,
			options,
		);
		if (finished === "superseded") return superseded();
		context.log.error({ instanceId: context.instance.id, cacheType }, PREPARATION_FAILURE_MESSAGE);
		return failure();
	}
}

/** Refresh library evidence after revoking authority before credential preparation. */
export async function refreshOwnedPlexCache(
	context: OwnedPlexRefreshContext,
): Promise<PlexCacheRefreshResult> {
	return await refreshWithOwnedPlexAttempt(
		context,
		"plex",
		async (publicationContext, attempt) =>
			await refreshPlexCacheWithAttempt(publicationContext, attempt),
		plexPreparationFailure,
		plexPreparationSuperseded,
	);
}

/** Refresh episode evidence after revoking authority before credential preparation. */
export async function refreshOwnedPlexEpisodeCache(
	context: OwnedPlexRefreshContext,
): Promise<PlexEpisodeRefreshResult> {
	return await refreshWithOwnedPlexAttempt(
		context,
		"plex_episode",
		async (publicationContext, attempt) =>
			await refreshPlexEpisodeCacheWithAttempt(publicationContext, attempt),
		plexEpisodePreparationFailure,
		plexEpisodePreparationSuperseded,
	);
}
