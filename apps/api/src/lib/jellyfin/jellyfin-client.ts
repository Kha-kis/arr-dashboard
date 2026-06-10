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
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	jellyfinEpisodesResponseSchema,
	jellyfinItemDetailSchema,
	jellyfinItemsResponseSchema,
	jellyfinLibrariesResponseSchema,
	jellyfinPublicInfoSchema,
	jellyfinServerInfoSchema,
	jellyfinSessionsResponseSchema,
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

export class JellyfinClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;

	constructor(baseUrl: string, apiKey: string, log: FastifyBaseLogger, timeout = DEFAULT_TIMEOUT) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.log = log;
		this.timeout = timeout;
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
		return data.Items.map((lib) => ({
			id: lib.Id,
			name: lib.Name,
			collectionType: lib.CollectionType ?? lib.Type,
		}));
	}

	/**
	 * Get all items in a library with TMDB IDs and user data.
	 */
	async getLibraryItems(
		userId: string,
		libraryId: string,
		options?: { includeItemTypes?: string },
	): Promise<JellyfinItem[]> {
		const params = new URLSearchParams({
			ParentId: libraryId,
			Fields: "ProviderIds,DateCreated,ImageTags",
			Recursive: "true",
			Limit: "10000",
		});
		if (options?.includeItemTypes) {
			params.set("IncludeItemTypes", options.includeItemTypes);
		}

		const data = await this.request(
			`/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`,
			{
				schema: jellyfinItemsResponseSchema,
			},
		);
		return data.Items.map(mapItem);
	}

	/**
	 * Get resume items (continue watching) for a user.
	 */
	async getResumeItems(userId: string): Promise<JellyfinItem[]> {
		const data = await this.request(
			`/Users/${encodeURIComponent(userId)}/Items/Resume?Fields=ProviderIds`,
			{
				schema: jellyfinItemsResponseSchema,
			},
		);
		return data.Items.map(mapItem);
	}

	/**
	 * Get next up episodes for a user (TV shows).
	 */
	async getNextUp(userId: string): Promise<JellyfinItem[]> {
		const data = await this.request(
			`/Shows/NextUp?userId=${encodeURIComponent(userId)}&Fields=ProviderIds`,
			{
				schema: jellyfinItemsResponseSchema,
			},
		);
		return data.Items.map(mapItem);
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
		const data = await this.request(
			`/Shows/${encodeURIComponent(seriesId)}/Episodes?userId=${encodeURIComponent(userId)}&Fields=ProviderIds`,
			{ schema: jellyfinEpisodesResponseSchema },
		);
		return data.Items.map(mapItem);
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
		const data = await this.request(
			`/Users/${encodeURIComponent(userId)}/Items?${params.toString().replace(/\+/g, "%20")}`,
			{ schema: jellyfinItemsResponseSchema },
		);
		return data.Items.map(mapItem);
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

	private authHeaders(): Record<string, string> {
		return {
			Accept: "application/json",
			Authorization: `MediaBrowser Token="${this.apiKey}", Client="${CLIENT_NAME}", Device="Server", DeviceId="${DEVICE_ID}", Version="1.0"`,
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
			? { Accept: "application/json" }
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
			this.log.warn({ status: response.status, path }, "Jellyfin API non-OK response");
			throw new Error(`Jellyfin API error: HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			let raw: unknown;
			try {
				raw = await response.json();
			} catch {
				throw new Error(
					`Jellyfin API: invalid JSON response (path: ${path}, status: ${response.status})`,
				);
			}
			if (!options?.schema) {
				throw new Error(`Jellyfin API: schema required for JSON responses (path: ${path})`);
			}
			const category = path.split("?")[0] ?? path;
			return parseUpstreamOrThrow(raw, options.schema, { integration: "jellyfin", category });
		}

		// Non-JSON responses (e.g., from POST /Library/Refresh)
		if (options?.schema) {
			throw new Error(
				`Jellyfin API: expected JSON response but got ${contentType} (path: ${path})`,
			);
		}
		return undefined as T;
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
	return new JellyfinClient(instance.baseUrl, apiKey, log);
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
