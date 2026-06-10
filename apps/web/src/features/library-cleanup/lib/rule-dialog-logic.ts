import type { CleanupRuleType } from "@arr/shared";

// ============================================================================
// splitCsv — parse comma-separated user input into trimmed, non-empty strings
// ============================================================================

export function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// ============================================================================
// BuildParamsState — flat snapshot of all dialog state vars that buildParams reads
// ============================================================================

export interface BuildParamsState {
	ruleType: CleanupRuleType;
	// age
	ageOp: string;
	days: number;
	// size
	sizeOp: string;
	sizeGb: number;
	// rating
	scoreOp: string;
	score: number;
	// status
	statuses: string;
	// genre
	genreOp: string;
	genres: string;
	// year_range
	yearOp: string;
	year: number;
	yearFrom: number;
	yearTo: number;
	// quality_profile
	profileNames: string;
	// language
	langOp: string;
	languages: string;
	// seerr_requested_by
	seerrUserNames: string;
	// seerr_request_age
	seerrReqAgeOp: string;
	seerrReqAgeDays: number;
	// seerr_request_status
	seerrReqStatuses: string;
	// video_codec
	videoCodecOp: string;
	selectedVideoCodecs: string[];
	// audio_codec
	audioCodecOp: string;
	selectedAudioCodecs: string[];
	// resolution
	resolutionOp: string;
	selectedResolutions: string[];
	// hdr_type
	hdrOp: string;
	selectedHdrTypes: string[];
	// custom_format_score
	cfScoreOp: string;
	cfScore: number;
	// runtime
	runtimeOp: string;
	runtimeMinutes: number;
	// release_group
	releaseGroupOp: string;
	selectedReleaseGroups: string[];
	// seerr_is_4k
	seerrIs4k: boolean;
	// seerr_request_modified_age
	seerrModifiedAgeOp: string;
	seerrModifiedAgeDays: number;
	// seerr_modified_by
	seerrModifiedByUsers: string;
	// plex_last_watched
	plexLastWatchedOp: string;
	plexLastWatchedDays: number;
	// plex_watch_count
	plexWatchCountOp: string;
	plexWatchCountVal: number;
	// plex_on_deck
	plexOnDeckVal: boolean;
	// plex_user_rating
	plexUserRatingOp: string;
	plexUserRatingVal: number;
	// plex_watched_by
	plexWatchedByOp: string;
	selectedPlexUsers: string[];
	// imdb_rating
	imdbRatingOp: string;
	imdbRatingScore: number;
	// file_path
	filePathOp: string;
	filePathPattern: string;
	filePathField: string;
	// seerr_is_requested
	seerrIsRequested: boolean;
	// seerr_request_count
	seerrRequestCountOp: string;
	seerrRequestCountVal: number;
	// audio_channels
	audioChannelsOp: string;
	audioChannelsVal: number;
	// tag_match
	tagMatchOp: string;
	// list membership (C3)
	tmdbListId: string;
	tmdbListOp: string;
	traktListSlug: string;
	traktListOp: string;
	selectedTagIds: number[];
	// plex_collection
	plexCollectionOp: string;
	selectedPlexCollections: string[];
	// plex_label
	plexLabelOp: string;
	selectedPlexLabels: string[];
	// plex_added_at
	plexAddedAtOp: string;
	plexAddedAtDays: number;
	// jellyfin_last_watched
	jellyfinLastWatchedOp: string;
	jellyfinLastWatchedDays: number;
	// jellyfin_watch_count
	jellyfinWatchCountOp: string;
	jellyfinWatchCountVal: number;
	// jellyfin_on_deck
	jellyfinOnDeckVal: boolean;
	// jellyfin_user_rating
	jellyfinUserRatingOp: string;
	jellyfinUserRatingVal: number;
	// jellyfin_watched_by
	jellyfinWatchedByOp: string;
	selectedJellyfinUsers: string[];
	// jellyfin_added_at
	jellyfinAddedAtOp: string;
	jellyfinAddedAtDays: number;
	// behavior analysis (plex_episode_completion, user_retention, staleness_score, recently_active)
	behaviorParams: Record<string, unknown>;
}

// ============================================================================
// buildParams — serialize dialog state into the parameters object for a rule
// ============================================================================

export function buildParams(state: BuildParamsState): Record<string, unknown> {
	switch (state.ruleType) {
		case "age":
			return { field: "arrAddedAt", operator: state.ageOp, days: state.days };
		case "size":
			return { operator: state.sizeOp, sizeGb: state.sizeGb };
		case "rating":
			return state.scoreOp === "unrated"
				? { source: "tmdb", operator: "unrated" }
				: { source: "tmdb", operator: state.scoreOp, score: state.score };
		case "status":
			return { statuses: splitCsv(state.statuses) };
		case "unmonitored":
		case "no_file":
			return {};
		case "genre":
			return { operator: state.genreOp, genres: splitCsv(state.genres) };
		case "year_range": {
			if (state.yearOp === "between")
				return { operator: state.yearOp, yearFrom: state.yearFrom, yearTo: state.yearTo };
			return { operator: state.yearOp, year: state.year };
		}
		case "quality_profile":
			return { profileNames: splitCsv(state.profileNames) };
		case "language":
			return { operator: state.langOp, languages: splitCsv(state.languages) };
		case "seerr_requested_by":
			return { userNames: splitCsv(state.seerrUserNames) };
		case "seerr_request_age":
			return { operator: state.seerrReqAgeOp, days: state.seerrReqAgeDays };
		case "seerr_request_status":
			return { statuses: splitCsv(state.seerrReqStatuses) };
		case "video_codec":
			return { operator: state.videoCodecOp, codecs: state.selectedVideoCodecs };
		case "audio_codec":
			return { operator: state.audioCodecOp, codecs: state.selectedAudioCodecs };
		case "resolution":
			return { operator: state.resolutionOp, resolutions: state.selectedResolutions };
		case "hdr_type":
			return state.hdrOp === "none"
				? { operator: "none" }
				: { operator: state.hdrOp, types: state.selectedHdrTypes };
		case "custom_format_score":
			return { operator: state.cfScoreOp, score: state.cfScore };
		case "runtime":
			return { operator: state.runtimeOp, minutes: state.runtimeMinutes };
		case "release_group":
			return { operator: state.releaseGroupOp, groups: state.selectedReleaseGroups };
		case "seerr_is_4k":
			return { is4k: state.seerrIs4k };
		case "seerr_request_modified_age":
			return { operator: state.seerrModifiedAgeOp, days: state.seerrModifiedAgeDays };
		case "seerr_modified_by":
			return { userNames: splitCsv(state.seerrModifiedByUsers) };
		case "plex_last_watched":
			return state.plexLastWatchedOp === "never"
				? { operator: "never" }
				: { operator: state.plexLastWatchedOp, days: state.plexLastWatchedDays };
		case "plex_watch_count":
			return { operator: state.plexWatchCountOp, count: state.plexWatchCountVal };
		case "plex_on_deck":
			return { isDeck: state.plexOnDeckVal };
		case "plex_user_rating":
			return state.plexUserRatingOp === "unrated"
				? { operator: "unrated" }
				: { operator: state.plexUserRatingOp, rating: state.plexUserRatingVal };
		case "plex_watched_by":
			return { operator: state.plexWatchedByOp, userNames: state.selectedPlexUsers };
		case "imdb_rating":
			return state.imdbRatingOp === "unrated"
				? { operator: "unrated" }
				: { operator: state.imdbRatingOp, score: state.imdbRatingScore };
		case "file_path":
			return {
				operator: state.filePathOp,
				pattern: state.filePathPattern,
				field: state.filePathField,
			};
		case "seerr_is_requested":
			return { isRequested: state.seerrIsRequested };
		case "seerr_request_count":
			return { operator: state.seerrRequestCountOp, count: state.seerrRequestCountVal };
		case "audio_channels":
			return { operator: state.audioChannelsOp, channels: state.audioChannelsVal };
		case "tag_match":
			return { operator: state.tagMatchOp, tagIds: state.selectedTagIds };
		case "tmdb_list_member":
			return { listId: state.tmdbListId.trim(), operator: state.tmdbListOp };
		case "trakt_list_member":
			return { listSlug: state.traktListSlug.trim(), operator: state.traktListOp };
		case "plex_collection":
			return { operator: state.plexCollectionOp, collections: state.selectedPlexCollections };
		case "plex_label":
			return { operator: state.plexLabelOp, labels: state.selectedPlexLabels };
		case "plex_added_at":
			return { operator: state.plexAddedAtOp, days: state.plexAddedAtDays };
		case "jellyfin_last_watched":
			return state.jellyfinLastWatchedOp === "never"
				? { operator: "never" }
				: { operator: state.jellyfinLastWatchedOp, days: state.jellyfinLastWatchedDays };
		case "jellyfin_watch_count":
			return { operator: state.jellyfinWatchCountOp, count: state.jellyfinWatchCountVal };
		case "jellyfin_on_deck":
			return { isDeck: state.jellyfinOnDeckVal };
		case "jellyfin_user_rating":
			return state.jellyfinUserRatingOp === "unrated"
				? { operator: "unrated" }
				: { operator: state.jellyfinUserRatingOp, rating: state.jellyfinUserRatingVal };
		case "jellyfin_watched_by":
			return { operator: state.jellyfinWatchedByOp, userNames: state.selectedJellyfinUsers };
		case "jellyfin_added_at":
			return { operator: state.jellyfinAddedAtOp, days: state.jellyfinAddedAtDays };
		case "plex_episode_completion":
		case "jellyfin_episode_completion":
		case "user_retention":
		case "staleness_score":
		case "recently_active":
			return state.behaviorParams;
		default:
			return {};
	}
}
