/**
 * Plex Media Server API Client
 *
 * Standalone client for the Plex API using X-Plex-Token header authentication.
 * Plex returns JSON when Accept: application/json is set.
 */

import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import {
	hasNativeInventoryExternalIds,
	type NativeInventoryExternalIds,
	normalizeNativeExternalId,
	normalizeNativeInventoryExternalIds,
} from "../provider-observation/native-inventory.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	plexAccountsResponseSchema,
	plexActivitiesResponseSchema,
	plexAllLeavesResponseSchema,
	plexEpisodeMediaItemsResponseSchema,
	plexEpisodesResponseSchema,
	plexHistoryResponseSchema,
	plexIdentityResponseSchema,
	plexLibraryGuidItemsResponseSchema,
	plexLibraryItemsResponseSchema,
	plexLibraryMediaItemsResponseSchema,
	plexMetadataTagsResponseSchema,
	plexNativeEpisodeItemsResponseSchema,
	plexNativeLibraryItemsResponseSchema,
	plexOnDeckResponseSchema,
	plexSectionsResponseSchema,
	plexServerInfoResponseSchema,
	plexSessionsResponseSchema,
	plexSettlementSectionsResponseSchema,
	plexTargetMetadataResponseSchema,
} from "./plex-schemas.js";

// ============================================================================
// Response Types
// ============================================================================

export interface PlexIdentity {
	machineIdentifier: string;
	version: string;
	friendlyName: string;
	platform: string;
}

export interface PlexLibrary {
	key: string; // section ID
	title: string;
	type: string; // "movie" | "show" | "artist"
	agent?: string; // e.g. "tv.plex.agents.movie", "com.plexapp.agents.none"
}

export interface PlexSettlementLibrary extends PlexLibrary {
	uuid: string;
	refreshing: boolean;
	scannedAt: number | null;
	updatedAt: number;
}

export interface PlexActivity {
	type: string;
	Context?: { librarySectionID?: string };
}

export interface PlexGuid {
	id: string; // e.g. "tmdb://12345", "imdb://tt1234567"
}

export interface PlexLibraryItem {
	ratingKey: string;
	title: string;
	type: string; // "movie" | "show"
	year?: number;
	userRating?: number; // 0-10 scale
	addedAt?: number; // Unix timestamp
	viewCount?: number;
	lastViewedAt?: number; // Unix timestamp
	thumb?: string; // Plex thumbnail path
	Guid?: PlexGuid[];
	Collection?: Array<{ tag: string }>;
	Label?: Array<{ tag: string }>;
}

export interface PlexCompletePageResult<T> {
	items: T[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
}

interface PlexCompletePageResultInternal<T> extends PlexCompletePageResult<T> {
	failureMessage?: string;
}

export interface PlexMovieMediaPart {
	file: string;
	size: number;
}

export interface PlexMovieMediaItem {
	ratingKey: string;
	parts: PlexMovieMediaPart[];
}

export interface PlexEpisodeMediaItem extends PlexMovieMediaItem {
	seasonNumber?: number;
	episodeNumber?: number;
}

export interface PlexSeriesMediaItem {
	ratingKey: string;
	episodes: PlexEpisodeMediaItem[];
}

export class PlexMovieNotFoundError extends Error {
	constructor(tmdbId: number) {
		super(`Plex returned no movie item for TMDb ${tmdbId}`);
		this.name = "PlexMovieNotFoundError";
	}
}

export class PlexSeriesNotFoundError extends Error {
	constructor(tvdbId: number) {
		super(`Plex returned no series item for TVDB ${tvdbId}`);
		this.name = "PlexSeriesNotFoundError";
	}
}

export interface PlexHistoryItem {
	historyKey?: string;
	ratingKey: string;
	parentRatingKey?: string;
	grandparentRatingKey?: string;
	title: string;
	grandparentTitle?: string;
	type: string; // "movie" | "episode" | "track"
	viewedAt: number; // Unix timestamp
	accountID: number;
	librarySectionID?: string;
}

export interface PlexAccount {
	id: number;
	name: string;
}

export interface PlexOnDeckItem {
	ratingKey: string;
	parentRatingKey?: string;
	grandparentRatingKey?: string;
	type: string; // "movie" | "episode"
}

export interface PlexSessionItem {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	type: string;
	user: { id: number; title: string; thumb?: string };
	player: { title: string; platform: string; product: string; state: string };
	state: "playing" | "paused" | "buffering";
	viewOffset: number;
	duration: number;
	videoDecision: string;
	audioDecision: string;
	bandwidth?: number;
	thumb?: string;
}

export interface PlexEpisodeItem {
	ratingKey: string;
	title: string;
	seasonNumber: number;
	episodeNumber: number;
	viewCount: number;
	lastViewedAt?: number;
}

export interface PlexNativeEpisodeItem {
	ratingKey: string;
	type: "episode";
	title: string;
	grandparentRatingKey: string | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
}

export interface PlexNativeLibraryItem {
	ratingKey: string;
	type: "movie" | "show" | "collection";
	title: string;
	externalIds?: NativeInventoryExternalIds;
}

/** Current metadata identity needed to bind a historical provider row. */
export interface PlexTargetMetadata {
	ratingKey: string;
	type: "movie" | "show" | "episode";
	guid: string;
	Guid: PlexGuid[];
	librarySectionID: string;
	parentRatingKey?: string;
	grandparentRatingKey?: string;
}

// ============================================================================
// Client Implementation
// ============================================================================

const DEFAULT_TIMEOUT = 15_000;
const SAFETY_PAGE_SIZE = 200;
// Metadata identifiers are encoded into the URL path rather than paged through
// query parameters. Keep this transport budget independent from result paging
// so large libraries remain verifiable behind bounded URI/proxy limits.
const METADATA_TAG_BATCH_SIZE = 50;
const TARGET_METADATA_BATCH_SIZE = 100;
const SAFETY_MAX_ITEMS = 100_000;
const HISTORY_SORT = "viewedAt:desc";

function plexExternalIds(guids: readonly PlexGuid[] | undefined): NativeInventoryExternalIds {
	const tmdb: unknown[] = [];
	const tvdb: unknown[] = [];
	for (const guid of guids ?? []) {
		const match = guid.id.trim().match(/^(tmdb|tvdb):\/\/(.+)$/i);
		if (!match) continue;
		const id = normalizeNativeExternalId(match[2]);
		if (id === undefined) continue;
		(match[1]?.toLowerCase() === "tmdb" ? tmdb : tvdb).push(id);
	}
	return normalizeNativeInventoryExternalIds({ tmdb, tvdb });
}

/**
 * Extract a ratingKey from a Plex path like "/library/metadata/65486".
 * The history API returns `grandparentKey` (full path) instead of
 * `grandparentRatingKey` (plain ID), so we need this fallback parser.
 */
function extractRatingKey(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const match = path.match(/\/library\/metadata\/(\d+)/);
	return match?.[1];
}

export type PlexReadPhase =
	| "identity"
	| "activities"
	| "sections"
	| "accounts"
	| "library"
	| "history"
	| "on-deck"
	| "metadata"
	| "other";

export type PlexReadContext = {
	signal: AbortSignal;
	onRequest: (phase: PlexReadPhase) => void;
};

function readPhase(path: string): PlexReadPhase {
	const pathname = path.split("?")[0];
	if (pathname === "/identity") return "identity";
	if (pathname === "/activities") return "activities";
	if (pathname === "/library/sections") return "sections";
	if (pathname === "/accounts") return "accounts";
	if (pathname?.startsWith("/library/sections/")) return "library";
	if (pathname?.startsWith("/status/sessions/history/")) return "history";
	if (pathname === "/library/onDeck") return "on-deck";
	if (pathname?.startsWith("/library/metadata/")) return "metadata";
	return "other";
}

export class PlexClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;
	private readonly httpAuthHeaders: Record<string, string>;
	private readonly ordinaryReadFlights = new Map<string, Promise<unknown>>();
	constructor(
		baseUrl: string,
		token: string,
		log: FastifyBaseLogger,
		timeout = DEFAULT_TIMEOUT,
		httpAuthHeaders: Record<string, string> = {},
		private readonly readContext?: PlexReadContext,
	) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.token = token;
		this.log = log;
		this.timeout = timeout;
		this.httpAuthHeaders = httpAuthHeaders;
	}

	/**
	 * Get Plex server identity (used for connection testing).
	 * Uses the unauthenticated /identity endpoint (no friendlyName/platform).
	 */
	async getIdentity(): Promise<PlexIdentity> {
		const data = await this.request("/identity", {
			schema: plexIdentityResponseSchema,
		});
		return {
			machineIdentifier: data.MediaContainer.machineIdentifier,
			version: data.MediaContainer.version,
			friendlyName: "",
			platform: "",
		};
	}

	/**
	 * Get full server info including friendlyName and platform.
	 * Uses the authenticated root "/" endpoint which returns richer metadata.
	 */
	async getServerInfo(): Promise<PlexIdentity> {
		const data = await this.request("/", {
			schema: plexServerInfoResponseSchema,
		});
		return {
			machineIdentifier: data.MediaContainer.machineIdentifier,
			version: data.MediaContainer.version,
			friendlyName: data.MediaContainer.friendlyName ?? "",
			platform: data.MediaContainer.platform ?? "",
		};
	}

	/**
	 * Get all library sections.
	 */
	async getLibrarySections(): Promise<PlexLibrary[]> {
		const data = await this.request("/library/sections", {
			schema: plexSectionsResponseSchema,
		});
		const directories = data.MediaContainer.Directory ?? [];
		this.assertCompleteSinglePageContainer(
			data.MediaContainer,
			directories.length,
			"Plex library section inventory",
		);
		return directories.map((d) => ({
			key: d.key,
			title: d.title,
			type: d.type,
			agent: d.agent,
		}));
	}

	/** Strict complete section-state probe used by live settlement authority. */
	async getLibrarySettlementSections(
		options: { uncached?: boolean } = {},
	): Promise<PlexSettlementLibrary[]> {
		return this.runOrdinaryRead(
			"library-settlement-sections",
			async () => {
				const data = await this.request("/library/sections", {
					schema: plexSettlementSectionsResponseSchema,
				});
				const directories = data.MediaContainer.Directory ?? [];
				this.assertCompleteSinglePageContainer(
					data.MediaContainer,
					directories.length,
					"Plex library settlement section inventory",
				);
				return directories.map((directory) => ({
					key: directory.key,
					uuid: directory.uuid,
					title: directory.title,
					type: directory.type,
					agent: directory.agent,
					refreshing: directory.refreshing,
					scannedAt: directory.scannedAt,
					updatedAt: directory.updatedAt,
				}));
			},
			options.uncached === true,
		);
	}

	/** Strict complete activity probe used by live settlement authority. */
	async getActivities(options: { uncached?: boolean } = {}): Promise<PlexActivity[]> {
		return this.runOrdinaryRead(
			"activities",
			async () => {
				const data = await this.request("/activities", { schema: plexActivitiesResponseSchema });
				const activities = data.MediaContainer.Activity ?? [];
				this.assertCompleteSinglePageContainer(
					data.MediaContainer,
					activities.length,
					"Plex activity inventory",
				);
				return activities.map((activity) => ({
					type: activity.type,
					...(activity.Context ? { Context: activity.Context } : {}),
				}));
			},
			options.uncached === true,
		);
	}

	/**
	 * Get all items from a library section.
	 */
	async getLibraryItems(sectionId: string): Promise<PlexLibraryItem[]> {
		const result = await this.getLibraryItemsWithCoverage(sectionId);
		if (result.reason !== null) {
			throw new Error("Plex safety pagination stopped before the declared total");
		}
		return result.items;
	}

	/**
	 * Get a complete library section with bounded coverage accounting. A page
	 * failure never exposes the rows observed before the failure.
	 */
	async getLibraryItemsWithCoverage(
		sectionId: string,
	): Promise<PlexCompletePageResult<PlexLibraryItem>> {
		const pageResult = await this.getCompleteSafetyMetadataWithCoverage(
			`/library/sections/${sectionId}/all?includeGuids=1&includeCollections=1&includeLabels=1`,
			plexLibraryItemsResponseSchema,
			(item) => item.ratingKey,
		);
		if (pageResult.reason !== null) {
			return {
				items: [],
				expectedRawCount: pageResult.expectedRawCount,
				pagesAttempted: pageResult.pagesAttempted,
				pagesCompleted: pageResult.pagesCompleted,
				rawObserved: pageResult.rawObserved,
				reason: pageResult.reason,
			};
		}
		const items = pageResult.items;
		let tags: Awaited<ReturnType<PlexClient["getAuthoritativeMetadataTags"]>>;
		try {
			tags = await this.getAuthoritativeMetadataTags(items.map((item) => item.ratingKey));
		} catch {
			return {
				items: [],
				expectedRawCount: pageResult.expectedRawCount,
				pagesAttempted: pageResult.pagesAttempted,
				pagesCompleted: pageResult.pagesCompleted,
				rawObserved: pageResult.rawObserved,
				reason: "page-failure",
			};
		}

		return {
			items: items.map((m) => ({
				ratingKey: m.ratingKey,
				title: m.title,
				type: m.type,
				year: m.year,
				userRating: m.userRating,
				addedAt: m.addedAt,
				viewCount: m.viewCount,
				lastViewedAt: m.lastViewedAt,
				thumb: m.thumb,
				Guid: m.Guid?.map((g) => ({ id: g.id })),
				Collection: tags.get(m.ratingKey)?.Collection?.map((c) => ({ tag: c.tag })),
				Label: tags.get(m.ratingKey)?.Label?.map((l) => ({ tag: l.tag })),
			})),
			expectedRawCount: pageResult.expectedRawCount,
			pagesAttempted: pageResult.pagesAttempted,
			pagesCompleted: pageResult.pagesCompleted,
			rawObserved: pageResult.rawObserved,
			reason: null,
		};
	}

	/**
	 * Get the complete native episode inventory for one owned library section.
	 * Mapping and watch metadata are deliberately outside this boundary: native
	 * presence remains observable even when those optional fields are absent.
	 */
	async getNativeEpisodeItemsWithCoverage(
		sectionId: string,
	): Promise<PlexCompletePageResult<PlexNativeEpisodeItem>> {
		const pageResult = await this.getCompleteSafetyMetadataWithCoverage(
			`/library/sections/${encodeURIComponent(sectionId)}/all?type=4`,
			plexNativeEpisodeItemsResponseSchema,
			(item) => item.ratingKey,
		);
		if (pageResult.reason !== null) {
			return {
				items: [],
				expectedRawCount: pageResult.expectedRawCount,
				pagesAttempted: pageResult.pagesAttempted,
				pagesCompleted: pageResult.pagesCompleted,
				rawObserved: pageResult.rawObserved,
				reason: pageResult.reason,
			};
		}

		return {
			items: pageResult.items.map((item) => ({
				ratingKey: item.ratingKey,
				type: item.type,
				title: item.title,
				grandparentRatingKey: item.grandparentRatingKey,
				seasonNumber: item.parentIndex,
				episodeNumber: item.index,
			})),
			expectedRawCount: pageResult.expectedRawCount,
			pagesAttempted: pageResult.pagesAttempted,
			pagesCompleted: pageResult.pagesCompleted,
			rawObserved: pageResult.rawObserved,
			reason: null,
		};
	}

	/**
	 * Get the complete native movie, show, and container inventory for one
	 * owned library section. Container rows are retained for the caller to
	 * account for explicitly when selecting supported media domains.
	 */
	async getNativeLibraryItemsWithCoverage(
		sectionId: string,
	): Promise<PlexCompletePageResult<PlexNativeLibraryItem>> {
		const pageResult = await this.getCompleteSafetyMetadataWithCoverage(
			`/library/sections/${encodeURIComponent(sectionId)}/all?includeGuids=1`,
			plexNativeLibraryItemsResponseSchema,
			(item) => item.ratingKey,
		);
		if (pageResult.reason !== null) {
			return {
				items: [],
				expectedRawCount: pageResult.expectedRawCount,
				pagesAttempted: pageResult.pagesAttempted,
				pagesCompleted: pageResult.pagesCompleted,
				rawObserved: pageResult.rawObserved,
				reason: pageResult.reason,
			};
		}

		return {
			items: pageResult.items.map((item) => {
				const externalIds = plexExternalIds(item.Guid);
				return {
					ratingKey: item.ratingKey,
					type: item.type,
					title: item.title,
					...(hasNativeInventoryExternalIds(externalIds) ? { externalIds } : {}),
				};
			}),
			expectedRawCount: pageResult.expectedRawCount,
			pagesAttempted: pageResult.pagesAttempted,
			pagesCompleted: pageResult.pagesCompleted,
			rawObserved: pageResult.rawObserved,
			reason: null,
		};
	}

	private async getAuthoritativeMetadataTags(ratingKeys: readonly string[]) {
		const tags = new Map<
			string,
			{ Collection?: Array<{ tag: string }>; Label?: Array<{ tag: string }> }
		>();
		for (let offset = 0; offset < ratingKeys.length; offset += METADATA_TAG_BATCH_SIZE) {
			const chunk = ratingKeys.slice(offset, offset + METADATA_TAG_BATCH_SIZE);
			const path = `/library/metadata/${chunk.map(encodeURIComponent).join(",")}?includeCollections=1&includeLabels=1`;
			const data = await this.request(path, { schema: plexMetadataTagsResponseSchema });
			const metadata = data.MediaContainer.Metadata ?? [];
			if (data.MediaContainer.size !== metadata.length || metadata.length !== chunk.length) {
				throw new Error("Plex metadata tag inventory was incomplete");
			}
			const expected = new Set(chunk);
			for (const item of metadata) {
				if (!expected.has(item.ratingKey) || tags.has(item.ratingKey)) {
					throw new Error("Plex metadata tag inventory returned an unexpected or duplicate item");
				}
				tags.set(item.ratingKey, {
					...(item.Collection ? { Collection: item.Collection.map(({ tag }) => ({ tag })) } : {}),
					...(item.Label ? { Label: item.Label.map(({ tag }) => ({ tag })) } : {}),
				});
			}
		}
		if (tags.size !== ratingKeys.length) {
			throw new Error("Plex metadata tag inventory did not cover every library item");
		}
		return tags;
	}

	private async getCompleteSafetyMetadata<T>(
		path: string,
		schema: z.ZodType<{
			MediaContainer: {
				offset: number;
				size: number;
				totalSize: number;
				Metadata?: T[];
			};
		}>,
		keyOf: (item: T) => string,
	): Promise<T[]> {
		const result = await this.getCompleteSafetyMetadataWithCoverage(path, schema, keyOf);
		if (result.reason !== null) {
			throw new Error(result.failureMessage ?? "Plex safety pagination failed");
		}
		return result.items;
	}

	private async getCompleteSafetyMetadataWithCoverage<T>(
		path: string,
		schema: z.ZodType<{
			MediaContainer: {
				offset: number;
				size: number;
				totalSize: number;
				Metadata?: T[];
			};
		}>,
		keyOf: (item: T) => string,
	): Promise<PlexCompletePageResultInternal<T>> {
		const allItems: T[] = [];
		const seenKeys = new Set<string>();
		let expectedTotal: number | null = null;
		let offset = 0;
		let pagesAttempted = 0;
		let pagesCompleted = 0;
		let failureMessage: string | undefined;

		while (expectedTotal === null || offset < expectedTotal) {
			pagesAttempted++;
			const pageUrl = new URL(path, "http://plex.invalid");
			pageUrl.searchParams.set("X-Plex-Container-Start", String(offset));
			pageUrl.searchParams.set("X-Plex-Container-Size", String(SAFETY_PAGE_SIZE));
			let page: {
				MediaContainer: {
					offset: number;
					size: number;
					totalSize: number;
					Metadata?: T[];
				};
			};
			try {
				page = (await this.request(`${pageUrl.pathname}${pageUrl.search}`, {
					schema,
				})) as typeof page;
			} catch {
				failureMessage = "Plex safety pagination page request failed";
				break;
			}
			const container = page.MediaContainer;
			const items = container.Metadata ?? [];

			if (container.offset !== offset || container.size !== items.length) {
				failureMessage = "Plex safety pagination metadata did not match the returned page";
				break;
			}
			if (expectedTotal === null) {
				expectedTotal = container.totalSize;
				if (expectedTotal > SAFETY_MAX_ITEMS) {
					failureMessage = "Plex safety result set is too large to verify completely";
					break;
				}
			} else if (container.totalSize !== expectedTotal) {
				failureMessage = "Plex safety result set changed while it was being paged";
				break;
			}
			if (expectedTotal === null) break;
			if (offset + items.length > expectedTotal) {
				failureMessage = "Plex safety pagination exceeded its declared total";
				break;
			}
			if (items.length === 0 && offset < expectedTotal) {
				failureMessage = "Plex safety pagination stopped before the declared total";
				break;
			}

			let duplicate = false;
			for (const item of items) {
				const key = keyOf(item);
				if (seenKeys.has(key)) {
					duplicate = true;
					break;
				}
				seenKeys.add(key);
				allItems.push(item);
			}
			if (duplicate) {
				failureMessage = "Plex safety pagination returned a duplicate item";
				break;
			}
			pagesCompleted++;
			offset += items.length;
		}

		if (failureMessage || expectedTotal === null || allItems.length !== expectedTotal) {
			return {
				items: [],
				expectedRawCount: expectedTotal,
				pagesAttempted,
				pagesCompleted,
				rawObserved: allItems.length,
				reason: "page-failure",
				...(failureMessage ? { failureMessage } : {}),
			};
		}
		return {
			items: allItems,
			expectedRawCount: expectedTotal,
			pagesAttempted,
			pagesCompleted,
			rawObserved: allItems.length,
			reason: null,
		};
	}

	/**
	 * Return physical media parts grouped by Plex movie item for an exact TMDb
	 * match. The caller uses file identity to distinguish the target from other
	 * items or versions that happen to share the same external ID.
	 */
	async getMovieMediaPartsByTmdbId(tmdbId: number): Promise<PlexMovieMediaItem[]> {
		const params = new URLSearchParams({
			type: "1",
			includeGuids: "1",
			includeMedia: "1",
		});
		// Modern Plex agents use a plex:// primary GUID. Plex's `guid=` query
		// filters only that primary value on current servers, so asking for an
		// alternate tmdb:// GUID returns an empty result even when `Guid` contains
		// the exact identifier. Page the complete movie inventory and perform the
		// authoritative alternate-GUID match below instead.
		const completeItems = await this.getCompleteSafetyMetadata(
			`/library/all?${params.toString()}`,
			plexLibraryMediaItemsResponseSchema,
			(item) => item.ratingKey,
		);
		const items = completeItems.filter((item) =>
			item.Guid?.some((guid) => guid.id === `tmdb://${tmdbId}`),
		);
		if (items.length === 0) {
			throw new PlexMovieNotFoundError(tmdbId);
		}

		return items.map((item) => {
			const parts = (item.Media ?? []).flatMap((media) =>
				(media.Part ?? []).map((part) => ({ file: part.file, size: part.size })),
			);
			if (parts.length === 0) {
				throw new Error(`Plex item ${item.ratingKey} returned no media parts`);
			}
			return { ratingKey: item.ratingKey, parts };
		});
	}

	/**
	 * Return physical media parts grouped by Plex episode for a TV series with
	 * the exact TVDB identifier. Plex stores alternate qualities as multiple
	 * media parts on the episode item, so callers must retain the grouping.
	 */
	async getSeriesEpisodeMediaPartsByTvdbId(tvdbId: number): Promise<PlexSeriesMediaItem[]> {
		// As with movies, TVDB is an alternate GUID under modern Plex agents and
		// cannot safely be used as the server-side primary `guid=` filter.
		const params = new URLSearchParams({
			type: "2",
			includeGuids: "1",
		});
		const shows = await this.getCompleteSafetyMetadata(
			`/library/all?${params.toString()}`,
			plexLibraryGuidItemsResponseSchema,
			(item) => item.ratingKey,
		);
		const exactShows = shows.filter(
			(item) => item.type === "show" && item.Guid?.some((guid) => guid.id === `tvdb://${tvdbId}`),
		);
		if (exactShows.length === 0) {
			throw new PlexSeriesNotFoundError(tvdbId);
		}

		const seriesItems = await Promise.all(
			exactShows.map(async (show) => {
				const completeEpisodes = await this.getCompleteSafetyMetadata(
					`/library/metadata/${encodeURIComponent(show.ratingKey)}/allLeaves?includeMedia=1`,
					plexEpisodeMediaItemsResponseSchema,
					(item) => item.ratingKey,
				);
				const episodes = completeEpisodes.map((item) => ({
					ratingKey: item.ratingKey,
					seasonNumber: item.parentIndex,
					episodeNumber: item.index,
					parts: item.Media.flatMap((media) =>
						media.Part.map((part) => ({ file: part.file, size: part.size })),
					),
				}));
				if (episodes.length === 0) {
					throw new Error(`Plex series item ${show.ratingKey} returned no episode media`);
				}
				return { ratingKey: show.ratingKey, episodes };
			}),
		);
		return seriesItems;
	}

	/**
	 * Get watch history across all users.
	 * Uses /status/sessions/history/all for multi-user history.
	 */
	async getHistory(options?: {
		maxResults?: number;
		requireComplete?: boolean;
	}): Promise<PlexHistoryItem[]> {
		return this.getHistoryPass(options);
	}

	private async getHistoryPass(options?: {
		maxResults?: number;
		requireComplete?: boolean;
	}): Promise<PlexHistoryItem[]> {
		const allItems: PlexHistoryItem[] = [];
		const pageSize = 200;
		const maxResults = options?.maxResults ?? 5000;
		const requireComplete = options?.requireComplete ?? false;
		const seenHistoryRows = new Set<string>();
		let expectedTotal: number | undefined;
		let offset = 0;

		while (
			allItems.length < maxResults &&
			(expectedTotal === undefined || allItems.length < expectedTotal)
		) {
			const remaining =
				expectedTotal === undefined
					? maxResults - allItems.length
					: Math.min(maxResults, expectedTotal) - allItems.length;
			const take = Math.min(pageSize, remaining);

			const data = await this.request(
				`/status/sessions/history/all?sort=${HISTORY_SORT}&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${take}`,
				{ schema: plexHistoryResponseSchema },
			);

			const container = data.MediaContainer;
			const items = container.Metadata ?? [];
			if (container.offset !== offset || container.size !== items.length) {
				throw new Error("Plex history pagination metadata did not match the returned page");
			}
			if (expectedTotal === undefined) {
				expectedTotal = container.totalSize;
				if (requireComplete && expectedTotal > maxResults) {
					throw new Error(
						`Plex history contains ${expectedTotal} rows, exceeding the safe ${maxResults}-row limit`,
					);
				}
			} else if (container.totalSize !== expectedTotal) {
				throw new Error("Plex history changed while it was being paged");
			}
			if (offset + items.length > expectedTotal) {
				throw new Error("Plex history pagination exceeded its declared total");
			}
			if (items.length === 0 && offset < Math.min(expectedTotal, maxResults)) {
				throw new Error("Plex history pagination stopped before the declared total");
			}
			for (const item of items) {
				if (requireComplete && !item.historyKey) {
					throw new Error("Plex history did not provide a stable row identity");
				}
				if (item.historyKey && seenHistoryRows.has(item.historyKey)) {
					throw new Error("Plex history returned a duplicate row while paging");
				}
				if (item.historyKey) seenHistoryRows.add(item.historyKey);
				allItems.push({
					historyKey: item.historyKey,
					ratingKey: item.ratingKey,
					parentRatingKey: item.parentRatingKey ?? extractRatingKey(item.parentKey),
					grandparentRatingKey: item.grandparentRatingKey ?? extractRatingKey(item.grandparentKey),
					title: item.title,
					grandparentTitle: item.grandparentTitle,
					type: item.type,
					viewedAt: item.viewedAt,
					accountID: item.accountID,
					librarySectionID: item.librarySectionID,
				});
			}
			offset += items.length;
		}

		if (requireComplete && (expectedTotal === undefined || allItems.length !== expectedTotal)) {
			throw new Error("Plex history inventory could not be verified as complete");
		}
		return allItems;
	}

	/** Re-read and compare every watch-relevant field before publication. */
	async verifyHistorySnapshot(history: readonly PlexHistoryItem[]): Promise<void> {
		const verification = await this.getHistoryPass({
			maxResults: SAFETY_MAX_ITEMS,
			requireComplete: true,
		});
		const signatures = (items: readonly PlexHistoryItem[]) =>
			items
				.map((item) =>
					JSON.stringify([
						item.historyKey,
						item.ratingKey,
						item.parentRatingKey ?? null,
						item.grandparentRatingKey ?? null,
						item.type,
						item.viewedAt,
						item.accountID,
						item.librarySectionID ?? null,
					]),
				)
				.sort();
		if (
			verification.length !== history.length ||
			JSON.stringify(signatures(verification)) !== JSON.stringify(signatures(history))
		) {
			throw new Error("Plex history changed before its complete snapshot could be verified");
		}
	}

	/**
	 * Get on-deck (continue watching) items.
	 */
	async getOnDeck(): Promise<PlexOnDeckItem[]> {
		const items = await this.getCompleteSafetyMetadata(
			"/library/onDeck",
			plexOnDeckResponseSchema,
			(item) =>
				`${item.type}:${item.grandparentRatingKey ?? item.parentRatingKey ?? item.ratingKey}:${item.ratingKey}`,
		);

		return items.map((m) => ({
			ratingKey: m.ratingKey,
			parentRatingKey: m.parentRatingKey,
			grandparentRatingKey: m.grandparentRatingKey,
			type: m.type,
		}));
	}

	/**
	 * Get active sessions (currently playing).
	 */
	async getSessions(): Promise<PlexSessionItem[]> {
		const data = await this.request("/status/sessions", {
			schema: plexSessionsResponseSchema,
		});

		return (data.MediaContainer.Metadata ?? []).map((m) => ({
			sessionKey: m.sessionKey,
			ratingKey: m.ratingKey,
			title: m.title,
			grandparentTitle: m.grandparentTitle,
			type: m.type,
			viewOffset: m.viewOffset ?? 0,
			duration: m.duration ?? 0,
			thumb: m.thumb,
			user: m.User
				? { id: m.User.id, title: m.User.title, thumb: m.User.thumb }
				: { id: 0, title: "Unknown", thumb: undefined },
			player: m.Player
				? {
						title: m.Player.title,
						platform: m.Player.platform,
						product: m.Player.product,
						state: m.Player.state,
					}
				: { title: "Unknown", platform: "unknown", product: "unknown", state: "unknown" },
			state: (m.Player?.state ?? "unknown") as "playing" | "paused" | "buffering",
			videoDecision: m.TranscodeSession?.videoDecision ?? "direct play",
			audioDecision: m.TranscodeSession?.audioDecision ?? "direct play",
			bandwidth: m.Session?.bandwidth,
		}));
	}

	/**
	 * Refresh a library section (trigger scan).
	 */
	async refreshSection(sectionId: string): Promise<void> {
		await this.request(`/library/sections/${sectionId}/refresh`, { method: "POST" });
	}

	/**
	 * Get all episodes for a show (all leaves).
	 */
	async getEpisodes(showRatingKey: string): Promise<PlexEpisodeItem[]> {
		const items = await this.getCompleteSafetyMetadata(
			`/library/metadata/${encodeURIComponent(showRatingKey)}/allLeaves`,
			plexAllLeavesResponseSchema,
			(item) => item.ratingKey,
		);
		const seenCoordinates = new Set<string>();
		return items.map((item) => {
			if (item.parentIndex === undefined || item.index === undefined) {
				throw new Error(`Plex episode ${item.ratingKey} did not provide a complete coordinate`);
			}
			const coordinate = `${item.parentIndex}:${item.index}`;
			if (seenCoordinates.has(coordinate)) {
				throw new Error(`Plex allLeaves returned duplicate episode coordinate ${coordinate}`);
			}
			seenCoordinates.add(coordinate);
			return {
				ratingKey: item.ratingKey,
				title: item.title,
				seasonNumber: item.parentIndex,
				episodeNumber: item.index,
				viewCount: item.viewCount ?? 0,
				lastViewedAt: item.lastViewedAt,
			};
		});
	}

	/**
	 * Read the current Plex play count for one exact episode.
	 *
	 * Destructive cleanup uses this at the mutation boundary instead of
	 * authorizing from the periodically refreshed episode cache alone.
	 */
	async getEpisodeWatchCount(ratingKey: string): Promise<number> {
		const data = await this.request(`/library/metadata/${encodeURIComponent(ratingKey)}`, {
			schema: plexEpisodesResponseSchema,
		});
		const matches = (data.MediaContainer.Metadata ?? []).filter(
			(item) => item.ratingKey === ratingKey,
		);
		if (matches.length !== 1) {
			throw new Error(`Plex returned ${matches.length} items for episode ${ratingKey}`);
		}
		const watchCount = matches[0]!.viewCount ?? 0;
		if (!Number.isSafeInteger(watchCount) || watchCount < 0) {
			throw new Error(`Plex episode ${ratingKey} returned an invalid watch count`);
		}
		return watchCount;
	}

	/**
	 * Read one current Plex metadata record with the identity fields required
	 * for historical watch reproof. A missing or duplicate record is unsafe to
	 * interpret as the requested item.
	 */
	async getTargetMetadata(ratingKey: string): Promise<PlexTargetMetadata> {
		const metadata = await this.getTargetMetadataBatch([ratingKey]);
		if (metadata.length !== 1) {
			throw new Error("Plex target metadata was not uniquely identified");
		}
		return metadata[0]!;
	}

	/**
	 * Read current Plex metadata for a bounded set of historical targets.
	 * Plex accepts comma-separated metadata identifiers in one request. Missing
	 * records are returned as unavailable; an unexpected or duplicate record is
	 * unsafe to bind and fails the whole batch.
	 */
	async getTargetMetadataBatch(ratingKeys: readonly string[]): Promise<PlexTargetMetadata[]> {
		const requested = [...ratingKeys];
		if (requested.length === 0) return [];
		if (
			requested.length > TARGET_METADATA_BATCH_SIZE ||
			requested.some((ratingKey) => typeof ratingKey !== "string" || ratingKey.trim() === "") ||
			new Set(requested).size !== requested.length
		) {
			throw new Error("Plex target metadata batch request is invalid or exceeds its limit");
		}

		const data = await this.request(
			`/library/metadata/${requested.map(encodeURIComponent).join(",")}?includeGuids=1`,
			{ schema: plexTargetMetadataResponseSchema },
		);
		const expected = new Set(requested);
		const seen = new Set<string>();
		for (const item of data.MediaContainer.Metadata) {
			if (!expected.has(item.ratingKey) || seen.has(item.ratingKey)) {
				throw new Error("Plex target metadata batch returned an unexpected or duplicate item");
			}
			seen.add(item.ratingKey);
		}
		return data.MediaContainer.Metadata.map((item) => ({
			ratingKey: item.ratingKey,
			type: item.type,
			guid: item.guid,
			Guid: item.Guid.map((guid) => ({ id: guid.id })),
			librarySectionID: item.librarySectionID,
			...(item.parentRatingKey ? { parentRatingKey: item.parentRatingKey } : {}),
			...(item.grandparentRatingKey ? { grandparentRatingKey: item.grandparentRatingKey } : {}),
		}));
	}

	/**
	 * Update metadata tags (collections, labels) on a Plex item.
	 * Plex uses query-parameter encoding for tag updates.
	 */
	async updateMetadataTags(
		ratingKey: string,
		mediaType: "movie" | "series",
		type: "collection" | "label",
		action: "add" | "remove",
		name: string,
	): Promise<void> {
		const tagType = type === "collection" ? "collection" : "label";
		const suffix = action === "remove" ? "-" : "";
		const params = new URLSearchParams({
			type: mediaType === "movie" ? "1" : "2",
			[`${tagType}.locked`]: "1",
			[`${tagType}[0].tag.tag${suffix}`]: name,
		});
		const path = `/library/metadata/${ratingKey}?${params.toString()}`;
		await this.request(path, { method: "PUT" });
	}

	/**
	 * Get all user accounts on the server.
	 */
	async getAccounts(): Promise<PlexAccount[]> {
		const data = await this.request("/accounts", {
			schema: plexAccountsResponseSchema,
		});

		const accounts = data.MediaContainer.Account ?? [];
		this.assertCompleteSinglePageContainer(
			data.MediaContainer,
			accounts.length,
			"Plex account inventory",
		);
		return accounts.map((a) => ({
			id: a.id,
			name: a.name,
		}));
	}

	private assertCompleteSinglePageContainer(
		container: { offset?: number; size?: number; totalSize?: number },
		returnedCount: number,
		label: string,
	): void {
		if (
			container.size !== returnedCount ||
			(container.offset !== undefined && container.offset !== 0) ||
			(container.totalSize !== undefined && container.totalSize !== returnedCount)
		) {
			throw new Error(`${label} did not provide a complete single-page result`);
		}
	}

	private runOrdinaryRead<T>(key: string, load: () => Promise<T>, uncached: boolean): Promise<T> {
		if (uncached) return load();
		const existing = this.ordinaryReadFlights.get(key) as Promise<T> | undefined;
		if (existing) return existing;
		let promise!: Promise<T>;
		promise = (async () => {
			try {
				return await load();
			} finally {
				if (this.ordinaryReadFlights.get(key) === promise) {
					this.ordinaryReadFlights.delete(key);
				}
			}
		})();
		this.ordinaryReadFlights.set(key, promise);
		return promise;
	}

	/**
	 * Fetch a raw image from Plex (e.g., poster thumbnails).
	 * Returns the raw Response for streaming to the client.
	 */
	async fetchImage(path: string): Promise<Response> {
		const url = new URL(`${this.baseUrl}${path}`);
		const response = await fetch(url.toString(), {
			headers: { "X-Plex-Token": this.token, ...this.httpAuthHeaders },
			signal: AbortSignal.timeout(this.timeout),
		});
		if (!response.ok) {
			throw new Error(`Plex image fetch failed: HTTP ${response.status}`);
		}
		return response;
	}

	/**
	 * Execute a Plex API request with X-Plex-Token header auth.
	 * Supports GET (default), POST, PUT via the options parameter.
	 */
	async request<T>(
		path: string,
		options?: { method?: string; body?: Record<string, unknown>; schema?: z.ZodType<T> },
	): Promise<T> {
		this.readContext?.signal.throwIfAborted();
		this.readContext?.onRequest(readPhase(path));
		const url = new URL(`${this.baseUrl}${path}`);

		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Plex-Token": this.token,
			...this.httpAuthHeaders,
		};

		const fetchOptions: RequestInit = {
			method: options?.method ?? "GET",
			headers,
			signal: this.readContext
				? AbortSignal.any([this.readContext.signal, AbortSignal.timeout(this.timeout)])
				: AbortSignal.timeout(this.timeout),
		};

		if (options?.body) {
			headers["Content-Type"] = "application/json";
			fetchOptions.body = JSON.stringify(options.body);
		}

		const response = await fetch(url.toString(), fetchOptions);

		if (!response.ok) {
			this.log.warn({ status: response.status, path }, "Plex API non-OK response");
			throw new Error(`Plex API error: HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			let raw: unknown;
			try {
				raw = await response.json();
			} catch {
				throw new Error(
					`Plex API: invalid JSON response (path: ${path}, status: ${response.status})`,
				);
			}
			if (!options?.schema) {
				throw new Error(`Plex API: schema required for JSON responses (path: ${path})`);
			}
			const category = path.split("?")[0] ?? path;
			return parseUpstreamOrThrow(raw, options.schema, { integration: "plex", category });
		}

		// Non-JSON responses (e.g., from POST /library/sections/{id}/refresh)
		if (options?.schema) {
			throw new Error(`Plex API: expected JSON response but got ${contentType} (path: ${path})`);
		}
		return undefined as T;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a PlexClient with decrypted API key from an encrypted instance.
 */
export function createPlexClient(
	encryptor: Encryptor,
	instance: ClientInstanceData,
	log: FastifyBaseLogger,
): PlexClient {
	const token = encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	return new PlexClient(
		instance.baseUrl,
		token,
		log,
		DEFAULT_TIMEOUT,
		getStoredHttpAuthHeaders(encryptor, instance),
	);
}
