/**
 * Plex Shared Types
 *
 * Types for Plex integration — watch enrichment, sessions, sections, episodes, collections.
 */

import type {
	ProviderCoverageReceiptV1,
	ProviderObservationProgress,
	ProviderObservationStatus,
	ProviderObservationStatusEnvelope,
	ProviderUiCondition,
} from "./provider-observation";
import type {
	SessionAvailability,
	SessionBandwidthBasis,
	SessionBandwidthCoverage,
} from "./session";

// ============================================================================
// Published cache evidence
// ============================================================================

export type PlexPublicationLevel = "authoritative" | "positive-only";

export type PlexAttemptState = "success" | "in_progress" | "error" | "partial" | "unknown";

export type PlexEvidenceAvailability = "current" | "last-known" | "unavailable";

export type PlexCoverageReasonCode =
	| "disabled_instance"
	| "missing_status"
	| "unpublished_generation"
	| "missing_generation_id"
	| "missing_metadata"
	| "malformed_metadata"
	| "unknown_metadata_version"
	| "invalid_publication_level"
	| "invalid_completeness"
	| "invalid_item_count"
	| "invalid_sections"
	| "duplicate_sections"
	| "stale_generation"
	| "generation_changed"
	| "published_timestamp_changed"
	| "row_count_mismatch"
	| "connection_generation_mismatch"
	| "identity_generation_mismatch"
	| "latest_attempt_failed"
	| "latest_attempt_in_progress"
	| "latest_attempt_partial"
	| "latest_attempt_unknown"
	| "latest_attempt_missing"
	| "latest_attempt_future_dated"
	| "published_generation_stale"
	| "metadata_invalid"
	| "receipt_missing"
	| "mutation_authority_unavailable"
	| "query_failed"
	| "parent_generation_unavailable"
	| "plex_activity_unavailable"
	| "plex_section_state_unavailable"
	| "plex_library_scan_in_progress"
	| "plex_metadata_refresh_in_progress"
	| "plex_library_activity_unknown"
	| "plex_library_revision_changed"
	| "plex_content_digest_changed"
	| "plex_settlement_metadata_missing"
	| "target_ledger_binding_missing"
	| "target_ledger_invalid"
	| "target_ledger_unavailable"
	| "target_count_mismatch"
	| "target_digest_mismatch"
	| "target_section_mismatch";

export interface PlexEvidenceSummary {
	/** Current trust, retained under the original field name for older clients. */
	publicationLevel: PlexPublicationLevel | "unavailable";
	completeness: "complete" | "partial" | "unknown";
	reasonCodes: PlexCoverageReasonCode[];
	/** Additive current-trust fields. Older clients may safely ignore them. */
	availability?: PlexEvidenceAvailability;
	authority?: PlexPublicationLevel | "unavailable";
	attemptState?: PlexAttemptState;
	/** Immutable facts about the last generation that was actually published. */
	publishedGeneration?: {
		generationId: string;
		publicationLevel: PlexPublicationLevel;
		publishedAt: string;
		itemCount: number;
	};
}

/**
 * Adapts durable Plex evidence to the provider-agnostic UI classifier without
 * exposing generation details to consumers.
 */
export function providerObservationStatusFromPlexEvidence(
	evidence: PlexEvidenceSummary | undefined,
): ProviderObservationStatus {
	if (!evidence) {
		return {
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["unknown-failure"],
		};
	}
	const running = evidence.attemptState === "in_progress";
	const failed = evidence.attemptState === "error";
	const unavailable = evidence.publicationLevel === "unavailable";
	const bounded =
		evidence.publicationLevel === "positive-only" || evidence.completeness === "partial";
	return {
		availability:
			running || failed || unavailable
				? "unavailable"
				: bounded
					? "partial"
					: (evidence.availability ?? "current"),
		evidence: unavailable ? "unknown" : bounded ? "positive-only" : "complete",
		observedAt: null,
		ageSeconds: null,
		latestAttempt: running ? "running" : failed ? "failed" : "successful",
		reasonCodes: running
			? ["refresh-running"]
			: failed
				? ["refresh-failed"]
				: bounded
					? evidence.publicationLevel === "positive-only"
						? ["positive-only"]
						: ["coverage-incomplete"]
					: unavailable
						? ["unknown-failure"]
						: [],
	};
}

export interface PlexGenerationSection {
	key: string;
	title: string;
	type: "movie" | "show";
}

export interface PlexGenerationMetadataV2 {
	version: 2;
	publicationLevel: PlexPublicationLevel;
	completeness: "complete" | "partial";
	itemCount: number;
	sections: PlexGenerationSection[];
}

export const PLEX_CANONICAL_DOMAINS = [
	"membership",
	"display",
	"labels",
	"collections",
	"watch",
	"on-deck",
	"episode-parents",
	"episodes",
] as const;

export type PlexCanonicalDomain = (typeof PLEX_CANONICAL_DOMAINS)[number];

export interface PlexGenerationSectionV3 extends PlexGenerationSection {
	uuid: string;
	refreshing: false;
	scannedAt: number;
	updatedAt: number;
}

export interface PlexGenerationDomainRoot {
	sectionKey: string;
	domain: PlexCanonicalDomain;
	digest: string;
}

export interface PlexGenerationMetadataV3 {
	version: 3;
	publicationLevel: "authoritative";
	completeness: "complete";
	itemCount: number;
	canonicalizationVersion: 1;
	sections: PlexGenerationSectionV3[];
	roots: PlexGenerationDomainRoot[];
	/** Absent on pre-ledger V3 observations; exact-target authority then fails closed. */
	targetLedgerVersion?: 1;
	targetCount?: number;
	targetDigest?: string;
}
export type PlexPartialReasonCode =
	| "currentItemsWithoutTmdbMetadata"
	| "currentLibraryItemsWithoutRatingKeys"
	| "historyItemsWithoutUsableMediaKey"
	| "currentHistoryItemsWithoutMappedMetadata"
	| "historyItemsWithUnknownAccounts"
	| "onDeckItemsWithoutMappedMetadata"
	| "onDeckFetchFailures";
export interface PlexPartialReason {
	code: PlexPartialReasonCode;
	count: number;
}
export interface PlexPositiveGenerationMetadataV4 {
	version: 4;
	publicationLevel: "positive-only";
	completeness: "partial";
	itemCount: number;
	canonicalizationVersion: 1;
	sections: PlexGenerationSectionV3[];
	observedRoots: PlexGenerationDomainRoot[];
	capabilities: readonly [
		{
			domain: "episode-parents";
			field: "membership";
			semantics: "observed-targets-only";
			operators: readonly [];
		},
	];
	targetLedgerVersion: 1;
	targetCount: number;
	targetDigest: string;
	partialReasons: readonly PlexPartialReason[];
}

export interface PlexAuthoritativeGenerationMetadataV5 {
	version: 5;
	publicationLevel: "authoritative";
	completeness: "complete";
	itemCount: number;
	canonicalizationVersion: 1;
	sections: PlexGenerationSectionV3[];
	roots: PlexGenerationDomainRoot[];
	targetLedgerVersion: 1;
	targetCount: number;
	targetDigest: string;
	partialReasons: readonly [];
	coverageReceipt: ProviderCoverageReceiptV1;
	observedRoots?: never;
	capabilities?: never;
}

export interface PlexPositiveGenerationMetadataV5 {
	version: 5;
	publicationLevel: "positive-only";
	completeness: "partial";
	itemCount: number;
	canonicalizationVersion: 1;
	sections: PlexGenerationSectionV3[];
	observedRoots: PlexGenerationDomainRoot[];
	capabilities: readonly [
		{
			domain: "episode-parents";
			field: "membership";
			semantics: "observed-targets-only";
			operators: readonly [];
		},
	];
	targetLedgerVersion: 1;
	targetCount: number;
	targetDigest: string;
	partialReasons: readonly [PlexPartialReason, ...PlexPartialReason[]];
	coverageReceipt: ProviderCoverageReceiptV1;
	roots?: never;
}

/** Exact V5 publication shapes; the discriminator determines all permitted fields. */
export type PlexGenerationMetadataV5 =
	| PlexAuthoritativeGenerationMetadataV5
	| PlexPositiveGenerationMetadataV5;

// ============================================================================
// Watch Enrichment (F1)
// ============================================================================

export interface WatchEnrichmentItem {
	lastWatchedAt: string | null;
	/** A null count is unknown; it is never an implied zero. */
	watchCount: number | null;
	/** Whether the visible count is exact, an observed lower bound, or unknown. */
	watchCountSemantics: "exact" | "lower-bound" | "unknown";
	watchedByUsers: string[];
	/** Null means the current provider has not supplied exact on-deck evidence. */
	onDeck: boolean | null;
	userRating: number | null;
	source: "plex" | "tautulli" | "both" | "jellyfin";
	/** Plex ratingKey for write-back operations (null if not available) */
	ratingKey: string | null;
	/** Jellyfin/Emby item ID for deep links (null if source is Plex) */
	jellyfinId?: string | null;
	/** Instance ID of the media server instance this item belongs to */
	instanceId: string | null;
	/** Collections this item belongs to */
	collections: string[];
	/** Plex labels applied to this item */
	labels: string[];
}

export interface WatchEnrichmentResponse {
	items: Record<string, WatchEnrichmentItem>;
	evidence?: PlexEvidenceSummary;
	tautulliStatus?: ProviderObservationStatus;
	providerStatus?: ProviderObservationStatusEnvelope;
}

// ============================================================================
// Sections (F2)
// ============================================================================

export interface PlexSection {
	sectionId: string;
	sectionUuid: string;
	sectionTitle: string;
	mediaType: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexSectionsResponse {
	sections: PlexSection[];
	/** Independent section-catalog evidence; does not grant canonical mutation authority. */
	catalog: {
		availability: "current" | "last-known" | "unavailable";
		observedAt: string | null;
	};
	evidence?: PlexEvidenceSummary;
}

// ============================================================================
// Now Playing / Sessions (F4)
// ============================================================================

export interface PlexSessionPlayer {
	title: string;
	platform: string;
	product: string;
	state: string;
}

export interface PlexSessionUser {
	/** Exact provider coordinate, or null when optional identity is unavailable. */
	id: string | null;
	title: string;
	thumb?: string;
}

export interface PlexSession {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	type: string;
	user: PlexSessionUser;
	player: PlexSessionPlayer;
	state: "playing" | "paused" | "buffering";
	viewOffset: number;
	duration: number;
	videoDecision: string;
	audioDecision: string;
	bandwidth?: number;
	videoCodec?: string;
	audioCodec?: string;
	videoResolution?: string;
	thumb?: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexNowPlayingResponse {
	sessions: PlexSession[];
	/** Compatibility known subtotal; use bandwidthCoverage to determine coverage. */
	totalBandwidth: number;
	availability: SessionAvailability;
	bandwidthCoverage?: SessionBandwidthCoverage;
	bandwidthBasis?: SessionBandwidthBasis;
}

// ============================================================================
// Episode Watch Status (F6)
// ============================================================================

export interface PlexEpisodeStatus {
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	watched: boolean;
	watchedByUsers: string[];
	lastWatchedAt: string | null;
}

export interface PlexEpisodeStatusResponse {
	showTmdbId: number;
	episodes: PlexEpisodeStatus[];
	evidence?: PlexEvidenceSummary;
}

// ============================================================================
// Collections & Labels (F8)
// ============================================================================

export interface PlexTagItem {
	name: string;
	count: number;
}

export interface PlexTagsResponse {
	collections: PlexTagItem[];
	labels: PlexTagItem[];
	evidence?: PlexEvidenceSummary;
}

export interface PlexTagUpdateRequest {
	type: "collection" | "label";
	action: "add" | "remove";
	name: string;
}

// ============================================================================
// Scan (F3)
// ============================================================================

export interface PlexScanResponse {
	success: boolean;
	message: string;
}

// ============================================================================
// Recently Added (F9)
// ============================================================================

export interface PlexRecentlyAddedItem {
	tmdbId: number;
	title: string;
	mediaType: "movie" | "show" | "episode" | string;
	sectionTitle: string;
	addedAt: string;
	ratingKey: string | null;
	thumb: string | null;
	instanceId: string;
	instanceName: string;
}

export interface PlexRecentlyAddedResponse {
	items: PlexRecentlyAddedItem[];
	evidence?: PlexEvidenceSummary;
}

// ============================================================================
// Server Identity (F10)
// ============================================================================

export interface PlexServerIdentity {
	instanceId: string;
	instanceName: string;
	machineId: string;
	version: string;
	friendlyName: string;
	platform: string;
}

export interface PlexIdentityResponse {
	servers: PlexServerIdentity[];
}

// ============================================================================
// On Deck / Continue Watching (F11)
// ============================================================================

export interface PlexOnDeckItem {
	tmdbId: number;
	title: string;
	mediaType: "movie" | "show" | "episode" | string;
	sectionTitle: string;
	instanceId: string;
	instanceName: string;
	ratingKey: string | null;
	thumb: string | null;
}

export interface PlexOnDeckResponse {
	items: PlexOnDeckItem[];
	evidence?: PlexEvidenceSummary;
}

// ============================================================================
// Plex Accounts (F12)
// ============================================================================

export interface PlexAccountsResponse {
	users: string[];
}

// ============================================================================
// Cache Health (F13)
// ============================================================================

export interface CacheHealthItem {
	/** Sanitized durable work progress. Never includes run/unit identifiers or scopes. */
	progress?:
		| ({
				state: "running" | "failed";
		  } & ProviderObservationProgress)
		| null;
	/** Additive shared UI state; old clients can retain existing result fields. */
	uiCondition?: ProviderUiCondition;
	/** Partial positive-only generations expose this bounded observed count, never an exact universe count. */
	observedItemCount?: number;
	instanceId: string;
	instanceName: string;
	cacheType:
		| "plex"
		| "tautulli"
		| "plex_episode"
		| "jellyfin"
		| "jellyfin_episode"
		| "emby"
		| "emby_episode";
	lastRefreshedAt: string | null;
	lastResult: "success" | "partial" | "error" | "in_progress";
	lastErrorMessage: string | null;
	itemCount: number | null;
	isStale: boolean;
	evidence?: PlexEvidenceSummary;
	providerStatus?: ProviderObservationStatusEnvelope;
}

export interface CacheHealthResponse {
	items: CacheHealthItem[];
}

// ============================================================================
// Series Progress (F14)
// ============================================================================

export type SeriesProgressItem =
	| { status: "exact"; total: number; watched: number; percent: number; watchedSemantics: "exact" }
	| {
			status: "partial";
			total: null;
			watched: number;
			percent: null;
			watchedSemantics: "lower-bound";
	  }
	| { status: "unknown"; total: null; watched: null; percent: null; watchedSemantics: "unknown" };

export interface SeriesProgressResponse {
	configured: boolean;
	progress: Record<number, SeriesProgressItem>;
	evidence?: PlexEvidenceSummary;
	providerStatus?: ProviderObservationStatusEnvelope;
}

// ============================================================================
// Transcode Analytics (F15)
// ============================================================================

export interface TranscodeAnalytics {
	directPlay: number;
	transcode: number;
	directStream: number;
	/** Unverified or unavailable video decisions, never imputed as Direct Play. */
	unknown?: number;
	totalSessions: number;
	/** Absent on old API responses: method basis and coverage are unverified. */
	measurement?: SessionMethodMeasurementSummary;
	dailyBreakdown: Array<{
		date: string;
		directPlay: number;
		transcode: number;
		directStream: number;
		unknown?: number;
		measurement?: SessionMethodMeasurementSummary;
	}>;
}

/** Native video processing observations; audio and overall decisions are separate. */
export interface SessionMethodMeasurementSummary {
	version: 1;
	methodAxis: "video";
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	measuredSessions: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

// ============================================================================
// Bandwidth Analytics (F16)
// ============================================================================

/** Recorded collection outcomes, not proof of continuous historical coverage. */
export interface SnapshotCollectionCoverage {
	activeSnapshots: number;
	idleSnapshots: number;
	failedSnapshots: number;
	legacySnapshots: number;
	invalidSnapshots: number;
}

export interface BandwidthMeasurementSummary {
	version: 1;
	status: "complete" | "partial" | "unavailable";
	bandwidthBasis: "provider-reported" | "encoding-estimate" | "mixed" | null;
	observedSessions: number;
	measuredSessions: number;
	observedSnapshots: number;
	measuredSnapshots: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

export interface BandwidthAnalytics {
	/** Maximum observed sample count; null without valid activity/idle evidence. */
	peakConcurrent: number | null;
	/** Known rate/subtotal; null when native evidence cannot establish a value. */
	peakBandwidth: number | null;
	/** Average of known-rate active snapshots only; see measured coverage. */
	avgBandwidth: number | null;
	/** Absent on old API responses: legacy/unverified, not complete coverage. */
	measurement?: BandwidthMeasurementSummary;
	timeSeries: Array<{
		date: string;
		concurrent: number | null;
		bandwidth: number | null;
		lanBandwidth: number | null;
		wanBandwidth: number | null;
		measurement?: BandwidthMeasurementSummary;
	}>;
}

// ============================================================================
// User Analytics (Tier 1)
// ============================================================================

export interface UserAnalyticsMeasurementSummary {
	version: 1;
	attribution: "source-provider-user-id";
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	attributedSessions: number;
	unattributedSessions: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

export interface UserAnalyticsBandwidthMeasurement {
	version: 1;
	bandwidthBasis: "provider-reported" | "encoding-estimate";
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	measuredSessions: number;
}

export interface UserAnalytics {
	users: Array<{
		username: string;
		/** Sample observations, not distinct sessions or continuous playback events. */
		totalSessions: number;
		/** Deprecated: summing sampled rates does not establish traffic volume. */
		totalBandwidth: number | null;
		/** Five-minute sample weighting, not verified continuous watch duration. */
		estimatedWatchTimeMinutes: number;
		mostRecentActivity: string;
		key?: string;
		avgBandwidth?: number | null;
		bandwidthMeasurement?: UserAnalyticsBandwidthMeasurement;
	}>;
	dailyBreakdown: Array<{
		date: string;
		/** Native responses use source/provider/user identity keys, not labels. */
		userSessions: Record<string, number>;
		measurement?: UserAnalyticsMeasurementSummary;
	}>;
	/** Absent on old responses: attribution and rates remain unverified. */
	measurement?: UserAnalyticsMeasurementSummary;
}

// ============================================================================
// Watch History (Tier 1)
// ============================================================================

export interface WatchHistoryEvent {
	/** Opaque observation key; raw native identifiers are not returned. */
	key?: string;
	user: string;
	title: string;
	timestamp: string;
	platform: string | null;
	videoDecision: string | null;
}

export interface WatchHistoryResponse {
	events: WatchHistoryEvent[];
	/** Missing on old responses: collection coverage is unverified. */
	measurement?: SampledActivityCollection;
}

/** Recorded sampling outcomes, not continuous provider-history coverage. */
export interface SampledActivityCollection {
	version: 1;
	configuredSources: number;
	collection: SnapshotCollectionCoverage;
	collectionByDate?: Record<string, SnapshotCollectionCoverage>;
}

// ============================================================================
// Codec/Resolution Analytics (Tier 1 / Tier 2)
// ============================================================================

export interface CodecAnalyticsMeasurementSummary {
	version: 1;
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	videoCodecMeasuredSessions: number;
	audioCodecMeasuredSessions: number;
	resolutionMeasuredSessions: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

export interface CodecAnalytics {
	videoCodecs: Array<{ codec: string; count: number; percent: number }>;
	audioCodecs: Array<{ codec: string; count: number; percent: number }>;
	resolutions: Array<{ resolution: string; count: number; percent: number }>;
	totalSessions: number;
	/** Missing on old responses: codec categories remain legacy/unverified. */
	measurement?: CodecAnalyticsMeasurementSummary;
}

// ============================================================================
// Device/Platform Analytics (Tier 2)
// ============================================================================

export interface DeviceAnalyticsMeasurementSummary {
	version: 1;
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	platformMeasuredSessions: number;
	playerMeasuredSessions: number;
	/** Plex reports platforms; Jellyfin/Emby report client-app labels. */
	platformAxis: "platform" | "client" | "mixed" | "unverified";
	unverifiedPlatformSnapshots: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

export interface DeviceAnalytics {
	platforms: Array<{ platform: string; sessions: number; percent: number }>;
	players: Array<{ player: string; platform: string; sessions: number }>;
	totalSessions: number;
	/** Absent on legacy responses, whose label provenance is unverified. */
	measurement?: DeviceAnalyticsMeasurementSummary;
}

// ============================================================================
// Collection/Label Statistics (Tier 2)
// ============================================================================

export interface CollectionStats {
	collections: Array<{
		name: string;
		totalItems: number;
		watchedItems: number;
		watchPercent: number;
	}>;
	labels: Array<{
		name: string;
		totalItems: number;
		watchedItems: number;
		watchPercent: number;
	}>;
	evidence?: PlexEvidenceSummary;
}

// ============================================================================
// Per-User Episode Completion (Tier 2)
// ============================================================================

export interface UserEpisodeCompletion {
	shows: Array<{
		tmdbId: number;
		users: Array<{
			username: string;
			watched: number;
			total: number;
			percent: number;
		}>;
	}>;
	evidence?: PlexEvidenceSummary;
	providerStatus?: ProviderObservationStatusEnvelope;
}

// ============================================================================
// Quality Score (Tier 3)
// ============================================================================

export interface QualityScoreComponents {
	directPlayScore: number | null;
	resolutionScore: number | null;
	transcodeScore: number | null;
}

export interface QualityScoreCoverage {
	observedSessions: number;
	methodMeasuredSessions: number;
	resolutionMeasuredSessions: number;
	scoredSessions: number;
}

export interface QualityScoreMeasurementSummary extends QualityScoreCoverage {
	version: 1;
	methodAxis: "video";
	status: "complete" | "partial" | "unavailable";
	invalidDetailSnapshots: number;
	unattributedSessions: number;
	collection: SnapshotCollectionCoverage;
	configuredSources?: number;
}

export interface QualityScoreAnalytics {
	/** Weighted heuristic on observations with BOTH native video and resolution evidence. */
	overallScore: number | null;
	/** Components on the same jointly measured cohort as overallScore. */
	breakdown: QualityScoreComponents;
	/** Independent known components; their measured cohorts may differ. */
	components?: QualityScoreComponents;
	/** Absent on old API responses: measurement authority is unverified. */
	measurement?: QualityScoreMeasurementSummary;
	trend: Array<{
		date: string;
		score: number | null;
		components?: QualityScoreComponents;
		measurement?: QualityScoreMeasurementSummary;
	}>;
	perUser: Array<{
		username: string;
		score: number | null;
		sessions: number;
		key?: string;
		components?: QualityScoreComponents;
		coverage?: QualityScoreCoverage;
	}>;
}

// ============================================================================
// Top Media Leaderboard (Tier 1) — replaces Tautulli home-stats top_*
// ============================================================================

export type TopMediaType = "movie" | "series" | "music";

export interface TopMediaItem {
	/** Display title — show name for episodes, movie name for movies, album/track for music */
	title: string;
	mediaType: TopMediaType;
	/** Known native playback subtotal, deduplicated across consecutive sampled ticks. */
	playCount: number;
	/** Known source-generation-scoped actors; not globally distinct people. */
	distinctUserCount: number;
	/** Observations without verified captured actor scope; not a shared Unknown user. */
	unattributedSessions?: number;
	/** Observations lacking native playback identity; excluded from known play subtotal. */
	unidentifiedPlaybackSessions?: number;
	/** Sample-weighted activity at five minutes per observation, not verified playback time. */
	totalDurationMinutes: number;
	/** ISO timestamp of the most recent watch event */
	lastWatchedAt: string;
}

export interface TopMediaResponse {
	items: TopMediaItem[];
	measurement?: SampledActivityCollection;
}

// ============================================================================
// Plays By Date (Tier 1) — replaces Tautulli cmd=get_plays_by_date
// ============================================================================

export interface PlaysByDateSeries {
	/** Display name — "Movies" | "TV" | "Music". Matches the legacy Tautulli shape. */
	name: string;
	/** One entry per date in `categories`, in the same order. */
	data: Array<number | null>;
}

export interface PlaysByDateResponse {
	/** Date strings (YYYY-MM-DD) covering the full window, ascending. */
	categories: string[];
	series: PlaysByDateSeries[];
	measurement?: SampledActivityCollection;
	/** Same date order; retained observations excluded from known playback counts. */
	unidentifiedPlaybackSessions?: number[];
	/** Same date order; invalid detail never establishes a zero-play day. */
	invalidDetailSnapshots?: number[];
}

// ============================================================================
// Most Concurrent (Tier 1) — replaces Tautulli home-stats most_concurrent
// ============================================================================

export interface MostConcurrentEntry {
	/** ISO timestamp of the snapshot tick where this peak was observed */
	capturedAt: string;
	concurrentStreams: number;
	/** Complete native event total only; missing/partial/legacy evidence is null. */
	totalBandwidth: number | null;
	/** Preserves partial native rates without certifying a complete total. */
	knownBandwidthSubtotal?: number | null;
	measurement?: {
		version: 1;
		concurrencyStatus: "native" | "legacy-unverified";
		bandwidthBasis: "provider-reported" | "encoding-estimate" | null;
		bandwidthStatus: "complete" | "partial" | "unavailable";
		observedSessions: number;
		measuredSessions: number;
	};
}

export interface MostConcurrentResponse {
	/** Highest per-source sample count, not a simultaneous all-server total. */
	peakConcurrent: number | null;
	/** Top-N peak events, deduped by 30-min proximity so a held peak collapses to one entry */
	events: MostConcurrentEntry[];
	measurement?: {
		version: 1;
		scope: "per-source-snapshot";
		/** Native count coverage, independent of event rate availability. */
		status: "complete" | "partial" | "unavailable";
		observedSnapshots: number;
		/** Includes successful idle observations excluded from active events. */
		nativeSnapshots: number;
		collection: SnapshotCollectionCoverage;
		configuredSources?: number;
	};
}

// ============================================================================
// Bandwidth Forecast (Tier 3)
// ============================================================================

export interface ForecastSampleCoverage extends BandwidthMeasurementSummary {
	/** Active snapshots whose native total includes every observed session. */
	completeTotalSnapshots: number;
}

export interface ForecastMeasurementSummary extends ForecastSampleCoverage {
	eligibleDays: number;
	projectionStatus: "available" | "insufficient-data" | "mixed-basis" | "numeric-unavailable";
}

export interface BandwidthForecast {
	historicalDaily: Array<{
		date: string;
		/** Mean and peak of completely measured active sample totals only. */
		avgBandwidth: number | null;
		peakBandwidth: number | null;
		/** Known subtotals retain partial evidence; never certify a complete total. */
		avgKnownSubtotal?: number | null;
		peakKnownSubtotal?: number | null;
		measurement?: ForecastSampleCoverage;
	}>;
	forecast: Array<{ date: string; predictedPeak: number }>;
	peakHours: Array<{
		hour: number;
		avgConcurrent: number | null;
		avgBandwidth: number | null;
		avgKnownSubtotal?: number | null;
		measurement?: ForecastSampleCoverage;
	}>;
	trend: "increasing" | "stable" | "decreasing" | "unknown";
	measurement?: ForecastMeasurementSummary;
}

// ============================================================================
// Plex OAuth Setup (PIN-based auth + server discovery)
// ============================================================================

export interface PlexOAuthPinResponse {
	pinId: number;
	pinCode: string;
}

export interface PlexOAuthTokenResponse {
	tokenRef: string | null;
}

export interface PlexServerConnection {
	uri: string;
	local: boolean;
	relay: boolean;
	reachable: boolean;
}

export interface PlexDiscoveredServer {
	name: string;
	clientIdentifier: string;
	platform?: string;
	version?: string;
	connections: PlexServerConnection[];
}

export interface PlexDiscoverServersResponse {
	servers: PlexDiscoveredServer[];
}
