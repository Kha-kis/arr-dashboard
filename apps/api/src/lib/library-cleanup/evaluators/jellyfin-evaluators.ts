import type {
	JellyfinAddedAtParams,
	JellyfinEpisodeCompletionParams,
	JellyfinLastWatchedParams,
	JellyfinOnDeckParams,
	JellyfinUserRatingParams,
	JellyfinWatchCountParams,
	JellyfinWatchedByParams,
} from "@arr/shared";
import { safeJsonParse } from "../../utils/json.js";
import type {
	CacheItemForEval,
	EvalContext,
	JellyfinWatchInfo,
	JellyfinWatchMap,
} from "../types.js";

// Jellyfin Rule Evaluators
// ============================================================================

function lookupJellyfinWatch(
	item: CacheItemForEval,
	jellyfinMap: JellyfinWatchMap | undefined,
): JellyfinWatchInfo | null {
	if (!jellyfinMap || jellyfinMap.size === 0) return null;
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const remoteIds = data.remoteIds as Record<string, unknown> | undefined;
	const tmdbId = remoteIds?.tmdbId;
	if (!tmdbId) return null;
	const mediaType = item.itemType === "movie" ? "movie" : "series";
	return jellyfinMap.get(`${mediaType}:${tmdbId}`) ?? null;
}

export function evaluateJellyfinLastWatched(
	item: CacheItemForEval,
	params: JellyfinLastWatchedParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (params.operator === "never") {
		return !watch || watch.lastWatchedAt === null ? "Never watched (per Jellyfin)" : null;
	}
	if (!watch) return null;
	if (watch.lastWatchedAt) {
		const ageDays = (ctx.now.getTime() - watch.lastWatchedAt.getTime()) / (1000 * 60 * 60 * 24);
		if (params.operator === "older_than" && params.days && ageDays >= params.days) {
			return `Last watched ${Math.floor(ageDays)} days ago in Jellyfin (threshold: > ${params.days} days)`;
		}
		return null;
	}
	if (params.operator === "older_than" && params.days) {
		const refDate = watch.addedAt ?? item.arrAddedAt;
		if (refDate) {
			const addedDays = (ctx.now.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24);
			if (addedDays >= params.days) {
				const source = watch.addedAt ? "Jellyfin" : "library";
				return `Never watched, added to ${source} ${Math.floor(addedDays)} days ago (threshold: > ${params.days} days)`;
			}
		}
	}
	return null;
}

export function evaluateJellyfinWatchCount(
	item: CacheItemForEval,
	params: JellyfinWatchCountParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (!watch) {
		if (
			ctx.jellyfinMap &&
			ctx.jellyfinMap.size > 0 &&
			params.operator === "less_than" &&
			params.count > 0 &&
			item.hasFile &&
			item.arrAddedAt
		) {
			const ageDays = Math.floor(
				(ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24),
			);
			return `Not tracked by Jellyfin, in library for ${ageDays} days (threshold: < ${params.count} plays)`;
		}
		return null;
	}
	const count = watch.watchCount;
	const ageCtx =
		count === 0 && watch.addedAt
			? `, added ${Math.floor((ctx.now.getTime() - watch.addedAt.getTime()) / (1000 * 60 * 60 * 24))} days ago`
			: "";
	if (params.operator === "less_than" && count < params.count)
		return `Jellyfin play count: ${count}${ageCtx} (threshold: < ${params.count})`;
	if (params.operator === "greater_than" && count > params.count)
		return `Jellyfin play count: ${count} (threshold: > ${params.count})`;
	return null;
}

export function evaluateJellyfinOnDeck(
	item: CacheItemForEval,
	params: JellyfinOnDeckParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (!watch) return null;
	if (params.isDeck && watch.onDeck) return "Item is on Jellyfin Continue Watching";
	if (!params.isDeck && !watch.onDeck) return "Item is not on Jellyfin Continue Watching";
	return null;
}

export function evaluateJellyfinUserRating(
	item: CacheItemForEval,
	params: JellyfinUserRatingParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (params.operator === "unrated")
		return !watch || watch.userRating === null ? "Unrated in Jellyfin" : null;
	if (!watch || watch.userRating === null) return null;
	if (
		params.operator === "less_than" &&
		params.rating !== undefined &&
		watch.userRating < params.rating
	)
		return `Jellyfin rating: ${watch.userRating.toFixed(1)} (threshold: < ${params.rating})`;
	if (
		params.operator === "greater_than" &&
		params.rating !== undefined &&
		watch.userRating > params.rating
	)
		return `Jellyfin rating: ${watch.userRating.toFixed(1)} (threshold: > ${params.rating})`;
	return null;
}

export function evaluateJellyfinWatchedBy(
	item: CacheItemForEval,
	params: JellyfinWatchedByParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (!watch) return null;
	const watchedBy = watch.watchedByUsers.map((u) => u.toLowerCase());
	const targetNames = params.userNames.map((n) => n.toLowerCase());
	if (params.operator === "includes_any") {
		const matched = targetNames.filter((n) => watchedBy.includes(n));
		if (matched.length > 0) return `Watched by Jellyfin user(s): ${matched.join(", ")}`;
	} else if (params.operator === "excludes_all") {
		if (targetNames.every((n) => !watchedBy.includes(n)))
			return `Not watched by Jellyfin user(s): ${params.userNames.join(", ")}`;
	}
	return null;
}

export function evaluateJellyfinAddedAt(
	item: CacheItemForEval,
	params: JellyfinAddedAtParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupJellyfinWatch(item, ctx.jellyfinMap);
	if (!watch?.addedAt) return null;
	const ageDays = (ctx.now.getTime() - watch.addedAt.getTime()) / (1000 * 60 * 60 * 24);
	if (params.operator === "older_than" && ageDays >= params.days)
		return `Added to Jellyfin ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	if (params.operator === "newer_than" && ageDays < params.days)
		return `Added to Jellyfin ${Math.floor(ageDays)} days ago (threshold: < ${params.days} days)`;
	return null;
}

export function evaluateJellyfinEpisodeCompletion(
	item: CacheItemForEval,
	params: JellyfinEpisodeCompletionParams,
	ctx: EvalContext,
): string | null {
	if (item.itemType !== "series") return null;
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const tmdbId = (data.remoteIds as Record<string, unknown> | undefined)?.tmdbId;
	if (typeof tmdbId !== "number") return null;

	const stats = ctx.jellyfinEpisodeMap?.get(tmdbId);
	if (!stats || stats.total === 0) return null;

	let total: number;
	let watched: number;
	if (params.minSeason != null && stats.seasons.size > 0) {
		total = 0;
		watched = 0;
		for (const [seasonNum, seasonStats] of stats.seasons) {
			if (seasonNum >= params.minSeason) {
				total += seasonStats.total;
				watched += seasonStats.watched;
			}
		}
		if (total === 0) return null;
	} else {
		total = stats.total;
		watched = stats.watched;
	}

	const pct = (watched / total) * 100;
	const seasonSuffix = params.minSeason != null ? ` (seasons >= ${params.minSeason})` : "";
	if (params.operator === "less_than" && pct < params.percentage)
		return `Jellyfin episode completion ${pct.toFixed(0)}% (${watched}/${total}) < ${params.percentage}%${seasonSuffix}`;
	if (params.operator === "greater_than" && pct > params.percentage)
		return `Jellyfin episode completion ${pct.toFixed(0)}% (${watched}/${total}) > ${params.percentage}%${seasonSuffix}`;
	return null;
}
