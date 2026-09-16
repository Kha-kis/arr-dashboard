/**
 * Jellyfin Media Server API Client
 *
 * Client for the Jellyfin API using API key or user token authentication.
 * Jellyfin uses the Authorization: MediaBrowser header format.
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
import { parseUpstreamOrThrow, UpstreamValidationError } from "../validation/parse-upstream.js";
import {
	jellyfinEpisodeItemsPageSchema,
	jellyfinItemDetailSchema,
	jellyfinItemsResponseSchema,
	jellyfinLibrariesResponseSchema,
	jellyfinMutationAncestorsSchema,
	jellyfinMutationItemSchema,
	jellyfinMutationServerInfoSchema,
	jellyfinMutationUsersSchema,
	jellyfinNativeEpisodeItemsResponseSchema,
	jellyfinNativeLibraryItemsResponseSchema,
	jellyfinNativeMediaFoldersResponseSchema,
	jellyfinPublicInfoSchema,
	jellyfinServerInfoSchema,
	jellyfinSessionsResponseSchema,
	jellyfinTargetWatchItemSchema,
	jellyfinUsersResponseSchema,
} from "./jellyfin-schemas.js";

// ============================================================================
// Response Types
// ============================================================================

export interface JellyfinServerInfo {
	id: string;
	serverName: string;
	version: string;
	operatingSystem: string;
}

export interface JellyfinLibrary {
	id: string;
	name: string;
	collectionType: string; // "movies" | "tvshows" | "music" | "books"
}

export interface JellyfinItem {
	id: string;
	name: string;
	type: string;
	seriesName?: string;
	seriesId?: string;
	episodeNumber?: number;
	seasonNumber?: number;
	year?: number;
	tmdbId?: number;
	imdbId?: string;
	played: boolean;
	playCount: number;
	lastPlayedDate: string | null;
	isFavorite: boolean;
	dateCreated?: string;
	imageTags?: Record<string, string>;
}

export type JellyfinNativeLibraryItemType = "Movie" | "Series" | "BoxSet";
export type JellyfinNativeLibraryIncludeItemTypes = "Movie" | "Series" | "Movie,Series";

export interface JellyfinNativeLibraryItem {
	id: string;
	type: JellyfinNativeLibraryItemType;
	name: string;
	externalIds?: NativeInventoryExternalIds;
}

export interface JellyfinNativeEpisodeItem {
	id: string;
	type: "Episode";
	name: string;
	seriesId?: string;
	seasonNumber?: number;
	episodeNumber?: number;
}

export interface JellyfinUser {
	id: string;
	name: string;
}

export interface JellyfinSession {
	id: string;
	userId?: string;
	userName?: string;
	client?: string;
	deviceName?: string;
	remoteEndPoint?: string;
	isPaused: boolean;
	playMethod?: string;
	/** Position in the current item (milliseconds, converted from ticks) */
	positionMs: number;
	/** Total duration of the current item (milliseconds, converted from ticks) */
	durationMs: number;
	nowPlayingItem?: JellyfinItem;
	transcodingInfo?: {
		isVideoDirect: boolean;
		isAudioDirect: boolean;
		bitrate?: number;
		width?: number;
		height?: number;
		audioCodec?: string;
		videoCodec?: string;
	};
}

// ============================================================================
// Client Implementation
// ============================================================================

const DEFAULT_TIMEOUT = 15_000;
const DEVICE_ID = "arr-dashboard-server";
const CLIENT_NAME = "Arr Control Center";
const COMPLETE_ITEMS_PAGE_SIZE = 1000;
const COMPLETE_ITEMS_MAX = 100_000;
const NATIVE_PAGE_RETRY_DELAYS_MS = [1000, 2000] as const;

function jellyfinExternalIds(
	providerIds: Readonly<Record<string, string>> | undefined,
): NativeInventoryExternalIds {
	const tmdb: unknown[] = [];
	const tvdb: unknown[] = [];
	for (const [key, value] of Object.entries(providerIds ?? {})) {
		if (key.toLowerCase() !== "tmdb" && key.toLowerCase() !== "tvdb") continue;
		const id = normalizeNativeExternalId(value);
		if (id === undefined) continue;
		(key.toLowerCase() === "tmdb" ? tmdb : tvdb).push(id);
	}
	return normalizeNativeInventoryExternalIds({ tmdb, tvdb });
}

export interface JellyfinCompleteItemsResult {
	items: JellyfinItem[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
}

export interface JellyfinNativeLibraryCoverageResult {
	items: JellyfinNativeLibraryItem[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
}

export interface JellyfinNativeEpisodeCoverageResult {
	items: JellyfinNativeEpisodeItem[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
}

export interface JellyfinEpisodeCoverageResult extends JellyfinCompleteItemsResult {
	failureMessage?: string;
}

export interface JellyfinEpisodeObservationItem {
	excludedReason?: never;
	id: string;
	name: string;
	type: "Episode";
	seriesId: string;
	episodeNumber: number;
	seasonNumber: number;
	played: boolean;
	playCount: number | null;
	lastPlayedDate: string | null;
}

export interface JellyfinEpisodeExcludedItem {
	id: string;
	type: "Episode";
	excludedReason: "missing-episode-metadata";
}

export interface JellyfinEpisodeItemsPage {
	/** Includes excluded identities so raw offsets are never shortened. */
	items: Array<JellyfinEpisodeObservationItem | JellyfinEpisodeExcludedItem>;
	startIndex: number;
	totalRecordCount: number;
}

export interface JellyfinMutationTargetSnapshot {
	readonly serverId: string;
	readonly itemId: string;
	readonly mediaType: "movie" | "series";
	readonly tmdbId: number;
	readonly tags: readonly string[];
	readonly ancestorIds: readonly string[];
}

export interface JellyfinTargetWatchRead {
	readonly serverId: string;
	readonly itemId: string;
	readonly mediaType: "movie" | "series";
	readonly tmdbId: number;
	readonly libraryId: string;
	readonly observedValue: number;
}

type JellyfinMutationItemDto = z.infer<typeof jellyfinMutationItemSchema>;

interface StoredMutationTarget {
	dto: JellyfinMutationItemDto;
	userId: string;
	serverId: string;
	itemId: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	tags: readonly string[];
	ancestorIds: readonly string[];
}

type JellyfinRawItem = z.infer<typeof jellyfinItemsResponseSchema>["Items"][number];

interface JellyfinItemsEnvelope {
	Items: Array<{ Id: string }>;
	StartIndex?: number;
	TotalRecordCount: number;
}

type JellyfinPageValidator<T> = (page: T, requestedStartIndex: number) => string | undefined;

interface JellyfinRawItemsResult<T extends { Id: string } = JellyfinRawItem> {
	items: T[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
	failureMessage?: string;
}

export class JellyfinClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;
	private readonly httpAuthHeaders: Record<string, string>;
	private readonly mutationTargets = new WeakMap<
		JellyfinMutationTargetSnapshot,
		StoredMutationTarget
	>();

	constructor(
		baseUrl: string,
		apiKey: string,
		log: FastifyBaseLogger,
		timeout = DEFAULT_TIMEOUT,
		httpAuthHeaders: Record<string, string> = {},
	) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.log = log;
		this.timeout = timeout;
		this.httpAuthHeaders = httpAuthHeaders;
	}

	/**
	 * Get public server info (no auth required).
	 */
	async getPublicInfo(): Promise<JellyfinServerInfo> {
		const data = await this.request("/System/Info/Public", {
			schema: jellyfinPublicInfoSchema,
			skipAuth: true,
		});
		return {
			id: data.Id,
			serverName: data.ServerName,
			version: data.Version,
			operatingSystem: data.OperatingSystem ?? "",
		};
	}

	/**
	 * Get full server info (requires auth).
	 */
	async getServerInfo(): Promise<JellyfinServerInfo> {
		const data = await this.request("/System/Info", {
			schema: jellyfinServerInfoSchema,
		});
		return {
			id: data.Id,
			serverName: data.ServerName,
			version: data.Version,
			operatingSystem: data.OperatingSystemDisplayName ?? data.OperatingSystem ?? "",
		};
	}

	/**
	 * Get all users on the server.
	 */
	async getUsers(): Promise<JellyfinUser[]> {
		const data = await this.request("/Users", {
			schema: jellyfinUsersResponseSchema,
		});
		return data.map((u) => ({ id: u.Id, name: u.Name }));
	}

	/**
	 * Get library views for a user.
	 */
	async getLibraries(userId: string): Promise<JellyfinLibrary[]> {
		const data = await this.request(`/Users/${encodeURIComponent(userId)}/Views`, {
			schema: jellyfinLibrariesResponseSchema,
		});
		if (data.Items.length !== data.TotalRecordCount) {
			throw new Error("Jellyfin library inventory was not returned completely");
		}
		return data.Items.map((lib) => ({
			id: lib.Id,
			name: lib.Name,
			collectionType: lib.CollectionType ?? lib.Type,
		}));
	}

	/** Get the server's complete native media-folder inventory. */
	async getNativeMediaFolders(options?: {
		mutationValidation?: boolean;
	}): Promise<JellyfinLibrary[]> {
		const data = options?.mutationValidation
			? await this.mutationRequest("/Library/MediaFolders", {
					schema: jellyfinNativeMediaFoldersResponseSchema,
				})
			: await this.request("/Library/MediaFolders", {
					schema: jellyfinNativeMediaFoldersResponseSchema,
				});
		if (data.Items.length !== data.TotalRecordCount) {
			throw new Error("Jellyfin native media-folder inventory was not returned completely");
		}
		if (
			data.StartIndex !== undefined &&
			(!Number.isSafeInteger(data.StartIndex) || data.StartIndex !== 0)
		) {
			throw new Error("Jellyfin native media-folder cursor is invalid");
		}
		const ids = new Set<string>();
		return data.Items.map((folder) => {
			if (ids.has(folder.Id))
				throw new Error("Jellyfin native media folders contain duplicate IDs");
			ids.add(folder.Id);
			return {
				id: folder.Id,
				name: folder.Name,
				collectionType: folder.CollectionType ?? folder.Type,
			};
		});
	}

	/**
	 * Get all items in a library with TMDB IDs and user data.
	 */
	async getLibraryItems(
		userId: string,
		libraryId: string,
		options?: { includeItemTypes?: string },
	): Promise<JellyfinItem[]> {
		const result = await this.getLibraryItemsWithRawCoverage(userId, libraryId, options);
		if (result.reason !== null) {
			throw new Error(
				result.failureMessage ?? "Jellyfin item inventory could not be verified as complete",
			);
		}
		return result.items.map(mapItem);
	}

	/**
	 * Get all items in a library with bounded pagination accounting. A page
	 * failure never exposes rows observed before that failure.
	 */
	async getLibraryItemsWithCoverage(
		userId: string,
		libraryId: string,
		options?: { includeItemTypes?: string },
	): Promise<JellyfinCompleteItemsResult> {
		const result = await this.getLibraryItemsWithRawCoverage(userId, libraryId, options);
		return {
			items: result.reason === null ? result.items.map(mapItem) : [],
			expectedRawCount: result.expectedRawCount,
			pagesAttempted: result.pagesAttempted,
			pagesCompleted: result.pagesCompleted,
			rawObserved: result.rawObserved,
			reason: result.reason,
		};
	}

	/**
	 * Get the complete native movie, series, and box-set inventory for one
	 * native library. Native rows request provider IDs while omitting watch and
	 * image metadata, so presence remains independent of those optional projections.
	 */
	async getNativeLibraryItemsWithCoverage(
		libraryId: string,
		options?: {
			includeItemTypes?: JellyfinNativeLibraryIncludeItemTypes;
			mutationValidation?: boolean;
		},
	): Promise<JellyfinNativeLibraryCoverageResult> {
		const params = new URLSearchParams({
			ParentId: libraryId,
			IncludeItemTypes: options?.includeItemTypes ?? "Movie,Series,BoxSet",
			Recursive: "true",
			CollapseBoxSetItems: "false",
			EnableUserData: "false",
			EnableImages: "false",
			Fields: "ProviderIds",
		});

		const result = await this.getNativeCompleteItemsWithCoverage(
			`/Items?${params.toString()}`,
			jellyfinNativeLibraryItemsResponseSchema,
			(page, requestedStartIndex) =>
				Number.isSafeInteger(page.StartIndex) &&
				page.StartIndex >= 0 &&
				page.StartIndex === requestedStartIndex
					? undefined
					: "Jellyfin native library page cursor is invalid",
			options?.mutationValidation,
		);
		return {
			items:
				result.reason === null
					? result.items.map((item) => {
							const externalIds = jellyfinExternalIds(item.ProviderIds);
							return {
								id: item.Id,
								type: item.Type,
								name: item.Name,
								...(hasNativeInventoryExternalIds(externalIds) ? { externalIds } : {}),
							};
						})
					: [],
			expectedRawCount: result.expectedRawCount,
			pagesAttempted: result.pagesAttempted,
			pagesCompleted: result.pagesCompleted,
			rawObserved: result.rawObserved,
			reason: result.reason,
		};
	}

	/**
	 * Get the complete native Episode inventory for one native library. This
	 * request deliberately does not request user-data or provider mapping
	 * fields, so native presence remains independent of watch state and TMDB
	 * matching.
	 */
	async getNativeEpisodeItemsWithCoverage(
		libraryId: string,
	): Promise<JellyfinNativeEpisodeCoverageResult> {
		const params = new URLSearchParams({
			ParentId: libraryId,
			IncludeItemTypes: "Episode",
			Recursive: "true",
			CollapseBoxSetItems: "false",
			EnableUserData: "false",
			EnableImages: "false",
		});
		const result = await this.getNativeCompleteItemsWithCoverage(
			`/Items?${params.toString()}`,
			jellyfinNativeEpisodeItemsResponseSchema,
			(page, requestedStartIndex) =>
				Number.isSafeInteger(page.StartIndex) &&
				page.StartIndex >= 0 &&
				page.StartIndex === requestedStartIndex
					? undefined
					: "Jellyfin native episode page cursor is invalid",
		);
		return {
			items:
				result.reason === null
					? result.items.map((item) => ({
							id: item.Id,
							type: item.Type,
							name: item.Name,
							...(item.SeriesId ? { seriesId: item.SeriesId } : {}),
							...(item.ParentIndexNumber !== undefined
								? { seasonNumber: item.ParentIndexNumber }
								: {}),
							...(item.IndexNumber !== undefined ? { episodeNumber: item.IndexNumber } : {}),
						}))
					: [],
			expectedRawCount: result.expectedRawCount,
			pagesAttempted: result.pagesAttempted,
			pagesCompleted: result.pagesCompleted,
			rawObserved: result.rawObserved,
			reason: result.reason,
		};
	}

	private async getLibraryItemsWithRawCoverage(
		userId: string,
		libraryId: string,
		options?: { includeItemTypes?: string },
	): Promise<JellyfinRawItemsResult> {
		const params = new URLSearchParams({
			ParentId: libraryId,
			Fields: "ProviderIds,DateCreated,ImageTags",
			Recursive: "true",
			CollapseBoxSetItems: "false",
		});
		if (options?.includeItemTypes) {
			params.set("IncludeItemTypes", options.includeItemTypes);
		}

		return await this.getCompleteItemsWithCoverage(
			`/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`,
		);
	}

	/**
	 * Get resume items (continue watching) for a user.
	 */
	async getResumeItems(userId: string): Promise<JellyfinItem[]> {
		const items = await this.getCompleteItems(
			`/Users/${encodeURIComponent(userId)}/Items/Resume?Fields=ProviderIds`,
		);
		return items.map(mapItem);
	}

	/**
	 * Get next up episodes for a user (TV shows).
	 */
	async getNextUp(userId: string): Promise<JellyfinItem[]> {
		const items = await this.getCompleteItems(
			`/Shows/NextUp?userId=${encodeURIComponent(userId)}&Fields=ProviderIds`,
		);
		return items.map(mapItem);
	}

	/**
	 * Get active sessions (now playing).
	 */
	async getSessions(): Promise<JellyfinSession[]> {
		const data = await this.request("/Sessions", {
			schema: jellyfinSessionsResponseSchema,
		});
		// Filter to sessions with active playback
		const TICKS_PER_MS = 10_000;
		return data
			.filter((s) => s.NowPlayingItem)
			.map((s) => ({
				id: s.Id,
				userId: s.UserId,
				userName: s.UserName,
				client: s.Client,
				deviceName: s.DeviceName,
				remoteEndPoint: s.RemoteEndPoint,
				isPaused: s.PlayState?.IsPaused ?? false,
				playMethod: s.PlayState?.PlayMethod,
				positionMs: Math.round((s.PlayState?.PositionTicks ?? 0) / TICKS_PER_MS),
				durationMs: Math.round((s.NowPlayingItem?.RunTimeTicks ?? 0) / TICKS_PER_MS),
				nowPlayingItem: s.NowPlayingItem ? mapItem(s.NowPlayingItem) : undefined,
				transcodingInfo: s.TranscodingInfo
					? {
							isVideoDirect: s.TranscodingInfo.IsVideoDirect ?? true,
							isAudioDirect: s.TranscodingInfo.IsAudioDirect ?? true,
							bitrate: s.TranscodingInfo.Bitrate,
							width: s.TranscodingInfo.Width,
							height: s.TranscodingInfo.Height,
							audioCodec: s.TranscodingInfo.AudioCodec,
							videoCodec: s.TranscodingInfo.VideoCodec,
						}
					: undefined,
			}));
	}

	/**
	 * Get episodes for a series with watch status.
	 */
	async getEpisodes(userId: string, seriesId: string): Promise<JellyfinItem[]> {
		const result = await this.getEpisodesWithCoverage(userId, seriesId);
		if (result.reason !== null) {
			throw new Error(
				result.failureMessage ?? "Jellyfin episode inventory could not be verified as complete",
			);
		}
		return result.items;
	}

	/**
	 * Get episodes with bounded pagination accounting. A page failure never
	 * exposes rows observed before that failure.
	 */
	async getEpisodesWithCoverage(
		userId: string,
		seriesId: string,
	): Promise<JellyfinEpisodeCoverageResult> {
		const result = await this.getCompleteItemsWithCoverage(
			`/Shows/${encodeURIComponent(seriesId)}/Episodes?userId=${encodeURIComponent(userId)}&Fields=ProviderIds`,
		);
		return {
			items: result.reason === null ? result.items.map(mapItem) : [],
			expectedRawCount: result.expectedRawCount,
			pagesAttempted: result.pagesAttempted,
			pagesCompleted: result.pagesCompleted,
			rawObserved: result.rawObserved,
			reason: result.reason,
			...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
		};
	}

	/**
	 * Read one immutable-size page for the durable episode collector. This is
	 * intentionally separate from the compatibility series fan-out helpers: a
	 * caller must persist and re-prove the cursor/total before asking for the
	 * next page.
	 */
	async getEpisodeItemsPageWithCoverage(
		userId: string,
		libraryId: string,
		startIndex: number,
		limit = COMPLETE_ITEMS_PAGE_SIZE,
	): Promise<JellyfinEpisodeItemsPage> {
		if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
			throw new Error("Jellyfin episode page start index is invalid");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > COMPLETE_ITEMS_PAGE_SIZE) {
			throw new Error("Jellyfin episode page limit is invalid");
		}
		const params = new URLSearchParams({
			ParentId: libraryId,
			IncludeItemTypes: "Episode",
			Recursive: "true",
			EnableUserData: "true",
			Fields: "ProviderIds,UserData",
			StartIndex: String(startIndex),
			Limit: String(limit),
		});
		const response = await this.request(
			`/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`,
			{ schema: jellyfinEpisodeItemsPageSchema },
		);
		if (
			!Number.isSafeInteger(response.StartIndex) ||
			response.StartIndex < 0 ||
			!Number.isSafeInteger(response.TotalRecordCount) ||
			response.TotalRecordCount < 0 ||
			response.StartIndex !== startIndex
		) {
			throw new Error("Jellyfin episode page coverage is inconsistent");
		}
		if (response.TotalRecordCount > COMPLETE_ITEMS_MAX) {
			throw new Error("Jellyfin episode page exceeds the safe 100000-row limit");
		}
		const ids = new Set<string>();
		for (const item of response.Items) {
			if (
				item.Type !== "Episode" ||
				item.Id.trim().length === 0 ||
				(item.ParentIndexNumber != null &&
					(!Number.isSafeInteger(item.ParentIndexNumber) || item.ParentIndexNumber < 0)) ||
				(item.IndexNumber != null &&
					(!Number.isSafeInteger(item.IndexNumber) || item.IndexNumber < 0)) ||
				!item.UserData ||
				typeof item.UserData.Played !== "boolean" ||
				(item.UserData.PlayCount !== undefined &&
					item.UserData.PlayCount !== null &&
					(!Number.isSafeInteger(item.UserData.PlayCount) || item.UserData.PlayCount < 0)) ||
				(item.UserData.LastPlayedDate !== undefined &&
					item.UserData.LastPlayedDate !== null &&
					!Number.isFinite(Date.parse(item.UserData.LastPlayedDate))) ||
				ids.has(item.Id)
			) {
				throw new Error("Jellyfin episode page rows are inconsistent");
			}
			ids.add(item.Id);
		}
		if (
			response.Items.length > limit ||
			startIndex + response.Items.length > response.TotalRecordCount
		) {
			throw new Error("Jellyfin episode page coverage is inconsistent");
		}
		return {
			items: response.Items.map((item) => {
				if (!item.SeriesId?.trim() || item.IndexNumber == null || item.ParentIndexNumber == null) {
					return {
						id: item.Id,
						type: "Episode" as const,
						excludedReason: "missing-episode-metadata" as const,
					};
				}
				return {
					id: item.Id,
					name: item.Name,
					type: "Episode" as const,
					seriesId: item.SeriesId!,
					episodeNumber: item.IndexNumber!,
					seasonNumber: item.ParentIndexNumber!,
					played: item.UserData!.Played!,
					playCount: item.UserData!.PlayCount ?? null,
					lastPlayedDate: item.UserData!.LastPlayedDate ?? null,
				};
			}),
			startIndex: response.StartIndex,
			totalRecordCount: response.TotalRecordCount,
		};
	}

	/**
	 * Trigger a library scan.
	 */
	async refreshLibrary(): Promise<void> {
		await this.request("/Library/Refresh", { method: "POST" });
	}

	/**
	 * Find items across all libraries that carry the given tag. Used by the
	 * label-sync source reader for Jellyfin/Emby — the JellyfinCache table
	 * doesn't store per-item tags, so we hit the live API.
	 */
	async getItemsByTag(userId: string, tagName: string): Promise<JellyfinItem[]> {
		const params = new URLSearchParams({
			Tags: tagName,
			Recursive: "true",
			Fields: "ProviderIds,DateCreated,Tags",
			IncludeItemTypes: "Movie,Series",
			Limit: "10000",
		});

		// Force RFC 3986 spaces (%20) instead of form-urlencoded `+` because tag
		// names like "Kids Stuff" carry user-supplied spaces; strict upstream URL
		// parsers can reject `+` in query values (see issue #470 for the Seerr
		// equivalent). Jellyfin's parser usually accepts both, but normalising
		// removes a class of latent failure.
		const items = await this.getCompleteItems(
			`/Users/${encodeURIComponent(userId)}/Items?${params.toString().replace(/\+/g, "%20")}`,
		);
		return items.map(mapItem);
	}

	/**
	 * Append a tag to an item. Read-modify-write against
	 * `POST /Items/{id}` — the canonical update endpoint that Jellyfin and
	 * Emby both implement. Idempotent: if the tag is already present we
	 * skip the write.
	 */
	async addItemTag(userId: string, itemId: string, tagName: string): Promise<void> {
		const detail = await this.request(
			`/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=Tags`,
			{ schema: jellyfinItemDetailSchema },
		);
		const existing = Array.isArray(detail.Tags) ? detail.Tags : [];
		if (existing.includes(tagName)) {
			return;
		}

		const merged = [...existing, tagName];
		// POST /Items/{id} expects the full BaseItemDto round-tripped back —
		// the passthrough schema preserves any fields we didn't model.
		const updatedDetail: Record<string, unknown> = { ...detail, Tags: merged };
		await this.request(`/Items/${encodeURIComponent(itemId)}`, {
			method: "POST",
			body: updatedDetail,
		});
	}

	/**
	 * Read the exact identity required for a future tag update. API keys do not
	 * carry a user ID, so Jellyfin 10.11 requires an explicit enabled admin
	 * context for both item detail and its translated library ancestors.
	 * The returned handle is intentionally smaller than the validated item DTO;
	 * the latter remains private to this client for the one-shot update.
	 */
	async readMutationTarget(itemId: string): Promise<JellyfinMutationTargetSnapshot> {
		if (!isMutationIdentifier(itemId)) {
			throw new Error("Jellyfin mutation target read failed");
		}
		try {
			const server = await this.mutationRequest("/System/Info", {
				schema: jellyfinMutationServerInfoSchema,
			});
			const users = await this.mutationRequest("/Users", { schema: jellyfinMutationUsersSchema });
			const userId = users
				.filter((user) => user.Policy.IsAdministrator && !user.Policy.IsDisabled)
				.map((user) => user.Id)
				.sort()[0];
			if (!userId) throw new Error("mutation user context unavailable");
			const userQuery = `?userId=${encodeURIComponent(userId)}`;
			const encodedItemId = encodeURIComponent(itemId);
			const item = await this.mutationRequest(`/Items/${encodedItemId}${userQuery}`, {
				schema: jellyfinMutationItemSchema,
			});
			if (item.Id !== itemId) throw new Error("item identity mismatch");
			const tmdbId = getCanonicalMutationTmdbId(item.ProviderIds);

			const ancestors = await this.mutationRequest(
				`/Items/${encodedItemId}/Ancestors${userQuery}`,
				{
					schema: jellyfinMutationAncestorsSchema,
				},
			);
			const ancestorIds = ancestors.map((ancestor) => ancestor.Id);
			if (new Set(ancestorIds).size !== ancestorIds.length) {
				throw new Error("duplicate ancestor identity");
			}

			const mediaType = item.Type === "Movie" ? "movie" : "series";
			const tags = [...item.Tags];
			const snapshot: JellyfinMutationTargetSnapshot = Object.freeze({
				serverId: server.Id,
				itemId: item.Id,
				mediaType,
				tmdbId,
				tags: Object.freeze(tags),
				ancestorIds: Object.freeze([...ancestorIds]),
			});
			this.mutationTargets.set(snapshot, {
				dto: item,
				userId,
				serverId: snapshot.serverId,
				itemId: snapshot.itemId,
				mediaType: snapshot.mediaType,
				tmdbId: snapshot.tmdbId,
				tags: snapshot.tags,
				ancestorIds: snapshot.ancestorIds,
			});
			return snapshot;
		} catch {
			throw new Error("Jellyfin mutation target read failed");
		}
	}

	/**
	 * Read one native item and its per-user watch state using GET requests only.
	 * A positive result is the maximum safe PlayCount among users whose item
	 * response explicitly says Played. Missing UserData is never interpreted as
	 * zero. Every user is read so a positive subset remains independently bound
	 * to the current Jellyfin user identities.
	 */
	async readTargetWatchCount(options: {
		itemId: string;
		mediaType: "movie" | "series";
		tmdbId: number;
		libraryId: string;
	}): Promise<JellyfinTargetWatchRead> {
		if (
			!isMutationIdentifier(options.itemId) ||
			!isMutationIdentifier(options.libraryId) ||
			!Number.isSafeInteger(options.tmdbId) ||
			options.tmdbId <= 0
		) {
			throw new Error("Jellyfin target watch read failed");
		}
		try {
			const server = await this.mutationRequest("/System/Info", {
				schema: jellyfinMutationServerInfoSchema,
			});
			const users = await this.mutationRequest("/Users", {
				schema: jellyfinMutationUsersSchema,
			});
			if (users.length === 0) throw new Error("target watch users unavailable");
			const adminUserId = users
				.filter((user) => user.Policy.IsAdministrator && !user.Policy.IsDisabled)
				.map((user) => user.Id)
				.sort()[0];
			if (!adminUserId) throw new Error("target watch admin unavailable");
			const encodedItemId = encodeURIComponent(options.itemId);
			const userItemResults = await Promise.allSettled(
				users.map((user) =>
					this.mutationRequest(
						`/Users/${encodeURIComponent(user.Id)}/Items/${encodedItemId}?Fields=ProviderIds,UserData`,
						{ schema: jellyfinTargetWatchItemSchema },
					),
				),
			);
			const userItems = userItemResults
				.filter(
					(
						result,
					): result is PromiseFulfilledResult<z.infer<typeof jellyfinTargetWatchItemSchema>> =>
						result.status === "fulfilled",
				)
				.map((result) => result.value);
			if (userItems.length === 0) throw new Error("target watch item unavailable");
			const expectedType = options.mediaType === "movie" ? "Movie" : "Series";
			for (const item of userItems) {
				if (item.Id !== options.itemId || item.Type !== expectedType) {
					throw new Error("target watch item identity mismatch");
				}
				if (getCanonicalMutationTmdbId(item.ProviderIds ?? {}) !== options.tmdbId) {
					throw new Error("target watch TMDb identity mismatch");
				}
			}
			const ancestors = await this.mutationRequest(
				`/Items/${encodedItemId}/Ancestors?userId=${encodeURIComponent(adminUserId)}`,
				{ schema: jellyfinMutationAncestorsSchema },
			);
			const ancestorIds = ancestors.map((ancestor) => ancestor.Id);
			if (
				new Set(ancestorIds).size !== ancestorIds.length ||
				!ancestorIds.includes(options.libraryId)
			) {
				throw new Error("target watch library identity mismatch");
			}
			let observedValue = 0;
			for (const item of userItems) {
				const userData = item.UserData;
				if (
					userData?.PlayCount !== undefined &&
					userData.PlayCount !== null &&
					(!Number.isSafeInteger(userData.PlayCount) || userData.PlayCount < 0)
				) {
					throw new Error("target watch count is invalid");
				}
				if (userData?.Played !== true) continue;
				if (userData?.PlayCount !== undefined && userData.PlayCount !== null) {
					observedValue = Math.max(observedValue, userData.PlayCount);
				}
			}
			return Object.freeze({
				serverId: server.Id,
				itemId: options.itemId,
				mediaType: options.mediaType,
				tmdbId: options.tmdbId,
				libraryId: options.libraryId,
				observedValue,
			});
		} catch {
			throw new Error("Jellyfin target watch read failed");
		}
	}

	/**
	 * Consume a target handle and replace its full validated DTO with a tag
	 * union. Handles are client-local and one-shot, including the no-op path.
	 */
	async addMutationTargetTag(
		target: JellyfinMutationTargetSnapshot,
		tag: string,
	): Promise<"sent" | "noop"> {
		if (!isMutationTag(tag)) {
			throw new Error("Jellyfin mutation tag is invalid");
		}
		if (typeof target !== "object" || target === null) {
			throw new Error("Jellyfin mutation target handle is invalid");
		}
		const stored = this.mutationTargets.get(target);
		if (!stored || !isStoredMutationTargetIntact(target, stored)) {
			throw new Error("Jellyfin mutation target handle is invalid");
		}
		this.mutationTargets.delete(target);

		if (stored.tags.includes(tag)) return "noop";

		const updatedDetail: JellyfinMutationItemDto = {
			...stored.dto,
			Tags: [...stored.tags, tag],
		};
		return await this.sendMutationTargetUpdate(
			`/Items/${encodeURIComponent(stored.itemId)}`,
			updatedDetail,
		);
	}

	/**
	 * Get image URL for an item (for proxying).
	 */
	getImageUrl(itemId: string, imageType = "Primary", maxWidth = 300): string {
		return `${this.baseUrl}/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(imageType)}?maxWidth=${maxWidth}`;
	}

	/**
	 * Fetch a raw image from Jellyfin.
	 */
	async fetchImage(itemId: string, imageType = "Primary", maxWidth = 300): Promise<Response> {
		const url = this.getImageUrl(itemId, imageType, maxWidth);
		const response = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(this.timeout),
		});
		if (!response.ok) {
			throw new Error(`Jellyfin image fetch failed: HTTP ${response.status}`);
		}
		return response;
	}

	// ========================================================================
	// Internal helpers
	// ========================================================================

	private async getCompleteItems(path: string): Promise<JellyfinRawItem[]> {
		const result = await this.getCompleteItemsWithCoverage(path);
		if (result.reason !== null) {
			throw new Error(
				result.failureMessage ?? "Jellyfin item inventory could not be verified as complete",
			);
		}
		return result.items;
	}

	private async getCompleteItemsWithCoverage(
		path: string,
	): Promise<JellyfinRawItemsResult<JellyfinRawItem>>;
	private async getCompleteItemsWithCoverage<T extends JellyfinItemsEnvelope>(
		path: string,
		schema: z.ZodType<T>,
		validatePage?: JellyfinPageValidator<T>,
	): Promise<JellyfinRawItemsResult<T["Items"][number]>>;
	private async getCompleteItemsWithCoverage<T extends JellyfinItemsEnvelope>(
		path: string,
		schema: z.ZodType<T> = jellyfinItemsResponseSchema as unknown as z.ZodType<T>,
		validatePage?: JellyfinPageValidator<T>,
		mutationValidation = false,
	): Promise<JellyfinRawItemsResult<T["Items"][number]>> {
		const items: T["Items"][number][] = [];
		const seenIds = new Set<string>();
		let expectedTotal: number | null = null;
		let startIndex = 0;
		let pagesAttempted = 0;
		let pagesCompleted = 0;
		let failureMessage: string | undefined;

		while (expectedTotal === null || startIndex < expectedTotal) {
			pagesAttempted++;
			const pageUrl = new URL(path, "http://jellyfin.invalid");
			pageUrl.searchParams.set("StartIndex", String(startIndex));
			pageUrl.searchParams.set("Limit", String(COMPLETE_ITEMS_PAGE_SIZE));
			let data: T;
			try {
				data = mutationValidation
					? await this.mutationRequest(`${pageUrl.pathname}${pageUrl.search}`, { schema })
					: await this.request(`${pageUrl.pathname}${pageUrl.search}`, { schema });
			} catch {
				failureMessage = "Jellyfin item page request failed";
				break;
			}
			const pageValidationFailure = validatePage?.(data, startIndex);
			if (pageValidationFailure) {
				failureMessage = pageValidationFailure;
				break;
			}

			if (expectedTotal === null) {
				expectedTotal = data.TotalRecordCount;
			}
			if (
				!Number.isSafeInteger(data.TotalRecordCount) ||
				data.TotalRecordCount < 0 ||
				data.TotalRecordCount > COMPLETE_ITEMS_MAX
			) {
				failureMessage = `Jellyfin item inventory contains ${data.TotalRecordCount} rows, exceeding the safe ${COMPLETE_ITEMS_MAX}-row limit`;
				break;
			}
			if (data.TotalRecordCount !== expectedTotal) {
				failureMessage = "Jellyfin item inventory changed while it was being paged";
				break;
			}
			if (
				data.Items.length > COMPLETE_ITEMS_PAGE_SIZE ||
				startIndex + data.Items.length > expectedTotal
			) {
				failureMessage = "Jellyfin item pagination exceeded its declared total";
				break;
			}
			if (data.Items.length === 0 && startIndex < expectedTotal) {
				failureMessage = "Jellyfin item pagination stopped before the declared total";
				break;
			}

			const pageIds = new Set<string>();
			let invalidIdentity = false;
			for (const item of data.Items) {
				if (!item.Id.trim() || seenIds.has(item.Id) || pageIds.has(item.Id)) {
					invalidIdentity = true;
					break;
				}
				pageIds.add(item.Id);
			}
			if (invalidIdentity) {
				failureMessage = "Jellyfin item pagination returned a duplicate item";
				break;
			}
			for (const item of data.Items) {
				seenIds.add(item.Id);
				items.push(item);
			}
			pagesCompleted++;
			startIndex += data.Items.length;
		}

		if (failureMessage || expectedTotal === null || items.length !== expectedTotal) {
			return {
				items: [],
				expectedRawCount: expectedTotal,
				pagesAttempted,
				pagesCompleted,
				rawObserved: items.length,
				reason: "page-failure",
				...(failureMessage ? { failureMessage } : {}),
			};
		}
		return {
			items,
			expectedRawCount: expectedTotal,
			pagesAttempted,
			pagesCompleted,
			rawObserved: items.length,
			reason: null,
		};
	}

	private async getNativeCompleteItemsWithCoverage<T extends JellyfinItemsEnvelope>(
		path: string,
		schema: z.ZodType<T>,
		validatePage?: JellyfinPageValidator<T>,
		mutationValidation = false,
	): Promise<JellyfinRawItemsResult<T["Items"][number]>> {
		let pagesAttempted = 0;
		let pagesCompleted = 0;

		for (let restartCount = 0; restartCount <= 1; restartCount++) {
			pagesAttempted = 0;
			pagesCompleted = 0;
			const items: T["Items"][number][] = [];
			const seenIds = new Set<string>();
			let expectedTotal: number | null = null;
			let startIndex = 0;
			let restartReason: string | undefined;
			let failureMessage: string | undefined;

			while (expectedTotal === null || startIndex < expectedTotal) {
				pagesAttempted++;
				const pageUrl = new URL(path, "http://jellyfin.invalid");
				pageUrl.searchParams.set("StartIndex", String(startIndex));
				pageUrl.searchParams.set("Limit", String(COMPLETE_ITEMS_PAGE_SIZE));
				let data: T | undefined;
				for (let attempt = 0; attempt < NATIVE_PAGE_RETRY_DELAYS_MS.length + 1; attempt++) {
					try {
						data = mutationValidation
							? await this.mutationRequest(`${pageUrl.pathname}${pageUrl.search}`, { schema })
							: await this.request(`${pageUrl.pathname}${pageUrl.search}`, { schema });
						break;
					} catch (error) {
						if (
							mutationValidation ||
							error instanceof UpstreamValidationError ||
							attempt >= NATIVE_PAGE_RETRY_DELAYS_MS.length
						) {
							failureMessage = "Jellyfin native item page request failed";
							break;
						}
						await new Promise<void>((resolve) =>
							setTimeout(resolve, NATIVE_PAGE_RETRY_DELAYS_MS[attempt]),
						);
					}
				}
				if (!data) break;

				const pageValidationFailure = validatePage?.(data, startIndex);
				if (pageValidationFailure) {
					failureMessage = pageValidationFailure;
					break;
				}
				if (
					!Number.isSafeInteger(data.TotalRecordCount) ||
					data.TotalRecordCount < 0 ||
					data.TotalRecordCount > COMPLETE_ITEMS_MAX
				) {
					failureMessage = `Jellyfin native item inventory contains ${data.TotalRecordCount} rows, exceeding the safe ${COMPLETE_ITEMS_MAX}-row limit`;
					break;
				}
				if (expectedTotal === null) {
					expectedTotal = data.TotalRecordCount;
				} else if (data.TotalRecordCount !== expectedTotal) {
					restartReason = "Jellyfin native item inventory changed while it was being paged";
					break;
				}
				if (
					data.Items.length > COMPLETE_ITEMS_PAGE_SIZE ||
					startIndex + data.Items.length > expectedTotal
				) {
					failureMessage = "Jellyfin native item pagination exceeded its declared total";
					break;
				}
				if (data.Items.length === 0 && startIndex < expectedTotal) {
					failureMessage = "Jellyfin native item pagination stopped before the declared total";
					break;
				}

				const pageIds = new Set<string>();
				for (const item of data.Items) {
					if (!item.Id.trim() || pageIds.has(item.Id) || seenIds.has(item.Id)) {
						restartReason = "Jellyfin native item pagination returned a duplicate item";
						break;
					}
					pageIds.add(item.Id);
				}
				if (restartReason) break;
				for (const item of data.Items) {
					seenIds.add(item.Id);
					items.push(item);
				}
				pagesCompleted++;
				startIndex += data.Items.length;
			}

			if (restartReason && restartCount === 0) continue;
			if (restartReason) failureMessage = restartReason;
			if (failureMessage || expectedTotal === null || items.length !== expectedTotal) {
				return {
					items: [],
					expectedRawCount: expectedTotal,
					pagesAttempted,
					pagesCompleted,
					rawObserved: items.length,
					reason: "page-failure",
					...(failureMessage ? { failureMessage } : {}),
				};
			}
			return {
				items,
				expectedRawCount: expectedTotal,
				pagesAttempted,
				pagesCompleted,
				rawObserved: items.length,
				reason: null,
			};
		}
		throw new Error("Jellyfin native item pagination exhausted its restart budget");
	}

	private authHeaders(): Record<string, string> {
		if (Object.keys(this.httpAuthHeaders).length === 0) {
			return {
				Accept: "application/json",
				Authorization: `MediaBrowser Token="${this.apiKey}", Client="${CLIENT_NAME}", Device="Server", DeviceId="${DEVICE_ID}", Version="1.0"`,
			};
		}
		return {
			Accept: "application/json",
			"X-Emby-Token": this.apiKey,
			"X-Emby-Authorization": `MediaBrowser Token="${this.apiKey}", Client="${CLIENT_NAME}", Device="Server", DeviceId="${DEVICE_ID}", Version="1.0"`,
			...this.httpAuthHeaders,
		};
	}

	private async request<T>(
		path: string,
		options?: {
			method?: string;
			body?: Record<string, unknown>;
			schema?: z.ZodType<T>;
			skipAuth?: boolean;
		},
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;

		const headers: Record<string, string> = options?.skipAuth
			? { Accept: "application/json", ...this.httpAuthHeaders }
			: this.authHeaders();

		const fetchOptions: RequestInit = {
			method: options?.method ?? "GET",
			headers,
			signal: AbortSignal.timeout(this.timeout),
		};

		if (options?.body) {
			headers["Content-Type"] = "application/json";
			fetchOptions.body = JSON.stringify(options.body);
		}

		const response = await fetch(url, fetchOptions);

		if (!response.ok) {
			this.log.warn({ status: response.status }, "Jellyfin API request failed");
			throw new Error(`Jellyfin API request failed: HTTP ${response.status}`);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			let raw: unknown;
			try {
				raw = await response.json();
			} catch {
				throw new Error("Jellyfin API returned invalid JSON");
			}
			if (!options?.schema) {
				throw new Error("Jellyfin API response schema is unavailable");
			}
			return parseUpstreamOrThrow(raw, options.schema, {
				integration: "jellyfin",
				category: "provider-response",
			});
		}

		// Non-JSON responses (e.g., from POST /Library/Refresh)
		if (options?.schema) {
			throw new Error("Jellyfin API returned an unexpected response type");
		}
		return undefined as T;
	}

	private async mutationRequest<T>(
		path: string,
		options: {
			method?: string;
			body?: Record<string, unknown>;
			schema: z.ZodType<T>;
		},
	): Promise<T> {
		try {
			const headers = this.authHeaders();
			const fetchOptions: RequestInit = {
				method: options.method ?? "GET",
				headers,
				signal: AbortSignal.timeout(this.timeout),
				redirect: "error",
			};
			if (options.body) {
				headers["Content-Type"] = "application/json";
				fetchOptions.body = JSON.stringify(options.body);
			}
			const response = await fetch(`${this.baseUrl}${path}`, fetchOptions);
			if (
				!response.ok ||
				!(response.headers.get("content-type") ?? "").includes("application/json")
			) {
				throw new Error("provider response unavailable");
			}
			const raw: unknown = await response.json();
			const parsed = options.schema.safeParse(raw);
			if (!parsed.success) throw new Error("provider response invalid");
			return parsed.data;
		} catch {
			throw new Error("Jellyfin mutation provider request failed");
		}
	}

	private async sendMutationTargetUpdate(
		path: string,
		body: Record<string, unknown>,
	): Promise<"sent"> {
		try {
			const headers = this.authHeaders();
			headers["Content-Type"] = "application/json";
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeout),
				redirect: "error",
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error("provider update failed");
			}
			return "sent";
		} catch {
			throw new Error("Jellyfin mutation target update failed");
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a JellyfinClient with decrypted API key from an encrypted instance.
 */
export function createJellyfinClient(
	encryptor: Encryptor,
	instance: ClientInstanceData,
	log: FastifyBaseLogger,
): JellyfinClient {
	const apiKey = encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});
	const httpAuthHeaders = getStoredHttpAuthHeaders(encryptor, instance);
	if (instance.service === "JELLYFIN" && Object.keys(httpAuthHeaders).length > 0) {
		throw new Error(
			"HTTP Basic Auth cannot be combined with modern Jellyfin authentication; configure a proxy bypass",
		);
	}
	return new JellyfinClient(instance.baseUrl, apiKey, log, DEFAULT_TIMEOUT, httpAuthHeaders);
}

// ============================================================================
// Helpers
// ============================================================================

/** Map a Jellyfin BaseItemDto to our normalized JellyfinItem */
function mapItem(item: {
	Id: string;
	Name: string;
	Type: string;
	SeriesName?: string;
	SeriesId?: string;
	IndexNumber?: number;
	ParentIndexNumber?: number;
	ProductionYear?: number;
	DateCreated?: string;
	ProviderIds?: Record<string, string>;
	UserData?: {
		Played?: boolean;
		PlayCount?: number;
		LastPlayedDate?: string | null;
		IsFavorite?: boolean;
	};
	ImageTags?: Record<string, string>;
}): JellyfinItem {
	const providerIds = item.ProviderIds ?? {};
	const tmdbStr = providerIds.Tmdb ?? providerIds.tmdb;
	const tmdbId = tmdbStr ? Number.parseInt(tmdbStr, 10) : undefined;

	return {
		id: item.Id,
		name: item.Name,
		type: item.Type,
		seriesName: item.SeriesName,
		seriesId: item.SeriesId,
		episodeNumber: item.IndexNumber,
		seasonNumber: item.ParentIndexNumber,
		year: item.ProductionYear,
		tmdbId: tmdbId && !Number.isNaN(tmdbId) ? tmdbId : undefined,
		imdbId: providerIds.Imdb ?? providerIds.imdb,
		played: item.UserData?.Played ?? false,
		playCount: item.UserData?.PlayCount ?? 0,
		lastPlayedDate: item.UserData?.LastPlayedDate ?? null,
		isFavorite: item.UserData?.IsFavorite ?? false,
		dateCreated: item.DateCreated,
		imageTags: item.ImageTags,
	};
}

function getCanonicalMutationTmdbId(providerIds: Record<string, string>): number {
	const tmdbEntries = Object.entries(providerIds).filter(([key]) => key.toLowerCase() === "tmdb");
	if (tmdbEntries.length !== 1) throw new Error("TMDb identity is ambiguous");
	const value = tmdbEntries[0]?.[1];
	if (!value || !/^[1-9]\d*$/.test(value)) throw new Error("TMDb identity is invalid");
	const tmdbId = Number(value);
	if (!Number.isSafeInteger(tmdbId) || String(tmdbId) !== value) {
		throw new Error("TMDb identity is invalid");
	}
	return tmdbId;
}

function isMutationTag(value: string): boolean {
	return (
		typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0
	);
}

function isMutationIdentifier(value: string): boolean {
	return (
		typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0
	);
}

function isStoredMutationTargetIntact(
	target: JellyfinMutationTargetSnapshot,
	stored: StoredMutationTarget,
): boolean {
	return (
		target.serverId === stored.serverId &&
		target.itemId === stored.itemId &&
		target.mediaType === stored.mediaType &&
		target.tmdbId === stored.tmdbId &&
		target.tags === stored.tags &&
		target.ancestorIds === stored.ancestorIds
	);
}
