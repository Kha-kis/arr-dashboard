/**
 * Library Cleanup Engine Types
 *
 * Internal types for the cleanup rule evaluation pipeline.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { JellyfinClient } from "../jellyfin/jellyfin-client.js";
import type { PlexClient } from "../plex/plex-client.js";
import type { LibraryItemType, PrismaClient, ServiceInstance } from "../prisma.js";
import type { QuiClient } from "../qui/client-factory.js";
import type { SeerrClient } from "../seerr/seerr-client.js";
import type { TautulliClient } from "../tautulli/tautulli-client.js";
import type { TmdbListItem } from "../tmdb/list-client.js";
import type { TraktListItem } from "../trakt/list-client.js";
import type { EpisodeTargetMetadata } from "./episode-scope.js";

// ============================================================================
// Dependencies
// ============================================================================

export interface CompleteQuiFileHashIndex {
	resolve(path: string): Promise<{ hashes: string[]; complete: true }>;
}

export interface CleanupExecutorDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	/** Audit attribution for configured runs; scheduler/system is the default. */
	auditTrigger?: "scheduled" | "manual" | "approval" | "retry" | "recovery";
	auditActorId?: string | null;
	/** Scheduler already ran the independent ancillary scan worker for this tick. */
	skipPendingMediaServerRescanRetry?: boolean;
	encryptor?: Encryptor;
	/** Test seam for live deletion-safety checks. */
	plexClientFactory?: (
		instance: ServiceInstance,
	) => Pick<
		PlexClient,
		"getAccounts" | "getMovieMediaPartsByTmdbId" | "getSeriesEpisodeMediaPartsByTvdbId"
	> &
		Partial<Pick<PlexClient, "getEpisodeWatchCount">>;
	/** Test seam and production adapter for exact-hash mutation-boundary qUI reads. */
	quiClientFactory?: (instance: ServiceInstance) => Pick<QuiClient, "getTorrentsByHash">;
	/** Test seam and production adapter for mutation-boundary Seerr inventory reads. */
	seerrClientFactory?: (instance: ServiceInstance) => Pick<SeerrClient, "getRequests">;
	/** Test seams for complete live provider refreshes at the mutation boundary. */
	plexCacheClientFactory?: (instance: ServiceInstance) => PlexClient;
	tautulliCacheClientFactory?: (instance: ServiceInstance) => TautulliClient;
	jellyfinCacheClientFactory?: (instance: ServiceInstance) => JellyfinClient;
	tmdbListClientFactory?: (apiKey: string) => {
		getListItems(listId: string): Promise<TmdbListItem[]>;
	};
	traktListClientFactory?: (
		accessToken: string,
		clientId: string,
	) => { getListItems(listSlug: string): Promise<TraktListItem[]> };
	traktClientId?: string | null;
	/**
	 * Resolve every torrent hash sharing the exact physical file inode from
	 * an uncached, explicitly complete qUI/filesystem snapshot.
	 */
	quiFileHashIndexFactory?: (instance: ServiceInstance) => Promise<CompleteQuiFileHashIndex>;
	log: FastifyBaseLogger;
}

// ============================================================================
// Rule Evaluation
// ============================================================================

/** A LibraryCache row with only the indexed fields needed for rule evaluation */
export interface CacheItemForEval {
	id: string;
	instanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
	title: string;
	year: number | null;
	monitored: boolean;
	hasFile: boolean;
	status: string | null;
	qualityProfileId: number | null;
	qualityProfileName: string | null;
	sizeOnDisk: bigint;
	arrAddedAt: Date | null;
	/** When this ARR cache row was last fully sourced from its service instance. */
	cachedAt?: Date;
	/** Full JSON data blob for extended lookups (e.g. tags, ratings) */
	data: string;
	/** Parent-level qUI metadata; episode candidates must never use this as file evidence. */
	torrentState?: string | null;
	infoHash?: string | null;
}

/** Seerr request info, extracted from the bulk prefetch for rule evaluation */
export interface SeerrRequestInfo {
	requestId: number;
	/** Seerr request status: 1=Pending, 2=Approved, 3=Declined, 4=Failed, 5=Completed */
	status: number;
	requestedBy: string;
	requestedByUserId: number;
	createdAt: string;
	/** ISO date string of when the request was last updated */
	updatedAt: string;
	/** Display name of the user who last modified the request, or null */
	modifiedBy: string | null;
	/** Whether this is a 4K request */
	is4k: boolean;
}

/**
 * Seerr request lookup map: "movie:tmdbId" | "tv:tmdbId" → SeerrRequestInfo[]
 * An item can have multiple requests (e.g., different users, 4K vs non-4K).
 */
export type SeerrRequestMap = Map<string, SeerrRequestInfo[]>;

/** Tautulli watch data for a single library item */
export interface TautulliWatchInfo {
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string[];
}

/**
 * Tautulli watch data lookup map: "movie:tmdbId" | "series:tmdbId" → TautulliWatchInfo
 */
export type TautulliWatchMap = Map<string, TautulliWatchInfo>;

/** Per-section Plex watch data */
export interface PlexSectionWatchInfo {
	sectionId: string;
	sectionTitle: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string[];
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
}

/** Plex watch data for a single library item (aggregated + per-section) */
export interface PlexWatchInfo {
	// Pre-computed aggregates (used when no plexLibraryFilter is set)
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string[];
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
	// Per-section breakdown (used when plexLibraryFilter is set)
	sections: PlexSectionWatchInfo[];
}

/**
 * Plex watch data lookup map: "movie:tmdbId" | "series:tmdbId" → PlexWatchInfo
 */
export type PlexWatchMap = Map<string, PlexWatchInfo>;

/** Jellyfin watch data for a single library item (aggregated across libraries) */
export interface JellyfinWatchInfo {
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string[];
	onDeck: boolean;
	userRating: number | null;
	addedAt: Date | null;
}

/**
 * Jellyfin watch data lookup map: "movie:tmdbId" | "series:tmdbId" → JellyfinWatchInfo
 */
export type JellyfinWatchMap = Map<string, JellyfinWatchInfo>;

/** Aggregated episode completion data for a show */
export interface PlexEpisodeStats {
	total: number;
	watched: number;
	/** Per-season breakdown for minSeason filtering */
	seasons: Map<number, { total: number; watched: number }>;
}

/**
 * Plex episode completion map: showTmdbId → PlexEpisodeStats
 */
export type PlexEpisodeMap = Map<number, PlexEpisodeStats>;

export type ListMembershipKey = `movie:${number}` | `series:${number}`;

export function listMembershipKey(
	mediaType: "movie" | "series",
	tmdbId: number,
): ListMembershipKey {
	return `${mediaType}:${tmdbId}`;
}

/**
 * Context object passed to all rule evaluators.
 * Replaces the growing list of optional parameters on evaluateRule().
 */
export interface EvalContext {
	now: Date;
	seerrMap?: SeerrRequestMap;
	tautulliMap?: TautulliWatchMap;
	plexMap?: PlexWatchMap;
	/** Complete, current Plex movie/show section-title inventory across enabled instances. */
	plexSectionTitles?: Set<string>;
	plexEpisodeMap?: PlexEpisodeMap;
	jellyfinMap?: JellyfinWatchMap;
	/** Reuses PlexEpisodeMap shape — same total/watched/seasons structure */
	jellyfinEpisodeMap?: PlexEpisodeMap;
	/**
	 * Auto-tagger external list memberships (used by `tmdb_list_member` and
	 * `trakt_list_member` rules). Map key is the list identifier (TMDb listId
	 * or Trakt listSlug); value is the set of media-type-qualified TMDb IDs
	 * in that list. Qualifying the ID prevents movie/series numeric collisions.
	 *
	 * Populated by the auto-tagger's per-rule prefetch — undefined when
	 * called from the cleanup executor (which doesn't use these rule types).
	 */
	tmdbListMemberships?: Map<string, Set<ListMembershipKey>>;
	traktListMemberships?: Map<string, Set<ListMembershipKey>>;
}

/** Tracks the outcome of each data source prefetch */
export interface PrefetchResults {
	seerr: "ok" | "failed" | "skipped";
	tautulli: "ok" | "failed" | "skipped";
	plex: "ok" | "failed" | "skipped";
	jellyfin: "ok" | "failed" | "skipped";
	tmdb: "ok" | "failed" | "skipped";
	trakt: "ok" | "failed" | "skipped";
}

/** Action from a rule definition (what the rule intends to do) */
export type RuleAction = "delete" | "unmonitor" | "delete_files";

/** Action recorded in execution details (what actually happened) */
export type DetailAction =
	| RuleAction
	| "flagged"
	| "removed"
	| "files_deleted"
	| "unmonitored"
	| "queued_for_approval"
	| "skipped";

/** Result of evaluating a single rule against a cache item */
export interface RuleMatch {
	ruleId: string;
	ruleName: string;
	reason: string;
	action: RuleAction;
	scanMediaServerAfterDelete?: boolean;
}

/** An item flagged by the cleanup engine */
export interface FlaggedItem {
	cacheItem: CacheItemForEval;
	match: RuleMatch;
	/** Preferred available *arr rating from the data blob */
	rating: number | null;
	/** Apply fresh qUI physical-file protection to destructive actions. */
	respectQuiSeeding?: boolean;
	/** Exact Sonarr episode identity when the rule targets an episode. */
	episodeTarget?: EpisodeTargetMetadata;
}

// ============================================================================
// Execution
// ============================================================================

export interface CleanupRunResult {
	isDryRun: boolean;
	status: "completed" | "partial" | "error";
	itemsEvaluated: number;
	itemsFlagged: number;
	/**
	 * Durable retries shown alongside current rule matches in preview responses.
	 * Null means retry storage could not be read, so the count is unknown.
	 */
	pendingRetryCount?: number | null;
	/** Whether retry ownership and planner counts were loaded completely. */
	selectionCountsComplete?: boolean;
	/** Known retry and fresh-candidate targets available to an interactive preview. */
	previewItemCount?: number;
	/**
	 * Next-run slot selection counts; blocked is an overlapping subset of
	 * selectedFresh because safety-blocked slots are never backfilled.
	 */
	previewSelection?: {
		selectedFresh: number;
		selectedRetries: number;
		deferredBudget: number;
		deferredApproval: number;
		deferredRetryFairness: number;
		deferredInFlightTarget: number;
		deferredDuplicateTarget: number;
		inFlight: number;
		blocked: number;
		retryStateUnavailable: number;
		retryState: "complete" | "unavailable";
		total: number;
	};
	itemsRemoved: number;
	itemsUnmonitored: number;
	itemsFilesDeleted: number;
	itemsSkipped: number;
	details: Array<{
		/** Stable lifecycle identity; retries retain the same action id. */
		actionId?: string;
		approvalId?: string;
		auditCorrelationId?: string;
		instanceId: string;
		arrItemId: number;
		title: string;
		seriesTitle?: string;
		episodeTitle?: string;
		ruleId: string;
		rule: string;
		reason: string;
		action: DetailAction;
		intendedAction?: RuleAction;
		auditOutcomeOwnedByExecution?: boolean;
		/** True only after control reached an upstream ARR mutating API call. */
		mutationAttempted?: boolean;
		/** Best-effort audit evidence was prepared before final mutation authority checks. */
		auditPrepared?: boolean;
		/** Upstream succeeded but the durable intent status could not be confirmed. */
		durableStateRecordingFailed?: boolean;
		itemType?: string;
		targetScope?: "series" | "episode";
		arrEpisodeId?: number;
		seasonNumber?: number;
		episodeNumber?: number;
		episodeFileId?: number;
		sizeOnDisk?: string;
		year?: number | null;
		rating?: number | null;
		previewDisposition?: "selected" | "deferred" | "blocked" | "in_flight";
		plannedAction?: RuleAction;
		isRetryAttempt?: boolean;
	}>;
	durationMs: number;
	error?: string;
	prefetchHealth?: PrefetchResults;
	warnings?: string[];
}
