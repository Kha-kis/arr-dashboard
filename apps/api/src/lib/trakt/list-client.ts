/**
 * Trakt list-membership client.
 *
 * Read-only client for the Trakt list-items API. Used exclusively by
 * the auto-tagger's TraktListCache refresher.
 *
 * Auth model: per-user **personal access token (PAT)**. The user
 * generates a PAT in their Trakt account, pastes it into the dashboard
 * Settings page, and the cache refresher reads their accessible lists.
 * No OAuth dance — chosen for self-hosted simplicity over a full OAuth
 * implementation that would require redirect URI config + callback
 * routing.
 *
 * Trakt also requires a per-app `trakt-api-key` header (the Client ID
 * from app registration). This is configured at the deployment level
 * via `TRAKT_CLIENT_ID` env var. If absent, the client throws on
 * construction.
 */

import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

const TRAKT_BASE_URL = "https://api.trakt.tv";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TraktListItem {
	tmdbId: number;
	mediaType: "movie" | "series";
	title: string;
}

// Trakt's list-items response wraps each item in a discriminator object:
// `{ type: "movie", movie: { ids: { tmdb, imdb, ... }, title, ... } }`
const traktIdsSchema = z
	.object({
		tmdb: z.number().int().positive().nullable().optional(),
		imdb: z.string().nullable().optional(),
	})
	.passthrough();

const traktItemBodySchema = z
	.object({
		title: z.string().optional(),
		ids: traktIdsSchema.optional(),
	})
	.passthrough();

const traktListItemSchema = z
	.object({
		type: z.string(), // "movie" | "show" | "season" | "episode" | "person"
		movie: traktItemBodySchema.optional(),
		show: traktItemBodySchema.optional(),
	})
	.passthrough();

const traktListResponseSchema = z.array(traktListItemSchema);

export interface TraktClient {
	/** Fetch the full membership of a list identified as `username/list-slug`. */
	getListItems(listSlug: string): Promise<TraktListItem[]>;
}

export function createTraktClient(
	accessToken: string,
	clientId: string,
	log: FastifyBaseLogger,
	options: { timeoutMs?: number; baseUrl?: string } = {},
): TraktClient {
	if (!clientId) {
		throw new Error(
			"Trakt client requires a TRAKT_CLIENT_ID (app-level Trakt API key). Configure it in the API env.",
		);
	}

	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const baseUrl = options.baseUrl ?? TRAKT_BASE_URL;

	async function fetchListItems(listSlug: string) {
		const [username, slug] = listSlug.split("/");
		if (!username || !slug) {
			throw new Error(`Trakt list slug must be 'username/list-slug', got: ${listSlug}`);
		}
		const url = `${baseUrl}/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(slug)}/items?extended=metadata`;
		const res = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"trakt-api-version": "2",
				"trakt-api-key": clientId,
				Authorization: `Bearer ${accessToken}`,
			},
			signal: AbortSignal.timeout(timeout),
		});
		if (!res.ok) {
			throw new Error(`Trakt list ${listSlug}: HTTP ${res.status} ${res.statusText}`);
		}
		const raw = await res.json();
		const parsed = traktListResponseSchema.safeParse(raw);
		if (!parsed.success) {
			log.warn(
				{ listSlug, issues: parsed.error.issues },
				"Trakt list response failed schema validation",
			);
			throw new Error(`Trakt list ${listSlug}: malformed response`);
		}
		return parsed.data;
	}

	return {
		async getListItems(listSlug: string): Promise<TraktListItem[]> {
			const raw = await fetchListItems(listSlug);
			const items: TraktListItem[] = [];
			for (const entry of raw) {
				const body =
					entry.type === "movie" ? entry.movie : entry.type === "show" ? entry.show : null;
				if (!body) continue;
				const tmdbId = body.ids?.tmdb;
				if (typeof tmdbId !== "number" || tmdbId <= 0) continue; // require TMDb mapping
				const mediaType: "movie" | "series" = entry.type === "movie" ? "movie" : "series";
				items.push({
					tmdbId,
					mediaType,
					title: body.title ?? "(untitled)",
				});
			}
			return items;
		},
	};
}
