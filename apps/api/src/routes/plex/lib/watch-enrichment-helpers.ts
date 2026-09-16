/**
 * Watch Enrichment Aggregation Helpers
 *
 * Pure functions for aggregating PlexCache + TautulliCache entries into
 * WatchEnrichmentItem records. Extracted from watch-enrichment-routes.ts
 * for testability.
 */

import type { ProviderObservationStatus, WatchEnrichmentItem } from "@arr/shared";
import { projectWatchDisplayEvidence } from "../../../lib/provider-observation/watch-display-evidence.js";

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
	providerStatus: ProviderObservationStatus | undefined;
}

/** Shape of a TautulliCache entry relevant to enrichment aggregation */
export interface TautulliCacheEntry {
	tmdbId: number;
	mediaType: string;
	instanceId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	providerStatus: ProviderObservationStatus | undefined;
}

/** Minimal logger interface for parse failure warnings */
export interface ParseLogger {
	warn: (obj: Record<string, unknown>, msg: string) => void;
}

function exactCurrentOnDeck(entry: PlexCacheEntry | undefined): boolean | null {
	if (!entry?.providerStatus) return null;
	const domain = entry.providerStatus.domains?.find((candidate) => candidate.domain === "on-deck");
	if (
		entry.providerStatus.availability !== "current" ||
		!domain ||
		domain.availability !== "current" ||
		domain.evidence !== "complete" ||
		domain.valueSemantics !== "exact"
	)
		return null;
	return entry.onDeck;
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
		const plexMatches = plexEntries.filter((e) => e.tmdbId === tmdbId && e.mediaType === mediaType);
		const tautulliMatches = tautulliEntries.filter(
			(e) => e.tmdbId === tmdbId && e.mediaType === mediaType,
		);

		if (plexMatches.length === 0 && tautulliMatches.length === 0) continue;

		const hasPlex = plexMatches.length > 0;
		const hasTautulli = tautulliMatches.length > 0;
		const projections = [
			...plexMatches.map((entry) => ({
				entry,
				display: projectWatchDisplayEvidence({ status: entry.providerStatus, row: entry }),
			})),
			...tautulliMatches.map((entry) => ({
				entry,
				display: projectWatchDisplayEvidence({ status: entry.providerStatus, row: entry }),
			})),
		];
		const countContributors = projections.filter(
			(
				candidate,
			): candidate is typeof candidate & {
				display: { watchCount: number; watchCountSemantics: "exact" | "lower-bound" };
			} =>
				candidate.display.watchCount !== null &&
				candidate.display.watchCountSemantics !== "unknown",
		);
		const preferredPlex = projections.find(
			(
				candidate,
			): candidate is {
				entry: PlexCacheEntry;
				display: ReturnType<typeof projectWatchDisplayEvidence>;
			} => "ratingKey" in candidate.entry,
		);
		const attribution = preferredPlex?.display ?? {
			lastWatchedAt: null,
			watchedByUsers: [] as string[],
		};
		const metadata = preferredPlex?.entry;
		const parseMetadata = (value: string, field: "collections" | "labels") => {
			try {
				const parsed: unknown = JSON.parse(value);
				return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
					? parsed
					: [];
			} catch {
				logger.warn(
					{ instanceId: metadata?.instanceId ?? "", tmdbId, field },
					"Skipping malformed JSON in PlexCache field",
				);
				return [];
			}
		};
		const count = countContributors.reduce(
			(maximum, candidate) => Math.max(maximum, candidate.display.watchCount),
			0,
		);
		const countSemantics =
			countContributors.length === 0
				? "unknown"
				: countContributors.length === 1 &&
						countContributors[0]!.display.watchCountSemantics === "exact"
					? "exact"
					: "lower-bound";
		const zeroLowerBound = countSemantics === "lower-bound" && count === 0;

		const item: WatchEnrichmentItem = {
			lastWatchedAt: attribution.lastWatchedAt,
			watchCount: countContributors.length === 0 || zeroLowerBound ? null : count,
			watchCountSemantics: zeroLowerBound ? "unknown" : countSemantics,
			watchedByUsers: attribution.watchedByUsers,
			onDeck: exactCurrentOnDeck(metadata),
			userRating: metadata?.userRating ?? null,
			source: hasPlex && hasTautulli ? "both" : hasPlex ? "plex" : "tautulli",
			ratingKey: metadata?.ratingKey ?? null,
			instanceId: metadata?.instanceId ?? null,
			collections: metadata ? parseMetadata(metadata.collections, "collections") : [],
			labels: metadata ? parseMetadata(metadata.labels, "labels") : [],
		};

		if (filterUser && !attribution.watchedByUsers.includes(filterUser)) {
			item.watchCount = null;
			item.watchCountSemantics = "unknown";
			item.lastWatchedAt = null;
			item.watchedByUsers = [];
			item.userRating = null;
		}

		items[key] = item;
	}

	return items;
}
