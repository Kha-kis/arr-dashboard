import type { RulePredicate } from "@arr/shared";
import { lookupPlexWatch } from "../library-cleanup/evaluators/plex-evaluators.js";
import { evaluateSingleCondition, parseAudioChannels } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../library-cleanup/types.js";
import { safeJsonParse } from "../utils/json.js";

export type CleanupPredicateResult =
	| { state: "match"; reason: string }
	| { state: "no_match" }
	| { state: "unknown" };

type ExternalSource = "seerr" | "plex" | "jellyfin";

const DEFAULT_STALENESS_WEIGHTS = {
	daysSinceLastWatch: 0.3,
	inverseWatchCount: 0.2,
	notOnDeck: 0.1,
	lowUserRating: 0.15,
	lowTmdbRating: 0.15,
	sizeOnDisk: 0.1,
} as const;

type StalenessEvidence = {
	plex: boolean;
	rating: boolean;
	sizeOnDisk: boolean;
};

function stalenessWeight(params: Record<string, unknown>, key: string): number | null {
	const weights = params.weights;
	const configured =
		typeof weights === "object" && weights !== null && !Array.isArray(weights)
			? (weights as Record<string, unknown>)[key]
			: DEFAULT_STALENESS_WEIGHTS[key as keyof typeof DEFAULT_STALENESS_WEIGHTS];
	return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
		? configured
		: null;
}

/** Keep preview and mutation authorization aligned on weighted score inputs. */
export function hasRequiredStalenessInputEvidence(
	params: Record<string, unknown>,
	evidence: StalenessEvidence,
): boolean {
	const weights = Object.fromEntries(
		Object.keys(DEFAULT_STALENESS_WEIGHTS).map((key) => [key, stalenessWeight(params, key)]),
	) as Record<keyof typeof DEFAULT_STALENESS_WEIGHTS, number | null>;
	if (Object.values(weights).some((weight) => weight === null)) return false;

	const needsPlex =
		weights.daysSinceLastWatch! > 0 ||
		weights.inverseWatchCount! > 0 ||
		weights.notOnDeck! > 0 ||
		weights.lowUserRating! > 0;
	return (
		(!needsPlex || evidence.plex) &&
		(weights.lowTmdbRating === 0 || evidence.rating) &&
		(weights.sizeOnDisk === 0 || evidence.sizeOnDisk)
	);
}

function dataRecord(item: CacheItemForEval): Record<string, unknown> | null {
	const parsed = safeJsonParse(item.data);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

function evidenceFlag(data: Record<string, unknown> | null, flag: string): boolean {
	const evidence = data?._arrDashboardEvidence;
	return (
		typeof evidence === "object" &&
		evidence !== null &&
		!Array.isArray(evidence) &&
		(evidence as Record<string, unknown>)[flag] === true
	);
}

function tmdbId(item: CacheItemForEval): number | null {
	const data = dataRecord(item);
	if (!data) return null;
	const remoteIds = data.remoteIds;
	if (typeof remoteIds === "object" && remoteIds !== null && !Array.isArray(remoteIds)) {
		const remoteTmdbId = (remoteIds as Record<string, unknown>).tmdbId;
		if (
			typeof remoteTmdbId === "number" &&
			Number.isSafeInteger(remoteTmdbId) &&
			remoteTmdbId > 0
		) {
			return remoteTmdbId;
		}
	}
	return typeof data.tmdbId === "number" && Number.isSafeInteger(data.tmdbId) && data.tmdbId > 0
		? data.tmdbId
		: null;
}

function mediaKey(item: CacheItemForEval): string | null {
	const id = tmdbId(item);
	return id === null ? null : `${item.itemType}:${id}`;
}

function sourceAvailable(ctx: EvalContext, source: ExternalSource): boolean {
	if (ctx.availableDataSources?.has(source)) return true;
	if (source === "seerr") return ctx.seerrMap !== undefined && ctx.seerrMap.size > 0;
	if (source === "plex") return ctx.plexMap !== undefined && ctx.plexMap.size > 0;
	return ctx.jellyfinMap !== undefined && ctx.jellyfinMap.size > 0;
}

function fileRecord(data: Record<string, unknown>): Record<string, unknown> | null {
	const candidate =
		typeof data.movieFile === "object" && data.movieFile !== null
			? data.movieFile
			: typeof data.episodeFile === "object" && data.episodeFile !== null
				? data.episodeFile
				: null;
	return candidate && !Array.isArray(candidate) ? (candidate as Record<string, unknown>) : null;
}

function isCompleteRatingValue(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10;
}

function hasRatingEvidence(
	data: Record<string, unknown> | null,
	kind: "rating" | "imdb_rating",
	instanceService: string,
): boolean {
	if (!data || typeof data.ratings !== "object" || data.ratings === null) return false;
	const ratings = data.ratings as Record<string, unknown>;
	if (kind === "imdb_rating") {
		const imdb = ratings.imdb;
		return (
			instanceService.toUpperCase() === "RADARR" &&
			typeof imdb === "object" &&
			imdb !== null &&
			isCompleteRatingValue((imdb as Record<string, unknown>).value)
		);
	}
	if (instanceService.toUpperCase() === "SONARR") return isCompleteRatingValue(ratings.value);
	if (instanceService.toUpperCase() !== "RADARR") return false;
	const tmdb = ratings.tmdb;
	return (
		typeof tmdb === "object" &&
		tmdb !== null &&
		isCompleteRatingValue((tmdb as Record<string, unknown>).value)
	);
}

function hasLanguageEvidence(data: Record<string, unknown> | null): boolean {
	if (!data) return false;
	if (typeof data.originalLanguage === "string" && data.originalLanguage.trim().length > 0) {
		return true;
	}
	if (typeof data.originalLanguage === "object" && data.originalLanguage !== null) {
		const name = (data.originalLanguage as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim().length > 0) return true;
	}
	return (
		Array.isArray(data.languages) &&
		data.languages.length > 0 &&
		data.languages.every(
			(language) =>
				(typeof language === "string" && language.trim().length > 0) ||
				(typeof language === "object" &&
					language !== null &&
					typeof (language as Record<string, unknown>).name === "string" &&
					((language as Record<string, unknown>).name as string).trim().length > 0),
		)
	);
}

function hasPlexEvidence(
	item: CacheItemForEval,
	ctx: EvalContext,
	plexLibraryFilter?: string[] | null,
): boolean {
	if (!sourceAvailable(ctx, "plex") || tmdbId(item) === null) return false;
	if (!plexLibraryFilter?.length) {
		const key = mediaKey(item);
		return key !== null && ctx.plexMap?.has(key) === true;
	}
	if (
		!ctx.plexSectionTitles ||
		plexLibraryFilter.some((sectionTitle) => !ctx.plexSectionTitles!.has(sectionTitle))
	) {
		return false;
	}
	return lookupPlexWatch(item, ctx.plexMap, plexLibraryFilter, ctx.plexSectionTitles) !== null;
}

function hasJellyfinEvidence(item: CacheItemForEval, ctx: EvalContext): boolean {
	const key = mediaKey(item);
	return sourceAvailable(ctx, "jellyfin") && key !== null && ctx.jellyfinMap?.has(key) === true;
}

function hasListEvidence(
	item: CacheItemForEval,
	params: Record<string, unknown>,
	memberships: Map<string, Set<number>> | undefined,
	identifierKey: "listId" | "listSlug",
): boolean {
	const identifier = params[identifierKey];
	return (
		tmdbId(item) !== null &&
		typeof identifier === "string" &&
		identifier.trim().length > 0 &&
		memberships?.has(identifier) === true
	);
}

function hasPredicateEvidence(
	item: CacheItemForEval,
	predicate: RulePredicate,
	ctx: EvalContext,
	instanceService: string,
	plexLibraryFilter?: string[] | null,
): boolean {
	const { kind, params } = predicate;
	const data = dataRecord(item);

	switch (kind) {
		case "age":
			return item.arrAddedAt instanceof Date && !Number.isNaN(item.arrAddedAt.getTime());
		case "size":
		case "unmonitored":
		case "no_file":
			return true;
		case "status":
			return typeof item.status === "string" && item.status.trim().length > 0;
		case "year_range":
			return typeof item.year === "number" && Number.isFinite(item.year);
		case "quality_profile":
			return (
				typeof item.qualityProfileName === "string" && item.qualityProfileName.trim().length > 0
			);
		case "rating":
		case "imdb_rating":
			return hasRatingEvidence(data, kind, instanceService);
		case "genre":
			return Array.isArray(data?.genres) && data.genres.every((genre) => typeof genre === "string");
		case "language":
			return hasLanguageEvidence(data);
		case "runtime":
			return typeof data?.runtime === "number" && Number.isFinite(data.runtime);
		case "file_path": {
			if (!data) return false;
			if (params.field === "rootFolderPath") {
				return typeof data.rootFolderPath === "string" && data.rootFolderPath.trim().length > 0;
			}
			return typeof data.path === "string" && data.path.trim().length > 0;
		}
		case "tag_match":
			return (
				(Array.isArray(data?.tags) &&
					data.tags.every(
						(tag) =>
							(typeof tag === "number" && Number.isSafeInteger(tag) && tag >= 0) ||
							(typeof tag === "string" && tag.trim().length > 0),
					)) ||
				(data?.tags === undefined && evidenceFlag(data, "tags"))
			);
		case "video_codec":
		case "audio_codec":
		case "resolution":
		case "custom_format_score":
		case "release_group": {
			if (!data) return false;
			const file = fileRecord(data);
			const field = {
				video_codec: "videoCodec",
				audio_codec: "audioCodec",
				resolution: "resolution",
				custom_format_score: "customFormatScore",
				release_group: "releaseGroup",
			}[kind];
			if (!file) return false;
			const value = file[field];
			return kind === "custom_format_score"
				? typeof value === "number" && Number.isFinite(value)
				: typeof value === "string" && value.trim().length > 0;
		}
		case "audio_channels": {
			if (!data) return false;
			const codec = fileRecord(data)?.audioCodec;
			return typeof codec === "string" && parseAudioChannels(codec) !== null;
		}
		case "hdr_type": {
			if (!data) return false;
			const file = fileRecord(data);
			return (
				file !== null &&
				((Object.hasOwn(file, "videoDynamicRange") &&
					(typeof file.videoDynamicRange === "string" || file.videoDynamicRange === null)) ||
					evidenceFlag(data, "hdrType"))
			);
		}
		case "seerr_requested_by":
		case "seerr_request_age":
		case "seerr_request_status":
		case "seerr_is_4k":
		case "seerr_request_modified_age":
		case "seerr_modified_by":
		case "seerr_is_requested":
		case "seerr_request_count":
			return sourceAvailable(ctx, "seerr") && tmdbId(item) !== null;
		case "plex_last_watched":
		case "plex_watch_count":
		case "plex_on_deck":
		case "plex_user_rating":
		case "plex_watched_by":
		case "plex_collection":
		case "plex_label":
		case "plex_added_at":
			return hasPlexEvidence(item, ctx, plexLibraryFilter);
		case "jellyfin_last_watched":
		case "jellyfin_watch_count":
		case "jellyfin_on_deck":
		case "jellyfin_user_rating":
		case "jellyfin_watched_by":
		case "jellyfin_added_at":
			return hasJellyfinEvidence(item, ctx);
		case "plex_episode_completion": {
			const id = tmdbId(item);
			return (
				item.itemType === "series" &&
				sourceAvailable(ctx, "plex") &&
				id !== null &&
				(ctx.plexEpisodeMap?.get(id)?.total ?? 0) > 0
			);
		}
		case "jellyfin_episode_completion": {
			const id = tmdbId(item);
			return (
				item.itemType === "series" &&
				sourceAvailable(ctx, "jellyfin") &&
				id !== null &&
				(ctx.jellyfinEpisodeMap?.get(id)?.total ?? 0) > 0
			);
		}
		case "user_retention":
			return (
				(params.source === undefined || params.source === "plex" || params.source === "either") &&
				hasPlexEvidence(item, ctx, plexLibraryFilter)
			);
		case "staleness_score":
			return (
				data !== null &&
				hasRequiredStalenessInputEvidence(params, {
					plex: hasPlexEvidence(item, ctx, plexLibraryFilter),
					rating: hasRatingEvidence(data, "rating", instanceService),
					sizeOnDisk: evidenceFlag(data, "sizeOnDisk"),
				})
			);
		case "recently_active": {
			if (!(item.arrAddedAt instanceof Date) || Number.isNaN(item.arrAddedAt.getTime()))
				return false;
			const protectionDays = params.protectionDays;
			if (typeof protectionDays !== "number") return false;
			const ageDays = (ctx.now.getTime() - item.arrAddedAt.getTime()) / (1000 * 60 * 60 * 24);
			return ageDays > protectionDays || params.requireActivity !== true
				? true
				: hasPlexEvidence(item, ctx, plexLibraryFilter);
		}
		case "seerr_requester_watched":
		case "seerr_requester_not_watched":
			return (
				sourceAvailable(ctx, "seerr") &&
				tmdbId(item) !== null &&
				hasPlexEvidence(item, ctx, plexLibraryFilter)
			);
		case "tmdb_list_member":
			return hasListEvidence(item, params, ctx.tmdbListMemberships, "listId");
		case "trakt_list_member":
			return hasListEvidence(item, params, ctx.traktListMemberships, "listSlug");
		default:
			return false;
	}
}

/**
 * Evaluate one cleanup leaf without collapsing missing evidence into a proven
 * false result. Canonical recursive rules use this tri-state contract so NOT
 * can never turn an unavailable field or provider snapshot into authority.
 */
export function evaluateCleanupPredicate(
	item: CacheItemForEval,
	predicate: RulePredicate,
	ctx: EvalContext,
	instanceService: string,
	plexLibraryFilter?: string[] | null,
): CleanupPredicateResult {
	if (!hasPredicateEvidence(item, predicate, ctx, instanceService, plexLibraryFilter)) {
		return { state: "unknown" };
	}
	try {
		const reason = evaluateSingleCondition(
			item,
			predicate.kind,
			predicate.params,
			ctx,
			plexLibraryFilter,
		);
		return reason === null ? { state: "no_match" } : { state: "match", reason };
	} catch {
		return { state: "unknown" };
	}
}
