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

import { type DataSourceDependency, ruleDataSourceMap } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { Prisma } from "../../generated/prisma/client.js";
import { isNotFoundError } from "../arr/client-factory.js";
import type { LibraryCleanupConfig, LibraryCleanupRule, ServiceInstance } from "../prisma.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { applyQuiSeedingFilter } from "./qui-filter.js";
import { evaluateItemAgainstRules, extractRating } from "./rule-evaluators.js";
import {
	ArrFileChangedDuringSafetyCheckError,
	assertVerifiedRadarrEmptyUnchanged,
	assertVerifiedRadarrFileUnchanged,
	assertVerifiedSonarrFilesUnchanged,
	buildRadarrCacheSafetyPlan,
	buildSonarrCacheSafetyPlan,
	type CleanupDeleteTarget,
	cleanupDeleteTargetKey,
	createSharedPlexSafetyContext,
	type ExecutableSharedMediaSafetyPlan,
	executableSafetyPlansEqual,
	findSharedPlexDeleteBlocks,
	parseExecutableSafetyPlan,
	RadarrFileChangedDuringSafetyCheckError,
	serializeExecutableSafetyPlan,
	type SharedMediaSafetyPlan,
	SonarrFilesChangedDuringSafetyCheckError,
	type VerifiedRadarrFileIdentity,
	type VerifiedSonarrFileIdentity,
} from "./shared-plex-safety.js";
import type {
	CacheItemForEval,
	CleanupExecutorDeps,
	CleanupRunResult,
	DetailAction,
	EvalContext,
	FlaggedItem,
	JellyfinWatchMap,
	PlexEpisodeMap,
	PlexSectionWatchInfo,
	PlexWatchMap,
	PrefetchResults,
	RuleAction,
	SeerrRequestInfo,
	SeerrRequestMap,
	TautulliWatchMap,
} from "./types.js";

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;

// The route returns at most 200 preview rows; avoid live safety I/O for rows
// the caller cannot inspect.
const PREVIEW_SAFETY_INSPECTION_LIMIT = 200;

// Circuit breaker: abort after N consecutive ARR API failures
const CIRCUIT_BREAKER_THRESHOLD = 3;

class ArrDeletePartialError extends Error {
	readonly service: "RADARR" | "SONARR";
	readonly deletedFileIds: number[];
	readonly hasRemainingFiles: boolean;
	readonly remainingSize: number;

	constructor(options: {
		cause: unknown;
		service: "RADARR" | "SONARR";
		deletedFileIds: number[];
		hasRemainingFiles?: boolean;
		remainingSize?: number;
		message?: string;
	}) {
		super(
			options.message ??
				`Partial cleanup: the verified ${options.service === "RADARR" ? "Radarr movie file" : "Sonarr episode files"} were deleted, but the ${options.service === "RADARR" ? "movie" : "series"} record could not be removed safely. No different file was deleted; review the ARR instance before retrying.`,
			options,
		);
		this.service = options.service;
		this.deletedFileIds = options.deletedFileIds;
		this.remainingSize = options.remainingSize ?? 0;
		this.hasRemainingFiles = options.hasRemainingFiles ?? this.remainingSize > 0;
	}
}

const SHARED_PLEX_WARNING =
	"Some deletions were safety-blocked because a connected media server could mutate a shared library and its live state was unsafe or could not be verified. Review each skipped-item reason before changing the ARR or media-server setup.";

// ============================================================================
// Detail Builder Helper
// ============================================================================

/** Build a detail entry for the cleanup run log. Ensures ruleId + itemType are always present. */
/**
 * Resolved rejection-memory window for a single rule (issue #474).
 * - `off`     → no memory, current pre-#474 behavior (rejected items re-proposed next run)
 * - `days`    → remember rejection for N days, then re-propose
 * - `forever` → remember indefinitely (never re-propose until manually cleared)
 */
export type RejectionMemoryWindow =
	| { mode: "off" }
	| { mode: "days"; days: number }
	| { mode: "forever" };

/**
 * Resolve the effective rejection-memory window for a rule, honoring per-rule
 * override when present. Semantics for the underlying days field:
 *   0    = off
 *   N>0  = remember for N days
 *   null = remember forever
 *
 * Per-rule override takes precedence over the config-level default when
 * `useGlobalRejectionMemory` is false.
 */
export function resolveRejectionMemoryWindow(
	rule: Pick<LibraryCleanupRule, "useGlobalRejectionMemory" | "rejectionMemoryDays">,
	config: Pick<LibraryCleanupConfig, "rejectionMemoryDays">,
): RejectionMemoryWindow {
	const effectiveDays = rule.useGlobalRejectionMemory
		? config.rejectionMemoryDays
		: rule.rejectionMemoryDays;
	if (effectiveDays === null) return { mode: "forever" };
	if (effectiveDays === 0) return { mode: "off" };
	return { mode: "days", days: effectiveDays };
}

/**
 * Build the Prisma `OR` clauses for the cleanup-approval dedup query
 * (issue #474). Always returns the `pending` skip; additionally appends a
 * `rejected`-skip clause when the memory window is non-off. Exported and
 * `now`-parameterised so unit tests can pin the cutoff math without
 * monkey-patching Date.now.
 */
export function buildDedupOrClauses(
	memWindow: RejectionMemoryWindow,
	now: Date = new Date(),
): Prisma.LibraryCleanupApprovalWhereInput[] {
	const clauses: Prisma.LibraryCleanupApprovalWhereInput[] = [{ status: "pending" }];
	if (memWindow.mode === "forever") {
		clauses.push({ status: "rejected" });
	} else if (memWindow.mode === "days") {
		const cutoff = new Date(now.getTime() - memWindow.days * 24 * 60 * 60 * 1000);
		clauses.push({ status: "rejected", reviewedAt: { gt: cutoff } });
	}
	return clauses;
}

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

function toDeleteTargets(items: FlaggedItem[]): CleanupDeleteTarget[] {
	return items.map((item) => ({
		instanceId: item.cacheItem.instanceId,
		arrItemId: item.cacheItem.arrItemId,
		itemType: item.cacheItem.itemType,
		action: item.match.action,
	}));
}

export function selectInspectableCleanupPreviewItems(flagged: FlaggedItem[]): FlaggedItem[] {
	return flagged.slice(0, PREVIEW_SAFETY_INSPECTION_LIMIT);
}

function asExecutableSafetyPlan(
	plan: SharedMediaSafetyPlan | undefined,
): ExecutableSharedMediaSafetyPlan | null {
	if (
		plan?.kind === "verified_radarr" ||
		plan?.kind === "verified_radarr_empty" ||
		plan?.kind === "verified_sonarr"
	) {
		return plan;
	}
	return null;
}

async function buildEvaluatedCacheSafetyPlan(
	prisma: CleanupExecutorDeps["prisma"],
	item: CacheItemForEval,
	livePlan: ExecutableSharedMediaSafetyPlan,
): Promise<ExecutableSharedMediaSafetyPlan | null> {
	const data = safeJsonParse(item.data);
	if (livePlan.kind === "verified_radarr" || livePlan.kind === "verified_radarr_empty") {
		return buildRadarrCacheSafetyPlan(data, item.hasFile);
	}
	const seriesPath =
		data && typeof data === "object" && "path" in data
			? (data as Record<string, unknown>).path
			: undefined;
	const episodeFiles = await prisma.episodeFileCache.findMany({
		where: { instanceId: item.instanceId, arrSeriesId: item.arrItemId },
		select: { arrEpisodeFileId: true, path: true, size: true },
	});
	return buildSonarrCacheSafetyPlan(seriesPath, item.hasFile, episodeFiles);
}

async function blockPlansThatDifferFromEvaluatedCache(
	deps: CleanupExecutorDeps,
	items: FlaggedItem[],
	context: ReturnType<typeof createSharedPlexSafetyContext>,
	blocks: Map<string, string>,
): Promise<void> {
	for (const item of items) {
		if (item.match.action === "unmonitor") continue;
		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		if (blocks.has(targetKey)) continue;
		const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
		if (!livePlan) continue;
		let cachePlan: ExecutableSharedMediaSafetyPlan | null = null;
		try {
			cachePlan = await buildEvaluatedCacheSafetyPlan(deps.prisma, item.cacheItem, livePlan);
		} catch (error) {
			deps.log.warn(
				{
					err: getErrorMessage(error),
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
				},
				"Cleanup could not load the cached file identity used for rule evaluation",
			);
		}
		if (cachePlan && executableSafetyPlansEqual(cachePlan, livePlan)) continue;

		const reason =
			"Skipped for safety: the live ARR file identity differs from the cached item evaluated by this cleanup rule. Sync the library and run cleanup again.";
		blocks.set(targetKey, reason);
		context.plans.set(targetKey, { kind: "blocked", reason });
	}
}

function withSharedPlexWarning(warnings: string[], blockCount: number): string[] {
	return blockCount > 0 && !warnings.includes(SHARED_PLEX_WARNING)
		? [...warnings, SHARED_PLEX_WARNING]
		: warnings;
}

export function buildCleanupPreviewDetails(
	flagged: FlaggedItem[],
	sharedPlexBlocks: Map<string, string>,
): CleanupRunResult["details"] {
	return flagged.map((item) => {
		const safetyReason = sharedPlexBlocks.get(cleanupDeleteTargetKey(item.cacheItem));
		return {
			instanceId: item.cacheItem.instanceId,
			arrItemId: item.cacheItem.arrItemId,
			title: item.cacheItem.title,
			ruleId: item.match.ruleId,
			rule: item.match.ruleName,
			reason: safetyReason ?? item.match.reason,
			action: safetyReason ? "skipped" : item.match.action,
			itemType: item.cacheItem.itemType,
			sizeOnDisk: item.cacheItem.sizeOnDisk.toString(),
			year: item.cacheItem.year,
			rating: item.rating,
		};
	});
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

	const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(
		deps,
		config,
		config.rules,
	);
	const inspected = selectInspectableCleanupPreviewItems(flagged);
	const safetyContext = createSharedPlexSafetyContext();
	const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
		deps,
		userId,
		toDeleteTargets(inspected),
		undefined,
		safetyContext,
	);
	await blockPlansThatDifferFromEvaluatedCache(deps, inspected, safetyContext, sharedPlexBlocks);
	const allWarnings = withSharedPlexWarning(warnings, sharedPlexBlocks.size);

	const details = buildCleanupPreviewDetails(inspected, sharedPlexBlocks);

	const hasWarnings = allWarnings.length > 0;
	log.info(
		{
			totalEvaluated,
			totalFlagged: flagged.length,
			sharedPlexBlocks: sharedPlexBlocks.size,
			hasWarnings,
		},
		"Library cleanup preview completed",
	);

	return {
		isDryRun: true,
		status: hasWarnings ? ("partial" as const) : ("completed" as const),
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: sharedPlexBlocks.size,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings,
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

	if (!config?.enabled || config.rules.length === 0) {
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

	const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(
		deps,
		config,
		config.rules,
	);

	// Respect max removals per run
	const limited = flagged.slice(0, config.maxRemovalsPerRun);

	if (config.dryRunMode) {
		const safetyContext = createSharedPlexSafetyContext();
		const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
			deps,
			userId,
			toDeleteTargets(limited),
			undefined,
			safetyContext,
		);
		await blockPlansThatDifferFromEvaluatedCache(deps, limited, safetyContext, sharedPlexBlocks);
		const allWarnings = withSharedPlexWarning(warnings, sharedPlexBlocks.size);
		const details = buildCleanupPreviewDetails(limited, sharedPlexBlocks);

		const result: CleanupRunResult = {
			isDryRun: true,
			status: allWarnings.length > 0 ? "partial" : "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: limited.length,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: flagged.length - limited.length + sharedPlexBlocks.size,
			details,
			durationMs: Date.now() - startTime,
			prefetchHealth,
			warnings: allWarnings,
		};

		await createRunLog(prisma, config.id, result, log);
		return result;
	}

	// Real execution
	if (config.requireApproval) {
		const safetyContext = createSharedPlexSafetyContext();
		const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
			deps,
			userId,
			toDeleteTargets(limited),
			undefined,
			safetyContext,
		);
		await blockPlansThatDifferFromEvaluatedCache(deps, limited, safetyContext, sharedPlexBlocks);
		const allWarnings = withSharedPlexWarning(warnings, sharedPlexBlocks.size);
		return await executeWithApproval(
			deps,
			config,
			limited,
			totalEvaluated,
			flagged.length,
			startTime,
			prefetchHealth,
			allWarnings,
			sharedPlexBlocks,
			safetyContext.plans,
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
	const claimedApprovalIds: string[] = [];
	const claimErrors: string[] = [];
	for (const approvalId of [...new Set(approvalIds)]) {
		try {
			const claim = await prisma.libraryCleanupApproval.updateMany({
				where: {
					id: approvalId,
					config: { userId },
					status: "approved",
					expiresAt: { gt: now },
				},
				data: { status: "executing" },
			});
			if (claim.count === 1) claimedApprovalIds.push(approvalId);
		} catch (error) {
			claimErrors.push("A cleanup approval could not be claimed and was not executed.");
			log.error({ err: error, approvalId }, "Failed to claim cleanup approval for execution");
		}
	}
	if (claimedApprovalIds.length === 0) {
		return { removed: 0, failed: claimErrors.length, errors: claimErrors };
	}

	const approvals = await prisma.libraryCleanupApproval.findMany({
		where: {
			id: { in: claimedApprovalIds },
			config: { userId },
			status: "executing",
		},
	});

	let removed = 0;
	let failed = claimErrors.length;
	const errors: string[] = [...claimErrors];
	const sharedPlexSafetyContext = createSharedPlexSafetyContext();

	for (const approval of approvals) {
		let instance: ServiceInstance | null = null;
		try {
			instance = await prisma.serviceInstance.findFirst({
				where: { id: approval.instanceId, userId },
			});
		} catch (error) {
			log.error(
				{ err: error, approvalId: approval.id },
				"Failed to load approval ARR instance; item was not executed",
			);
		}
		if (!instance) {
			errors.push("Cleanup item was not executed because its ARR instance could not be loaded.");
			failed++;
			await prisma.libraryCleanupApproval
				.update({
					where: { id: approval.id },
					data: {
						status: "pending",
						lastExecutionError:
							"Cleanup item was not executed because its ARR instance could not be loaded.",
					},
				})
				.catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return approval with missing instance to pending",
					);
				});
			continue;
		}

		let action: RuleAction;
		try {
			action = validateCleanupMutationShape(instance, approval.itemType, approval.action);
		} catch (error) {
			const executionError =
				"Cleanup item was not executed because its stored action or media type is invalid.";
			errors.push(executionError);
			failed++;
			log.error(
				{ err: error, approvalId: approval.id, instanceId: approval.instanceId },
				"Approved cleanup item has an invalid mutation shape",
			);
			await prisma.libraryCleanupApproval
				.update({
					where: { id: approval.id },
					data: { status: "pending", lastExecutionError: executionError },
				})
				.catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return invalid approval to pending",
					);
				});
			continue;
		}

		let sharedPlexBlock: string | undefined;
		let approvalIdentityChanged = false;
		let safetyPlan: SharedMediaSafetyPlan | undefined =
			action === "unmonitor" ? { kind: "not_required" } : undefined;
		try {
			const targetKey = cleanupDeleteTargetKey(approval);
			const blocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				[
					{
						instanceId: approval.instanceId,
						arrItemId: approval.arrItemId,
						itemType: approval.itemType,
						action,
					},
				],
				[instance],
				sharedPlexSafetyContext,
			);
			sharedPlexBlock = blocks.get(targetKey);
			safetyPlan = sharedPlexSafetyContext.plans.get(targetKey);
		} catch (error) {
			log.error(
				{ err: error, approvalId: approval.id },
				"Approved cleanup item safety preflight failed closed",
			);
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard could not complete the live ARR and media-server preflight.";
		}
		if (action !== "unmonitor" && !sharedPlexBlock && !safetyPlan) {
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard did not produce an explicit media-server deletion plan.";
		}
		if (action !== "unmonitor" && !sharedPlexBlock) {
			const approvedPlan = parseExecutableSafetyPlan(approval.safetySnapshot);
			const livePlan = asExecutableSafetyPlan(safetyPlan);
			if (!approvedPlan || !livePlan || !executableSafetyPlansEqual(approvedPlan, livePlan)) {
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the ARR file identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
			}
		}
		if (sharedPlexBlock) {
			errors.push(`Cleanup item was not executed: ${sharedPlexBlock}`);
			failed++;
			log.warn(
				{ title: approval.title, instanceId: approval.instanceId },
				"Approved cleanup item blocked by shared-media safety check",
			);
			await prisma.libraryCleanupApproval
				.update({
					where: { id: approval.id },
					data: {
						status: approvalIdentityChanged ? "expired" : "pending",
						...(approvalIdentityChanged ? { reviewedAt: new Date() } : {}),
						lastExecutionError: sharedPlexBlock,
					},
				})
				.catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id, title: approval.title },
						"Failed to revert safety-blocked approval status",
					);
				});
			continue;
		}

		let arrMutationSucceeded = false;
		try {
			if (action === "unmonitor") {
				await unmonitorInArr(arrClientFactory, instance, approval.arrItemId);
				arrMutationSucceeded = true;
				await prisma.libraryCache
					.updateMany({
						where: {
							instanceId: approval.instanceId,
							arrItemId: approval.arrItemId,
							itemType: approval.itemType,
						},
						data: { monitored: false },
					})
					.catch((cacheErr) => {
						log.error(
							{ err: cacheErr, approvalId: approval.id },
							"Approved cleanup action succeeded but its cache update failed",
						);
					});
			} else if (action === "delete_files") {
				await deleteFilesFromArr(arrClientFactory, instance, approval.arrItemId, safetyPlan!);
				arrMutationSucceeded = true;
				await reconcileSonarrEpisodeFileCache(prisma, instance, approval.arrItemId, log);
				await prisma.libraryCache
					.updateMany({
						where: {
							instanceId: approval.instanceId,
							arrItemId: approval.arrItemId,
							itemType: approval.itemType,
						},
						data: { hasFile: false, sizeOnDisk: 0 },
					})
					.catch((cacheErr) => {
						log.error(
							{ err: cacheErr, approvalId: approval.id },
							"Approved cleanup action succeeded but its cache update failed",
						);
					});
			} else {
				await deleteFromArr(arrClientFactory, instance, approval.arrItemId, safetyPlan!);
				arrMutationSucceeded = true;
				await reconcileSonarrEpisodeFileCache(prisma, instance, approval.arrItemId, log);
				await prisma.libraryCache
					.deleteMany({
						where: {
							instanceId: approval.instanceId,
							arrItemId: approval.arrItemId,
							itemType: approval.itemType,
						},
					})
					.catch((cacheErr) => {
						log.error(
							{ err: cacheErr, approvalId: approval.id },
							"Approved cleanup action succeeded but its cache update failed",
						);
					});
			}

			await prisma.libraryCleanupApproval.update({
				where: { id: approval.id },
				data: { status: "executed", executedAt: new Date(), lastExecutionError: null },
			});

			removed++;
			log.info(
				{ title: approval.title, instanceId: approval.instanceId, action },
				"Approved cleanup item executed",
			);
		} catch (error) {
			if (arrMutationSucceeded) {
				const recordingError =
					"Cleanup action completed, but arr-dashboard could not record the executed approval state.";
				try {
					await prisma.libraryCleanupApproval.update({
						where: { id: approval.id },
						data: { status: "executed", executedAt: new Date(), lastExecutionError: null },
					});
					removed++;
				} catch (retryError) {
					removed++;
					failed++;
					errors.push(recordingError);
					log.error(
						{ err: retryError, approvalId: approval.id, instanceId: approval.instanceId },
						"Approved cleanup action completed but its executed status could not be recorded",
					);
				}
				continue;
			}
			const executionError =
				error instanceof ArrFileChangedDuringSafetyCheckError ||
				error instanceof ArrDeletePartialError
					? error.message
					: "Cleanup item could not be executed. Review the API logs for details.";
			errors.push(executionError);
			failed++;
			if (error instanceof ArrDeletePartialError) {
				await reconcilePartialFileDeletion(
					prisma,
					instance,
					approval.arrItemId,
					approval.itemType,
					error,
					log,
				);
				await prisma.libraryCache
					.updateMany({
						where: {
							instanceId: approval.instanceId,
							arrItemId: approval.arrItemId,
							itemType: approval.itemType,
						},
						data: {
							hasFile: error.hasRemainingFiles,
							sizeOnDisk: error.remainingSize,
						},
					})
					.catch((cacheErr) => {
						log.error(
							{ err: cacheErr, approvalId: approval.id },
							"Cleanup partial ARR delete could not update the cache",
						);
					});
			}
			log.error(
				{ err: error, title: approval.title, instanceId: approval.instanceId },
				"Failed to execute approved cleanup item",
			);
			// Return to the actionable queue so the item can be retried.
			await prisma.libraryCleanupApproval
				.update({
					where: { id: approval.id },
					data: {
						status: "pending",
						lastExecutionError: executionError,
					},
				})
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
function collectActiveRuleTypes(
	rules: Pick<LibraryCleanupRule, "enabled" | "ruleType" | "conditions">[],
): Set<string> {
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
			encryptedHttpAuthCredentials: true,
			httpAuthEncryptionIv: true,
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
		const map: TautulliWatchMap = new Map();
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate to bound peak heap.
		while (true) {
			const batch = await prisma.tautulliCache.findMany({
				where: { instanceId: tautulliInstance.id },
				select: {
					id: true,
					tmdbId: true,
					mediaType: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
				},
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const key = `${row.mediaType}:${row.tmdbId}`;
					const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];
					map.set(key, {
						lastWatchedAt: row.lastWatchedAt,
						watchCount: row.watchCount,
						watchedByUsers,
					});
				} catch (rowErr) {
					log.warn(
						{ err: rowErr, tmdbId: row.tmdbId },
						"Skipping Tautulli cache row with bad data",
					);
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}

		log.info(
			{ totalRows, totalEntries: map.size },
			"Tautulli watch data prefetch complete for cleanup",
		);
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
export async function prefetchPlexData(
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
		const map: PlexWatchMap = new Map();
		const instanceIds = plexInstances.map((i) => i.id);
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate to bound peak heap. Project only columns the watch-map
		// builder reads — skipping ratingKey/thumb/title and the per-row instanceId.
		while (true) {
			const batch = await prisma.plexCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: {
					id: true,
					tmdbId: true,
					mediaType: true,
					sectionId: true,
					sectionTitle: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					collections: true,
					labels: true,
					addedAt: true,
				},
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
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
						if (
							row.lastWatchedAt &&
							(!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)
						) {
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
							existing.userRating =
								existing.userRating != null
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
				} catch (rowErr) {
					log.warn({ err: rowErr, tmdbId: row.tmdbId }, "Skipping Plex cache row with bad data");
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}

		log.info(
			{ totalRows, totalEntries: map.size },
			"Plex watch data prefetch complete for cleanup",
		);
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
 * Prefetch Jellyfin watch data from JellyfinCache.
 * Mirrors prefetchPlexData but simpler — no sections/labels.
 */
async function prefetchJellyfinData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<JellyfinWatchMap | undefined> {
	const { prisma, log } = deps;

	const jellyfinInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
		select: { id: true },
	});

	if (jellyfinInstances.length === 0) return undefined;

	try {
		const map: JellyfinWatchMap = new Map();
		const instanceIds = jellyfinInstances.map((i) => i.id);
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate. Project only columns the watch-map reader uses.
		while (true) {
			const batch = await prisma.jellyfinCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: {
					id: true,
					tmdbId: true,
					mediaType: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					addedAt: true,
				},
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const key = `${row.mediaType}:${row.tmdbId}`;
					const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];

					const existing = map.get(key);
					if (existing) {
						if (
							row.lastWatchedAt &&
							(!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)
						) {
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
							existing.userRating =
								existing.userRating != null
									? Math.max(existing.userRating, row.userRating)
									: row.userRating;
						}
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
							addedAt: row.addedAt,
						});
					}
				} catch (rowErr) {
					log.warn(
						{ err: rowErr, tmdbId: row.tmdbId },
						"Skipping Jellyfin cache row with bad data",
					);
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}

		log.info(
			{ totalRows, totalEntries: map.size },
			"Jellyfin watch data prefetch complete for cleanup",
		);
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin data for cleanup — Jellyfin rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Jellyfin episode completion data.
 * Mirrors Plex pattern using JellyfinEpisodeCache with GROUP BY.
 */
async function prefetchJellyfinEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true },
		});
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return new Map();

		const totalCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const watchedCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		const seasonTotals = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const seasonWatched = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		const seasonWatchedMap = new Map(
			seasonWatched.map((g) => [`${g.showTmdbId}:${g.seasonNumber}`, g._count.id]),
		);

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

		log.info({ totalShows: map.size }, "Jellyfin episode data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin episode data for cleanup — episode completion rules will be skipped",
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
): Promise<{
	flagged: FlaggedItem[];
	totalEvaluated: number;
	prefetchHealth: PrefetchResults;
	warnings: string[];
}> {
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
		"seerr_requester_watched",
		"seerr_requester_not_watched",
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
	const tautulliResult = hasTautulliRules
		? await prefetchTautulliData(deps, config.userId)
		: undefined;
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
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];
	const hasPlexRules = PLEX_RULE_TYPES.some((t) => activeTypes.has(t));
	const plexResult = hasPlexRules ? await prefetchPlexData(deps, config.userId) : undefined;
	const plexMap = hasPlexRules ? plexResult : undefined;

	// Prefetch Jellyfin watch data if any Jellyfin rule types are active
	const JELLYFIN_RULE_TYPES = [
		"jellyfin_last_watched",
		"jellyfin_watch_count",
		"jellyfin_on_deck",
		"jellyfin_user_rating",
		"jellyfin_watched_by",
		"jellyfin_added_at",
	];
	const hasJellyfinRules = JELLYFIN_RULE_TYPES.some((t) => activeTypes.has(t));
	const jellyfinResult = hasJellyfinRules
		? await prefetchJellyfinData(deps, config.userId)
		: undefined;
	const jellyfinMap = hasJellyfinRules ? jellyfinResult : undefined;

	// Prefetch Plex episode data if episode completion rule is active
	const hasEpisodeRules = activeTypes.has("plex_episode_completion");
	const plexEpisodeMap = hasEpisodeRules
		? await prefetchPlexEpisodeData(deps, config.userId)
		: undefined;

	const hasJellyfinEpisodeRules = activeTypes.has("jellyfin_episode_completion");
	const jellyfinEpisodeMap = hasJellyfinEpisodeRules
		? await prefetchJellyfinEpisodeData(deps, config.userId)
		: undefined;

	// Build prefetch health status
	const prefetchHealth: PrefetchResults = {
		seerr: hasSeerrRules ? (seerrMap ? "ok" : "failed") : "skipped",
		tautulli: hasTautulliRules ? (tautulliMap ? "ok" : "failed") : "skipped",
		plex: hasPlexRules ? (plexMap ? "ok" : "failed") : "skipped",
		jellyfin: hasJellyfinRules ? (jellyfinMap ? "ok" : "failed") : "skipped",
	};

	// Check for failed prefetches that have dependent rules — generate warnings
	const failedSources = new Set<DataSourceDependency>();
	if (prefetchHealth.seerr === "failed") failedSources.add("seerr");
	if (prefetchHealth.tautulli === "failed") failedSources.add("tautulli");
	if (prefetchHealth.plex === "failed") failedSources.add("plex");
	if (prefetchHealth.jellyfin === "failed") failedSources.add("jellyfin");

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
		log.warn(
			{ prefetchHealth, warnings },
			"Cleanup run has failed prefetches with dependent rules",
		);
	}

	// Build evaluation context
	const ctx: EvalContext = {
		now,
		seerrMap,
		tautulliMap,
		plexMap,
		plexEpisodeMap,
		jellyfinMap,
		jellyfinEpisodeMap,
	};

	const flagged: FlaggedItem[] = [];
	let totalEvaluated = 0;
	let cursor: string | undefined;

	// Phase 2.2: optionally exclude items qui has confirmed are seeding,
	// to honor seeding obligations (private trackers, ratio targets). The
	// actual filter lives in `qui-filter.ts` — sibling pattern to
	// `lib/queue-cleaner/qui-gate.ts`. Keeping the filter in its own file
	// gives it a testable seam (see `__tests__/qui-filter.test.ts`) and
	// keeps cross-feature qui deps next to their consumer rather than
	// pulled into `lib/qui/` (which stays focused on the qui client).
	const baseWhere = applyQuiSeedingFilter(
		{ instanceId: { in: instances.map((i) => i.id) } },
		Boolean(config.respectQuiSeeding),
	);

	// Paginate through LibraryCache with cursor-based pagination
	while (true) {
		const batch: CacheItemForEval[] = await prisma.libraryCache.findMany({
			where: baseWhere,
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
	sharedPlexBlocks: Map<string, string> = new Map(),
	safetyPlans: Map<string, SharedMediaSafetyPlan> = new Map(),
): Promise<CleanupRunResult> {
	const { prisma, log } = deps;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

	const details: CleanupRunResult["details"] = [];
	let queued = 0;

	// Precompute rejection-memory window per rule once. The window is the same
	// for every flagged item that matched the same rule, so resolving once
	// avoids O(rules × items) lookups inside the queue loop (issue #474).
	const memoryByRuleId = new Map<string, RejectionMemoryWindow>();
	for (const rule of config.rules) {
		memoryByRuleId.set(rule.id, resolveRejectionMemoryWindow(rule, config));
	}

	for (const item of flagged) {
		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		const sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		if (sharedPlexBlock) {
			details.push(buildDetail(item, "skipped", sharedPlexBlock));
			log.warn(
				{ title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup approval item blocked by shared-media safety check",
			);
			continue;
		}

		try {
			const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };

			// Dedup query: always skip pending approvals; additionally skip
			// rejected approvals when the rule's memory window says so (#474).
			const orClauses = buildDedupOrClauses(memWindow);

			const existing = await prisma.libraryCleanupApproval.findFirst({
				where: {
					configId: config.id,
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					OR: orClauses,
				},
			});

			if (existing) {
				const skipReason =
					existing.status === "rejected"
						? memWindow.mode === "forever"
							? "Previously rejected — rejection memory: forever"
							: memWindow.mode === "days"
								? `Previously rejected — rejection memory: ${memWindow.days} day${memWindow.days === 1 ? "" : "s"}`
								: undefined
						: undefined;
				details.push(buildDetail(item, "skipped", skipReason));
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
					safetySnapshot:
						item.match.action === "unmonitor"
							? null
							: serializeExecutableSafetyPlan(
									asExecutableSafetyPlan(safetyPlans.get(targetKey)) ??
										(() => {
											throw new Error("No executable cleanup safety plan was produced");
										})(),
								),
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
		itemsSkipped: totalFlaggedBeforeLimit - flagged.length + sharedPlexBlocks.size,
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
export async function executeDirectRemoval(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	totalEvaluated: number,
	totalFlaggedBeforeLimit: number,
	startTime: number,
	prefetchHealth?: PrefetchResults,
	warnings?: string[],
	sharedPlexBlocks: Map<string, string> = new Map(),
): Promise<CleanupRunResult> {
	const { prisma, arrClientFactory, log } = deps;

	const details: CleanupRunResult["details"] = [];
	let removed = 0;
	let unmonitored = 0;
	let filesDeleted = 0;
	let consecutiveFailures = 0;
	let circuitBroken = false;
	let runtimeSafetyBlocks = 0;
	let partialArrDeletes = 0;
	let instanceLookupFailures = 0;
	let invalidMutationTargets = 0;
	const sharedPlexSafetyContext = createSharedPlexSafetyContext();

	for (const item of flagged) {
		// Circuit breaker: abort after N consecutive failures
		if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
			circuitBroken = true;
			log.error(
				{ consecutiveFailures, remainingItems: flagged.length - details.length },
				"Circuit breaker triggered: aborting cleanup after consecutive ARR API failures",
			);
			// Skip remaining items
			details.push(
				buildDetail(
					item,
					"skipped",
					`Skipped: circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
				),
			);
			continue;
		}

		let instance: ServiceInstance | null = null;
		try {
			instance = await prisma.serviceInstance.findFirst({
				where: { id: item.cacheItem.instanceId, userId },
			});
		} catch (error) {
			log.error(
				{ err: error, instanceId: item.cacheItem.instanceId },
				"Cleanup could not load ARR instance; item was skipped",
			);
		}
		if (!instance) {
			instanceLookupFailures++;
			details.push(
				buildDetail(item, "skipped", "Skipped: the ARR instance could not be loaded safely"),
			);
			continue;
		}

		let ruleAction: RuleAction;
		try {
			ruleAction = validateCleanupMutationShape(
				instance,
				item.cacheItem.itemType,
				item.match.action,
			);
		} catch (error) {
			invalidMutationTargets++;
			log.error(
				{ err: error, instanceId: instance.id, arrItemId: item.cacheItem.arrItemId },
				"Cleanup item has an invalid mutation shape; item was skipped",
			);
			details.push(
				buildDetail(item, "skipped", "Skipped: stored cleanup action or media type is invalid"),
			);
			continue;
		}

		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		let sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		let safetyPlan: SharedMediaSafetyPlan | undefined =
			ruleAction === "unmonitor" ? { kind: "not_required" } : undefined;
		try {
			const freshBlocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				[
					{
						instanceId: item.cacheItem.instanceId,
						arrItemId: item.cacheItem.arrItemId,
						itemType: item.cacheItem.itemType,
						action: ruleAction,
					},
				],
				[instance],
				sharedPlexSafetyContext,
			);
			await blockPlansThatDifferFromEvaluatedCache(
				deps,
				[item],
				sharedPlexSafetyContext,
				freshBlocks,
			);
			sharedPlexBlock = freshBlocks.get(targetKey);
			safetyPlan = sharedPlexSafetyContext.plans.get(targetKey);
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup deletion safety preflight failed closed",
			);
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard could not complete the live ARR and media-server preflight.";
		}
		if (ruleAction !== "unmonitor" && !sharedPlexBlock && !safetyPlan) {
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard did not produce an explicit media-server deletion plan.";
		}
		if (sharedPlexBlock) {
			runtimeSafetyBlocks++;
			details.push(buildDetail(item, "skipped", sharedPlexBlock));
			log.warn(
				{ title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup deletion blocked by shared-media safety check",
			);
			continue;
		}

		try {
			if (ruleAction === "unmonitor") {
				await unmonitorInArr(arrClientFactory, instance, item.cacheItem.arrItemId);
				try {
					await prisma.libraryCache.updateMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
						data: { monitored: false },
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR action succeeded but cache update failed — cache is now stale",
					);
				}
				details.push(buildDetail(item, "unmonitored"));
				unmonitored++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: unmonitored item in ARR instance",
				);
			} else if (ruleAction === "delete_files") {
				await deleteFilesFromArr(arrClientFactory, instance, item.cacheItem.arrItemId, safetyPlan!);
				await reconcileSonarrEpisodeFileCache(prisma, instance, item.cacheItem.arrItemId, log);
				try {
					await prisma.libraryCache.updateMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
						data: { hasFile: false, sizeOnDisk: 0 },
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR action succeeded but cache update failed — cache is now stale",
					);
				}
				details.push(buildDetail(item, "files_deleted"));
				filesDeleted++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: deleted files for item in ARR instance",
				);
			} else {
				// Default: delete
				await deleteFromArr(arrClientFactory, instance, item.cacheItem.arrItemId, safetyPlan!);
				await reconcileSonarrEpisodeFileCache(prisma, instance, item.cacheItem.arrItemId, log);
				try {
					await prisma.libraryCache.deleteMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR delete succeeded but cache cleanup failed — cache is now stale",
					);
				}
				details.push(buildDetail(item, "removed"));
				removed++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
		} catch (error) {
			if (error instanceof ArrDeletePartialError) {
				partialArrDeletes++;
				const deletedAnyVerifiedFiles = error.deletedFileIds.length > 0;
				if (deletedAnyVerifiedFiles) filesDeleted++;
				await reconcilePartialFileDeletion(
					prisma,
					instance,
					item.cacheItem.arrItemId,
					item.cacheItem.itemType,
					error,
					log,
				);
				await prisma.libraryCache
					.updateMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
						data: {
							hasFile: error.hasRemainingFiles,
							sizeOnDisk: error.remainingSize,
						},
					})
					.catch((cacheErr) => {
						log.error(
							{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
							"Cleanup partial ARR delete could not update the cache",
						);
					});
				details.push(
					buildDetail(item, deletedAnyVerifiedFiles ? "files_deleted" : "skipped", error.message),
				);
				log.error(
					{ err: error, title: item.cacheItem.title, instanceId: instance.id },
					deletedAnyVerifiedFiles
						? "Cleanup deleted verified ARR files but could not safely finish the item mutation"
						: "Cleanup could not verify the ARR file mutation outcome and retained the item record",
				);
				continue;
			}
			if (error instanceof ArrFileChangedDuringSafetyCheckError) {
				runtimeSafetyBlocks++;
				details.push(buildDetail(item, "skipped", error.message));
				log.warn(
					{ title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup deletion blocked because the verified ARR file set changed",
				);
				continue;
			}
			consecutiveFailures++;
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: instance.id, consecutiveFailures },
				"Cleanup: failed to execute action on item",
			);
			details.push(buildDetail(item, "skipped", `Action failed: ${getErrorMessage(error)}`));
		}
	}

	const allWarnings = withSharedPlexWarning([...(warnings ?? [])], runtimeSafetyBlocks);
	if (circuitBroken) {
		allWarnings.push(
			`Circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive ARR API failures. Remaining items were skipped.`,
		);
	}
	if (instanceLookupFailures > 0) {
		allWarnings.push(
			`${instanceLookupFailures} items were skipped because their ARR instances could not be loaded.`,
		);
	}
	if (invalidMutationTargets > 0) {
		allWarnings.push(
			`${invalidMutationTargets} ${
				invalidMutationTargets === 1 ? "item was" : "items were"
			} skipped because the stored cleanup action or media type was invalid.`,
		);
	}
	if (partialArrDeletes > 0) {
		allWarnings.push(
			`${partialArrDeletes} ${
				partialArrDeletes === 1 ? "item had an" : "items had"
			} incomplete or unverifiable ARR file mutation. The corresponding ${
				partialArrDeletes === 1 ? "record remains" : "records remain"
			}; review the affected instance before retrying.`,
		);
	}
	const hasWarnings = allWarnings.length > 0;

	const result: CleanupRunResult = {
		isDryRun: false,
		status: circuitBroken || hasWarnings ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		itemsRemoved: removed,
		itemsUnmonitored: unmonitored,
		itemsFilesDeleted: filesDeleted,
		itemsSkipped:
			totalFlaggedBeforeLimit -
			flagged.length +
			(flagged.length - removed - unmonitored - filesDeleted),
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

function sonarrFileSetSize(files: Array<{ size?: number | null }>): number {
	let total = 0;
	for (const file of files) {
		if (
			typeof file.size === "number" &&
			Number.isSafeInteger(file.size) &&
			file.size > 0 &&
			Number.isSafeInteger(total + file.size)
		) {
			total += file.size;
		}
	}
	return total;
}

async function inspectRadarrFileState(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expected: VerifiedRadarrFileIdentity,
): Promise<
	| { kind: "record_absent" }
	| { kind: "file_absent" }
	| { kind: "same_file" }
	| { kind: "replacement"; size: number }
> {
	let movie: Awaited<ReturnType<typeof radarr.movie.getById>>;
	try {
		movie = await radarr.movie.getById(arrItemId);
	} catch (error) {
		if (isNotFoundError(error)) return { kind: "record_absent" };
		throw error;
	}
	const movieFileId = movie.movieFileId;
	if (typeof movieFileId !== "number" || movieFileId <= 0) {
		if (movie.hasFile === false) return { kind: "file_absent" };
		throw new Error("Radarr returned hasFile=true without a valid movie file ID");
	}
	if (movie.hasFile === false) {
		throw new Error("Radarr returned hasFile=false with a positive movie file ID");
	}
	if (movieFileId === expected.movieFileId) return { kind: "same_file" };

	let size = 0;
	try {
		const replacement = await radarr.movieFile.getById(movieFileId);
		if (
			typeof replacement.size === "number" &&
			Number.isSafeInteger(replacement.size) &&
			replacement.size > 0
		) {
			size = replacement.size;
		}
	} catch {
		// The replacement identity is enough to retain the record. Its size is
		// best-effort cache metadata and must not affect the safety decision.
	}
	return { kind: "replacement", size };
}

async function deleteVerifiedRadarrFile(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expected: VerifiedRadarrFileIdentity,
): Promise<void> {
	await assertVerifiedRadarrFileUnchanged(radarr, arrItemId, expected);
	let deleteError: unknown;
	try {
		await radarr.movieFile.delete(expected.movieFileId);
	} catch (error) {
		deleteError = error;
	}

	let state: Awaited<ReturnType<typeof inspectRadarrFileState>>;
	try {
		state = await inspectRadarrFileState(radarr, arrItemId, expected);
	} catch (verificationError) {
		throw new ArrDeletePartialError({
			cause: deleteError ?? verificationError,
			service: "RADARR",
			deletedFileIds: [],
			hasRemainingFiles: true,
			remainingSize: expected.size,
			message:
				"Partial cleanup: Radarr's movie-file deletion outcome could not be verified, so the movie record was retained. Review Radarr before retrying.",
		});
	}

	if (state.kind === "file_absent" || state.kind === "record_absent") return;
	if (state.kind === "same_file") {
		if (deleteError) throw deleteError;
		throw new Error("Radarr did not delete the verified movie file");
	}
	throw new ArrDeletePartialError({
		cause: deleteError ?? new RadarrFileChangedDuringSafetyCheckError(),
		service: "RADARR",
		deletedFileIds: [expected.movieFileId],
		hasRemainingFiles: true,
		remainingSize: state.size,
		message:
			"Partial cleanup: the verified Radarr movie file was deleted, but a replacement file appeared before the mutation finished. The movie record was retained.",
	});
}

async function deleteRadarrRecordWithoutFiles(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	deletedFileIds: number[],
): Promise<void> {
	let lastDeleteError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await assertVerifiedRadarrEmptyUnchanged(radarr, arrItemId);
		} catch (error) {
			if (isNotFoundError(error)) return;
			if (error instanceof RadarrFileChangedDuringSafetyCheckError) {
				throw new ArrDeletePartialError({
					cause: error,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: a Radarr replacement file appeared before the movie record could be removed. The movie record was retained.",
				});
			}
			throw new ArrDeletePartialError({
				cause: error,
				service: "RADARR",
				deletedFileIds,
				hasRemainingFiles: true,
				message:
					"Partial cleanup: arr-dashboard could not verify that the Radarr movie stayed fileless, so its record was retained.",
			});
		}

		try {
			await radarr.movie.delete(arrItemId, {
				deleteFiles: false,
				addImportExclusion: false,
			});
			return;
		} catch (error) {
			lastDeleteError = error;
			try {
				await radarr.movie.getById(arrItemId);
			} catch (readError) {
				if (isNotFoundError(readError)) return;
				throw new ArrDeletePartialError({
					cause: readError,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: the Radarr movie-record deletion outcome could not be verified. Review Radarr before retrying.",
				});
			}
		}
	}

	if (deletedFileIds.length === 0) throw lastDeleteError;
	throw new ArrDeletePartialError({
		cause: lastDeleteError,
		service: "RADARR",
		deletedFileIds,
		hasRemainingFiles: false,
	});
}

async function deleteVerifiedSonarrFiles(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expected: VerifiedSonarrFileIdentity,
): Promise<number[]> {
	await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, expected);
	const expectedIds = expected.episodeFiles.map((file) => file.episodeFileId);
	if (expectedIds.length === 0) return [];

	let bulkError: unknown;
	try {
		await sonarr.episodeFile.bulkDelete(expectedIds);
	} catch (error) {
		bulkError = error;
	}

	let remainingFiles: Awaited<ReturnType<typeof sonarr.episodeFile.getBySeries>>;
	try {
		remainingFiles = await sonarr.episodeFile.getBySeries(arrItemId);
	} catch (verificationError) {
		throw new ArrDeletePartialError({
			cause: bulkError ?? verificationError,
			service: "SONARR",
			deletedFileIds: [],
			hasRemainingFiles: true,
			remainingSize: sonarrFileSetSize(expected.episodeFiles),
			message:
				"Partial cleanup: Sonarr's episode-file deletion outcome could not be verified, so the series record was retained. Review Sonarr before retrying.",
		});
	}

	const remainingIds = new Set(
		remainingFiles
			.map((file) => file.id)
			.filter((id): id is number => typeof id === "number" && id > 0),
	);
	const deletedFileIds = expectedIds.filter((id) => !remainingIds.has(id));
	const remainingSize = sonarrFileSetSize(remainingFiles);
	if (bulkError) {
		if (deletedFileIds.length === 0) throw bulkError;
		throw new ArrDeletePartialError({
			cause: bulkError,
			service: "SONARR",
			deletedFileIds,
			hasRemainingFiles: remainingFiles.length > 0,
			remainingSize,
			message:
				"Partial cleanup: Sonarr deleted only part of the verified episode-file set. The series record was retained; review Sonarr before retrying.",
		});
	}
	if (deletedFileIds.length !== expectedIds.length || remainingFiles.length > 0) {
		if (deletedFileIds.length === 0) {
			throw new Error("Sonarr did not delete the verified episode-file set");
		}
		throw new ArrDeletePartialError({
			cause: new SonarrFilesChangedDuringSafetyCheckError(),
			service: "SONARR",
			deletedFileIds,
			hasRemainingFiles: true,
			remainingSize,
			message:
				"Partial cleanup: the verified Sonarr episode files were deleted, but another file appeared before the mutation finished. The series record was retained.",
		});
	}
	return deletedFileIds;
}

async function deleteSonarrRecordWithoutFiles(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expected: VerifiedSonarrFileIdentity,
	deletedFileIds: number[],
): Promise<void> {
	let lastDeleteError: unknown;
	const emptyExpected: VerifiedSonarrFileIdentity = {
		seriesPath: expected.seriesPath,
		episodeFiles: [],
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, emptyExpected);
		} catch (error) {
			if (isNotFoundError(error)) return;
			if (error instanceof SonarrFilesChangedDuringSafetyCheckError) {
				let remainingFiles: Awaited<ReturnType<typeof sonarr.episodeFile.getBySeries>> = [];
				let remainingFilesKnown = false;
				try {
					remainingFiles = await sonarr.episodeFile.getBySeries(arrItemId);
					remainingFilesKnown = true;
				} catch {
					// Retain the record and report an unknown remaining size.
				}
				throw new ArrDeletePartialError({
					cause: error,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: !remainingFilesKnown || remainingFiles.length > 0,
					remainingSize: sonarrFileSetSize(remainingFiles),
					message:
						"Partial cleanup: the Sonarr series changed or gained files before its record could be removed. The series record was retained.",
				});
			}
			throw new ArrDeletePartialError({
				cause: error,
				service: "SONARR",
				deletedFileIds,
				hasRemainingFiles: true,
				message:
					"Partial cleanup: arr-dashboard could not verify that the Sonarr series stayed fileless, so its record was retained.",
			});
		}

		try {
			await sonarr.series.delete(arrItemId, {
				deleteFiles: false,
				addImportListExclusion: false,
			});
			return;
		} catch (error) {
			lastDeleteError = error;
			try {
				await sonarr.series.getById(arrItemId);
			} catch (readError) {
				if (isNotFoundError(readError)) return;
				throw new ArrDeletePartialError({
					cause: readError,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: the Sonarr series-record deletion outcome could not be verified. Review Sonarr before retrying.",
				});
			}
		}
	}

	if (deletedFileIds.length === 0) throw lastDeleteError;
	throw new ArrDeletePartialError({
		cause: lastDeleteError,
		service: "SONARR",
		deletedFileIds,
		hasRemainingFiles: false,
	});
}

async function reconcileSonarrEpisodeFileCache(
	prisma: CleanupExecutorDeps["prisma"],
	instance: ServiceInstance,
	arrItemId: number,
	log: CleanupExecutorDeps["log"],
): Promise<void> {
	if (instance.service !== "SONARR") return;
	await prisma.episodeFileCache
		.deleteMany({
			where: { instanceId: instance.id, arrSeriesId: arrItemId },
		})
		.catch((error) => {
			log.error(
				{ err: error, instanceId: instance.id, arrItemId },
				"Cleanup Sonarr action succeeded but episode-file cache reconciliation failed",
			);
		});
}

async function reconcilePartialFileDeletion(
	prisma: CleanupExecutorDeps["prisma"],
	instance: ServiceInstance,
	arrItemId: number,
	itemType: string,
	error: ArrDeletePartialError,
	log: CleanupExecutorDeps["log"],
): Promise<void> {
	if (error.service !== "SONARR" || error.deletedFileIds.length === 0) return;
	await prisma.episodeFileCache
		.deleteMany({
			where: {
				instanceId: instance.id,
				arrSeriesId: arrItemId,
				arrEpisodeFileId: { in: error.deletedFileIds },
			},
		})
		.catch((cacheError) => {
			log.error(
				{ err: cacheError, instanceId: instance.id, arrItemId, itemType },
				"Cleanup partial Sonarr delete could not reconcile episode-file cache rows",
			);
		});
}

function validateCleanupMutationShape(
	instance: ServiceInstance,
	itemType: string,
	action: unknown,
): RuleAction {
	const normalizedAction = action ?? "delete";
	if (
		normalizedAction !== "delete" &&
		normalizedAction !== "unmonitor" &&
		normalizedAction !== "delete_files"
	) {
		throw new Error("Unknown cleanup action");
	}

	const expectedItemType =
		instance.service === "RADARR" ? "movie" : instance.service === "SONARR" ? "series" : null;
	if (!expectedItemType || itemType !== expectedItemType) {
		throw new Error("Cleanup media type does not match the target ARR service");
	}

	return normalizedAction;
}

/**
 * Delete an item from an ARR instance via the SDK client.
 */
async function deleteFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
	safetyPlan: SharedMediaSafetyPlan,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(radarr, arrItemId, safetyPlan.file);
				await deleteRadarrRecordWithoutFiles(radarr, arrItemId, [safetyPlan.file.movieFileId]);
			} else if (safetyPlan.kind === "verified_radarr_empty") {
				await deleteRadarrRecordWithoutFiles(radarr, arrItemId, []);
			} else if (safetyPlan.kind === "not_required") {
				throw new Error("A verified Radarr file identity is required for deletion");
			} else {
				const exhaustivePlan: never = safetyPlan;
				throw new Error(`Unsupported Radarr safety plan: ${String(exhaustivePlan)}`);
			}
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_radarr" || safetyPlan.kind === "verified_radarr_empty") {
				throw new Error("Radarr safety plan cannot authorize a Sonarr mutation");
			}
			if (safetyPlan.kind === "verified_sonarr") {
				const deletedFileIds = await deleteVerifiedSonarrFiles(sonarr, arrItemId, safetyPlan.files);
				await deleteSonarrRecordWithoutFiles(sonarr, arrItemId, safetyPlan.files, deletedFileIds);
			} else if (safetyPlan.kind === "not_required") {
				throw new Error("A verified Sonarr file identity is required for deletion");
			} else {
				const exhaustivePlan: never = safetyPlan;
				throw new Error(`Unsupported Sonarr safety plan: ${String(exhaustivePlan)}`);
			}
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
			await sonarr.series.update(arrItemId, {
				...series,
				id: arrItemId,
				monitored: false,
			} as Parameters<typeof sonarr.series.update>[1]);
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
	safetyPlan: SharedMediaSafetyPlan,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(radarr, arrItemId, safetyPlan.file);
				break;
			}
			if (safetyPlan.kind === "verified_radarr_empty") {
				await assertVerifiedRadarrEmptyUnchanged(radarr, arrItemId);
				break;
			}
			if (safetyPlan.kind === "not_required") {
				throw new Error("A verified Radarr file identity is required for file deletion");
			}
			const exhaustivePlan: never = safetyPlan;
			throw new Error(`Unsupported Radarr safety plan: ${String(exhaustivePlan)}`);
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_radarr" || safetyPlan.kind === "verified_radarr_empty") {
				throw new Error("Radarr safety plan cannot authorize a Sonarr mutation");
			}
			if (safetyPlan.kind === "verified_sonarr") {
				await deleteVerifiedSonarrFiles(sonarr, arrItemId, safetyPlan.files);
			} else if (safetyPlan.kind === "not_required") {
				throw new Error("A verified Sonarr file identity is required for file deletion");
			} else {
				const exhaustivePlan: never = safetyPlan;
				throw new Error(`Unsupported Sonarr safety plan: ${String(exhaustivePlan)}`);
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
		"seerr_requested_by",
		"seerr_request_age",
		"seerr_request_status",
		"seerr_is_4k",
		"seerr_request_modified_age",
		"seerr_modified_by",
		"seerr_is_requested",
		"seerr_request_count",
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];
	const TAUTULLI_RULE_TYPES = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
		"user_retention",
	];
	const PLEX_RULE_TYPES_LIST = [
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
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];

	const [seerrMap, tautulliMap, plexMap, plexEpisodeMap] = await Promise.all([
		SEERR_RULE_TYPES.some((t) => activeTypes.has(t))
			? prefetchSeerrRequests(deps, userId)
			: undefined,
		TAUTULLI_RULE_TYPES.some((t) => activeTypes.has(t))
			? prefetchTautulliData(deps, userId)
			: undefined,
		PLEX_RULE_TYPES_LIST.some((t) => activeTypes.has(t))
			? prefetchPlexData(deps, userId)
			: undefined,
		activeTypes.has("plex_episode_completion") ? prefetchPlexEpisodeData(deps, userId) : undefined,
	]);

	return {
		now: new Date(),
		seerrMap: seerrMap ?? undefined,
		tautulliMap: tautulliMap ?? undefined,
		plexMap: plexMap ?? undefined,
		plexEpisodeMap: plexEpisodeMap ?? undefined,
	};
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
		log?.warn(
			{ err: error, configId },
			"Failed to write cleanup run log — run result is still valid",
		);
	}
}
