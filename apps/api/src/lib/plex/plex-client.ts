/**
 * Plex Media Server API Client
 *
 * Standalone client for the Plex API using X-Plex-Token header authentication.
 * Plex returns JSON when Accept: application/json is set.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";

// ============================================================================
// Response Types
// ============================================================================

export interface PlexIdentity {
	machineIdentifier: string;
	version: string;
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
	 */
	async getIdentity(): Promise<PlexIdentity> {
		const data = await this.request<{
			MediaContainer: { machineIdentifier: string; version: string };
		}>("/identity");
		return {
			machineIdentifier: data.MediaContainer.machineIdentifier,
			version: data.MediaContainer.version,
		};
	}

	/**
	 * Get all library sections.
	 */
	async getLibrarySections(): Promise<PlexLibrary[]> {
		const data = await this.request<{
			MediaContainer: { Directory?: Array<{ key: string; title: string; type: string }> };
		}>("/library/sections");
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
		const data = await this.request<{
			MediaContainer: {
				Metadata?: Array<{
					ratingKey: string;
					title: string;
					type: string;
					year?: number;
					userRating?: number;
					addedAt?: number;
					Guid?: Array<{ id: string }>;
					Collection?: Array<{ tag: string }>;
					Label?: Array<{ tag: string }>;
				}>;
			};
		}>(`/library/sections/${sectionId}/all?includeGuids=1&includeCollections=1&includeLabels=1`);

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

			const data = await this.request<{
				MediaContainer: {
					size?: number;
					Metadata?: Array<{
						ratingKey: string;
						parentRatingKey?: string;
						parentKey?: string;
						grandparentRatingKey?: string;
						grandparentKey?: string;
						title: string;
						grandparentTitle?: string;
						type: string;
						viewedAt: number;
						accountID: number;
					}>;
				};
			}>(`/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${take}`);

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
		const data = await this.request<{
			MediaContainer: {
				Metadata?: Array<{
					ratingKey: string;
					parentRatingKey?: string;
					grandparentRatingKey?: string;
					type: string;
				}>;
			};
		}>("/library/onDeck");

		return (data.MediaContainer.Metadata ?? []).map((m) => ({
			ratingKey: m.ratingKey,
			parentRatingKey: m.parentRatingKey,
			grandparentRatingKey: m.grandparentRatingKey,
			type: m.type,
		}));
	}

	/**
	 * Get all user accounts on the server.
	 */
	async getAccounts(): Promise<PlexAccount[]> {
		const data = await this.request<{
			MediaContainer: {
				Account?: Array<{ id: number; name: string }>;
			};
		}>("/accounts");

		return (data.MediaContainer.Account ?? []).map((a) => ({
			id: a.id,
			name: a.name,
		}));
	}

	/**
	 * Execute a Plex API request with X-Plex-Token header auth.
	 */
	private async request<T>(path: string): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);

		const response = await fetch(url.toString(), {
			headers: {
				Accept: "application/json",
				"X-Plex-Token": this.token,
			},
			signal: AbortSignal.timeout(this.timeout),
		});

		if (!response.ok) {
			this.log.warn({ status: response.status, path }, "Plex API non-OK response");
			throw new Error(`Plex API error: HTTP ${response.status} ${response.statusText}`);
		}

		return (await response.json()) as T;
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
