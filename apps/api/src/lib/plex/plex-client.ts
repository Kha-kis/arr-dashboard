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
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	plexAccountsResponseSchema,
	plexAllLeavesResponseSchema,
	plexEpisodeMediaItemsResponseSchema,
	plexEpisodesResponseSchema,
	plexHistoryResponseSchema,
	plexIdentityResponseSchema,
	plexLibraryGuidItemsResponseSchema,
	plexLibraryItemsResponseSchema,
	plexLibraryMediaItemsResponseSchema,
	plexOnDeckResponseSchema,
	plexSectionsResponseSchema,
	plexServerInfoResponseSchema,
	plexSessionsResponseSchema,
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
	thumb?: string; // Plex thumbnail path
	Guid?: PlexGuid[];
	Collection?: Array<{ tag: string }>;
	Label?: Array<{ tag: string }>;
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

// ============================================================================
// Client Implementation
// ============================================================================

const DEFAULT_TIMEOUT = 15_000;
const SAFETY_PAGE_SIZE = 200;
const SAFETY_MAX_ITEMS = 100_000;

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

export class PlexClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;
	private readonly httpAuthHeaders: Record<string, string>;
	constructor(
		baseUrl: string,
		token: string,
		log: FastifyBaseLogger,
		timeout = DEFAULT_TIMEOUT,
		httpAuthHeaders: Record<string, string> = {},
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
		}));
	}

	/**
	 * Get all items from a library section.
	 */
	async getLibraryItems(sectionId: string): Promise<PlexLibraryItem[]> {
		const items = await this.getCompleteSafetyMetadata(
			`/library/sections/${sectionId}/all?includeGuids=1&includeCollections=1&includeLabels=1`,
			plexLibraryItemsResponseSchema,
			(item) => item.ratingKey,
		);

		return items.map((m) => ({
			ratingKey: m.ratingKey,
			title: m.title,
			type: m.type,
			year: m.year,
			userRating: m.userRating,
			addedAt: m.addedAt,
			thumb: m.thumb,
			Guid: m.Guid?.map((g) => ({ id: g.id })),
			Collection: m.Collection?.map((c) => ({ tag: c.tag })),
			Label: m.Label?.map((l) => ({ tag: l.tag })),
		}));
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
		const allItems: T[] = [];
		const seenKeys = new Set<string>();
		let expectedTotal: number | undefined;
		let offset = 0;

		while (expectedTotal === undefined || offset < expectedTotal) {
			const pageUrl = new URL(path, "http://plex.invalid");
			pageUrl.searchParams.set("X-Plex-Container-Start", String(offset));
			pageUrl.searchParams.set("X-Plex-Container-Size", String(SAFETY_PAGE_SIZE));
			const page = await this.request(`${pageUrl.pathname}${pageUrl.search}`, { schema });
			const container = page.MediaContainer;
			const items = container.Metadata ?? [];

			if (container.offset !== offset || container.size !== items.length) {
				throw new Error("Plex safety pagination metadata did not match the returned page");
			}
			if (expectedTotal === undefined) {
				expectedTotal = container.totalSize;
				if (expectedTotal > SAFETY_MAX_ITEMS) {
					throw new Error("Plex safety result set is too large to verify completely");
				}
			} else if (container.totalSize !== expectedTotal) {
				throw new Error("Plex safety result set changed while it was being paged");
			}
			if (offset + items.length > expectedTotal) {
				throw new Error("Plex safety pagination exceeded its declared total");
			}
			if (items.length === 0 && offset < expectedTotal) {
				throw new Error("Plex safety pagination stopped before the declared total");
			}

			for (const item of items) {
				const key = keyOf(item);
				if (seenKeys.has(key)) {
					throw new Error("Plex safety pagination returned a duplicate item");
				}
				seenKeys.add(key);
				allItems.push(item);
			}
			offset += items.length;
		}

		if (expectedTotal === undefined || allItems.length !== expectedTotal) {
			throw new Error("Plex safety result set could not be verified as complete");
		}
		return allItems;
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
			throw new Error(`Plex returned no movie item for TMDb ${tmdbId}`);
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
				`/status/sessions/history/all?sort=viewedAt:desc,historyKey:desc&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${take}`,
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
	 * Update metadata tags (collections, labels) on a Plex item.
	 * Plex uses query-parameter encoding for tag updates.
	 */
	async updateMetadataTags(
		ratingKey: string,
		type: "collection" | "label",
		action: "add" | "remove",
		name: string,
	): Promise<void> {
		const tagType = type === "collection" ? "collection" : "label";
		const suffix = action === "remove" ? "-" : "";
		const path = `/library/metadata/${ratingKey}?${tagType}[0].tag.tag${suffix}=${encodeURIComponent(name)}`;
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
		const url = new URL(`${this.baseUrl}${path}`);

		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Plex-Token": this.token,
			...this.httpAuthHeaders,
		};

		const fetchOptions: RequestInit = {
			method: options?.method ?? "GET",
			headers,
			signal: AbortSignal.timeout(this.timeout),
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
