/**
 * Library Cleanup Engine Types
 *
 * Internal types for the cleanup rule evaluation pipeline.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { NotificationPayload } from "../notifications/types.js";
import type { LibraryItemType, PrismaClient } from "../prisma.js";

// ============================================================================
// Dependencies
// ============================================================================

export interface CleanupExecutorDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
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
	/** Full JSON data blob for extended lookups (e.g. tags, ratings) */
	data: string;
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

/**
 * Context object passed to all rule evaluators.
 * Replaces the growing list of optional parameters on evaluateRule().
 */
export interface EvalContext {
	now: Date;
	seerrMap?: SeerrRequestMap;
	tautulliMap?: TautulliWatchMap;
	plexMap?: PlexWatchMap;
	plexEpisodeMap?: PlexEpisodeMap;
}

/** Tracks the outcome of each data source prefetch */
export interface PrefetchResults {
	seerr: "ok" | "failed" | "skipped";
	tautulli: "ok" | "failed" | "skipped";
	plex: "ok" | "failed" | "skipped";
}

/** Action from a rule definition (what the rule intends to do) */
export type RuleAction = "delete" | "unmonitor" | "delete_files";

/** Action recorded in execution details (what actually happened) */
export type DetailAction =
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
}

/** An item flagged by the cleanup engine */
export interface FlaggedItem {
	cacheItem: CacheItemForEval;
	match: RuleMatch;
	/** TMDB rating if available from the data blob */
	rating: number | null;
}

// ============================================================================
// Execution
// ============================================================================

export interface CleanupRunResult {
	isDryRun: boolean;
	status: "completed" | "partial" | "error";
	itemsEvaluated: number;
	itemsFlagged: number;
	itemsRemoved: number;
	itemsUnmonitored: number;
	itemsFilesDeleted: number;
	itemsSkipped: number;
	details: Array<{
		instanceId: string;
		arrItemId: number;
		title: string;
		ruleId: string;
		rule: string;
		reason: string;
		action: DetailAction;
		itemType?: string;
		sizeOnDisk?: string;
		year?: number | null;
		rating?: number | null;
	}>;
	durationMs: number;
	error?: string;
	prefetchHealth?: PrefetchResults;
	warnings?: string[];
}

// ============================================================================
// Scheduler
// ============================================================================

export interface CleanupSchedulerOptions {
	notifyFn?: (payload: NotificationPayload) => Promise<void>;
}
