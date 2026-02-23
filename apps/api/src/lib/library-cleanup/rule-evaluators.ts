/**
 * Library Cleanup Rule Evaluators
 *
 * Pure functions that evaluate a single LibraryCache item against a cleanup rule.
 * Each rule type has its own evaluator that returns a reason string if matched, or null.
 */

import type {
	AgeRuleParams,
	AudioCodecRuleParams,
	CustomFormatScoreRuleParams,
	GenreRuleParams,
	HdrTypeRuleParams,
	LanguageRuleParams,
	QualityProfileRuleParams,
	RatingRuleParams,
	ReleaseGroupRuleParams,
	ResolutionRuleParams,
	RuntimeRuleParams,
	SeerrIs4kParams,
	SeerrModifiedByParams,
	SeerrRequestAgeParams,
	SeerrRequestedByParams,
	SeerrRequestModifiedAgeParams,
	SeerrRequestStatusParams,
	SizeRuleParams,
	StatusRuleParams,
	TautulliLastWatchedParams,
	TautulliWatchCountParams,
	TautulliWatchedByParams,
	VideoCodecRuleParams,
	YearRangeRuleParams,
} from "@arr/shared";
import type { LibraryCleanupRule } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import type {
	CacheItemForEval,
	EvalContext,
	RuleMatch,
	SeerrRequestInfo,
	SeerrRequestMap,
	TautulliWatchMap,
} from "./types.js";

// ============================================================================
// Per-Type Evaluators
// ============================================================================

/**
 * Age rule: flag items added more than N days ago.
 */
function evaluateAgeRule(item: CacheItemForEval, params: AgeRuleParams, now: Date): string | null {
	const dateField = item.arrAddedAt;
	if (!dateField) return null;

	const ageDays = (now.getTime() - dateField.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Added ${Math.floor(ageDays)} days ago (threshold: ${params.days} days)`;
	}

	return null;
}

/**
 * Size rule: flag items based on disk size.
 */
function evaluateSizeRule(item: CacheItemForEval, params: SizeRuleParams): string | null {
	const sizeGb = Number(item.sizeOnDisk) / (1024 * 1024 * 1024);

	if (params.operator === "greater_than" && sizeGb > params.sizeGb) {
		return `Size: ${sizeGb.toFixed(1)} GB (threshold: > ${params.sizeGb} GB)`;
	}
	if (params.operator === "less_than" && sizeGb < params.sizeGb) {
		return `Size: ${sizeGb.toFixed(1)} GB (threshold: < ${params.sizeGb} GB)`;
	}

	return null;
}

/**
 * Rating rule: flag items based on TMDB rating from the data blob.
 */
function evaluateRatingRule(item: CacheItemForEval, params: RatingRuleParams): string | null {
	const rating = extractRating(item);
	if (rating === null) return null;

	if (params.operator === "less_than" && rating < params.score) {
		return `TMDB rating: ${rating.toFixed(1)} (threshold: < ${params.score})`;
	}
	if (params.operator === "greater_than" && rating > params.score) {
		return `TMDB rating: ${rating.toFixed(1)} (threshold: > ${params.score})`;
	}

	return null;
}

/**
 * Status rule: flag items with specific statuses (e.g., "ended", "deleted").
 */
function evaluateStatusRule(item: CacheItemForEval, params: StatusRuleParams): string | null {
	if (!item.status) return null;

	const normalizedStatus = item.status.toLowerCase();
	const matched = params.statuses.find((s) => s.toLowerCase() === normalizedStatus);

	if (matched) {
		return `Status is "${item.status}" (matches: ${params.statuses.join(", ")})`;
	}

	return null;
}

/**
 * Unmonitored rule: flag items that are not monitored.
 */
function evaluateUnmonitoredRule(item: CacheItemForEval): string | null {
	if (!item.monitored) {
		return "Item is unmonitored";
	}
	return null;
}

/**
 * Genre rule: flag items with/without specific genres.
 * Genres are extracted from the JSON data blob (Sonarr/Radarr store genres as string[]).
 */
function evaluateGenreRule(item: CacheItemForEval, params: GenreRuleParams): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const genres = Array.isArray(data.genres)
		? (data.genres as string[]).map((g) => g.toLowerCase())
		: [];

	if (genres.length === 0) return null;

	const targetGenres = params.genres.map((g) => g.toLowerCase());

	if (params.operator === "includes_any") {
		const matched = targetGenres.filter((g) => genres.includes(g));
		if (matched.length > 0) {
			return `Genres include: ${matched.join(", ")} (match: includes_any [${params.genres.join(", ")}])`;
		}
	} else if (params.operator === "excludes_all") {
		const hasNone = targetGenres.every((g) => !genres.includes(g));
		if (hasNone) {
			return `Genres exclude all of: ${params.genres.join(", ")} (item genres: ${genres.join(", ")})`;
		}
	}

	return null;
}

/**
 * Year range rule: flag items based on their release year.
 */
function evaluateYearRangeRule(item: CacheItemForEval, params: YearRangeRuleParams): string | null {
	if (item.year === null) return null;

	if (params.operator === "before" && params.year !== undefined && item.year < params.year) {
		return `Year ${item.year} is before ${params.year}`;
	}
	if (params.operator === "after" && params.year !== undefined && item.year > params.year) {
		return `Year ${item.year} is after ${params.year}`;
	}
	if (
		params.operator === "between" &&
		params.yearFrom !== undefined &&
		params.yearTo !== undefined &&
		item.year >= params.yearFrom &&
		item.year <= params.yearTo
	) {
		return `Year ${item.year} is between ${params.yearFrom}-${params.yearTo}`;
	}

	return null;
}

/**
 * No file rule: flag items that have no file on disk.
 */
function evaluateNoFileRule(item: CacheItemForEval): string | null {
	if (!item.hasFile) {
		return "Item has no file on disk";
	}
	return null;
}

/**
 * Quality profile rule: flag items assigned to specific quality profiles.
 * Uses the indexed qualityProfileName field from the cache.
 */
function evaluateQualityProfileRule(
	item: CacheItemForEval,
	params: QualityProfileRuleParams,
): string | null {
	if (!item.qualityProfileName) return null;

	const matched = params.profileNames.find(
		(p) => p.toLowerCase() === item.qualityProfileName!.toLowerCase(),
	);
	if (matched) {
		return `Quality profile "${item.qualityProfileName}" matches [${params.profileNames.join(", ")}]`;
	}

	return null;
}

/**
 * Language rule: flag items with/without specific languages.
 * Checks both Sonarr's originalLanguage field and Radarr's language from the data blob.
 */
function evaluateLanguageRule(item: CacheItemForEval, params: LanguageRuleParams): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	// Collect language strings from various ARR formats
	const languages: string[] = [];

	// Radarr: originalLanguage.name
	if (typeof data.originalLanguage === "object" && data.originalLanguage !== null) {
		const lang = (data.originalLanguage as Record<string, unknown>).name;
		if (typeof lang === "string") languages.push(lang.toLowerCase());
	}

	// Sonarr: originalLanguage sometimes a direct object or string
	if (typeof data.originalLanguage === "string") {
		languages.push(data.originalLanguage.toLowerCase());
	}

	// Both: languages array (e.g. [{id: 1, name: "English"}])
	if (Array.isArray(data.languages)) {
		for (const entry of data.languages) {
			if (typeof entry === "object" && entry !== null) {
				const name = (entry as Record<string, unknown>).name;
				if (typeof name === "string") languages.push(name.toLowerCase());
			} else if (typeof entry === "string") {
				languages.push(entry.toLowerCase());
			}
		}
	}

	if (languages.length === 0) return null;

	const targetLangs = params.languages.map((l) => l.toLowerCase());

	if (params.operator === "includes_any") {
		const matched = targetLangs.filter((l) => languages.includes(l));
		if (matched.length > 0) {
			return `Language includes: ${matched.join(", ")} (match: includes_any [${params.languages.join(", ")}])`;
		}
	} else if (params.operator === "excludes_all") {
		const hasNone = targetLangs.every((l) => !languages.includes(l));
		if (hasNone) {
			return `Languages exclude all of: ${params.languages.join(", ")} (item languages: ${languages.join(", ")})`;
		}
	}

	return null;
}

// ============================================================================
// File Metadata Helpers & Evaluators
// ============================================================================

/** Normalized file metadata extracted from the cached ARR data blob */
interface FileMetadata {
	videoCodec: string | null;
	audioCodec: string | null;
	resolution: string | null;
	videoDynamicRange: string | null;
	customFormatScore: number | null;
	releaseGroup: string | null;
}

/**
 * Extract file metadata from the cached data blob.
 * Movies: data.movieFile.*, Series: data.episodeFile.* (single file) or data.statistics
 */
function extractFileMetadata(item: CacheItemForEval): FileMetadata | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	// Try movieFile first (Radarr)
	const movieFile = data.movieFile as Record<string, unknown> | undefined;
	if (movieFile && typeof movieFile === "object") {
		return {
			videoCodec: typeof movieFile.videoCodec === "string" ? movieFile.videoCodec : null,
			audioCodec: typeof movieFile.audioCodec === "string" ? movieFile.audioCodec : null,
			resolution: typeof movieFile.resolution === "string" ? movieFile.resolution : null,
			videoDynamicRange:
				typeof movieFile.videoDynamicRange === "string" ? movieFile.videoDynamicRange : null,
			customFormatScore:
				typeof movieFile.customFormatScore === "number" ? movieFile.customFormatScore : null,
			releaseGroup: typeof movieFile.releaseGroup === "string" ? movieFile.releaseGroup : null,
		};
	}

	// Try episodeFile (Sonarr — single episode file attached to series)
	const episodeFile = data.episodeFile as Record<string, unknown> | undefined;
	if (episodeFile && typeof episodeFile === "object") {
		return {
			videoCodec: typeof episodeFile.videoCodec === "string" ? episodeFile.videoCodec : null,
			audioCodec: typeof episodeFile.audioCodec === "string" ? episodeFile.audioCodec : null,
			resolution: typeof episodeFile.resolution === "string" ? episodeFile.resolution : null,
			videoDynamicRange:
				typeof episodeFile.videoDynamicRange === "string" ? episodeFile.videoDynamicRange : null,
			customFormatScore:
				typeof episodeFile.customFormatScore === "number" ? episodeFile.customFormatScore : null,
			releaseGroup: typeof episodeFile.releaseGroup === "string" ? episodeFile.releaseGroup : null,
		};
	}

	return null;
}

/**
 * Video codec rule: flag items by video codec (e.g., x264, x265, AV1).
 */
function evaluateVideoCodecRule(
	item: CacheItemForEval,
	params: VideoCodecRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (!meta?.videoCodec) return null;

	const codec = meta.videoCodec.toLowerCase();
	const targets = params.codecs.map((c) => c.toLowerCase());

	if (params.operator === "is" && targets.includes(codec)) {
		return `Video codec is "${meta.videoCodec}" (matches: [${params.codecs.join(", ")}])`;
	}
	if (params.operator === "is_not" && !targets.includes(codec)) {
		return `Video codec is "${meta.videoCodec}" (not in: [${params.codecs.join(", ")}])`;
	}
	return null;
}

/**
 * Audio codec rule: flag items by audio codec (e.g., AAC, DTS, TrueHD).
 */
function evaluateAudioCodecRule(
	item: CacheItemForEval,
	params: AudioCodecRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (!meta?.audioCodec) return null;

	const codec = meta.audioCodec.toLowerCase();
	const targets = params.codecs.map((c) => c.toLowerCase());

	if (params.operator === "is" && targets.includes(codec)) {
		return `Audio codec is "${meta.audioCodec}" (matches: [${params.codecs.join(", ")}])`;
	}
	if (params.operator === "is_not" && !targets.includes(codec)) {
		return `Audio codec is "${meta.audioCodec}" (not in: [${params.codecs.join(", ")}])`;
	}
	return null;
}

/**
 * Resolution rule: flag items by resolution (e.g., R2160p, R1080p, R720p).
 */
function evaluateResolutionRule(
	item: CacheItemForEval,
	params: ResolutionRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (!meta?.resolution) return null;

	const res = meta.resolution.toLowerCase();
	const targets = params.resolutions.map((r) => r.toLowerCase());

	if (params.operator === "is" && targets.includes(res)) {
		return `Resolution is "${meta.resolution}" (matches: [${params.resolutions.join(", ")}])`;
	}
	if (params.operator === "is_not" && !targets.includes(res)) {
		return `Resolution is "${meta.resolution}" (not in: [${params.resolutions.join(", ")}])`;
	}
	return null;
}

/**
 * HDR type rule: flag items by dynamic range (e.g., HDR, HDR10, Dolby Vision).
 * "none" operator flags items with no HDR (empty or missing videoDynamicRange).
 */
function evaluateHdrTypeRule(item: CacheItemForEval, params: HdrTypeRuleParams): string | null {
	const meta = extractFileMetadata(item);

	if (params.operator === "none") {
		if (!meta?.videoDynamicRange || meta.videoDynamicRange.trim() === "") {
			return "No HDR/dynamic range detected";
		}
		return null;
	}

	if (!meta?.videoDynamicRange) return null;
	const hdr = meta.videoDynamicRange.toLowerCase();
	const targets = (params.types ?? []).map((t) => t.toLowerCase());

	if (params.operator === "is" && targets.includes(hdr)) {
		return `HDR type is "${meta.videoDynamicRange}" (matches: [${(params.types ?? []).join(", ")}])`;
	}
	if (params.operator === "is_not" && !targets.includes(hdr)) {
		return `HDR type is "${meta.videoDynamicRange}" (not in: [${(params.types ?? []).join(", ")}])`;
	}
	return null;
}

/**
 * Custom format score rule: flag items by their custom format score.
 */
function evaluateCustomFormatScoreRule(
	item: CacheItemForEval,
	params: CustomFormatScoreRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (meta?.customFormatScore === null || meta?.customFormatScore === undefined) return null;

	if (params.operator === "greater_than" && meta.customFormatScore > params.score) {
		return `Custom format score: ${meta.customFormatScore} (threshold: > ${params.score})`;
	}
	if (params.operator === "less_than" && meta.customFormatScore < params.score) {
		return `Custom format score: ${meta.customFormatScore} (threshold: < ${params.score})`;
	}
	return null;
}

/**
 * Runtime rule: flag items by runtime in minutes.
 * Uses the top-level `runtime` field from the data blob.
 */
function evaluateRuntimeRule(item: CacheItemForEval, params: RuntimeRuleParams): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	let runtime: number | null = null;
	if (typeof data.runtime === "number") {
		runtime = data.runtime;
	} else if (typeof data.statistics === "object" && data.statistics !== null) {
		const stats = data.statistics as Record<string, unknown>;
		if (typeof stats.runtime === "number") runtime = stats.runtime;
	}

	if (runtime === null) return null;

	if (params.operator === "greater_than" && runtime > params.minutes) {
		return `Runtime: ${runtime} min (threshold: > ${params.minutes} min)`;
	}
	if (params.operator === "less_than" && runtime < params.minutes) {
		return `Runtime: ${runtime} min (threshold: < ${params.minutes} min)`;
	}
	return null;
}

/**
 * Release group rule: flag items by release group name.
 */
function evaluateReleaseGroupRule(
	item: CacheItemForEval,
	params: ReleaseGroupRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (!meta?.releaseGroup) return null;

	const group = meta.releaseGroup.toLowerCase();
	const targets = params.groups.map((g) => g.toLowerCase());

	if (params.operator === "is" && targets.includes(group)) {
		return `Release group is "${meta.releaseGroup}" (matches: [${params.groups.join(", ")}])`;
	}
	if (params.operator === "is_not" && !targets.includes(group)) {
		return `Release group is "${meta.releaseGroup}" (not in: [${params.groups.join(", ")}])`;
	}
	return null;
}

// ============================================================================
// Seerr Rule Evaluators
// ============================================================================

/** Seerr request status code → label mapping */
const SEERR_STATUS_LABELS: Record<number, string> = {
	1: "pending",
	2: "approved",
	3: "declined",
	4: "failed",
	5: "completed",
};

/**
 * Look up Seerr requests for a cache item via its tmdbId from the data blob.
 */
function lookupSeerrRequests(
	item: CacheItemForEval,
	seerrMap: SeerrRequestMap | undefined,
): SeerrRequestInfo[] | null {
	if (!seerrMap || seerrMap.size === 0) return null;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	// Extract tmdbId from the data blob (LibraryItem.remoteIds.tmdbId)
	const remoteIds = data.remoteIds as Record<string, unknown> | undefined;
	const tmdbId = remoteIds?.tmdbId;
	if (!tmdbId) return null;

	// Build the lookup key: "movie:12345" or "tv:12345"
	const mediaType = item.itemType === "movie" ? "movie" : "tv";
	const key = `${mediaType}:${tmdbId}`;

	return seerrMap.get(key) ?? null;
}

/**
 * Seerr Requested By: flag items requested by specific Seerr users.
 */
function evaluateSeerrRequestedBy(
	item: CacheItemForEval,
	params: SeerrRequestedByParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	const targetNames = params.userNames.map((n) => n.toLowerCase());

	for (const req of requests) {
		if (targetNames.includes(req.requestedBy.toLowerCase())) {
			return `Requested by "${req.requestedBy}" (match: [${params.userNames.join(", ")}])`;
		}
	}

	return null;
}

/**
 * Seerr Request Age: flag items whose Seerr request is older/newer than N days.
 */
function evaluateSeerrRequestAge(
	item: CacheItemForEval,
	params: SeerrRequestAgeParams,
	seerrMap: SeerrRequestMap | undefined,
	now: Date,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	// Use the oldest request's createdAt
	let oldest = requests[0]!;
	for (const req of requests) {
		if (req.createdAt < oldest.createdAt) oldest = req;
	}

	const requestDate = new Date(oldest.createdAt);
	const ageDays = (now.getTime() - requestDate.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Seerr request ${Math.floor(ageDays)} days old (threshold: > ${params.days} days, requested by ${oldest.requestedBy})`;
	}
	if (params.operator === "newer_than" && ageDays <= params.days) {
		return `Seerr request ${Math.floor(ageDays)} days old (threshold: < ${params.days} days, requested by ${oldest.requestedBy})`;
	}

	return null;
}

/**
 * Seerr Request Status: flag items whose Seerr request has a specific status.
 */
function evaluateSeerrRequestStatus(
	item: CacheItemForEval,
	params: SeerrRequestStatusParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	for (const req of requests) {
		const statusLabel = SEERR_STATUS_LABELS[req.status];
		if (statusLabel && params.statuses.includes(statusLabel as (typeof params.statuses)[number])) {
			return `Seerr request status is "${statusLabel}" (requested by ${req.requestedBy})`;
		}
	}

	return null;
}

/**
 * Seerr Is 4K: flag items based on whether the Seerr request is for 4K.
 */
function evaluateSeerrIs4k(
	item: CacheItemForEval,
	params: SeerrIs4kParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	for (const req of requests) {
		if (req.is4k === params.is4k) {
			return params.is4k
				? `Seerr request is 4K (requested by ${req.requestedBy})`
				: `Seerr request is not 4K (requested by ${req.requestedBy})`;
		}
	}
	return null;
}

/**
 * Seerr Request Modified Age: flag items by how recently the Seerr request was modified.
 */
function evaluateSeerrRequestModifiedAge(
	item: CacheItemForEval,
	params: SeerrRequestModifiedAgeParams,
	seerrMap: SeerrRequestMap | undefined,
	now: Date,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	// Use the most recently modified request
	let latest = requests[0]!;
	for (const req of requests) {
		if (req.updatedAt && req.updatedAt > (latest.updatedAt ?? "")) latest = req;
	}

	if (!latest.updatedAt) return null;
	const modifiedDate = new Date(latest.updatedAt);
	const ageDays = (now.getTime() - modifiedDate.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Seerr request last modified ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	}
	if (params.operator === "newer_than" && ageDays <= params.days) {
		return `Seerr request last modified ${Math.floor(ageDays)} days ago (threshold: < ${params.days} days)`;
	}
	return null;
}

/**
 * Seerr Modified By: flag items whose Seerr request was last modified by specific users.
 */
function evaluateSeerrModifiedBy(
	item: CacheItemForEval,
	params: SeerrModifiedByParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	const targetNames = params.userNames.map((n) => n.toLowerCase());

	for (const req of requests) {
		if (req.modifiedBy && targetNames.includes(req.modifiedBy.toLowerCase())) {
			return `Seerr request modified by "${req.modifiedBy}" (match: [${params.userNames.join(", ")}])`;
		}
	}
	return null;
}

// ============================================================================
// Tautulli Rule Evaluators
// ============================================================================

/**
 * Look up Tautulli watch data for a cache item via its tmdbId from the data blob.
 */
function lookupTautulliWatch(
	item: CacheItemForEval,
	tautulliMap: TautulliWatchMap | undefined,
): { lastWatchedAt: Date | null; watchCount: number; watchedByUsers: string[] } | null {
	if (!tautulliMap || tautulliMap.size === 0) return null;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	const remoteIds = data.remoteIds as Record<string, unknown> | undefined;
	const tmdbId = remoteIds?.tmdbId;
	if (!tmdbId) return null;

	const mediaType = item.itemType === "movie" ? "movie" : "series";
	const key = `${mediaType}:${tmdbId}`;

	return tautulliMap.get(key) ?? null;
}

/**
 * Tautulli Last Watched: flag items based on when they were last watched.
 * "never" operator flags items that have never been watched.
 */
function evaluateTautulliLastWatched(
	item: CacheItemForEval,
	params: TautulliLastWatchedParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupTautulliWatch(item, ctx.tautulliMap);

	if (params.operator === "never") {
		if (!watch || watch.lastWatchedAt === null) {
			return "Never watched (per Tautulli)";
		}
		return null;
	}

	if (!watch || !watch.lastWatchedAt) return null;
	const ageDays = (ctx.now.getTime() - watch.lastWatchedAt.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && params.days && ageDays >= params.days) {
		return `Last watched ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	}
	return null;
}

/**
 * Tautulli Watch Count: flag items based on play count.
 */
function evaluateTautulliWatchCount(
	item: CacheItemForEval,
	params: TautulliWatchCountParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupTautulliWatch(item, ctx.tautulliMap);
	const count = watch?.watchCount ?? 0;

	if (params.operator === "less_than" && count < params.count) {
		return `Watch count: ${count} (threshold: < ${params.count})`;
	}
	if (params.operator === "greater_than" && count > params.count) {
		return `Watch count: ${count} (threshold: > ${params.count})`;
	}
	return null;
}

/**
 * Tautulli Watched By: flag items based on which users have watched them.
 */
function evaluateTautulliWatchedBy(
	item: CacheItemForEval,
	params: TautulliWatchedByParams,
	ctx: EvalContext,
): string | null {
	const watch = lookupTautulliWatch(item, ctx.tautulliMap);
	if (!watch || watch.watchedByUsers.length === 0) return null;

	const users = watch.watchedByUsers.map((u) => u.toLowerCase());
	const targetNames = params.userNames.map((n) => n.toLowerCase());

	if (params.operator === "includes_any") {
		const matched = targetNames.filter((n) => users.includes(n));
		if (matched.length > 0) {
			return `Watched by: ${matched.join(", ")} (match: includes_any [${params.userNames.join(", ")}])`;
		}
	} else if (params.operator === "excludes_all") {
		const hasNone = targetNames.every((n) => !users.includes(n));
		if (hasNone) {
			return `Not watched by any of: ${params.userNames.join(", ")} (watched by: ${watch.watchedByUsers.join(", ")})`;
		}
	}
	return null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract TMDB rating from the item's JSON data blob.
 * The data field contains a serialized LibraryItem which may have ratings info
 * from Sonarr/Radarr's API response (stored in the `ratings` or `certification` fields).
 */
export function extractRating(item: CacheItemForEval): number | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;

	const data = parsed as Record<string, unknown>;

	// Radarr stores ratings as { tmdb: { value: 7.5 }, imdb: { value: 7.2 } }
	if (typeof data.ratings === "object" && data.ratings !== null) {
		const ratings = data.ratings as Record<string, unknown>;
		const tmdb = ratings.tmdb as Record<string, unknown> | undefined;
		if (tmdb && typeof tmdb.value === "number") {
			return tmdb.value;
		}
		// Fallback to any available rating
		for (const source of Object.values(ratings)) {
			if (typeof source === "object" && source !== null) {
				const val = (source as Record<string, unknown>).value;
				if (typeof val === "number" && val > 0) return val;
			}
		}
	}

	return null;
}

/**
 * Parse rule parameters JSON string into a typed object.
 */
function parseParams(rule: LibraryCleanupRule): Record<string, unknown> | null {
	return safeJsonParse(rule.parameters) as Record<string, unknown> | null;
}

/**
 * Check if item's service type passes the rule's service filter.
 */
function passesServiceFilter(instanceService: string, serviceFilter: string | null): boolean {
	if (!serviceFilter) return true;
	const filter = safeJsonParse(serviceFilter) as string[] | null;
	if (!filter || filter.length === 0) return true;
	return filter.some((s) => s.toUpperCase() === instanceService.toUpperCase());
}

/**
 * Check if item's instance passes the rule's instance filter.
 */
function passesInstanceFilter(instanceId: string, instanceFilter: string | null): boolean {
	if (!instanceFilter) return true;
	const filter = safeJsonParse(instanceFilter) as string[] | null;
	if (!filter || filter.length === 0) return true;
	return filter.includes(instanceId);
}

/**
 * Check if item should be excluded by tag filter.
 */
function passesTagExclusion(item: CacheItemForEval, excludeTags: string | null): boolean {
	if (!excludeTags) return true;
	const tagIds = safeJsonParse(excludeTags) as number[] | null;
	if (!tagIds || tagIds.length === 0) return true;

	// Parse tags from data blob (LibraryItem stores tags as string[])
	const parsed = safeJsonParse(item.data);
	if (!parsed) return true;

	const data = parsed as Record<string, unknown>;
	const itemTags = Array.isArray(data.tags) ? data.tags : [];

	// Tags might be tag IDs (numbers) or tag labels (strings) depending on ARR version
	// Check for any overlap
	for (const excludeId of tagIds) {
		if (itemTags.includes(excludeId) || itemTags.includes(String(excludeId))) {
			return false; // excluded
		}
	}
	return true;
}

/**
 * Check if item should be excluded by title regex patterns.
 */
function passesTitleExclusion(title: string, excludeTitles: string | null): boolean {
	if (!excludeTitles) return true;
	const patterns = safeJsonParse(excludeTitles) as string[] | null;
	if (!patterns || patterns.length === 0) return true;

	for (const pattern of patterns) {
		try {
			const regex = new RegExp(pattern, "i");
			if (regex.test(title)) return false; // excluded
		} catch {
			// Invalid regex — skip pattern
		}
	}
	return true;
}

// ============================================================================
// Main Evaluator
// ============================================================================

/**
 * Evaluate a single cache item against a single cleanup rule.
 * Returns a RuleMatch if the rule triggers, null otherwise.
 *
 * This function handles:
 * 1. Rule enable check
 * 2. Service/instance/tag/title filters
 * 3. Dispatching to per-type evaluator
 */
export function evaluateRule(
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
	instanceService: string,
	ctx: EvalContext,
): RuleMatch | null {
	if (!rule.enabled) return null;

	// Pre-filters
	if (!passesServiceFilter(instanceService, rule.serviceFilter)) return null;
	if (!passesInstanceFilter(item.instanceId, rule.instanceFilter)) return null;
	if (!passesTagExclusion(item, rule.excludeTags)) return null;
	if (!passesTitleExclusion(item.title, rule.excludeTitles)) return null;

	const params = parseParams(rule);
	if (!params) return null;

	let reason: string | null = null;

	switch (rule.ruleType) {
		// ── Basic rules ─────────────────────────────────────────────
		case "age":
			reason = evaluateAgeRule(item, params as AgeRuleParams, ctx.now);
			break;
		case "size":
			reason = evaluateSizeRule(item, params as SizeRuleParams);
			break;
		case "rating":
			reason = evaluateRatingRule(item, params as RatingRuleParams);
			break;
		case "status":
			reason = evaluateStatusRule(item, params as StatusRuleParams);
			break;
		case "unmonitored":
			reason = evaluateUnmonitoredRule(item);
			break;
		case "genre":
			reason = evaluateGenreRule(item, params as GenreRuleParams);
			break;
		case "year_range":
			reason = evaluateYearRangeRule(item, params as YearRangeRuleParams);
			break;
		case "no_file":
			reason = evaluateNoFileRule(item);
			break;
		case "quality_profile":
			reason = evaluateQualityProfileRule(item, params as QualityProfileRuleParams);
			break;
		case "language":
			reason = evaluateLanguageRule(item, params as LanguageRuleParams);
			break;

		// ── File metadata rules ─────────────────────────────────────
		case "video_codec":
			reason = evaluateVideoCodecRule(item, params as VideoCodecRuleParams);
			break;
		case "audio_codec":
			reason = evaluateAudioCodecRule(item, params as AudioCodecRuleParams);
			break;
		case "resolution":
			reason = evaluateResolutionRule(item, params as ResolutionRuleParams);
			break;
		case "hdr_type":
			reason = evaluateHdrTypeRule(item, params as HdrTypeRuleParams);
			break;
		case "custom_format_score":
			reason = evaluateCustomFormatScoreRule(item, params as CustomFormatScoreRuleParams);
			break;
		case "runtime":
			reason = evaluateRuntimeRule(item, params as RuntimeRuleParams);
			break;
		case "release_group":
			reason = evaluateReleaseGroupRule(item, params as ReleaseGroupRuleParams);
			break;

		// ── Seerr rules ─────────────────────────────────────────────
		case "seerr_requested_by":
			reason = evaluateSeerrRequestedBy(item, params as SeerrRequestedByParams, ctx.seerrMap);
			break;
		case "seerr_request_age":
			reason = evaluateSeerrRequestAge(
				item,
				params as SeerrRequestAgeParams,
				ctx.seerrMap,
				ctx.now,
			);
			break;
		case "seerr_request_status":
			reason = evaluateSeerrRequestStatus(item, params as SeerrRequestStatusParams, ctx.seerrMap);
			break;
		case "seerr_is_4k":
			reason = evaluateSeerrIs4k(item, params as SeerrIs4kParams, ctx.seerrMap);
			break;
		case "seerr_request_modified_age":
			reason = evaluateSeerrRequestModifiedAge(
				item,
				params as SeerrRequestModifiedAgeParams,
				ctx.seerrMap,
				ctx.now,
			);
			break;
		case "seerr_modified_by":
			reason = evaluateSeerrModifiedBy(item, params as SeerrModifiedByParams, ctx.seerrMap);
			break;

		// ── Tautulli rules ──────────────────────────────────────────
		case "tautulli_last_watched":
			reason = evaluateTautulliLastWatched(item, params as TautulliLastWatchedParams, ctx);
			break;
		case "tautulli_watch_count":
			reason = evaluateTautulliWatchCount(item, params as TautulliWatchCountParams, ctx);
			break;
		case "tautulli_watched_by":
			reason = evaluateTautulliWatchedBy(item, params as TautulliWatchedByParams, ctx);
			break;

		default:
			return null;
	}

	if (reason) {
		return { ruleId: rule.id, ruleName: rule.name, reason };
	}

	return null;
}

/**
 * Evaluate a cache item against all rules (sorted by priority).
 * First matching rule wins.
 */
export function evaluateItemAgainstRules(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
): RuleMatch | null {
	for (const rule of rules) {
		const match = evaluateRule(item, rule, instanceService, ctx);
		if (match) return match;
	}
	return null;
}
