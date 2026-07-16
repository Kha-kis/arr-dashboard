import type {
	PlexAddedAtParams,
	PlexCollectionRuleParams,
	PlexLabelRuleParams,
	PlexLastWatchedParams,
	PlexOnDeckParams,
	PlexUserRatingParams,
	PlexWatchCountParams,
	PlexWatchedByParams,
} from "@arr/shared";
import { safeJsonParse } from "../../utils/json.js";
import type { CacheItemForEval, EvalContext, PlexWatchInfo, PlexWatchMap } from "../types.js";

// Plex Rule Evaluators
// ============================================================================

/**
 * Look up Plex watch data for a cache item via its tmdbId from the data blob.
 * When plexLibraryFilter is set, only data from matching Plex library sections is used.
 */
export function lookupPlexWatch(
	item: CacheItemForEval,
	plexMap: PlexWatchMap | undefined,
	plexLibraryFilter?: string[] | null,
): PlexWatchInfo | null {
	if (!plexMap || plexMap.size === 0) return null;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	const remoteIds = data.remoteIds as Record<string, unknown> | undefined;
	const tmdbId = remoteIds?.tmdbId;
	if (!tmdbId) return null;

	const mediaType = item.itemType === "movie" ? "movie" : "series";
	const key = `${mediaType}:${tmdbId}`;

	const entry = plexMap.get(key);
	if (!entry) return null;

	// If no filter, return the pre-computed aggregates (existing behavior)
	if (!plexLibraryFilter || plexLibraryFilter.length === 0) return entry;

	// Filter to matching sections only
	const matchingSections = entry.sections.filter((s) => plexLibraryFilter.includes(s.sectionTitle));
	if (matchingSections.length === 0) return null;

	// Re-aggregate from filtered sections
	return {
		lastWatchedAt: matchingSections.reduce<Date | null>((latest, s) => {
			if (!s.lastWatchedAt) return latest;
			return !latest || s.lastWatchedAt > latest ? s.lastWatchedAt : latest;
		}, null),
		watchCount: matchingSections.reduce((sum, s) => sum + s.watchCount, 0),
		watchedByUsers: [...new Set(matchingSections.flatMap((s) => s.watchedByUsers))],
		onDeck: matchingSections.some((s) => s.onDeck),
		userRating: matchingSections.reduce<number | null>((best, s) => {
			if (s.userRating == null) return best;
			return best != null ? Math.max(best, s.userRating) : s.userRating;
		}, null),
		collections: [...new Set(matchingSections.flatMap((s) => s.collections))],
		labels: [...new Set(matchingSections.flatMap((s) => s.labels))],
		addedAt: matchingSections.reduce<Date | null>((earliest, s) => {
			if (!s.addedAt) return earliest;
			return !earliest || s.addedAt < earliest ? s.addedAt : earliest;
		}, null),
		sections: matchingSections,
	};
}

/**
 * Plex Last Watched: flag items based on when they were last watched.
 * "never" operator flags items that have never been watched.
 * "older_than" uses addedAt as a fallback for never-watched items — if an item
 * was added N+ days ago and never watched, it qualifies as "unwatched for N+ days".
 */
export function evaluatePlexLastWatched(
	item: CacheItemForEval,
	params: PlexLastWatchedParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);

	if (params.operator === "never") {
		if (!watch || watch.lastWatchedAt === null) {
			return "Never watched (per Plex)";
		}
		return null;
	}

	if (!watch) return null;

	if (watch.lastWatchedAt) {
		const ageDays = (ctx.now.getTime() - watch.lastWatchedAt.getTime()) / (1000 * 60 * 60 * 24);
		if (params.operator === "older_than" && params.days && ageDays >= params.days) {
			return `Last watched ${Math.floor(ageDays)} days ago in Plex (threshold: > ${params.days} days)`;
		}
		return null;
	}

	// Never watched — fall back to addedAt (Plex), then arrAddedAt (Sonarr/Radarr)
	if (params.operator === "older_than" && params.days) {
		const refDate = watch.addedAt ?? item.arrAddedAt;
		if (refDate) {
			const addedDays = (ctx.now.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24);
			if (addedDays >= params.days) {
				const source = watch.addedAt ? "Plex" : "library";
				return `Never watched, added to ${source} ${Math.floor(addedDays)} days ago (threshold: > ${params.days} days)`;
			}
		}
	}

	return null;
}

/**
 * Plex Watch Count: flag items based on play count.
 */
export function evaluatePlexWatchCount(
	item: CacheItemForEval,
	params: PlexWatchCountParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch) {
		// Not in Plex — infer 0 plays when Plex is configured and item has a file
		if (
			ctx.plexMap &&
			ctx.plexMap.size > 0 &&
			params.operator === "less_than" &&
			params.count > 0 &&
			item.hasFile &&
			item.arrAddedAt
		) {
			const ageDays = Math.floor(
				(ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24),
			);
			return `Not tracked by Plex, in library for ${ageDays} days (threshold: < ${params.count} plays)`;
		}
		return null;
	}
	const count = watch.watchCount;

	// Age context for low play counts
	const ageCtx =
		count === 0 && watch.addedAt
			? `, added ${Math.floor((ctx.now.getTime() - watch.addedAt.getTime()) / (1000 * 60 * 60 * 24))} days ago`
			: "";

	if (params.operator === "less_than" && count < params.count) {
		return `Plex play count: ${count}${ageCtx} (threshold: < ${params.count})`;
	}
	if (params.operator === "greater_than" && count > params.count) {
		return `Plex play count: ${count} (threshold: > ${params.count})`;
	}
	return null;
}

/**
 * Plex On Deck: flag items based on whether they are on Plex's Continue Watching.
 */
export function evaluatePlexOnDeck(
	item: CacheItemForEval,
	params: PlexOnDeckParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch) return null;
	const isOnDeck = watch.onDeck;

	if (params.isDeck && isOnDeck) {
		return "Item is on Plex Continue Watching";
	}
	if (!params.isDeck && !isOnDeck) {
		return "Item is not on Plex Continue Watching";
	}
	return null;
}

/**
 * Plex User Rating: flag items based on the admin's star rating in Plex.
 * "unrated" operator flags items with no rating.
 */
export function evaluatePlexUserRating(
	item: CacheItemForEval,
	params: PlexUserRatingParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);

	if (params.operator === "unrated") {
		if (!watch || watch.userRating === null) {
			return "Unrated in Plex";
		}
		return null;
	}

	if (!watch || watch.userRating === null) return null;

	if (
		params.operator === "less_than" &&
		params.rating !== undefined &&
		watch.userRating < params.rating
	) {
		return `Plex user rating: ${watch.userRating.toFixed(1)} (threshold: < ${params.rating})`;
	}
	if (
		params.operator === "greater_than" &&
		params.rating !== undefined &&
		watch.userRating > params.rating
	) {
		return `Plex user rating: ${watch.userRating.toFixed(1)} (threshold: > ${params.rating})`;
	}
	return null;
}

/**
 * Plex Watched By: flag items based on which Plex users have watched them.
 */
export function evaluatePlexWatchedBy(
	item: CacheItemForEval,
	params: PlexWatchedByParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch) return null;
	const watchedBy = watch.watchedByUsers.map((u) => u.toLowerCase());
	const targetNames = params.userNames.map((n) => n.toLowerCase());

	if (params.operator === "includes_any") {
		const matched = targetNames.filter((n) => watchedBy.includes(n));
		if (matched.length > 0) {
			return `Watched by Plex user(s): ${matched.join(", ")}`;
		}
	} else if (params.operator === "excludes_all") {
		const noneWatched = targetNames.every((n) => !watchedBy.includes(n));
		if (noneWatched) {
			return `Not watched by Plex user(s): ${params.userNames.join(", ")}`;
		}
	}

	return null;
}

/**
 * Plex Collection: flag items based on Plex collection membership.
 */
export function evaluatePlexCollection(
	item: CacheItemForEval,
	params: PlexCollectionRuleParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch) return null;
	const collections = watch.collections;

	const targetLower = params.collections.map((c) => c.toLowerCase());
	const itemLower = collections.map((c) => c.toLowerCase());

	if (params.operator === "in") {
		const matched = targetLower.filter((c) => itemLower.includes(c));
		if (matched.length > 0) {
			return `In Plex collection(s): ${matched.join(", ")}`;
		}
	} else if (params.operator === "not_in") {
		const hasNone = targetLower.every((c) => !itemLower.includes(c));
		if (hasNone) {
			return `Not in Plex collection(s): ${params.collections.join(", ")}`;
		}
	}
	return null;
}

/**
 * Plex Label: flag items based on Plex label tags.
 */
export function evaluatePlexLabel(
	item: CacheItemForEval,
	params: PlexLabelRuleParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch) return null;
	const labels = watch.labels;

	const targetLower = params.labels.map((l) => l.toLowerCase());
	const itemLower = labels.map((l) => l.toLowerCase());

	if (params.operator === "has_any") {
		const matched = targetLower.filter((l) => itemLower.includes(l));
		if (matched.length > 0) {
			return `Has Plex label(s): ${matched.join(", ")}`;
		}
	} else if (params.operator === "has_none") {
		const hasNone = targetLower.every((l) => !itemLower.includes(l));
		if (hasNone) {
			return `Does not have Plex label(s): ${params.labels.join(", ")}`;
		}
	}
	return null;
}

/**
 * Plex Added At: flag items based on when they were added to Plex.
 * "older_than" flags items added more than N days ago.
 * "newer_than" flags items added less than N days ago.
 */
export function evaluatePlexAddedAt(
	item: CacheItemForEval,
	params: PlexAddedAtParams,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): string | null {
	const watch = lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter);
	if (!watch?.addedAt) return null;

	const ageDays = (ctx.now.getTime() - watch.addedAt.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Added to Plex ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	}
	if (params.operator === "newer_than" && ageDays < params.days) {
		return `Added to Plex ${Math.floor(ageDays)} days ago (threshold: < ${params.days} days)`;
	}
	return null;
}
