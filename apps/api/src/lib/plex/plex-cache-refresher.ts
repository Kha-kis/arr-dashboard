/**
 * Plex Cache Refresher
 *
 * Fetches watch history, on-deck status, and user ratings from Plex
 * and atomically replaces the PlexCache table for the instance. This provides
 * a materialized view of a complete Plex snapshot for cleanup rule evaluation.
 *
 * Strategy:
 * 1. Get accounts → build accountId→username map
 * 2. Get library sections → filter movie/show sections
 * 3. For each section: get library items → extract TMDB GUIDs and ratings
 * 4. Get history → group by ratingKey, map accountId→username
 * 5. Get on-deck → set of ratingKeys currently on-deck
 * 6. Re-verify mutable evidence and publish one identity-bound generation
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import { PlexClient } from "./plex-client.js";

/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const PLEX_CACHE_PUBLICATION_CHUNK_SIZE = 100;
/** Allow bounded publication batches to complete on higher-latency databases. */
export const PLEX_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS = 60_000;

// ============================================================================
// GUID Parsing
// ============================================================================

/**
 * Parse TMDB ID from Plex's Guid array.
 * Plex stores GUIDs like: [{id: "tmdb://12345"}, {id: "imdb://tt1234567"}]
 */
function parsePlexTmdbId(guids: Array<{ id: string }> | undefined): number | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.id.match(/^tmdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return Number.parseInt(match[1], 10);
		}
	}

	return null;
}

function parsePlexTvdbId(guids: Array<{ id: string }> | undefined): number | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.id.match(/^tvdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return Number.parseInt(match[1], 10);
		}
	}

	return null;
}

// ============================================================================
// Aggregation Types
// ============================================================================

interface ItemAggregation {
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle: string;
	title: string;
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
	thumb: string | null;
}

export interface PlexCacheSnapshotRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle: string;
	title: string;
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	onDeck: boolean;
	userRating: number | null;
	collections: string;
	labels: string;
	addedAt: Date | null;
	thumb: string | null;
}

export interface PlexCacheSnapshot {
	rows: PlexCacheSnapshotRow[];
	sections: Array<{ key: string; title: string; type: "movie" | "show" }>;
}

export interface PlexInventoryTarget {
	mediaType: "movie" | "series";
	tmdbId: number;
	tvdbId?: number;
	ratingKey: string;
}

export interface PlexPublicationContext {
	prisma: PrismaClient;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export interface PlexCacheRefreshResult {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
	generationId?: string;
	snapshot?: PlexCacheSnapshot;
	inventoryTargets?: PlexInventoryTarget[];
}

function onDeckSignature(items: Awaited<ReturnType<PlexClient["getOnDeck"]>>): string[] {
	return items
		.map((item) =>
			JSON.stringify([
				item.type,
				item.ratingKey,
				item.parentRatingKey ?? null,
				item.grandparentRatingKey ?? null,
			]),
		)
		.sort();
}

function mediaLibrarySignature(
	sections: Awaited<ReturnType<PlexClient["getLibrarySections"]>>,
): string[] {
	return sections
		.map((section) => JSON.stringify([section.key, section.title, section.type]))
		.sort();
}

function libraryInventoryItemSignature(
	section: { key: string; type: string },
	item: Awaited<ReturnType<PlexClient["getLibraryItems"]>>[number],
): string {
	return JSON.stringify([
		section.key,
		section.type,
		item.ratingKey,
		item.type,
		item.title,
		item.userRating ?? null,
		item.addedAt ?? null,
		item.thumb ?? null,
		(item.Guid ?? []).map((guid) => guid.id).sort(),
		(item.Collection ?? []).map((collection) => collection.tag).sort(),
		(item.Label ?? []).map((label) => label.tag).sort(),
	]);
}

const incompleteReasonLabels: Record<string, string> = {
	currentLibraryItemsWithoutRatingKeys: "current library item(s) without a usable rating key",
	currentItemsWithoutTmdbMetadata: "current library item(s) without TMDB metadata",
	historyItemsWithoutUsableMediaKey: "history item(s) without a usable media key",
	currentHistoryItemsWithoutMappedMetadata: "current history item(s) without mapped TMDB metadata",
	historyItemsWithUnknownAccounts: "history item(s) with unknown accounts",
	onDeckItemsWithoutMappedMetadata: "on-deck item(s) without mapped TMDB metadata",
};

function appendIncompleteReasonMessages(
	errorMessages: string[],
	incompleteReasons: Record<string, number>,
): void {
	for (const [reason, count] of Object.entries(incompleteReasons)) {
		const label = incompleteReasonLabels[reason];
		if (label) errorMessages.push(`Plex cache incomplete: ${count} ${label}`);
	}
}

/** Build the only production publication context from an owned database row. */
export function createOwnedPlexPublicationSnapshot(
	encryptor: Pick<Encryptor, "decrypt">,
	instance: ServiceInstance,
): OwnedProviderPublicationSnapshot {
	if (instance.service !== "PLEX") {
		throw new Error("Plex publication requires a Plex service instance");
	}
	return {
		...createProviderPublicationAuthority(instance),
		label: instance.label,
		apiKey: encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		}),
		httpAuthHeaders: getStoredHttpAuthHeaders(encryptor, instance),
	};
}

function plexClientForSnapshot(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
): PlexClient {
	return new PlexClient(
		instance.baseUrl,
		instance.apiKey,
		log,
		undefined,
		instance.httpAuthHeaders,
	);
}

function unpublishedResult(error: unknown): PlexCacheRefreshResult {
	if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") {
		return {
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: false,
			superseded: true,
		};
	}
	return {
		upserted: 0,
		errors: 1,
		errorMessages: [
			error instanceof ProviderIdentityGuardError
				? error.message
				: `Atomic Plex cache publication failed: ${getErrorMessage(error)}`,
		],
		complete: false,
	};
}

/**
 * Collect and publish Plex cache data through the shared identity authority.
 * The data client is always constructed from the exact snapshot observed by
 * both identity reads; callers cannot provide a separate Plex connection.
 */
export async function refreshPlexCache(
	context: PlexPublicationContext,
): Promise<PlexCacheRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		return await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () =>
				await collectPlexCacheLiveEvidence(plexClientForSnapshot(instance, log), instance.id, log),
			async (tx, collected) => await publishPlexCacheSnapshot(tx, instance, collected),
			{
				cleanupRunClaimToken: context.cleanupRunClaimToken,
				timeout: PLEX_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		const result = unpublishedResult(error);
		log.error({ err: error, instanceId: instance.id }, "Plex cache publication rejected");
		return result;
	}
}

async function publishPlexCacheSnapshot(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	collected: PlexCacheRefreshResult,
): Promise<PlexCacheRefreshResult> {
	if (!collected.complete || !collected.completedAt || !collected.snapshot) return collected;

	const rows = collected.snapshot.rows;
	const generationId = randomUUID();
	const generationMetadata = JSON.stringify({ sections: collected.snapshot.sections });
	await tx.plexCache.deleteMany({ where: { instanceId: instance.id } });
	for (let start = 0; start < rows.length; start += PLEX_CACHE_PUBLICATION_CHUNK_SIZE) {
		await tx.plexCache.createMany({
			data: rows.slice(start, start + PLEX_CACHE_PUBLICATION_CHUNK_SIZE).map((row) => ({
				...row,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
		});
	}
	await tx.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
		create: {
			instanceId: instance.id,
			cacheType: "plex",
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			itemCount: rows.length,
			generationId,
			generationMetadata,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		update: {
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: rows.length,
			generationId,
			generationMetadata,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
	});
	return {
		...collected,
		upserted: rows.length,
		generationId,
		inventoryTargets: collected.inventoryTargets,
	};
}

// ============================================================================
// Refresher
// ============================================================================

/**
 * Refresh the PlexCache for a given instance.
 */
export async function collectPlexCacheLiveEvidence(
	client: PlexClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<PlexCacheRefreshResult> {
	const upserted = 0;
	let errors = 0;
	let complete = true;
	let completedAt: Date | undefined;
	const errorMessages: string[] = [];
	const incompleteReasons: Record<string, number> = {};
	let totalLibraryItems = 0;
	let mappedLibraryItems = 0;
	let ignoredHistoricalItems = 0;
	let verifiedInventoryTargets: PlexInventoryTarget[] | undefined;
	const markIncomplete = (reason: string) => {
		complete = false;
		incompleteReasons[reason] = (incompleteReasons[reason] ?? 0) + 1;
	};

	try {
		// 1. Build accountId → username map
		const accounts = await client.getAccounts();
		if (accounts.length === 0) {
			markIncomplete("noUserAccounts");
			errors++;
			errorMessages.push("Plex returned no user accounts");
			log.warn({ instanceId }, "Plex cache refresh: no user accounts discovered");
		}
		const accountMap = new Map<number, string>();
		for (const account of accounts) {
			accountMap.set(account.id, account.name);
		}

		// 2. Get library sections (movie and show only)
		const sections = await client.getLibrarySections();
		const mediaLibs = sections.filter((s) => s.type === "movie" || s.type === "show");
		const initialMediaLibrarySignature = mediaLibrarySignature(mediaLibs);
		if (mediaLibs.length === 0) {
			markIncomplete("noMediaLibraries");
			errors++;
			errorMessages.push("Plex returned no movie or show libraries");
			log.warn({ instanceId }, "Plex cache refresh: no movie or show libraries discovered");
		}

		// 3. Build ratingKey → item data (TMDB ID, media type, rating, section)
		const ratingKeyMap = new Map<
			string,
			{
				tmdbId: number;
				mediaType: "movie" | "series";
				ratingKey: string;
				title: string;
				userRating: number | null;
				sectionId: string;
				sectionTitle: string;
				collections: string[];
				labels: string[];
				addedAt: number | null;
				thumb: string | null;
			}
		>();
		const currentLibraryRatingKeys = new Set<string>();
		const initialLibraryInventorySignature: string[] = [];
		const inventoryTargets: PlexInventoryTarget[] = [];

		for (const lib of mediaLibs) {
			try {
				const items = await client.getLibraryItems(lib.key);
				for (const item of items) {
					initialLibraryInventorySignature.push(libraryInventoryItemSignature(lib, item));
					totalLibraryItems++;
					if (!item.ratingKey.trim()) {
						markIncomplete("currentLibraryItemsWithoutRatingKeys");
						continue;
					}
					currentLibraryRatingKeys.add(item.ratingKey);
					const tmdbId = parsePlexTmdbId(item.Guid);
					if (!tmdbId) {
						markIncomplete("currentItemsWithoutTmdbMetadata");
						continue;
					}

					const mediaType: "movie" | "series" = item.type === "movie" ? "movie" : "series";
					const tvdbId = mediaType === "series" ? parsePlexTvdbId(item.Guid) : null;
					inventoryTargets.push({
						mediaType,
						tmdbId,
						...(tvdbId ? { tvdbId } : {}),
						ratingKey: item.ratingKey,
					});
					ratingKeyMap.set(item.ratingKey, {
						tmdbId,
						mediaType,
						ratingKey: item.ratingKey,
						title: item.title,
						userRating: item.userRating ?? null,
						sectionId: lib.key,
						sectionTitle: lib.title,
						collections: item.Collection?.map((c) => c.tag) ?? [],
						labels: item.Label?.map((l) => l.tag) ?? [],
						addedAt: item.addedAt ?? null,
						thumb: item.thumb ?? null,
					});
				}
			} catch (err) {
				markIncomplete("librarySnapshotFetchFailures");
				const msg = `Failed to fetch library "${lib.title}": ${getErrorMessage(err)}`;
				log.warn({ err, sectionId: lib.key, sectionTitle: lib.title }, msg);
				errors++;
				errorMessages.push(msg);
			}
		}
		initialLibraryInventorySignature.sort();
		inventoryTargets.sort(
			(left, right) =>
				left.mediaType.localeCompare(right.mediaType) ||
				left.tmdbId - right.tmdbId ||
				(left.tvdbId ?? 0) - (right.tvdbId ?? 0) ||
				left.ratingKey.localeCompare(right.ratingKey),
		);
		mappedLibraryItems = ratingKeyMap.size;

		// 4. Get history and aggregate (per-section: key includes sectionId)
		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		const historyCount = history.length;
		const aggregations = new Map<string, ItemAggregation>();

		for (const entry of history) {
			const isRelevantHistory = entry.type === "movie" || entry.type === "episode";
			const itemRatingKey = entry.type === "episode" ? entry.grandparentRatingKey : entry.ratingKey;
			if (!itemRatingKey?.trim()) {
				if (isRelevantHistory) markIncomplete("historyItemsWithoutUsableMediaKey");
				continue;
			}

			const username = accountMap.get(entry.accountID);
			if (isRelevantHistory) {
				if (!username) {
					markIncomplete("historyItemsWithUnknownAccounts");
					continue;
				}
				if (!currentLibraryRatingKeys.has(itemRatingKey)) {
					ignoredHistoricalItems++;
					continue;
				}
			}

			const itemData = ratingKeyMap.get(itemRatingKey);
			if (!itemData) {
				if (isRelevantHistory) markIncomplete("currentHistoryItemsWithoutMappedMetadata");
				continue;
			}

			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
			if (!username) {
				markIncomplete("historyItemsWithUnknownAccounts");
				continue;
			}

			const existing = aggregations.get(aggKey);
			if (existing) {
				existing.watchCount++;
				existing.watchedByUsers.add(username);
				const watchedAt = new Date(entry.viewedAt * 1000);
				if (!existing.lastWatchedAt || watchedAt > existing.lastWatchedAt) {
					existing.lastWatchedAt = watchedAt;
				}
			} else {
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: new Date(entry.viewedAt * 1000),
					watchCount: 1,
					watchedByUsers: new Set([username]),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// Ensure all library items are in aggregations (even if unwatched)
		for (const [_ratingKey, itemData] of ratingKeyMap) {
			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
			if (!aggregations.has(aggKey)) {
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: null,
					watchCount: 0,
					watchedByUsers: new Set(),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// 5. Get on-deck items and mark
		let verifiedOnDeckSignature: string[] = [];
		try {
			const onDeckItems = await client.getOnDeck();
			verifiedOnDeckSignature = onDeckSignature(onDeckItems);
			for (const deckItem of onDeckItems) {
				// For episodes, use the show's ratingKey
				const itemRatingKey =
					deckItem.type === "episode"
						? (deckItem.grandparentRatingKey ?? deckItem.ratingKey)
						: deckItem.ratingKey;

				const itemData = ratingKeyMap.get(itemRatingKey);
				if (!itemData) {
					if (deckItem.type === "movie" || deckItem.type === "episode") {
						markIncomplete("onDeckItemsWithoutMappedMetadata");
					}
					continue;
				}

				const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
				const agg = aggregations.get(aggKey);
				if (agg) {
					agg.onDeck = true;
				}
			}
		} catch (err) {
			markIncomplete("onDeckFetchFailures");
			errors++;
			errorMessages.push(`Failed to fetch Plex on-deck items: ${getErrorMessage(err)}`);
			log.warn({ err }, "Failed to fetch Plex on-deck items");
		}

		// Release ratingKeyMap — all data now lives in aggregations (#239)
		ratingKeyMap.clear();

		// 6. Publish one complete generation atomically. Until every upstream
		// dependency has been verified, the previously published evidence remains
		// untouched and continues to describe the last successful inventory.
		const aggregationsArray = [...aggregations.values()];
		// Release Map hash table — aggregationsArray now owns all references (#239)
		aggregations.clear();

		if (errors === 0 && complete) {
			const latestSections = await client.getLibrarySections();
			const latestMediaLibs = latestSections.filter(
				(section) => section.type === "movie" || section.type === "show",
			);
			if (
				JSON.stringify(mediaLibrarySignature(latestMediaLibs)) !==
				JSON.stringify(initialMediaLibrarySignature)
			) {
				throw new Error("Plex library sections changed before cache publication");
			}
			const latestLibraryInventorySignature: string[] = [];
			for (const lib of latestMediaLibs) {
				const items = await client.getLibraryItems(lib.key);
				for (const item of items) {
					latestLibraryInventorySignature.push(libraryInventoryItemSignature(lib, item));
				}
			}
			latestLibraryInventorySignature.sort();
			if (
				JSON.stringify(latestLibraryInventorySignature) !==
				JSON.stringify(initialLibraryInventorySignature)
			) {
				throw new Error("Plex library inventory changed before cache publication");
			}
			await client.verifyHistorySnapshot(history);
			const latestOnDeckSignature = onDeckSignature(await client.getOnDeck());
			if (JSON.stringify(latestOnDeckSignature) !== JSON.stringify(verifiedOnDeckSignature)) {
				throw new Error("Plex on-deck state changed before cache publication");
			}
			verifiedInventoryTargets = inventoryTargets;
			completedAt = new Date();
			const sections = mediaLibs
				.map((section) => ({
					key: section.key,
					title: section.title,
					type: section.type as "movie" | "show",
				}))
				.sort(
					(left, right) =>
						left.key.localeCompare(right.key) ||
						left.title.localeCompare(right.title) ||
						left.type.localeCompare(right.type),
				);
			const rows: PlexCacheSnapshotRow[] = aggregationsArray.map((agg) => ({
				instanceId,
				tmdbId: agg.tmdbId,
				mediaType: agg.mediaType,
				sectionId: agg.sectionId,
				sectionTitle: agg.sectionTitle,
				title: agg.title,
				ratingKey: agg.ratingKey,
				lastWatchedAt: agg.lastWatchedAt,
				watchCount: agg.watchCount,
				watchedByUsers: JSON.stringify([...agg.watchedByUsers].sort()),
				onDeck: agg.onDeck,
				userRating: agg.userRating,
				collections: JSON.stringify([...agg.collections].sort()),
				labels: JSON.stringify([...agg.labels].sort()),
				addedAt: agg.addedAt,
				thumb: agg.thumb,
			}));
			return {
				upserted: 0,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt,
				inventoryTargets,
				snapshot: { rows, sections },
			};
		}
		log.warn(
			{
				instanceId,
				aggregationSize: aggregationsArray.length,
				totalLibraryItems,
				mappedLibraryItems,
				ignoredHistoricalItems,
				incompleteReasons,
				errors,
			},
			"Plex cache: skipping eviction because the refreshed inventory was incomplete",
		);

		log.info(
			{
				instanceId,
				totalLibraryItems,
				mappedLibraryItems,
				ignoredHistoricalItems,
				incompleteReasons,
				totalHistory: historyCount,
				uniqueItems: aggregationsArray.length,
				upserted,
				errors,
			},
			"Plex cache refresh complete",
		);
	} catch (error) {
		complete = false;
		const msg = `Plex cache refresh failed: ${getErrorMessage(error)}`;
		log.error({ err: error, instanceId }, msg);
		errors++;
		errorMessages.push(msg);
	}

	appendIncompleteReasonMessages(errorMessages, incompleteReasons);

	return {
		upserted,
		errors,
		errorMessages,
		complete: complete && errors === 0,
		completedAt,
		inventoryTargets:
			complete && errors === 0 && completedAt ? verifiedInventoryTargets : undefined,
	};
}
