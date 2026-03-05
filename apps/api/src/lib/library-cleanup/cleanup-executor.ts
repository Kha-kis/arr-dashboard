/**
 * Library Cleanup Executor
 *
 * Orchestrates cleanup evaluation and execution:
 * 1. Loads config + rules for the user
 * 2. Queries LibraryCache items (operating on cached data, not live API)
 * 3. Evaluates each item against rules (first match wins)
 * 4. Either flags items for approval or removes them directly
 *
 * Supports three actions per rule: delete, unmonitor, delete_files.
 */

import { ruleDataSourceMap, type DataSourceDependency } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { LibraryCleanupConfig, LibraryCleanupRule, ServiceInstance } from "../prisma.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { evaluateItemAgainstRules, evaluateRule, extractRating } from "./rule-evaluators.js";
import type {
	CacheItemForEval,
	CleanupExecutorDeps,
	CleanupRunResult,
	DetailAction,
	EvalContext,
	FlaggedItem,
	PlexSectionWatchInfo,
	PlexEpisodeMap,
	PlexEpisodeStats,
	PlexWatchMap,
	PrefetchResults,
	SeerrRequestInfo,
	SeerrRequestMap,
	TautulliWatchMap,
} from "./types.js";

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;

// Circuit breaker: abort after N consecutive ARR API failures
const CIRCUIT_BREAKER_THRESHOLD = 3;

// ============================================================================
// Detail Builder Helper
// ============================================================================

/** Build a detail entry for the cleanup run log. Ensures ruleId + itemType are always present. */
function buildDetail(
	item: FlaggedItem,
	action: DetailAction,
	reasonOverride?: string,
): CleanupRunResult["details"][number] {
	return {
		instanceId: item.cacheItem.instanceId,
		arrItemId: item.cacheItem.arrItemId,
		title: item.cacheItem.title,
		ruleId: item.match.ruleId,
		rule: item.match.ruleName,
		reason: reasonOverride ?? item.match.reason,
		action,
		itemType: item.cacheItem.itemType,
		sizeOnDisk: item.cacheItem.sizeOnDisk.toString(),
		year: item.cacheItem.year,
		rating: null,
	};
}

// ============================================================================
// Preview (Dry Run)
// ============================================================================

/**
 * Run a preview evaluation without making any changes.
 * Returns all items that would be flagged by the current rule set.
 */
export async function executeCleanupPreview(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: { priority: "asc" } } },
	});

	if (!config || config.rules.length === 0) {
		return {
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
		};
	}

	const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(deps, config, config.rules);

	const details = flagged.map((f) => ({
		instanceId: f.cacheItem.instanceId,
		arrItemId: f.cacheItem.arrItemId,
		title: f.cacheItem.title,
		ruleId: f.match.ruleId,
		rule: f.match.ruleName,
		reason: f.match.reason,
		action: f.match.action as DetailAction,
		itemType: f.cacheItem.itemType,
		sizeOnDisk: f.cacheItem.sizeOnDisk.toString(),
		year: f.cacheItem.year,
		rating: f.rating,
	}));

	const hasFailedPrefetch = warnings.length > 0;
	log.info({ totalEvaluated, totalFlagged: flagged.length, hasFailedPrefetch }, "Library cleanup preview completed");

	return {
		isDryRun: true,
		status: hasFailedPrefetch ? "partial" as const : "completed" as const,
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: 0,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings,
	};
}

// ============================================================================
// Full Execution
// ============================================================================

/**
 * Execute a full cleanup run. Depending on config:
 * - dryRunMode=true: Only log what would happen
 * - requireApproval=true: Create approval queue entries
 * - Otherwise: Execute actions directly on ARR instances
 */
export async function executeCleanupRun(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: { priority: "asc" } } },
	});

	if (!config || !config.enabled || config.rules.length === 0) {
		return {
			isDryRun: config?.dryRunMode ?? true,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
		};
	}

	const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(deps, config, config.rules);

	// Respect max removals per run
	const limited = flagged.slice(0, config.maxRemovalsPerRun);
	const hasFailedPrefetch = warnings.length > 0;

	if (config.dryRunMode) {
		const details = limited.map((f) => ({
			instanceId: f.cacheItem.instanceId,
			arrItemId: f.cacheItem.arrItemId,
			title: f.cacheItem.title,
			ruleId: f.match.ruleId,
			rule: f.match.ruleName,
			reason: f.match.reason,
			action: "flagged" as const,
			itemType: f.cacheItem.itemType,
			sizeOnDisk: f.cacheItem.sizeOnDisk.toString(),
			year: f.cacheItem.year,
			rating: f.rating,
		}));

		const result: CleanupRunResult = {
			isDryRun: true,
			status: hasFailedPrefetch ? "partial" : "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: limited.length,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: flagged.length - limited.length,
			details,
			durationMs: Date.now() - startTime,
			prefetchHealth,
			warnings,
		};

		await createRunLog(prisma, config.id, result, log);
		return result;
	}

	// Real execution
	if (config.requireApproval) {
		return await executeWithApproval(
			deps,
			config,
			limited,
			totalEvaluated,
			flagged.length,
			startTime,
			prefetchHealth,
			warnings,
		);
	}

	return await executeDirectRemoval(
		deps,
		config,
		userId,
		limited,
		totalEvaluated,
		flagged.length,
		startTime,
		prefetchHealth,
		warnings,
	);
}

/**
 * Execute approved items from the approval queue.
 * Dispatches on the stored action (delete, unmonitor, delete_files).
 */
export async function executeApprovedItems(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
): Promise<{ removed: number; failed: number; errors: string[] }> {
	const { prisma, arrClientFactory, log } = deps;

	// Atomically transition approved → executing to prevent double-execution
	// Also enforce expiry — don't execute items past their expiration
	const now = new Date();
	await prisma.libraryCleanupApproval.updateMany({
		where: {
			id: { in: approvalIds },
			config: { userId },
			status: "approved",
			expiresAt: { gt: now },
		},
		data: { status: "executing" },
	});

	const approvals = await prisma.libraryCleanupApproval.findMany({
		where: {
			id: { in: approvalIds },
			config: { userId },
			status: "executing",
		},
	});

	// Load instances for these approvals
	const instanceIds = [...new Set(approvals.map((a) => a.instanceId))];
	const instances = await prisma.serviceInstance.findMany({
		where: { id: { in: instanceIds }, userId },
	});
	const instanceMap = new Map(instances.map((i) => [i.id, i]));

	let removed = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const approval of approvals) {
		const instance = instanceMap.get(approval.instanceId);
		if (!instance) {
			errors.push(`Instance not found for ${approval.title}`);
			failed++;
			continue;
		}

		try {
			const action = approval.action ?? "delete";

			if (action === "unmonitor") {
				await unmonitorInArr(arrClientFactory, instance, approval.arrItemId);
				await prisma.libraryCache.updateMany({
					where: {
						instanceId: approval.instanceId,
						arrItemId: approval.arrItemId,
						itemType: approval.itemType,
					},
					data: { monitored: false },
				});
			} else if (action === "delete_files") {
				await deleteFilesFromArr(arrClientFactory, instance, approval.arrItemId);
				await prisma.libraryCache.updateMany({
					where: {
						instanceId: approval.instanceId,
						arrItemId: approval.arrItemId,
						itemType: approval.itemType,
					},
					data: { hasFile: false, sizeOnDisk: 0 },
				});
			} else {
				await deleteFromArr(arrClientFactory, instance, approval.arrItemId);
				await prisma.libraryCache.deleteMany({
					where: {
						instanceId: approval.instanceId,
						arrItemId: approval.arrItemId,
						itemType: approval.itemType,
					},
				});
			}

			await prisma.libraryCleanupApproval.update({
				where: { id: approval.id },
				data: { status: "executed", executedAt: new Date() },
			});

			removed++;
			log.info(
				{ title: approval.title, instanceId: approval.instanceId, action },
				"Approved cleanup item executed",
			);
		} catch (error) {
			const msg = getErrorMessage(error);
			errors.push(`Failed to execute "${approval.title}": ${msg}`);
			failed++;
			log.error(
				{ err: error, title: approval.title, instanceId: approval.instanceId },
				"Failed to execute approved cleanup item",
			);
			// Revert to approved so the item can be retried
			await prisma.libraryCleanupApproval
				.update({ where: { id: approval.id }, data: { status: "approved" } })
				.catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id, title: approval.title },
						"Failed to revert approval status — item may be stuck in executing state",
					);
				});
		}
	}

	return { removed, failed, errors };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Collect all rule types from enabled rules, including conditions inside composite rules.
 * Used to decide which external data to prefetch (Seerr, Tautulli, Plex).
 */
function collectActiveRuleTypes(rules: Pick<LibraryCleanupRule, "enabled" | "ruleType" | "conditions">[]): Set<string> {
	const types = new Set<string>();
	for (const r of rules) {
		if (!r.enabled) continue;
		types.add(r.ruleType);
		if (r.conditions) {
			const conds = safeJsonParse(r.conditions) as Array<{ ruleType?: string }> | null;
			if (Array.isArray(conds)) for (const c of conds) if (c.ruleType) types.add(c.ruleType);
		}
	}
	return types;
}

/**
 * Prefetch all Seerr requests and build a lookup map keyed by "movie:tmdbId" or "tv:tmdbId".
 * Returns undefined if no Seerr instance is configured (Seerr rules silently skip).
 */
async function prefetchSeerrRequests(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<SeerrRequestMap | undefined> {
	const { prisma, arrClientFactory, log } = deps;

	// Find user's Seerr instance
	const seerrInstance = await prisma.serviceInstance.findFirst({
		where: { userId, service: "SEERR" },
		select: {
			id: true,
			baseUrl: true,
			encryptedApiKey: true,
			encryptionIv: true,
			service: true,
			label: true,
		},
	});

	if (!seerrInstance) return undefined;

	try {
		const client = new SeerrClient(arrClientFactory, seerrInstance, log);
		const map: SeerrRequestMap = new Map();
		const take = 50;
		let skip = 0;
		const maxPages = 100; // Up to 5,000 requests

		for (let page = 0; page < maxPages; page++) {
			const result = await client.getRequests({ take, skip });

			for (const req of result.results) {
				const key = `${req.type}:${req.media.tmdbId}`;
				const info: SeerrRequestInfo = {
					requestId: req.id,
					status: req.status,
					requestedBy: req.requestedBy.displayName,
					requestedByUserId: req.requestedBy.id,
					createdAt: req.createdAt,
					updatedAt: req.updatedAt,
					modifiedBy: req.modifiedBy?.displayName ?? null,
					is4k: req.is4k ?? false,
				};

				const existing = map.get(key);
				if (existing) {
					existing.push(info);
				} else {
					map.set(key, [info]);
				}
			}

			if (result.results.length < take) break;
			skip += take;
		}

		log.info(
			{ totalRequests: [...map.values()].reduce((sum, arr) => sum + arr.length, 0) },
			"Seerr request prefetch complete for cleanup",
		);
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Seerr requests for cleanup — Seerr rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Tautulli watch data from the TautulliCache table and build a lookup map.
 * Returns undefined if no Tautulli instance is configured.
 */
async function prefetchTautulliData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<TautulliWatchMap | undefined> {
	const { prisma, log } = deps;

	// Find user's Tautulli instance
	const tautulliInstance = await prisma.serviceInstance.findFirst({
		where: { userId, service: "TAUTULLI" },
		select: { id: true },
	});

	if (!tautulliInstance) return undefined;

	try {
		const cacheRows = await prisma.tautulliCache.findMany({
			where: { instanceId: tautulliInstance.id },
		});

		const map: TautulliWatchMap = new Map();
		for (const row of cacheRows) {
			try {
				const key = `${row.mediaType}:${row.tmdbId}`;
				const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];
				map.set(key, {
					lastWatchedAt: row.lastWatchedAt,
					watchCount: row.watchCount,
					watchedByUsers,
				});
			} catch {
				log.warn({ tmdbId: row.tmdbId }, "Skipping Tautulli cache row with bad data");
			}
		}

		log.info({ totalEntries: map.size }, "Tautulli watch data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Tautulli data for cleanup — Tautulli rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Plex watch data from the PlexCache table and build a lookup map.
 * Now section-aware: each row carries sectionId/sectionTitle, and PlexWatchInfo
 * contains both pre-computed cross-section aggregates and a per-section breakdown.
 * Also includes collections and labels from the PlexCache table.
 * Returns undefined if no Plex instance is configured.
 */
async function prefetchPlexData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexWatchMap | undefined> {
	const { prisma, log } = deps;

	const plexInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: "PLEX" },
		select: { id: true },
	});

	if (plexInstances.length === 0) return undefined;

	try {
		const cacheRows = await prisma.plexCache.findMany({
			where: { instanceId: { in: plexInstances.map((i) => i.id) } },
		});

		const map: PlexWatchMap = new Map();
		for (const row of cacheRows) {
			try {
			// Key is mediaType:tmdbId (aggregating across sections)
			const key = `${row.mediaType}:${row.tmdbId}`;
			const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];
			const collections = (safeJsonParse(row.collections) as string[]) ?? [];
			const labels = (safeJsonParse(row.labels) as string[]) ?? [];

			const sectionInfo: PlexSectionWatchInfo = {
				sectionId: row.sectionId,
				sectionTitle: row.sectionTitle,
				lastWatchedAt: row.lastWatchedAt,
				watchCount: row.watchCount,
				watchedByUsers,
				onDeck: row.onDeck,
				userRating: row.userRating,
				collections,
				labels,
				addedAt: row.addedAt,
			};

			const existing = map.get(key);
			if (existing) {
				existing.sections.push(sectionInfo);
				// Update aggregates: merge across sections
				if (row.lastWatchedAt && (!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)) {
					existing.lastWatchedAt = row.lastWatchedAt;
				}
				existing.watchCount += row.watchCount;
				for (const user of watchedByUsers) {
					if (!existing.watchedByUsers.includes(user)) {
						existing.watchedByUsers.push(user);
					}
				}
				existing.onDeck = existing.onDeck || row.onDeck;
				if (row.userRating != null) {
					existing.userRating = existing.userRating != null
						? Math.max(existing.userRating, row.userRating)
						: row.userRating;
				}
				// Merge collections and labels
				for (const c of collections) {
					if (!existing.collections.includes(c)) existing.collections.push(c);
				}
				for (const l of labels) {
					if (!existing.labels.includes(l)) existing.labels.push(l);
				}
				// Merge addedAt: take earliest (first appearance in any library)
				if (row.addedAt && (!existing.addedAt || row.addedAt < existing.addedAt)) {
					existing.addedAt = row.addedAt;
				}
			} else {
				map.set(key, {
					lastWatchedAt: row.lastWatchedAt,
					watchCount: row.watchCount,
					watchedByUsers: [...watchedByUsers],
					onDeck: row.onDeck,
					userRating: row.userRating,
					collections: [...collections],
					labels: [...labels],
					addedAt: row.addedAt,
					sections: [sectionInfo],
				});
			}
			} catch {
				log.warn({ tmdbId: row.tmdbId }, "Skipping Plex cache row with bad data");
			}
		}

		log.info({ totalEntries: map.size }, "Plex watch data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex data for cleanup — Plex rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Plex episode completion data for series.
 * Uses SQL GROUP BY on PlexEpisodeCache to avoid loading all episodes into memory.
 * Returns a Map of showTmdbId → { total, watched }.
 */
async function prefetchPlexEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await prisma.serviceInstance.findMany({
			where: { userId },
			select: { id: true },
		});
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return new Map();

		// Three groupBy queries: show-level totals, show-level watched, and per-season counts
		const totalCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const watchedCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		// Per-season counts for minSeason filtering
		const seasonTotals = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const seasonWatched = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		// Build per-season watched lookup: "showTmdbId:seasonNumber" → count
		const seasonWatchedMap = new Map(
			seasonWatched.map((g) => [`${g.showTmdbId}:${g.seasonNumber}`, g._count.id]),
		);

		// Build per-show season maps
		const showSeasonsMap = new Map<number, Map<number, { total: number; watched: number }>>();
		for (const g of seasonTotals) {
			let seasons = showSeasonsMap.get(g.showTmdbId);
			if (!seasons) {
				seasons = new Map();
				showSeasonsMap.set(g.showTmdbId, seasons);
			}
			seasons.set(g.seasonNumber, {
				total: g._count.id,
				watched: seasonWatchedMap.get(`${g.showTmdbId}:${g.seasonNumber}`) ?? 0,
			});
		}

		const watchedMap = new Map(watchedCounts.map((g) => [g.showTmdbId, g._count.id]));
		const map: PlexEpisodeMap = new Map();

		for (const group of totalCounts) {
			map.set(group.showTmdbId, {
				total: group._count.id,
				watched: watchedMap.get(group.showTmdbId) ?? 0,
				seasons: showSeasonsMap.get(group.showTmdbId) ?? new Map(),
			});
		}

		log.info({ totalShows: map.size }, "Plex episode data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex episode data for cleanup — episode completion rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Evaluate all LibraryCache items against the rule set.
 * Queries in batches to avoid memory issues with large libraries.
 * Uses collectActiveRuleTypes() to detect rule types inside composite conditions.
 *
 * Now tracks prefetch results for observability and aborts with "partial" status
 * when a failed data source has dependent rules that could produce false matches.
 */
async function evaluateAllItems(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig,
	rules: LibraryCleanupRule[],
): Promise<{ flagged: FlaggedItem[]; totalEvaluated: number; prefetchHealth: PrefetchResults; warnings: string[] }> {
	const { prisma, log } = deps;
	const now = new Date();
	const warnings: string[] = [];

	// Load all user instances to map instanceId → service type
	const instances = await prisma.serviceInstance.findMany({
		where: { userId: config.userId },
		select: { id: true, service: true },
	});
	const instanceServiceMap = new Map(instances.map((i) => [i.id, i.service]));

	// Collect all active rule types (including inside composite conditions)
	const activeTypes = collectActiveRuleTypes(rules);

	// Prefetch Seerr requests if any Seerr rule types are active
	const SEERR_RULE_TYPES = [
		"seerr_requested_by",
		"seerr_request_age",
		"seerr_request_status",
		"seerr_is_4k",
		"seerr_request_modified_age",
		"seerr_modified_by",
		"seerr_is_requested",
		"seerr_request_count",
	];
	const hasSeerrRules = SEERR_RULE_TYPES.some((t) => activeTypes.has(t));
	const seerrResult = hasSeerrRules ? await prefetchSeerrRequests(deps, config.userId) : undefined;
	const seerrMap = hasSeerrRules ? seerrResult : undefined;

	// Prefetch Tautulli watch data if any Tautulli rule types are active
	const TAUTULLI_RULE_TYPES = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
		"user_retention", // Can use tautulli as source
	];
	const hasTautulliRules = TAUTULLI_RULE_TYPES.some((t) => activeTypes.has(t));
	const tautulliResult = hasTautulliRules ? await prefetchTautulliData(deps, config.userId) : undefined;
	const tautulliMap = hasTautulliRules ? tautulliResult : undefined;

	// Prefetch Plex watch data if any Plex rule types are active
	const PLEX_RULE_TYPES = [
		"plex_last_watched",
		"plex_watch_count",
		"plex_on_deck",
		"plex_user_rating",
		"plex_watched_by",
		"plex_collection",
		"plex_label",
		"plex_added_at",
		"plex_episode_completion",
		"user_retention",
		"staleness_score",
		"recently_active",
	];
	const hasPlexRules = PLEX_RULE_TYPES.some((t) => activeTypes.has(t));
	const plexResult = hasPlexRules ? await prefetchPlexData(deps, config.userId) : undefined;
	const plexMap = hasPlexRules ? plexResult : undefined;

	// Prefetch Plex episode data if episode completion rule is active
	const hasEpisodeRules = activeTypes.has("plex_episode_completion");
	const plexEpisodeMap = hasEpisodeRules ? await prefetchPlexEpisodeData(deps, config.userId) : undefined;

	// Build prefetch health status
	const prefetchHealth: PrefetchResults = {
		seerr: hasSeerrRules ? (seerrMap ? "ok" : "failed") : "skipped",
		tautulli: hasTautulliRules ? (tautulliMap ? "ok" : "failed") : "skipped",
		plex: hasPlexRules ? (plexMap ? "ok" : "failed") : "skipped",
	};

	// Check for failed prefetches that have dependent rules — generate warnings
	const failedSources = new Set<DataSourceDependency>();
	if (prefetchHealth.seerr === "failed") failedSources.add("seerr");
	if (prefetchHealth.tautulli === "failed") failedSources.add("tautulli");
	if (prefetchHealth.plex === "failed") failedSources.add("plex");

	if (failedSources.size > 0) {
		for (const source of failedSources) {
			const affectedRules = rules
				.filter((r) => r.enabled && getRuleDataSources(r).has(source!))
				.map((r) => r.name);
			if (affectedRules.length > 0) {
				warnings.push(
					`${source} data unavailable — rules affected: ${affectedRules.join(", ")}. ` +
					`These rules were skipped for safety to prevent false matches.`,
				);
			}
		}
		log.warn({ prefetchHealth, warnings }, "Cleanup run has failed prefetches with dependent rules");
	}

	// Build evaluation context
	const ctx: EvalContext = { now, seerrMap, tautulliMap, plexMap, plexEpisodeMap };

	const flagged: FlaggedItem[] = [];
	let totalEvaluated = 0;
	let cursor: string | undefined;

	// Paginate through LibraryCache with cursor-based pagination
	while (true) {
		const batch: CacheItemForEval[] = await prisma.libraryCache.findMany({
			where: {
				instanceId: { in: instances.map((i) => i.id) },
			},
			select: {
				id: true,
				instanceId: true,
				arrItemId: true,
				itemType: true,
				title: true,
				year: true,
				monitored: true,
				hasFile: true,
				status: true,
				qualityProfileId: true,
				qualityProfileName: true,
				sizeOnDisk: true,
				arrAddedAt: true,
				data: true,
			},
			take: CACHE_QUERY_BATCH_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});

		if (batch.length === 0) break;

		for (const item of batch) {
			totalEvaluated++;
			const instanceService = instanceServiceMap.get(item.instanceId);
			if (!instanceService) continue; // Skip orphaned cache items with no matching instance

			const match = evaluateItemAgainstRules(item, rules, instanceService, ctx, failedSources);
			if (match) {
				flagged.push({
					cacheItem: item,
					match,
					rating: extractRating(item),
				});
			}
		}

		cursor = batch[batch.length - 1]!.id;
		if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
	}

	return { flagged, totalEvaluated, prefetchHealth, warnings };
}

/**
 * Get all data sources a rule depends on (including composite sub-conditions).
 */
function getRuleDataSources(rule: LibraryCleanupRule): Set<DataSourceDependency> {
	const sources = new Set<DataSourceDependency>();
	const dep = ruleDataSourceMap[rule.ruleType];
	if (dep) sources.add(dep);
	if (rule.conditions) {
		const conds = safeJsonParse(rule.conditions) as Array<{ ruleType?: string }> | null;
		if (Array.isArray(conds)) {
			for (const c of conds) {
				const cdep = c.ruleType ? ruleDataSourceMap[c.ruleType] : undefined;
				if (cdep) sources.add(cdep);
			}
		}
	}
	return sources;
}

/**
 * Create approval queue entries for flagged items.
 * Stores the action from each rule match on the approval record.
 */
async function executeWithApproval(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	flagged: FlaggedItem[],
	totalEvaluated: number,
	totalFlaggedBeforeLimit: number,
	startTime: number,
	prefetchHealth?: PrefetchResults,
	warnings?: string[],
): Promise<CleanupRunResult> {
	const { prisma, log } = deps;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

	const details: CleanupRunResult["details"] = [];
	let queued = 0;

	for (const item of flagged) {
		try {
			// Skip if already pending approval for this item
			const existing = await prisma.libraryCleanupApproval.findFirst({
				where: {
					configId: config.id,
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					status: "pending",
				},
			});

			if (existing) {
				details.push(buildDetail(item, "skipped"));
				continue;
			}

			await prisma.libraryCleanupApproval.create({
				data: {
					configId: config.id,
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					title: item.cacheItem.title,
					matchedRuleId: item.match.ruleId,
					matchedRuleName: item.match.ruleName,
					reason: item.match.reason,
					action: item.match.action,
					sizeOnDisk: item.cacheItem.sizeOnDisk,
					year: item.cacheItem.year,
					rating: item.rating,
					status: "pending",
					expiresAt,
				},
			});

			details.push(buildDetail(item, "queued_for_approval"));
			queued++;
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title },
				"Failed to create cleanup approval entry",
			);
			details.push(buildDetail(item, "skipped", `Failed to queue: ${getErrorMessage(error)}`));
		}
	}

	const hasFailedPrefetch = warnings && warnings.length > 0;
	const result: CleanupRunResult = {
		isDryRun: false,
		status: hasFailedPrefetch ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: queued,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: totalFlaggedBeforeLimit - flagged.length,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings,
	};

	await createRunLog(prisma, config.id, result, log);
	return result;
}

/**
 * Directly execute flagged items on ARR instances.
 * Dispatches on each item's action (delete, unmonitor, delete_files).
 */
async function executeDirectRemoval(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	totalEvaluated: number,
	totalFlaggedBeforeLimit: number,
	startTime: number,
	prefetchHealth?: PrefetchResults,
	warnings?: string[],
): Promise<CleanupRunResult> {
	const { prisma, arrClientFactory, log } = deps;

	// Load instances for deletion
	const instanceIds = [...new Set(flagged.map((f) => f.cacheItem.instanceId))];
	const instances = await prisma.serviceInstance.findMany({
		where: { id: { in: instanceIds }, userId },
	});
	const instanceMap = new Map(instances.map((i) => [i.id, i]));

	const details: CleanupRunResult["details"] = [];
	let removed = 0;
	let unmonitored = 0;
	let filesDeleted = 0;
	let consecutiveFailures = 0;
	let circuitBroken = false;

	for (const item of flagged) {
		// Circuit breaker: abort after N consecutive failures
		if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
			circuitBroken = true;
			log.error(
				{ consecutiveFailures, remainingItems: flagged.length - details.length },
				"Circuit breaker triggered: aborting cleanup after consecutive ARR API failures",
			);
			// Skip remaining items
			details.push(buildDetail(item, "skipped", `Skipped: circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`));
			continue;
		}

		const instance = instanceMap.get(item.cacheItem.instanceId);
		if (!instance) {
			details.push(buildDetail(item, "skipped"));
			continue;
		}

		const ruleAction = item.match.action ?? "delete";

		try {
			if (ruleAction === "unmonitor") {
				await unmonitorInArr(arrClientFactory, instance, item.cacheItem.arrItemId);
				await prisma.libraryCache.updateMany({
					where: {
						instanceId: item.cacheItem.instanceId,
						arrItemId: item.cacheItem.arrItemId,
						itemType: item.cacheItem.itemType,
					},
					data: { monitored: false },
				});
				details.push(buildDetail(item, "unmonitored"));
				unmonitored++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: unmonitored item in ARR instance",
				);
			} else if (ruleAction === "delete_files") {
				await deleteFilesFromArr(arrClientFactory, instance, item.cacheItem.arrItemId);
				await prisma.libraryCache.updateMany({
					where: {
						instanceId: item.cacheItem.instanceId,
						arrItemId: item.cacheItem.arrItemId,
						itemType: item.cacheItem.itemType,
					},
					data: { hasFile: false, sizeOnDisk: 0 },
				});
				details.push(buildDetail(item, "files_deleted"));
				filesDeleted++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: deleted files for item in ARR instance",
				);
			} else {
				// Default: delete
				await deleteFromArr(arrClientFactory, instance, item.cacheItem.arrItemId);
				await prisma.libraryCache.deleteMany({
					where: {
						instanceId: item.cacheItem.instanceId,
						arrItemId: item.cacheItem.arrItemId,
						itemType: item.cacheItem.itemType,
					},
				});
				details.push(buildDetail(item, "removed"));
				removed++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
		} catch (error) {
			consecutiveFailures++;
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: instance.id, consecutiveFailures },
				"Cleanup: failed to execute action on item",
			);
			details.push(buildDetail(item, "skipped", `Action failed: ${getErrorMessage(error)}`));
		}
	}

	const hasFailedPrefetch = warnings && warnings.length > 0;
	const allWarnings = [...(warnings ?? [])];
	if (circuitBroken) {
		allWarnings.push(
			`Circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive ARR API failures. Remaining items were skipped.`,
		);
	}

	const result: CleanupRunResult = {
		isDryRun: false,
		status: circuitBroken || hasFailedPrefetch ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: removed,
		itemsUnmonitored: unmonitored,
		itemsFilesDeleted: filesDeleted,
		itemsSkipped: totalFlaggedBeforeLimit - flagged.length + (flagged.length - removed - unmonitored - filesDeleted),
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};

	await createRunLog(prisma, config.id, result, log);
	return result;
}

// ============================================================================
// ARR Action Functions
// ============================================================================

/**
 * Delete an item from an ARR instance via the SDK client.
 */
async function deleteFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			await radarr.movie.delete(arrItemId, { deleteFiles: true, addImportExclusion: false });
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			await sonarr.series.delete(arrItemId, { deleteFiles: true, addImportListExclusion: false });
			break;
		}
		default:
			throw new Error(`Unsupported service type for library cleanup: ${instance.service}`);
	}
}

/**
 * Unmonitor an item in an ARR instance without deleting it.
 * Sets monitored=false on the movie/series.
 */
async function unmonitorInArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			const movie = await radarr.movie.getById(arrItemId);
			await radarr.movie.update(arrItemId, { ...movie, id: arrItemId, monitored: false });
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			const series = await sonarr.series.getById(arrItemId);
			await sonarr.series.update(
				arrItemId,
				{ ...series, id: arrItemId, monitored: false } as Parameters<typeof sonarr.series.update>[1],
			);
			break;
		}
		default:
			throw new Error(`Unsupported service type for unmonitor: ${instance.service}`);
	}
}

/**
 * Delete files for an item in an ARR instance without removing the item itself.
 * For Radarr: deletes the movie file. For Sonarr: bulk-deletes all episode files.
 */
async function deleteFilesFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			const movie = await radarr.movie.getById(arrItemId);
			if (movie.movieFileId && movie.movieFileId > 0) {
				await radarr.movieFile.delete(movie.movieFileId);
			}
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			const episodeFiles = await sonarr.episodeFile.getBySeries(arrItemId);
			const fileIds = episodeFiles
				.map((f) => f.id)
				.filter((id): id is number => id != null && id > 0);
			if (fileIds.length > 0) {
				await sonarr.episodeFile.bulkDelete(fileIds);
			}
			break;
		}
		default:
			throw new Error(`Unsupported service type for delete_files: ${instance.service}`);
	}
}

/**
 * Build a fully-populated EvalContext by running all relevant prefetch functions.
 * Used by the explain endpoint so it can evaluate rules with real external data
 * rather than an empty context that always returns "not matched" for external rules.
 */
export async function buildEvalContext(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; ruleType: string; conditions: string | null }>,
): Promise<EvalContext> {
	const activeTypes = collectActiveRuleTypes(rules);

	const SEERR_RULE_TYPES = [
		"seerr_requested_by", "seerr_request_age", "seerr_request_status",
		"seerr_is_4k", "seerr_request_modified_age", "seerr_modified_by",
		"seerr_is_requested", "seerr_request_count",
	];
	const TAUTULLI_RULE_TYPES = ["tautulli_last_watched", "tautulli_watch_count", "tautulli_watched_by", "user_retention"];
	const PLEX_RULE_TYPES_LIST = [
		"plex_last_watched", "plex_watch_count", "plex_on_deck", "plex_user_rating",
		"plex_watched_by", "plex_collection", "plex_label", "plex_added_at",
		"plex_episode_completion", "user_retention", "staleness_score", "recently_active",
	];

	const [seerrMap, tautulliMap, plexMap, plexEpisodeMap] = await Promise.all([
		SEERR_RULE_TYPES.some((t) => activeTypes.has(t)) ? prefetchSeerrRequests(deps, userId) : undefined,
		TAUTULLI_RULE_TYPES.some((t) => activeTypes.has(t)) ? prefetchTautulliData(deps, userId) : undefined,
		PLEX_RULE_TYPES_LIST.some((t) => activeTypes.has(t)) ? prefetchPlexData(deps, userId) : undefined,
		activeTypes.has("plex_episode_completion") ? prefetchPlexEpisodeData(deps, userId) : undefined,
	]);

	return { now: new Date(), seerrMap: seerrMap ?? undefined, tautulliMap: tautulliMap ?? undefined, plexMap: plexMap ?? undefined, plexEpisodeMap: plexEpisodeMap ?? undefined };
}

/**
 * Create a cleanup run log entry.
 * Failures are logged but not rethrown — the run result is more important than its log.
 */
async function createRunLog(
	prisma: CleanupExecutorDeps["prisma"],
	configId: string,
	result: Omit<CleanupRunResult, "error"> & { error?: string },
	log?: CleanupExecutorDeps["log"],
): Promise<void> {
	try {
		await prisma.libraryCleanupLog.create({
			data: {
				configId,
				isDryRun: result.isDryRun,
				status: result.status,
				itemsEvaluated: result.itemsEvaluated,
				itemsFlagged: result.itemsFlagged,
				itemsRemoved: result.itemsRemoved,
				itemsUnmonitored: result.itemsUnmonitored,
				itemsFilesDeleted: result.itemsFilesDeleted,
				itemsSkipped: result.itemsSkipped,
				details: JSON.stringify(result.details),
				error: result.error,
				prefetchHealth: result.prefetchHealth ? JSON.stringify(result.prefetchHealth) : null,
				warnings: result.warnings?.length ? JSON.stringify(result.warnings) : null,
				durationMs: result.durationMs,
				startedAt: new Date(Date.now() - result.durationMs),
				completedAt: new Date(),
			},
		});
	} catch (error) {
		log?.warn({ err: error, configId }, "Failed to write cleanup run log — run result is still valid");
	}
}
