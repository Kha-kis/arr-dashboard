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

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { LibraryCleanupConfig, LibraryCleanupRule, ServiceInstance } from "../prisma.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { evaluateItemAgainstRules, extractRating } from "./rule-evaluators.js";
import type {
	CacheItemForEval,
	CleanupExecutorDeps,
	CleanupRunResult,
	DetailAction,
	EvalContext,
	FlaggedItem,
	PlexSectionWatchInfo,
	PlexWatchMap,
	SeerrRequestInfo,
	SeerrRequestMap,
	TautulliWatchMap,
} from "./types.js";

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;

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

	const { flagged, totalEvaluated } = await evaluateAllItems(deps, config, config.rules);

	const details = flagged.map((f) => ({
		instanceId: f.cacheItem.instanceId,
		arrItemId: f.cacheItem.arrItemId,
		title: f.cacheItem.title,
		rule: f.match.ruleName,
		reason: f.match.reason,
		action: f.match.action as DetailAction,
		sizeOnDisk: f.cacheItem.sizeOnDisk.toString(),
		year: f.cacheItem.year,
		rating: f.rating,
	}));

	log.info({ totalEvaluated, totalFlagged: flagged.length }, "Library cleanup preview completed");

	return {
		isDryRun: true,
		status: "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: 0,
		details,
		durationMs: Date.now() - startTime,
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
	const { prisma } = deps;

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

	const { flagged, totalEvaluated } = await evaluateAllItems(deps, config, config.rules);

	// Respect max removals per run
	const limited = flagged.slice(0, config.maxRemovalsPerRun);

	if (config.dryRunMode) {
		const details = limited.map((f) => ({
			instanceId: f.cacheItem.instanceId,
			arrItemId: f.cacheItem.arrItemId,
			title: f.cacheItem.title,
			rule: f.match.ruleName,
			reason: f.match.reason,
			action: "flagged" as const,
			sizeOnDisk: f.cacheItem.sizeOnDisk.toString(),
			year: f.cacheItem.year,
			rating: f.rating,
		}));

		const result: CleanupRunResult = {
			isDryRun: true,
			status: "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: limited.length,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: flagged.length - limited.length,
			details,
			durationMs: Date.now() - startTime,
		};

		await createRunLog(prisma, config.id, result);
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
				.catch(() => {});
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
function collectActiveRuleTypes(rules: LibraryCleanupRule[]): Set<string> {
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
 * Evaluate all LibraryCache items against the rule set.
 * Queries in batches to avoid memory issues with large libraries.
 * Uses collectActiveRuleTypes() to detect rule types inside composite conditions.
 */
async function evaluateAllItems(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig,
	rules: LibraryCleanupRule[],
): Promise<{ flagged: FlaggedItem[]; totalEvaluated: number }> {
	const { prisma } = deps;
	const now = new Date();

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
	const seerrMap = hasSeerrRules ? await prefetchSeerrRequests(deps, config.userId) : undefined;

	// Prefetch Tautulli watch data if any Tautulli rule types are active
	const TAUTULLI_RULE_TYPES = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
	];
	const hasTautulliRules = TAUTULLI_RULE_TYPES.some((t) => activeTypes.has(t));
	const tautulliMap = hasTautulliRules
		? await prefetchTautulliData(deps, config.userId)
		: undefined;

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
	];
	const hasPlexRules = PLEX_RULE_TYPES.some((t) => activeTypes.has(t));
	const plexMap = hasPlexRules
		? await prefetchPlexData(deps, config.userId)
		: undefined;

	// Build evaluation context
	const ctx: EvalContext = { now, seerrMap, tautulliMap, plexMap };

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

			const match = evaluateItemAgainstRules(item, rules, instanceService, ctx);
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

	return { flagged, totalEvaluated };
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
				details.push({
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					title: item.cacheItem.title,
					rule: item.match.ruleName,
					reason: item.match.reason,
					action: "skipped",
				});
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

			details.push({
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				title: item.cacheItem.title,
				rule: item.match.ruleName,
				reason: item.match.reason,
				action: "queued_for_approval",
			});
			queued++;
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title },
				"Failed to create cleanup approval entry",
			);
			details.push({
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				title: item.cacheItem.title,
				rule: item.match.ruleName,
				reason: `Failed to queue: ${getErrorMessage(error)}`,
				action: "skipped",
			});
		}
	}

	const result: CleanupRunResult = {
		isDryRun: false,
		status: "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: queued,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: totalFlaggedBeforeLimit - flagged.length,
		details,
		durationMs: Date.now() - startTime,
	};

	await createRunLog(prisma, config.id, result);
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

	for (const item of flagged) {
		const instance = instanceMap.get(item.cacheItem.instanceId);
		if (!instance) {
			details.push({
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				title: item.cacheItem.title,
				rule: item.match.ruleName,
				reason: item.match.reason,
				action: "skipped",
			});
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
				details.push({
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					title: item.cacheItem.title,
					rule: item.match.ruleName,
					reason: item.match.reason,
					action: "unmonitored",
				});
				unmonitored++;
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
				details.push({
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					title: item.cacheItem.title,
					rule: item.match.ruleName,
					reason: item.match.reason,
					action: "files_deleted",
				});
				filesDeleted++;
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
				details.push({
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					title: item.cacheItem.title,
					rule: item.match.ruleName,
					reason: item.match.reason,
					action: "removed",
				});
				removed++;
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: instance.id },
				"Cleanup: failed to execute action on item",
			);
			details.push({
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				title: item.cacheItem.title,
				rule: item.match.ruleName,
				reason: `Action failed: ${getErrorMessage(error)}`,
				action: "skipped",
			});
		}
	}

	const result: CleanupRunResult = {
		isDryRun: false,
		status: "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: removed,
		itemsUnmonitored: unmonitored,
		itemsFilesDeleted: filesDeleted,
		itemsSkipped: totalFlaggedBeforeLimit - flagged.length + (flagged.length - removed - unmonitored - filesDeleted),
		details,
		durationMs: Date.now() - startTime,
	};

	await createRunLog(prisma, config.id, result);
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
 * Create a cleanup run log entry.
 */
async function createRunLog(
	prisma: CleanupExecutorDeps["prisma"],
	configId: string,
	result: Omit<CleanupRunResult, "error"> & { error?: string },
): Promise<void> {
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
			durationMs: result.durationMs,
			startedAt: new Date(Date.now() - result.durationMs),
			completedAt: new Date(),
		},
	});
}
