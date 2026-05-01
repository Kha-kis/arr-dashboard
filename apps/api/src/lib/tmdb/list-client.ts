/**
 * TMDb v3 list-membership client.
 *
 * Read-only client for the v3 List API. Used exclusively by the
 * auto-tagger's TmdbListCache refresher — see
 * `apps/api/src/plugins/tmdb-list-cache-scheduler.ts`.
 *
 * Auth: per-user TMDb v3 API key from `User.encryptedTmdbApiKey`. The
 * key was already collected by the Settings page (Account tab) but had
 * no consumer in the codebase prior to the auto-tagger; now it powers
 * the public-list lookups for `tmdb_list_member` rules.
 *
 * Scope: **public lists only**. v3 list endpoint is read-only and
 * returns any list created publicly on TMDb. User-private lists need
 * v4 token auth — out of scope here.
 */

import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

const TMDB_V3_BASE_URL = "https://api.themoviedb.org/3";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TmdbListItem {
	tmdbId: number;
	mediaType: "movie" | "series";
	title: string;
}

// v3 lists are returned in a single response (no pagination at this
// endpoint — the whole list comes back). Each item has `media_type`
// alongside the title fields.
const tmdbV3ListItemSchema = z
	.object({
		id: z.number().int().positive(),
		media_type: z.enum(["movie", "tv", "person"]).optional(),
		title: z.string().optional(), // movies
		name: z.string().optional(), // tv
	})
	.passthrough();

const tmdbV3ListResponseSchema = z
	.object({
		id: z.union([z.string(), z.number()]),
		name: z.string().optional(),
		items: z.array(tmdbV3ListItemSchema),
		item_count: z.number().int().min(0).optional(),
	})
	.passthrough();

export interface TmdbV3Client {
	/** Fetch all members of a v3 public list. */
	getListItems(listId: string): Promise<TmdbListItem[]>;
}

export function createTmdbV3Client(
	apiKey: string,
	log: FastifyBaseLogger,
	options: { timeoutMs?: number; baseUrl?: string } = {},
): TmdbV3Client {
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const baseUrl = options.baseUrl ?? TMDB_V3_BASE_URL;

	return {
		async getListItems(listId: string): Promise<TmdbListItem[]> {
			const url = `${baseUrl}/list/${encodeURIComponent(listId)}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
			const res = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(timeout),
			});
			if (!res.ok) {
				throw new Error(`TMDb v3 list ${listId}: HTTP ${res.status} ${res.statusText}`);
			}
			const raw = await res.json();
			const parsed = tmdbV3ListResponseSchema.safeParse(raw);
			if (!parsed.success) {
				log.warn(
					{ listId, issues: parsed.error.issues },
					"TMDb v3 list response failed schema validation",
				);
				throw new Error(`TMDb v3 list ${listId}: malformed response`);
			}

			const items: TmdbListItem[] = [];
			for (const r of parsed.data.items) {
				if (r.media_type === "person") continue;
				const mediaType: "movie" | "series" = r.media_type === "tv" ? "series" : "movie";
				const title = r.title ?? r.name ?? "(untitled)";
				items.push({ tmdbId: r.id, mediaType, title });
			}
			return items;
		},
	};
}
