/**
 * Library Cleanup Rule Evaluators
 *
 * Pure functions that evaluate a single LibraryCache item against a cleanup rule.
 * Each rule type has its own evaluator that returns a reason string if matched, or null.
 *
 * The main entry point, evaluateRule(), supports both legacy single-condition rules
 * and AND/OR composite rules (flat, one-level).
 */

import type {
	AgeRuleParams,
	AudioChannelsRuleParams,
	AudioCodecRuleParams,
	Condition,
	CustomFormatScoreRuleParams,
	FilePathRuleParams,
	GenreRuleParams,
	HdrTypeRuleParams,
	ImdbRatingRuleParams,
	LanguageRuleParams,
	PlexAddedAtParams,
	PlexCollectionRuleParams,
	PlexLabelRuleParams,
	PlexLastWatchedParams,
	PlexOnDeckParams,
	PlexUserRatingParams,
	PlexWatchCountParams,
	PlexEpisodeCompletionParams,
	PlexWatchedByParams,
	QualityProfileRuleParams,
	RatingRuleParams,
	ReleaseGroupRuleParams,
	ResolutionRuleParams,
	RuntimeRuleParams,
	SeerrIs4kParams,
	SeerrIsRequestedParams,
	SeerrModifiedByParams,
	SeerrRequestAgeParams,
	SeerrRequestCountParams,
	SeerrRequestedByParams,
	SeerrRequestModifiedAgeParams,
	SeerrRequestStatusParams,
	SizeRuleParams,
	RecentlyActiveParams,
	StalenessScoreParams,
	StatusRuleParams,
	TagMatchRuleParams,
	UserRetentionParams,
	TautulliLastWatchedParams,
	TautulliWatchCountParams,
	TautulliWatchedByParams,
	VideoCodecRuleParams,
	YearRangeRuleParams,
} from "@arr/shared";
import { isRegexSafe, ruleDataSourceMap, type DataSourceDependency } from "@arr/shared";
import type { LibraryCleanupRule } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import type {
	CacheItemForEval,
	EvalContext,
	PlexWatchInfo,
	PlexWatchMap,
	RuleAction,
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
		return `Added ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	}
	if (params.operator === "newer_than" && ageDays < params.days) {
		return `Added ${Math.floor(ageDays)} days ago (threshold: < ${params.days} days)`;
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

	if (params.operator === "unrated") {
		return rating === null ? "No TMDB rating" : null;
	}

	if (rating === null || params.score === undefined) return null;

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
	if (params.operator === "newer_than" && ageDays < params.days) {
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
	if (params.operator === "newer_than" && ageDays < params.days) {
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

/**
 * Seerr Is Requested: flag items based on whether they have any Seerr request.
 */
function evaluateSeerrIsRequested(
	item: CacheItemForEval,
	params: SeerrIsRequestedParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	// If Seerr data is unavailable, skip evaluation to avoid false "not requested" matches
	if (!seerrMap) return null;
	const requests = lookupSeerrRequests(item, seerrMap);
	const hasRequest = requests !== null && requests.length > 0;

	if (params.isRequested && hasRequest) {
		return `Has Seerr request (${requests!.length} request(s))`;
	}
	if (!params.isRequested && !hasRequest) {
		return "No Seerr request found";
	}
	return null;
}

/**
 * Seerr Request Count: flag items based on number of Seerr requests.
 */
function evaluateSeerrRequestCount(
	item: CacheItemForEval,
	params: SeerrRequestCountParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	if (!seerrMap) return null;
	const requests = lookupSeerrRequests(item, seerrMap);
	// If lookup returns null (no tmdbId), skip to avoid false "0 requests" matches
	if (requests === null) return null;
	const count = requests.length;

	if (params.operator === "less_than" && count < params.count) {
		return `Seerr request count: ${count} (threshold: < ${params.count})`;
	}
	if (params.operator === "greater_than" && count > params.count) {
		return `Seerr request count: ${count} (threshold: > ${params.count})`;
	}
	if (params.operator === "equals" && count === params.count) {
		return `Seerr request count: ${count} (threshold: = ${params.count})`;
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

	if (!watch || !watch.lastWatchedAt) {
		// Never watched — fall back to best available added date
		if (params.operator === "older_than" && params.days) {
			// Prefer Plex addedAt (when added to media server), then arrAddedAt (when grabbed by ARR)
			const plexWatch = lookupPlexWatch(item, ctx.plexMap);
			const refDate = plexWatch?.addedAt ?? item.arrAddedAt;
			if (refDate) {
				const addedDays = (ctx.now.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24);
				if (addedDays >= params.days) {
					const source = plexWatch?.addedAt ? "Plex" : "library";
					return `Never watched per Tautulli, added to ${source} ${Math.floor(addedDays)} days ago (threshold: > ${params.days} days)`;
				}
			}
		}
		return null;
	}
	const ageDays = (ctx.now.getTime() - watch.lastWatchedAt.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && params.days && ageDays >= params.days) {
		return `Last watched ${Math.floor(ageDays)} days ago per Tautulli (threshold: > ${params.days} days)`;
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
	if (!watch) {
		// Not in Tautulli — infer 0 plays when Tautulli is configured and item has a file
		if (
			ctx.tautulliMap &&
			ctx.tautulliMap.size > 0 &&
			params.operator === "less_than" &&
			params.count > 0 &&
			item.hasFile &&
			item.arrAddedAt
		) {
			const ageDays = Math.floor(
				(ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24),
			);
			return `Not tracked by Tautulli, in library for ${ageDays} days (threshold: < ${params.count} plays)`;
		}
		return null;
	}
	const count = watch.watchCount;

	// Age context for low play counts
	const ageCtx =
		count === 0 && item.arrAddedAt
			? `, in library for ${Math.floor((ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24))} days`
			: "";

	if (params.operator === "less_than" && count < params.count) {
		return `Tautulli play count: ${count}${ageCtx} (threshold: < ${params.count})`;
	}
	if (params.operator === "greater_than" && count > params.count) {
		return `Tautulli play count: ${count} (threshold: > ${params.count})`;
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
// Plex Rule Evaluators
// ============================================================================

/**
 * Look up Plex watch data for a cache item via its tmdbId from the data blob.
 * When plexLibraryFilter is set, only data from matching Plex library sections is used.
 */
function lookupPlexWatch(
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
function evaluatePlexLastWatched(
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
function evaluatePlexWatchCount(
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
function evaluatePlexOnDeck(
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
function evaluatePlexUserRating(
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
function evaluatePlexWatchedBy(
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
function evaluatePlexCollection(
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
function evaluatePlexLabel(
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
function evaluatePlexAddedAt(
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

// ============================================================================
// Phase C: New Rule Evaluators
// ============================================================================

/**
 * IMDb Rating rule: flag items based on IMDb rating from the data blob.
 */
function evaluateImdbRatingRule(
	item: CacheItemForEval,
	params: ImdbRatingRuleParams,
): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	// Extract IMDb rating: ratings.imdb.value
	if (typeof data.ratings !== "object" || data.ratings === null) {
		return params.operator === "unrated" ? "No IMDb rating" : null;
	}
	const ratings = data.ratings as Record<string, unknown>;
	const imdb = ratings.imdb as Record<string, unknown> | undefined;
	if (!imdb || typeof imdb.value !== "number") {
		return params.operator === "unrated" ? "No IMDb rating" : null;
	}

	if (params.operator === "unrated") return null; // Has a rating, doesn't match unrated

	const rating = imdb.value;
	if (params.score === undefined) return null;

	if (params.operator === "less_than" && rating < params.score) {
		return `IMDb rating: ${rating.toFixed(1)} (threshold: < ${params.score})`;
	}
	if (params.operator === "greater_than" && rating > params.score) {
		return `IMDb rating: ${rating.toFixed(1)} (threshold: > ${params.score})`;
	}
	return null;
}

/** Cache compiled regexes to avoid re-compiling per item. Rejects unsafe patterns. */
const regexCache = new Map<string, RegExp>();
const MAX_REGEX_CACHE = 200;
function getCachedRegex(pattern: string): RegExp | null {
	let cached = regexCache.get(pattern);
	if (cached) return cached;
	if (!isRegexSafe(pattern)) return null;
	try {
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		cached = new RegExp(pattern, "i");
		// FIFO eviction when cache is full
		if (regexCache.size >= MAX_REGEX_CACHE) {
			const firstKey = regexCache.keys().next().value;
			if (firstKey !== undefined) regexCache.delete(firstKey);
		}
		regexCache.set(pattern, cached);
		return cached;
	} catch {
		return null;
	}
}

/**
 * File Path rule: flag items based on file path regex matching.
 */
function evaluateFilePathRule(item: CacheItemForEval, params: FilePathRuleParams): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	const field = params.field ?? "path";
	let pathValue: string | null = null;

	if (field === "path") {
		pathValue = typeof data.path === "string" ? data.path : null;
		// Fallback to movieFile.path or folderName
		if (!pathValue) {
			const movieFile = data.movieFile as Record<string, unknown> | undefined;
			if (movieFile && typeof movieFile.path === "string") pathValue = movieFile.path;
		}
		if (!pathValue && typeof data.folderName === "string") pathValue = data.folderName;
	} else {
		pathValue = typeof data.rootFolderPath === "string" ? data.rootFolderPath : null;
	}

	if (!pathValue) return null;

	const regex = getCachedRegex(params.pattern);
	if (!regex) return null;

	const matches = regex.test(pathValue);
	if (params.operator === "matches" && matches) {
		return `Path "${pathValue}" matches pattern /${params.pattern}/`;
	}
	if (params.operator === "not_matches" && !matches) {
		return `Path "${pathValue}" does not match pattern /${params.pattern}/`;
	}
	return null;
}

/**
 * Audio Channels rule: flag items by audio channel count.
 * Parses channel count from audioCodec string.
 */
function evaluateAudioChannelsRule(
	item: CacheItemForEval,
	params: AudioChannelsRuleParams,
): string | null {
	const meta = extractFileMetadata(item);
	if (!meta?.audioCodec) return null;

	const channels = parseAudioChannels(meta.audioCodec);
	if (channels === null) return null;

	if (params.operator === "is" && channels === params.channels) {
		return `Audio channels: ${channels} (matches: ${params.channels})`;
	}
	if (params.operator === "is_not" && channels !== params.channels) {
		return `Audio channels: ${channels} (not: ${params.channels})`;
	}
	if (params.operator === "greater_than" && channels > params.channels) {
		return `Audio channels: ${channels} (threshold: > ${params.channels})`;
	}
	if (params.operator === "less_than" && channels < params.channels) {
		return `Audio channels: ${channels} (threshold: < ${params.channels})`;
	}
	return null;
}

/**
 * Parse audio channel count from codec string.
 * Common patterns: "5.1" → 6, "7.1" → 8, "Stereo" → 2, "Mono" → 1, "Atmos" → 8
 */
function parseAudioChannels(codec: string): number | null {
	const lower = codec.toLowerCase();

	// Explicit channel patterns: "5.1", "7.1", "2.0"
	const channelMatch = lower.match(/(\d+)\.(\d+)/);
	if (channelMatch?.[1] && channelMatch[2]) {
		return Number.parseInt(channelMatch[1], 10) + Number.parseInt(channelMatch[2], 10);
	}

	// Named patterns
	if (lower.includes("mono")) return 1;
	if (lower.includes("stereo")) return 2;
	if (lower.includes("atmos")) return 8;

	return null;
}

/**
 * Tag Match rule: flag items based on ARR tag IDs (inclusion filter).
 * The inverse of the exclusion filter — matches when tags ARE present.
 */
function evaluateTagMatchRule(item: CacheItemForEval, params: TagMatchRuleParams): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const itemTags = Array.isArray(data.tags) ? data.tags : [];

	if (params.operator === "includes_any") {
		const matched: number[] = [];
		for (const tagId of params.tagIds) {
			if (itemTags.includes(tagId) || itemTags.includes(String(tagId))) {
				matched.push(tagId);
			}
		}
		if (matched.length > 0) {
			return `Has tag(s): ${matched.join(", ")} (match: includes_any [${params.tagIds.join(", ")}])`;
		}
	} else if (params.operator === "excludes_all") {
		const hasNone = params.tagIds.every(
			(tagId) => !itemTags.includes(tagId) && !itemTags.includes(String(tagId)),
		);
		if (hasNone) {
			return `Does not have any tag(s): [${params.tagIds.join(", ")}]`;
		}
	}
	return null;
}

// ============================================================================
// Phase 2: Behavior-Aware Evaluators
// ============================================================================

/**
 * Episode completion: flag series where watched episodes are below/above a percentage.
 * Only applies to series items (itemType === "series").
 */
function evaluatePlexEpisodeCompletion(
	item: CacheItemForEval,
	params: PlexEpisodeCompletionParams,
	ctx: EvalContext,
): string | null {
	if (item.itemType !== "series") return null;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const tmdbId = (data.remoteIds as Record<string, unknown> | undefined)?.tmdbId;
	if (typeof tmdbId !== "number") return null;

	const stats = ctx.plexEpisodeMap?.get(tmdbId);
	if (!stats || stats.total === 0) return null;

	// When minSeason is set, only count episodes from seasons >= minSeason
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
		if (total === 0) return null; // No episodes in filtered seasons
	} else {
		total = stats.total;
		watched = stats.watched;
	}

	const pct = (watched / total) * 100;
	const seasonSuffix = params.minSeason != null ? ` (seasons >= ${params.minSeason})` : "";

	if (params.operator === "less_than" && pct < params.percentage) {
		return `Episode completion ${pct.toFixed(0)}% (${watched}/${total}) < ${params.percentage}%${seasonSuffix}`;
	}
	if (params.operator === "greater_than" && pct > params.percentage) {
		return `Episode completion ${pct.toFixed(0)}% (${watched}/${total}) > ${params.percentage}%${seasonSuffix}`;
	}

	return null;
}

/**
 * User retention: flag based on which users have watched/not watched.
 * Combines Plex and/or Tautulli user data depending on source setting.
 */
function evaluateUserRetention(
	item: CacheItemForEval,
	params: UserRetentionParams,
	ctx: EvalContext,
): string | null {
	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const tmdbId = (data.remoteIds as Record<string, unknown> | undefined)?.tmdbId;
	if (typeof tmdbId !== "number") return null;

	const key = `${item.itemType}:${tmdbId}`;

	// Gather users who watched from specified source(s)
	const watchedUsers = new Set<string>();
	const source = params.source ?? "plex";

	if (source === "plex" || source === "either") {
		const plex = ctx.plexMap?.get(key);
		if (plex?.watchedByUsers) {
			for (const u of plex.watchedByUsers) watchedUsers.add(u.toLowerCase());
		}
	}
	if (source === "tautulli" || source === "either") {
		const tautulli = ctx.tautulliMap?.get(key);
		if (tautulli?.watchedByUsers) {
			for (const u of tautulli.watchedByUsers) watchedUsers.add(u.toLowerCase());
		}
	}

	if (params.operator === "watched_by_none") {
		if (watchedUsers.size === 0) {
			return `Not watched by any user (source: ${source})`;
		}
	} else if (params.operator === "watched_by_all") {
		const targetUsers = params.userNames;
		if (targetUsers && targetUsers.length > 0) {
			const allWatched = targetUsers.every((u) => watchedUsers.has(u.toLowerCase()));
			if (allWatched) {
				return `Watched by all specified users: ${targetUsers.join(", ")} (source: ${source})`;
			}
		}
	} else if (params.operator === "watched_by_count") {
		const minUsers = params.minUsers ?? 1;
		if (watchedUsers.size >= minUsers) {
			return `Watched by ${watchedUsers.size} user(s) >= ${minUsers} (source: ${source})`;
		}
	}

	return null;
}

/**
 * Staleness score: weighted 0-100 score combining multiple signals.
 * Higher = more stale. Uses Plex and item data.
 */
function evaluateStalenessScore(
	item: CacheItemForEval,
	params: StalenessScoreParams,
	ctx: EvalContext,
): string | null {
	const defaults = {
		daysSinceLastWatch: 0.3,
		inverseWatchCount: 0.2,
		notOnDeck: 0.1,
		lowUserRating: 0.15,
		lowTmdbRating: 0.15,
		sizeOnDisk: 0.1,
	};
	const w = params.weights ?? defaults;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;
	const tmdbId = (data.remoteIds as Record<string, unknown> | undefined)?.tmdbId;
	const key = typeof tmdbId === "number" ? `${item.itemType}:${tmdbId}` : null;

	const plex = key ? ctx.plexMap?.get(key) : undefined;

	// 1. Days since last watch (365+ days = 100, 0 days = 0)
	let daysSinceScore = 100;
	if (plex?.lastWatchedAt) {
		const days =
			(ctx.now.getTime() - new Date(plex.lastWatchedAt).getTime()) / (1000 * 60 * 60 * 24);
		daysSinceScore = Math.min(100, (days / 365) * 100);
	}

	// 2. Inverse watch count (0 plays = 100, 10+ plays = 0)
	let watchCountScore = 100;
	if (plex) {
		watchCountScore = Math.max(0, 100 - plex.watchCount * 10);
	}

	// 3. Not on deck (not on deck = 100, on deck = 0)
	const onDeckScore = plex?.onDeck ? 0 : 100;

	// 4. Low user rating (no rating or < 5 = 100, 10 = 0)
	let userRatingScore = 100;
	if (plex?.userRating !== null && plex?.userRating !== undefined) {
		userRatingScore = Math.max(0, 100 - plex.userRating * 10);
	}

	// 5. Low TMDB rating
	let tmdbRatingScore = 100;
	const tmdbRating = extractRating(item);
	if (tmdbRating !== null) {
		tmdbRatingScore = Math.max(0, 100 - tmdbRating * 10);
	}

	// 6. Size on disk (normalized: 50GB+ = 100)
	let sizeScore = 0;
	if (item.sizeOnDisk) {
		const sizeGb = Number(item.sizeOnDisk) / (1024 * 1024 * 1024);
		sizeScore = Math.min(100, (sizeGb / 50) * 100);
	}

	const total =
		daysSinceScore * w.daysSinceLastWatch +
		watchCountScore * w.inverseWatchCount +
		onDeckScore * w.notOnDeck +
		userRatingScore * w.lowUserRating +
		tmdbRatingScore * w.lowTmdbRating +
		sizeScore * w.sizeOnDisk;

	// Normalize by sum of weights to handle incomplete weights
	const weightSum =
		w.daysSinceLastWatch +
		w.inverseWatchCount +
		w.notOnDeck +
		w.lowUserRating +
		w.lowTmdbRating +
		w.sizeOnDisk;
	const score = weightSum > 0 ? total / weightSum : 0;

	if (params.operator === "greater_than" && score > params.threshold) {
		return `Staleness score ${score.toFixed(1)} > ${params.threshold} (watch: ${daysSinceScore.toFixed(0)}, plays: ${watchCountScore.toFixed(0)}, tmdb: ${tmdbRatingScore.toFixed(0)})`;
	}

	return null;
}

/**
 * Recently active protection: returns a match if the item was recently added
 * AND (optionally) has activity. Designed for retention mode — returns match
 * for items that SHOULD be protected, not items to delete.
 */
function evaluateRecentlyActive(
	item: CacheItemForEval,
	params: RecentlyActiveParams,
	ctx: EvalContext,
): string | null {
	if (!item.arrAddedAt) return null;

	const ageDays = (ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24);
	if (ageDays > params.protectionDays) return null; // Outside protection window

	if (params.requireActivity) {
		// Check for activity signals from Plex
		const parsed = safeJsonParse(item.data);
		if (!parsed) return null;
		const data = parsed as Record<string, unknown>;
		const tmdbId = (data.remoteIds as Record<string, unknown> | undefined)?.tmdbId;
		const key = typeof tmdbId === "number" ? `${item.itemType}:${tmdbId}` : null;
		const plex = key ? ctx.plexMap?.get(key) : undefined;

		const hasActivity = plex?.onDeck || (plex?.watchCount ?? 0) > 0;
		if (!hasActivity) return null;

		return `Recently added (${Math.floor(ageDays)} days) with activity (protection window: ${params.protectionDays} days)`;
	}

	return `Recently added (${Math.floor(ageDays)} days, protection window: ${params.protectionDays} days)`;
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
		const regex = getCachedRegex(pattern);
		if (regex?.test(title)) return false; // excluded
	}
	return true;
}

// ============================================================================
// Single Condition Evaluator (extracted for composite rule support)
// ============================================================================

/**
 * Evaluate a single condition (ruleType + params) against an item.
 * This is the inner dispatch extracted from the old evaluateRule() switch.
 * Returns a reason string if matched, null otherwise.
 */
export function evaluateSingleCondition(
	item: CacheItemForEval,
	ruleType: string,
	params: Record<string, unknown>,
	ctx: EvalContext,
	plexLibFilter?: string[] | null,
): string | null {
	switch (ruleType) {
		// ── Basic rules ─────────────────────────────────────────────
		case "age":
			return evaluateAgeRule(item, params as AgeRuleParams, ctx.now);
		case "size":
			return evaluateSizeRule(item, params as SizeRuleParams);
		case "rating":
			return evaluateRatingRule(item, params as RatingRuleParams);
		case "status":
			return evaluateStatusRule(item, params as StatusRuleParams);
		case "unmonitored":
			return evaluateUnmonitoredRule(item);
		case "genre":
			return evaluateGenreRule(item, params as GenreRuleParams);
		case "year_range":
			return evaluateYearRangeRule(item, params as YearRangeRuleParams);
		case "no_file":
			return evaluateNoFileRule(item);
		case "quality_profile":
			return evaluateQualityProfileRule(item, params as QualityProfileRuleParams);
		case "language":
			return evaluateLanguageRule(item, params as LanguageRuleParams);

		// ── File metadata rules ─────────────────────────────────────
		case "video_codec":
			return evaluateVideoCodecRule(item, params as VideoCodecRuleParams);
		case "audio_codec":
			return evaluateAudioCodecRule(item, params as AudioCodecRuleParams);
		case "resolution":
			return evaluateResolutionRule(item, params as ResolutionRuleParams);
		case "hdr_type":
			return evaluateHdrTypeRule(item, params as HdrTypeRuleParams);
		case "custom_format_score":
			return evaluateCustomFormatScoreRule(item, params as CustomFormatScoreRuleParams);
		case "runtime":
			return evaluateRuntimeRule(item, params as RuntimeRuleParams);
		case "release_group":
			return evaluateReleaseGroupRule(item, params as ReleaseGroupRuleParams);

		// ── Seerr rules ─────────────────────────────────────────────
		case "seerr_requested_by":
			return evaluateSeerrRequestedBy(item, params as SeerrRequestedByParams, ctx.seerrMap);
		case "seerr_request_age":
			return evaluateSeerrRequestAge(item, params as SeerrRequestAgeParams, ctx.seerrMap, ctx.now);
		case "seerr_request_status":
			return evaluateSeerrRequestStatus(item, params as SeerrRequestStatusParams, ctx.seerrMap);
		case "seerr_is_4k":
			return evaluateSeerrIs4k(item, params as SeerrIs4kParams, ctx.seerrMap);
		case "seerr_request_modified_age":
			return evaluateSeerrRequestModifiedAge(
				item,
				params as SeerrRequestModifiedAgeParams,
				ctx.seerrMap,
				ctx.now,
			);
		case "seerr_modified_by":
			return evaluateSeerrModifiedBy(item, params as SeerrModifiedByParams, ctx.seerrMap);
		case "seerr_is_requested":
			return evaluateSeerrIsRequested(item, params as SeerrIsRequestedParams, ctx.seerrMap);
		case "seerr_request_count":
			return evaluateSeerrRequestCount(item, params as SeerrRequestCountParams, ctx.seerrMap);

		// ── Tautulli rules ──────────────────────────────────────────
		case "tautulli_last_watched":
			return evaluateTautulliLastWatched(item, params as TautulliLastWatchedParams, ctx);
		case "tautulli_watch_count":
			return evaluateTautulliWatchCount(item, params as TautulliWatchCountParams, ctx);
		case "tautulli_watched_by":
			return evaluateTautulliWatchedBy(item, params as TautulliWatchedByParams, ctx);

		// ── Plex rules ─────────────────────────────────────────────
		case "plex_last_watched":
			return evaluatePlexLastWatched(item, params as PlexLastWatchedParams, ctx, plexLibFilter);
		case "plex_watch_count":
			return evaluatePlexWatchCount(item, params as PlexWatchCountParams, ctx, plexLibFilter);
		case "plex_on_deck":
			return evaluatePlexOnDeck(item, params as PlexOnDeckParams, ctx, plexLibFilter);
		case "plex_user_rating":
			return evaluatePlexUserRating(item, params as PlexUserRatingParams, ctx, plexLibFilter);
		case "plex_watched_by":
			return evaluatePlexWatchedBy(item, params as PlexWatchedByParams, ctx, plexLibFilter);
		case "plex_collection":
			return evaluatePlexCollection(item, params as PlexCollectionRuleParams, ctx, plexLibFilter);
		case "plex_label":
			return evaluatePlexLabel(item, params as PlexLabelRuleParams, ctx, plexLibFilter);
		case "plex_added_at":
			return evaluatePlexAddedAt(item, params as PlexAddedAtParams, ctx, plexLibFilter);

		// ── Phase C: New rule types ─────────────────────────────────
		case "imdb_rating":
			return evaluateImdbRatingRule(item, params as ImdbRatingRuleParams);
		case "file_path":
			return evaluateFilePathRule(item, params as FilePathRuleParams);
		case "audio_channels":
			return evaluateAudioChannelsRule(item, params as AudioChannelsRuleParams);
		case "tag_match":
			return evaluateTagMatchRule(item, params as TagMatchRuleParams);

		// ── Phase 2: Behavior-aware rules ────────────────────────────
		case "plex_episode_completion":
			return evaluatePlexEpisodeCompletion(item, params as PlexEpisodeCompletionParams, ctx);
		case "user_retention":
			return evaluateUserRetention(item, params as UserRetentionParams, ctx);
		case "staleness_score":
			return evaluateStalenessScore(item, params as StalenessScoreParams, ctx);
		case "recently_active":
			return evaluateRecentlyActive(item, params as RecentlyActiveParams, ctx);

		default:
			return null;
	}
}

// ============================================================================
// Main Evaluator (supports both legacy single-condition and composite rules)
// ============================================================================

/**
 * Evaluate a single cache item against a single cleanup rule.
 * Returns a RuleMatch if the rule triggers, null otherwise.
 *
 * This function handles:
 * 1. Rule enable check
 * 2. Service/instance/tag/title filters
 * 3. Composite AND/OR logic (when operator is set)
 * 4. Legacy single-condition dispatch (when operator is null)
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

	// Parse Plex library filter once for all Plex evaluators
	const plexLibFilter = safeJsonParse(rule.plexLibraryFilter) as string[] | null;
	const action = (rule.action ?? "delete") as RuleAction;

	// ── Composite rule path ────────────────────────────────────────
	if (rule.operator && rule.conditions) {
		const conditions = safeJsonParse(rule.conditions) as Condition[] | null;
		if (!conditions?.length) return null;

		if (rule.operator === "AND") {
			const reasons: string[] = [];
			for (const c of conditions) {
				const reason = evaluateSingleCondition(
					item,
					c.ruleType,
					c.parameters as Record<string, unknown>,
					ctx,
					plexLibFilter,
				);
				if (!reason) return null; // ALL must match
				reasons.push(reason);
			}
			return { ruleId: rule.id, ruleName: rule.name, reason: reasons.join(" AND "), action };
		}

		if (rule.operator === "OR") {
			for (const c of conditions) {
				const reason = evaluateSingleCondition(
					item,
					c.ruleType,
					c.parameters as Record<string, unknown>,
					ctx,
					plexLibFilter,
				);
				if (reason) {
					return { ruleId: rule.id, ruleName: rule.name, reason, action };
				}
			}
			return null; // AT LEAST ONE must match
		}
	}

	// ── Legacy single-condition path ───────────────────────────────
	const params = parseParams(rule);
	if (!params) return null;

	const reason = evaluateSingleCondition(item, rule.ruleType, params, ctx, plexLibFilter);
	return reason ? { ruleId: rule.id, ruleName: rule.name, reason, action } : null;
}

/**
 * Evaluate a cache item against all rules (sorted by priority).
 *
 * Two-phase evaluation:
 * 1. Retention rules checked first — if ANY match, item is protected (returns null).
 * 2. Cleanup rules checked in priority order — first match wins.
 *
 * When `failedSources` is provided, rules depending on unavailable data sources
 * are skipped to prevent false matches (the C1 safety fix).
 */
export function evaluateItemAgainstRules(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
	failedSources?: Set<DataSourceDependency>,
): RuleMatch | null {
	// Phase 1: Check retention rules first — any match = protected
	for (const rule of rules) {
		if (!rule.retentionMode) continue;
		if (shouldSkipForFailedSource(rule, failedSources)) continue;
		const match = evaluateRule(item, rule, instanceService, ctx);
		if (match) return null; // Item is protected by retention rule
	}

	// Phase 2: Check cleanup rules — first match wins
	for (const rule of rules) {
		if (rule.retentionMode) continue;
		if (shouldSkipForFailedSource(rule, failedSources)) continue;
		const match = evaluateRule(item, rule, instanceService, ctx);
		if (match) return match;
	}
	return null;
}

/**
 * Explain how each rule would evaluate against a specific item.
 * Returns per-rule breakdown for the explain endpoint.
 */
export function explainItemAgainstRules(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
): Array<{
	ruleId: string;
	ruleName: string;
	matched: boolean;
	reason: string | null;
	filteredBy:
		| "service_filter"
		| "instance_filter"
		| "tag_exclusion"
		| "title_exclusion"
		| "disabled"
		| null;
	retentionMode: boolean;
}> {
	const results: Array<{
		ruleId: string;
		ruleName: string;
		matched: boolean;
		reason: string | null;
		filteredBy:
			| "service_filter"
			| "instance_filter"
			| "tag_exclusion"
			| "title_exclusion"
			| "disabled"
			| null;
		retentionMode: boolean;
	}> = [];

	for (const rule of rules) {
		if (!rule.enabled) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy: "disabled",
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		// Check pre-filters and report which one blocked
		const filteredBy = getFilterReason(item, rule, instanceService);
		if (filteredBy) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy,
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		// Evaluate the rule
		const match = evaluateRule(item, rule, instanceService, ctx);
		results.push({
			ruleId: rule.id,
			ruleName: rule.name,
			matched: match !== null,
			reason: match?.reason ?? null,
			filteredBy: null,
			retentionMode: rule.retentionMode,
		});
	}

	return results;
}

/**
 * Check if a rule should be skipped because its data source failed.
 * Examines both the top-level ruleType and composite sub-conditions.
 */
function shouldSkipForFailedSource(
	rule: LibraryCleanupRule,
	failedSources?: Set<DataSourceDependency>,
): boolean {
	if (!failedSources || failedSources.size === 0) return false;

	// Check top-level rule type
	if (shouldSkipRuleType(rule.ruleType, rule.parameters, failedSources)) return true;

	// Check composite sub-conditions
	if (rule.conditions) {
		const conds = safeJsonParse(rule.conditions) as Array<{
			ruleType?: string;
			parameters?: Record<string, unknown>;
		}> | null;
		if (Array.isArray(conds)) {
			for (const c of conds) {
				if (
					c.ruleType &&
					shouldSkipRuleType(
						c.ruleType,
						c.parameters ? JSON.stringify(c.parameters) : null,
						failedSources,
					)
				)
					return true;
			}
		}
	}
	return false;
}

/**
 * Check if a single rule type should be skipped based on failed data sources.
 * Handles dynamic dependencies like `user_retention` whose source depends on params.
 */
function shouldSkipRuleType(
	ruleType: string,
	parametersJson: string | null,
	failedSources: Set<DataSourceDependency>,
): boolean {
	// Special case: user_retention depends on params.source
	if (ruleType === "user_retention") {
		const params = parametersJson
			? (safeJsonParse(parametersJson) as Record<string, unknown> | null)
			: null;
		const source = (params?.source as string) ?? "plex";
		if (source === "plex") return failedSources.has("plex");
		if (source === "tautulli") return failedSources.has("tautulli");
		if (source === "either") return failedSources.has("plex") && failedSources.has("tautulli");
		return false;
	}

	const dep = ruleDataSourceMap[ruleType];
	return dep != null && failedSources.has(dep);
}

/**
 * Determine which pre-filter (if any) would block this rule from evaluating the item.
 */
function getFilterReason(
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
	instanceService: string,
): "service_filter" | "instance_filter" | "tag_exclusion" | "title_exclusion" | null {
	if (!passesServiceFilter(instanceService, rule.serviceFilter)) return "service_filter";
	if (!passesInstanceFilter(item.instanceId, rule.instanceFilter)) return "instance_filter";
	if (!passesTagExclusion(item, rule.excludeTags)) return "tag_exclusion";
	if (!passesTitleExclusion(item.title, rule.excludeTitles)) return "title_exclusion";
	return null;
}
