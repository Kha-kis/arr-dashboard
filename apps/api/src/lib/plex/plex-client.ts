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
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	plexAccountsResponseSchema,
	plexEpisodesResponseSchema,
	plexHistoryResponseSchema,
	plexIdentityResponseSchema,
	plexLibraryItemsResponseSchema,
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
	Guid?: PlexGuid[];
	Collection?: Array<{ tag: string }>;
	Label?: Array<{ tag: string }>;
}

export interface PlexHistoryItem {
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
	constructor(baseUrl: string, token: string, log: FastifyBaseLogger, timeout = DEFAULT_TIMEOUT) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.token = token;
		this.log = log;
		this.timeout = timeout;
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
		return (data.MediaContainer.Directory ?? []).map((d) => ({
			key: d.key,
			title: d.title,
			type: d.type,
		}));
	}

	/**
	 * Get all items from a library section.
	 */
	async getLibraryItems(sectionId: string): Promise<PlexLibraryItem[]> {
		const data = await this.request(
			`/library/sections/${sectionId}/all?includeGuids=1&includeCollections=1&includeLabels=1`,
			{ schema: plexLibraryItemsResponseSchema },
		);

		return (data.MediaContainer.Metadata ?? []).map((m) => ({
			ratingKey: m.ratingKey,
			title: m.title,
			type: m.type,
			year: m.year,
			userRating: m.userRating,
			addedAt: m.addedAt,
			Guid: m.Guid?.map((g) => ({ id: g.id })),
			Collection: m.Collection?.map((c) => ({ tag: c.tag })),
			Label: m.Label?.map((l) => ({ tag: l.tag })),
		}));
	}

	/**
	 * Get watch history across all users.
	 * Uses /status/sessions/history/all for multi-user history.
	 */
	async getHistory(options?: {
		maxResults?: number;
	}): Promise<PlexHistoryItem[]> {
		const allItems: PlexHistoryItem[] = [];
		const pageSize = 200;
		const maxResults = options?.maxResults ?? 5000;
		let offset = 0;

		while (allItems.length < maxResults) {
			const remaining = maxResults - allItems.length;
			const take = Math.min(pageSize, remaining);

			const data = await this.request(
				`/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${take}`,
				{ schema: plexHistoryResponseSchema },
			);

			const items = data.MediaContainer.Metadata ?? [];
			for (const item of items) {
				allItems.push({
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

			if (items.length < take) break;
			offset += take;
		}

		return allItems;
	}

	/**
	 * Get on-deck (continue watching) items.
	 */
	async getOnDeck(): Promise<PlexOnDeckItem[]> {
		const data = await this.request("/library/onDeck", {
			schema: plexOnDeckResponseSchema,
		});

		return (data.MediaContainer.Metadata ?? []).map((m) => ({
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
				? { title: m.Player.title, platform: m.Player.platform, product: m.Player.product, state: m.Player.state }
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
		const data = await this.request(`/library/metadata/${showRatingKey}/allLeaves`, {
			schema: plexEpisodesResponseSchema,
		});

		return (data.MediaContainer.Metadata ?? []).map((m) => ({
			ratingKey: m.ratingKey,
			title: m.title,
			seasonNumber: m.parentIndex ?? 0,
			episodeNumber: m.index ?? 0,
			viewCount: m.viewCount ?? 0,
			lastViewedAt: m.lastViewedAt,
		}));
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

		return (data.MediaContainer.Account ?? []).map((a) => ({
			id: a.id,
			name: a.name,
		}));
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
			const raw = await response.json();
			if (options?.schema) {
				const category = path.split("?")[0] ?? path;
				return parseUpstreamOrThrow(raw, options.schema, { integration: "plex", category });
			}
			return raw as T;
		}

		// Non-JSON responses (e.g., from POST /library/sections/{id}/refresh)
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

	return new PlexClient(instance.baseUrl, token, log);
}
