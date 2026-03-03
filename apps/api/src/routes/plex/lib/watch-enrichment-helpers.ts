/**
 * Watch Enrichment Aggregation Helpers
 *
 * Pure functions for aggregating PlexCache + TautulliCache entries into
 * WatchEnrichmentItem records. Extracted from watch-enrichment-routes.ts
 * for testability.
 */

import type { WatchEnrichmentItem } from "@arr/shared";

/** Shape of a PlexCache entry relevant to enrichment aggregation */
export interface PlexCacheEntry {
	tmdbId: number;
	mediaType: string;
	instanceId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	onDeck: boolean;
	userRating: number | null;
	ratingKey: string | null;
	watchedByUsers: string;
	collections: string;
	labels: string;
}

/** Shape of a TautulliCache entry relevant to enrichment aggregation */
export interface TautulliCacheEntry {
	tmdbId: number;
	mediaType: string;
	instanceId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
}

/** Minimal logger interface for parse failure warnings */
export interface ParseLogger {
	warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Aggregate PlexCache and TautulliCache entries into WatchEnrichmentItems.
 *
 * For each unique key in `uniqueKeys`, finds matching entries in both sources,
 * merges them using max(plex, tautulli) for watchCount (to avoid double-counting),
 * and optionally filters by a specific user.
 */
export function aggregateWatchEnrichment(
	uniqueKeys: Map<string, { tmdbId: number; mediaType: string }>,
	plexEntries: PlexCacheEntry[],
	tautulliEntries: TautulliCacheEntry[],
	filterUser: string | undefined,
	logger: ParseLogger,
): Record<string, WatchEnrichmentItem> {
	const items: Record<string, WatchEnrichmentItem> = {};

	for (const [key, { tmdbId, mediaType }] of uniqueKeys) {
		const plexMatches = plexEntries.filter(
			(e) => e.tmdbId === tmdbId && e.mediaType === mediaType,
		);
		const tautulliMatches = tautulliEntries.filter(
			(e) => e.tmdbId === tmdbId && e.mediaType === mediaType,
		);

		if (plexMatches.length === 0 && tautulliMatches.length === 0) continue;

		let lastWatchedAt: Date | null = null;
		let plexWatchCount = 0;
		let tautulliWatchCount = 0;
		const allUsers = new Set<string>();
		let onDeck = false;
		let userRating: number | null = null;
		let ratingKey: string | null = null;
		let instanceId: string | null = null;
		let collections: string[] = [];
		let labels: string[] = [];

		for (const entry of plexMatches) {
			if (entry.lastWatchedAt && (!lastWatchedAt || entry.lastWatchedAt > lastWatchedAt)) {
				lastWatchedAt = entry.lastWatchedAt;
			}
			plexWatchCount += entry.watchCount;
			if (entry.onDeck) onDeck = true;
			if (entry.userRating != null && (userRating == null || entry.userRating > userRating)) {
				userRating = entry.userRating;
			}
			if (entry.ratingKey && !ratingKey) {
				ratingKey = entry.ratingKey;
				instanceId = entry.instanceId;
				try {
					collections = JSON.parse(entry.collections) as string[];
				} catch {
					logger.warn({ instanceId: entry.instanceId, tmdbId: entry.tmdbId, field: "collections" }, "Skipping malformed JSON in PlexCache field");
					collections = [];
				}
				try {
					labels = JSON.parse(entry.labels) as string[];
				} catch {
					logger.warn({ instanceId: entry.instanceId, tmdbId: entry.tmdbId, field: "labels" }, "Skipping malformed JSON in PlexCache field");
					labels = [];
				}
			}
			try {
				const users = JSON.parse(entry.watchedByUsers) as string[];
				for (const u of users) allUsers.add(u);
			} catch {
				logger.warn({ instanceId: entry.instanceId, tmdbId: entry.tmdbId, field: "watchedByUsers" }, "Skipping malformed JSON in PlexCache field");
			}
		}

		for (const entry of tautulliMatches) {
			if (entry.lastWatchedAt && (!lastWatchedAt || entry.lastWatchedAt > lastWatchedAt)) {
				lastWatchedAt = entry.lastWatchedAt;
			}
			tautulliWatchCount += entry.watchCount;
			try {
				const users = JSON.parse(entry.watchedByUsers) as string[];
				for (const u of users) allUsers.add(u);
			} catch {
				logger.warn({ instanceId: entry.instanceId, tmdbId: entry.tmdbId, field: "watchedByUsers" }, "Skipping malformed JSON in TautulliCache field");
			}
		}

		const hasPlex = plexMatches.length > 0;
		const hasTautulli = tautulliMatches.length > 0;

		const item: WatchEnrichmentItem = {
			lastWatchedAt: lastWatchedAt?.toISOString() ?? null,
			watchCount: Math.max(plexWatchCount, tautulliWatchCount),
			watchedByUsers: [...allUsers],
			onDeck,
			userRating,
			source: hasPlex && hasTautulli ? "both" : hasPlex ? "plex" : "tautulli",
			ratingKey,
			instanceId,
			collections,
			labels,
		};

		if (filterUser && !allUsers.has(filterUser)) {
			item.watchCount = 0;
			item.lastWatchedAt = null;
			item.watchedByUsers = [];
			item.onDeck = false;
			item.userRating = null;
		}

		items[key] = item;
	}

	return items;
}
