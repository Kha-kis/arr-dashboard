/**
 * Queue Cleaner Executor
 *
 * Orchestrates queue cleaning for ARR instances. Delegates to:
 * - queue-item-utils.ts: raw item parsing, keyword matching, whitelist
 * - rule-evaluators.ts: rule evaluation pipeline
 * - auto-import-handler.ts: auto-import eligibility and execution
 * - cleaner-formatters.ts: display helpers and queue summaries
 */

import type { FastifyInstance } from "fastify";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { findImportSourceProtection } from "../arr/import-operations/repository.js";
import { readImportCommandOutcome } from "../arr/manual-import-command.js";
import {
	CleanupMaintenanceConflictError,
	withIndependentCleanupOperationGuard,
} from "../library-cleanup/cleanup-maintenance-gate.js";
import { loggers } from "../logger.js";
import type { QueueCleanerConfig, ServiceInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { attemptAutoImport, evaluateAutoImportEligibility } from "./auto-import-handler.js";
import { calculateQueueSummary, generateDetailedReason } from "./cleaner-formatters.js";
import {
	type CleanerResult,
	type CleanerResultItem,
	type EnhancedPreviewItem,
	type EnhancedPreviewResult,
	MAX_AUTO_IMPORTS_PER_RUN,
	type WhitelistPattern,
} from "./constants.js";
import {
	acquireQueueSourceAction,
	importConnectionFingerprint,
	PROTECTED_IMPORT_STATES,
	queueDownloadKey,
} from "./import-receipt.js";
import { resolveLibraryReferencedItemIds } from "./last-seed-gate.js";
import {
	checkWhitelist,
	collectStatusTexts,
	isFutureEpisode,
	parseDate,
	type RawQueueItem,
} from "./queue-item-utils.js";
import {
	queueItemFingerprint,
	readCompleteQueue,
	readCurrentQueueItem,
} from "./queue-observation.js";
import { normalizeDownloadId, resolveQuiAwareGateReasons } from "./qui-gate.js";
import {
	isUnsafeRetainedTorrentPolicy,
	RETAINED_TORRENT_BLOCKLIST_ERROR,
} from "./retained-torrent-policy.js";
import {
	evaluateQueueItem,
	shouldSkipByProfileFilter,
	shouldSkipByTagFilter,
} from "./rule-evaluators.js";
import {
	createTorrentFilePolicyEvaluator,
	parseAllowedFileExtensions,
	type TorrentFilePolicyResult,
} from "./torrent-file-policy.js";

const log = loggers.queueCleaner;

const IMPORT_PREVIEW_DETAIL =
	"Would attempt import after current candidate, file and safety verification; source retained. " +
	"An accepted command is not verified file completion and never authorizes removal.";

/** Keep row actions and counts aligned with execution's ordered admission caps. */
function applyPreviewActionLimits<
	T extends { action: EnhancedPreviewItem["action"]; reason: string; detailedReason?: string },
>(
	items: T[],
	config: QueueCleanerConfig,
): (Omit<T, "action"> & { action: EnhancedPreviewItem["action"] })[] {
	let admittedActions = 0;
	let importAttempts = 0;
	return items.map((item) => {
		if (item.action !== "remove" && item.action !== "import") return item;
		let reason: string | undefined;
		if (admittedActions >= config.maxRemovalsPerRun) {
			reason = `Exceeded max removals per run (${config.maxRemovalsPerRun})`;
		} else {
			// Execution caps its candidate list before consuming the import budget.
			admittedActions++;
			if (item.action === "import") {
				if (importAttempts >= MAX_AUTO_IMPORTS_PER_RUN) {
					reason = "Per-run import budget exhausted; eligible source retained for a later run.";
				} else importAttempts++;
			}
		}
		return reason
			? {
					...item,
					action: "skip",
					reason,
					...(item.detailedReason !== undefined ? { detailedReason: reason } : {}),
				}
			: item;
	});
}

function isUnsafeRetainedTorrentAction(
	item: Pick<CleanerResultItem, "protocol" | "rule">,
	config: QueueCleanerConfig,
): boolean {
	const normalizedProtocol =
		typeof item.protocol === "string" ? item.protocol.toLowerCase() : undefined;
	return (
		normalizedProtocol !== "usenet" &&
		item.rule !== "disallowed_file_extension" &&
		isUnsafeRetainedTorrentPolicy(config)
	);
}

function isEligibleForFilePolicy(
	item: RawQueueItem,
	config: QueueCleanerConfig,
	now: Date,
	isSonarr: boolean,
	whitelistPatterns: WhitelistPattern[],
): boolean {
	const added = parseDate(item.added);
	if (added) {
		const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
		if (ageMins < config.minQueueAgeMins) return false;
	}
	if (shouldSkipByTagFilter(item, config) || shouldSkipByProfileFilter(item, config)) return false;
	if (isSonarr && config.skipFutureEpisodes && isFutureEpisode(item, now)) return false;
	if (whitelistPatterns.length > 0 && checkWhitelist(item, whitelistPatterns).matched) return false;
	return true;
}

async function evaluateFilePolicyForEligibleItems(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: QueueCleanerConfig,
	queueRecords: RawQueueItem[],
	now: Date,
	whitelistPatterns: WhitelistPattern[],
	allowedExtensions: string[],
): Promise<Map<RawQueueItem, TorrentFilePolicyResult>> {
	const resultsByItem = new Map<RawQueueItem, TorrentFilePolicyResult>();
	if (!config.fileExtensionAllowlistEnabled) return resultsByItem;

	const isSonarr = instance.service === "SONARR";
	const eligible = queueRecords.filter((item) =>
		isEligibleForFilePolicy(item, config, now, isSonarr, whitelistPatterns),
	);
	if (eligible.length === 0) return resultsByItem;

	try {
		const evaluator = createTorrentFilePolicyEvaluator(app, instance.userId, allowedExtensions);
		const results = await evaluator.evaluateMany(eligible);
		for (let index = 0; index < eligible.length; index++) {
			resultsByItem.set(eligible[index]!, results[index]!);
		}
	} catch (error) {
		log.warn(
			{ err: error, instanceId: instance.id },
			"Queue cleaner file policy evaluation failed unexpectedly; deferring all checks",
		);
		for (const item of eligible) {
			resultsByItem.set(item, {
				status: "deferred",
				reason: "File allowlist check deferred because qui inspection failed",
			});
		}
	}

	return resultsByItem;
}

async function resolveSafetyGateReasons(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: QueueCleanerConfig,
	queueRecords: RawQueueItem[],
	now: Date,
	whitelistPatterns: WhitelistPattern[],
	preparedOperationId?: string,
): Promise<Map<string, string>> {
	const reasons = new Map<string, string>();
	const sourceItemIds = new Map<string, string[]>();
	const sourceItems = new Map<string, RawQueueItem>();
	for (const item of queueRecords) {
		const key = queueDownloadKey(item);
		if (key === null) continue;
		const ids = sourceItemIds.get(key) ?? [];
		ids.push(String(item.id));
		sourceItemIds.set(key, ids);
		sourceItems.set(String(item.id), item);
	}
	const sourceKeys = [...sourceItemIds.keys()];
	try {
		// Import protection applies to every protocol, before torrent-only safety checks.
		for (let offset = 0; offset < sourceKeys.length; offset += 500) {
			const protectedSources = await findImportSourceProtection(
				app.prisma,
				instance.userId,
				sourceKeys.slice(offset, offset + 500),
			);
			const retryIds = [
				...new Set(
					protectedSources.flatMap((protection) =>
						protection.automaticRetryInstanceId === instance.id
							? (sourceItemIds.get(protection.downloadKey) ?? [])
							: [],
					),
				),
			];
			const retryStrikes = new Map(
				(retryIds.length && !preparedOperationId
					? await app.prisma.queueCleanerStrike.findMany({
							where: {
								instanceId: instance.id,
								instance: { userId: instance.userId },
								downloadId: { in: retryIds },
							},
							take: retryIds.length,
						})
					: []
				).map((strike) => [strike.downloadId, strike]),
			);
			for (const protection of protectedSources) {
				// Only the shared service's final import gate recognizes its own
				// preparing operation. Cleanup calls never pass this identity.
				if (
					preparedOperationId &&
					protection.kind !== "legacy" &&
					protection.operationId === preparedOperationId &&
					protection.state === "preparing"
				)
					continue;
				for (const id of sourceItemIds.get(protection.downloadKey) ?? []) {
					if (protection.automaticRetryInstanceId === instance.id) {
						// The final preparing gate has already consumed its new ordinal;
						// submission's transaction still checks its current policy/history.
						if (preparedOperationId) continue;
						const item = sourceItems.get(id);
						const fingerprint = item && queueItemFingerprint(item);
						const strike = retryStrikes.get(id);
						const rule = item && evaluateQueueItem(item, config, now)?.rule;
						if (
							item &&
							fingerprint &&
							(rule === "import_pending" || rule === "import_blocked") &&
							evaluateAutoImportEligibility(
								collectStatusTexts(item),
								config,
								strike?.downloadFingerprint === fingerprint ? strike : null,
								now,
							).eligible
						)
							continue;
					}
					reasons.set(
						id,
						protection.state === "not-submitted"
							? "An automatic import was not submitted; source retained. Review the files and deliberately retry Manual Import, or resolve the source in ARR before cleanup."
							: "Import evidence protects this queued source; cleanup authority is unavailable. Observe import progress and resolve the source in ARR before cleanup.",
					);
				}
			}
		}
	} catch {
		log.warn(
			{ category: "import-protection-unavailable", sourceCount: sourceKeys.length },
			"Import protection lookup unavailable; cleanup deferred",
		);
		for (const ids of sourceItemIds.values()) {
			for (const id of ids)
				reasons.set(
					id,
					"Import protection evidence is unavailable; source retained. Retry observation before cleanup.",
				);
		}
	}

	const isSonarr = instance.service === "SONARR";
	const hashByItemId = new Map<string, string>();
	for (const item of queueRecords) {
		if (!isEligibleForFilePolicy(item, config, now, isSonarr, whitelistPatterns)) continue;
		if (!queueItemFingerprint(item)) {
			reasons.set(String(item.id), "Queue download identity is unavailable; action deferred");
		}
		const hash = normalizeDownloadId(item.downloadId);
		if (
			config.lastSeedProtection &&
			item.protocol !== "usenet" &&
			!(typeof item.protocol === "string" && item.protocol.toLowerCase() === "usenet") &&
			!hash
		) {
			reasons.set(String(item.id), "last-seed protection: torrent identity is unavailable");
		}
		if (hash) hashByItemId.set(String(item.id), hash);
	}
	if (hashByItemId.size === 0) return reasons;

	if (config.quiAwareMode) {
		try {
			const gateReasons = await resolveQuiAwareGateReasons(
				app.prisma,
				instance.userId,
				hashByItemId,
			);
			for (const [id, reason] of gateReasons) {
				reasons.set(
					id,
					reason === "evidence_unavailable"
						? "qui-aware: qUI evidence is unavailable or stale"
						: "qui-aware: torrent is paused or errored in qui",
				);
			}
		} catch (error) {
			log.warn(
				{ err: error, instanceId: instance.id },
				"qui-aware preview lookup failed; preview is failing closed for correlated torrents",
			);
			for (const id of hashByItemId.keys()) {
				reasons.set(id, "qui-aware: qUI evidence is unavailable or stale");
			}
		}
	}

	if (config.lastSeedProtection) {
		try {
			let unavailable = false;
			const protectedIds = await resolveLibraryReferencedItemIds(
				app.prisma,
				instance.userId,
				hashByItemId,
				{
					onUnavailable: () => {
						unavailable = true;
					},
				},
			);
			if (unavailable) {
				log.warn(
					{ instanceId: instance.id, category: "reference-evidence-unavailable" },
					"Last-seed reference lookup unavailable; cleanup deferred",
				);
			}
			for (const id of protectedIds) {
				if (!reasons.has(id)) {
					reasons.set(
						id,
						unavailable
							? "last-seed protection: reference evidence is unavailable"
							: "last-seed protection: *arr library still references this torrent",
					);
				}
			}
		} catch (error) {
			log.warn(
				{ err: error, instanceId: instance.id },
				"last-seed reference lookup failed; cleanup is deferred for safety",
			);
			for (const id of hashByItemId.keys()) {
				reasons.set(id, "last-seed protection: reference evidence is unavailable");
			}
		}
	}

	return reasons;
}

// Re-export types for external use
export type {
	CleanerResult,
	CleanerResultItem,
	CleanerRule,
	EnhancedPreviewItem,
	EnhancedPreviewResult,
	PreviewRule,
	QueueStateSummary,
} from "./constants.js";

/**
 * Execute the queue cleaner for an instance.
 *
 * 1. Fetches the queue from the ARR instance
 * 2. Checks whitelist first (skip matching items)
 * 3. Evaluates each item against configured rules
 * 4. Applies strike system if enabled
 * 5. In dry-run mode, returns preview without removing
 * 6. In live mode, removes matched items from the queue
 */
export async function executeQueueCleaner(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: QueueCleanerConfig,
): Promise<CleanerResult> {
	if (config.dryRunMode) return executeQueueCleanerWithGuard(app, instance, config);
	try {
		// Independent ownership survives a parent request/scheduler timeout until provider work settles.
		return await withIndependentCleanupOperationGuard(() =>
			executeQueueCleanerWithGuard(app, instance, config),
		);
	} catch (error) {
		if (!(error instanceof CleanupMaintenanceConflictError)) throw error;
		return {
			itemsCleaned: 0,
			itemsSkipped: 0,
			itemsWarned: 0,
			cleanedItems: [],
			skippedItems: [],
			warnedItems: [],
			isDryRun: false,
			status: "error",
			message:
				"Queue Cleaner is unavailable during connection deletion or database maintenance. No queue action was started.",
		};
	}
}

async function executeQueueCleanerWithGuard(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: QueueCleanerConfig,
): Promise<CleanerResult> {
	const client = app.arrClientFactory.create(instance) as QueueCapableClient;
	const now = new Date();
	let allowedFileExtensions: string[] = [];

	// Parse whitelist patterns
	let whitelistPatterns: WhitelistPattern[] = [];
	if (config.whitelistEnabled && config.whitelistPatterns) {
		try {
			whitelistPatterns = JSON.parse(config.whitelistPatterns);
		} catch (error) {
			log.error(
				{ instanceId: instance.id, err: error },
				"Invalid whitelist patterns JSON - aborting clean for safety",
			);
			return {
				itemsCleaned: 0,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: config.dryRunMode,
				status: "error",
				message:
					"Whitelist configuration is invalid. Please fix whitelist patterns before running.",
			};
		}
	}

	// Validate error patterns upfront
	if (config.errorPatternsEnabled && config.errorPatterns) {
		try {
			const parsed = JSON.parse(config.errorPatterns);
			if (!Array.isArray(parsed)) {
				throw new Error("Error patterns must be an array");
			}
		} catch (error) {
			log.error(
				{ instanceId: instance.id, err: error },
				"Invalid error patterns JSON - aborting clean for safety",
			);
			return {
				itemsCleaned: 0,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: config.dryRunMode,
				status: "error",
				message:
					"Error patterns configuration is invalid. Please fix error patterns before running.",
			};
		}
	}

	if (config.fileExtensionAllowlistEnabled) {
		const parsed = parseAllowedFileExtensions(config.allowedFileExtensions);
		if (!parsed.ok || parsed.extensions.length === 0) {
			log.error(
				{ instanceId: instance.id },
				"Invalid torrent file allowlist - aborting clean for safety",
			);
			return {
				itemsCleaned: 0,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: config.dryRunMode,
				status: "error",
				message:
					"Torrent file allowlist configuration is invalid. Add at least one valid extension before running.",
			};
		}
		allowedFileExtensions = parsed.extensions;
	}

	// Fetch queue
	// For Radarr, include items that can't be matched to a known movie —
	// these are often the stuck import-error items users report.
	let queueRecords: Array<RawQueueItem & { id: number }>;
	try {
		queueRecords = await readCompleteQueue(client, instance.service);
	} catch (error) {
		const message = getErrorMessage(error, "Unknown error");
		return {
			itemsCleaned: 0,
			itemsSkipped: 0,
			itemsWarned: 0,
			cleanedItems: [],
			skippedItems: [],
			warnedItems: [],
			isDryRun: config.dryRunMode,
			status: "error",
			message: `Failed to fetch queue: ${message}`,
		};
	}

	const matched: CleanerResultItem[] = [];
	const skipped: CleanerResultItem[] = [];
	let safetyDeferrals = 0;
	const reconciledImports: CleanerResultItem[] = [];
	const importProtectedIds = new Set<number>();
	try {
		// Cached existence only: an absent queue source does not settle a
		// durable attempt, and a cleaner tick must not replay it or scan History.
		const outstanding = await app.prisma.arrImportOperation.findMany({
			where: {
				userId: instance.userId,
				originalInstanceId: instance.id,
				origin: "queue-cleaner",
				state: { notIn: ["completed", "not-submitted"] },
			},
			select: { id: true },
			take: 1,
		});
		if (outstanding.length) safetyDeferrals++;
	} catch {
		log.warn(
			{ category: "tracked-import-progress-unavailable" },
			"Cached import progress unavailable; no cleanup attempted",
		);
		return {
			itemsCleaned: 0,
			itemsSkipped: 0,
			itemsWarned: 0,
			cleanedItems: [],
			skippedItems: [],
			warnedItems: [],
			isDryRun: config.dryRunMode,
			status: "partial",
			message:
				"Cached import progress is unavailable; no queue mutations attempted. Retry observation before cleanup.",
		};
	}
	try {
		const receipts = await app.prisma.queueCleanerImportReceipt.findMany({
			where: { instance: { userId: instance.userId }, state: { in: PROTECTED_IMPORT_STATES } },
		});
		for (const receipt of receipts) {
			const id = receipt.queueId;
			const current = queueRecords.filter((item) => queueDownloadKey(item) === receipt.downloadKey);
			if (receipt.instanceId !== instance.id) {
				for (const item of current) importProtectedIds.add(item.id);
				if (current.length > 0) {
					safetyDeferrals++;
					skipped.push({
						id: current[0]!.id,
						title: typeof current[0]!.title === "string" ? current[0]!.title : "Unknown",
						rule: "import_pending",
						reason:
							"Another connection has an import receipt for this source; action withheld until provider reconciliation.",
					});
				}
				continue;
			}
			// Positive per-file completion is historical evidence, not current connection authority.
			// Never degrade it after replacement or ask a new provider to re-prove it.
			if (receipt.state === "completed") {
				if (current.length > 0) {
					for (const item of current) importProtectedIds.add(item.id!);
					safetyDeferrals++;
					skipped.push({
						id,
						title: receipt.downloadTitle,
						rule: "import_pending",
						reason:
							"Prior import verified, but the same download remains queued; source retained for provider reconciliation.",
					});
				}
				continue;
			}
			if (config.dryRunMode) {
				for (const item of current) importProtectedIds.add(item.id!);
				if (current.length > 0)
					skipped.push({
						id,
						title: receipt.downloadTitle,
						rule: "import_pending",
						reason:
							"Auto-import receipt is unresolved; source retained. Preview does not reconcile or change receipts.",
					});
				continue;
			}
			const outcome =
				receipt.connectionFingerprint === importConnectionFingerprint(instance)
					? await readImportCommandOutcome(
							client,
							instance.service.toLowerCase(),
							receipt.commandId,
							receipt.commandFingerprint,
							receipt.lastAttemptAt,
						)
					: { state: "unknown" as const };
			const changed = await app.prisma.queueCleanerImportReceipt.updateMany({
				where: {
					id: receipt.id,
					instanceId: instance.id,
					state: receipt.state,
					commandId: receipt.commandId,
					lastAttemptAt: receipt.lastAttemptAt,
				},
				data: {
					state: outcome.state,
					commandId: "commandId" in outcome ? outcome.commandId : receipt.commandId,
				},
			});
			if (changed.count !== 1) throw new Error("Import receipt fence changed");
			if (outcome.state === "completed") {
				reconciledImports.push({
					id,
					title: receipt.downloadTitle,
					rule: "import_pending",
					reason: "Auto-import command completion verified by ARR.",
				});
				for (const item of current) importProtectedIds.add(item.id!);
			} else if (outcome.state === "failed") {
				for (const item of current) importProtectedIds.add(item.id);
				safetyDeferrals++;
				skipped.push({
					id,
					title: receipt.downloadTitle,
					rule: "import_pending",
					reason:
						"Prior auto-import failed or partially completed; automatic retry and source removal withheld. Resolve the import in ARR before retrying.",
				});
			} else {
				for (const item of current) importProtectedIds.add(item.id!);
				safetyDeferrals++;
				skipped.push({
					id,
					title: receipt.downloadTitle,
					rule: "import_pending",
					reason:
						outcome.state === "pending"
							? "Auto-import command is pending; source retained."
							: "Auto-import outcome is unknown; source retained. Check provider command activity before retrying.",
				});
			}
		}
	} catch {
		return {
			itemsCleaned: reconciledImports.length,
			itemsSkipped: skipped.length,
			itemsWarned: 0,
			cleanedItems: reconciledImports,
			skippedItems: skipped,
			warnedItems: [],
			isDryRun: config.dryRunMode,
			status: "error",
			message: "Import receipt reconciliation is unavailable; no queue mutations attempted.",
		};
	}

	if (queueRecords.length === 0) {
		return {
			itemsCleaned: reconciledImports.length,
			itemsSkipped: skipped.length,
			itemsWarned: 0,
			cleanedItems: reconciledImports,
			skippedItems: skipped,
			warnedItems: [],
			isDryRun: config.dryRunMode,
			status: safetyDeferrals > 0 ? "partial" : "completed",
			message:
				safetyDeferrals > 0
					? "Import outcome remains uncertain despite an empty queue; source authority retained."
					: reconciledImports.length > 0
						? "Prior auto-import command completion verified by ARR."
						: "Queue is empty",
		};
	}

	const queueItemIds = new Set<string>();
	const filePolicyResults = await evaluateFilePolicyForEligibleItems(
		app,
		instance,
		config,
		queueRecords,
		now,
		whitelistPatterns,
		allowedFileExtensions,
	);

	const isSonarr = instance.service === "SONARR";

	for (const item of queueRecords) {
		const id = typeof item.id === "number" ? item.id : 0;
		const idStr = String(id);
		const title = typeof item.title === "string" ? item.title : "Unknown";
		const added = parseDate(item.added);

		queueItemIds.add(idStr);
		if (importProtectedIds.has(id)) continue;

		// Age guard
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			if (ageMins < config.minQueueAgeMins) {
				continue;
			}
		}

		// Tag/profile pre-filters (skip items that don't match)
		if (shouldSkipByTagFilter(item, config) || shouldSkipByProfileFilter(item, config)) {
			continue;
		}

		// Skip future episodes (Sonarr only)
		if (isSonarr && config.skipFutureEpisodes && isFutureEpisode(item, now)) {
			skipped.push({
				id,
				title,
				reason: "Skipped: future episode (hasn't aired yet)",
				rule: "future_episode",
			});
			continue;
		}

		// Whitelist check
		if (whitelistPatterns.length > 0) {
			const whitelistResult = checkWhitelist(item, whitelistPatterns);
			if (whitelistResult.matched) {
				skipped.push({
					id,
					title,
					reason: `Whitelisted: ${whitelistResult.reason}`,
					rule: "whitelisted",
				});
				continue;
			}
		}

		const filePolicy = filePolicyResults.get(item);
		const standardEvaluation = evaluateQueueItem(item, config, now);
		if (filePolicy?.status === "deferred") {
			skipped.push({
				id,
				title,
				reason: filePolicy.reason,
				rule: "file_policy_deferred",
			});
			continue;
		}
		const evaluation =
			filePolicy?.status === "violation"
				? {
						rule: "disallowed_file_extension" as const,
						reason: filePolicy.reason,
					}
				: standardEvaluation;
		if (evaluation) {
			const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : undefined;
			matched.push({ id, title, reason: evaluation.reason, rule: evaluation.rule, protocol });
		}
	}

	const gateReasons = await resolveSafetyGateReasons(
		app,
		instance,
		config,
		queueRecords,
		now,
		whitelistPatterns,
	);
	const ungated: CleanerResultItem[] = [];
	for (const item of matched) {
		const reason = gateReasons.get(String(item.id));
		if (reason) {
			if (reason.includes("unavailable")) safetyDeferrals++;
			skipped.push({ ...item, reason: `${item.reason} — skipped (${reason})` });
		} else ungated.push(item);
	}
	matched.length = 0;
	matched.push(...ungated);

	const queueItemMap = new Map(queueRecords.map((item) => [Number(item.id), item]));
	const revalidate = async (
		candidate: CleanerResultItem,
		preparedOperationId?: string,
	): Promise<RawQueueItem | null> => {
		const defer = () => {
			safetyDeferrals++;
			return null;
		};
		try {
			const currentInstance = await app.prisma.serviceInstance.findUnique({
				where: { id: instance.id, userId: instance.userId, enabled: true },
			});
			if (
				!currentInstance ||
				importConnectionFingerprint(currentInstance) !== importConnectionFingerprint(instance)
			) {
				skipped.push({
					...candidate,
					reason: "Connection owner, availability, or provider identity changed; action deferred.",
				});
				return defer();
			}
			const observed = queueItemMap.get(candidate.id);
			const current = await readCurrentQueueItem(client, instance.service, candidate.id);
			if (
				!observed ||
				!current ||
				!queueItemFingerprint(observed) ||
				queueItemFingerprint(observed) !== queueItemFingerprint(current)
			) {
				skipped.push({
					...candidate,
					reason: "Queue target identity changed or is unavailable; action deferred.",
				});
				return defer();
			}
			const currentTime = new Date();
			const downloadKey = queueDownloadKey(current);
			const receipts = await app.prisma.queueCleanerImportReceipt.findMany({
				where: {
					instance: { userId: instance.userId },
					downloadKey: downloadKey ?? "",
					state: { in: PROTECTED_IMPORT_STATES },
				},
			});
			if (!downloadKey || receipts.some((receipt) => receipt.downloadKey === downloadKey)) {
				skipped.push({
					...candidate,
					reason:
						"Source identity is unavailable or an import receipt requires provider reconciliation; action deferred.",
				});
				return defer();
			}
			if (!isEligibleForFilePolicy(current, config, currentTime, isSonarr, whitelistPatterns)) {
				skipped.push({
					...candidate,
					reason: "Queue target is no longer eligible; action deferred.",
				});
				return defer();
			}
			const policies = await evaluateFilePolicyForEligibleItems(
				app,
				instance,
				config,
				[current],
				currentTime,
				whitelistPatterns,
				allowedFileExtensions,
			);
			const policy = policies.get(current);
			const currentRule =
				policy?.status === "violation"
					? "disallowed_file_extension"
					: evaluateQueueItem(current, config, currentTime)?.rule;
			const reasons = await resolveSafetyGateReasons(
				app,
				instance,
				config,
				[current],
				currentTime,
				whitelistPatterns,
				preparedOperationId,
			);
			const reason = reasons.get(String(candidate.id));
			if (policy?.status === "deferred" || currentRule !== candidate.rule || reason) {
				skipped.push({
					...candidate,
					reason: reason ?? "Queue target rule or protection changed; action deferred.",
				});
				return defer();
			}
			return current;
		} catch {
			skipped.push({
				...candidate,
				reason: "Queue target identity or safety evidence is unavailable; action deferred.",
			});
			return defer();
		}
	};
	if (!config.dryRunMode) {
		const currentMatches: CleanerResultItem[] = [];
		for (const candidate of matched) {
			if (await revalidate(candidate)) currentMatches.push(candidate);
		}
		matched.length = 0;
		matched.push(...currentMatches);
	}

	// Apply strike system if enabled
	let toRemove: CleanerResultItem[] = [];
	const warned: CleanerResultItem[] = [];
	const strikesToDeleteAfterRemoval: Map<string, string> = new Map();

	if (config.strikeSystemEnabled && !config.dryRunMode) {
		try {
			const { toRemoveItems, warnedItems, pendingStrikeDeletions } = await app.prisma.$transaction(
				async (tx) => {
					const existingStrikes = await tx.queueCleanerStrike.findMany({
						where: { instanceId: instance.id },
					});
					const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));

					const txToRemove: CleanerResultItem[] = [];
					const txWarned: CleanerResultItem[] = [];
					const txPendingStrikeDeletions: Map<string, string> = new Map();

					for (const item of matched) {
						const itemIdStr = String(item.id);
						const priorStrike = strikeMap.get(itemIdStr);
						const source = queueItemMap.get(item.id)!;
						const downloadFingerprint = queueItemFingerprint(source)!;
						const existingStrike =
							priorStrike?.downloadFingerprint === downloadFingerprint ? priorStrike : undefined;
						const newStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;

						if (newStrikeCount >= config.maxStrikes) {
							txToRemove.push({
								...item,
								reason: `${item.reason} (strike ${newStrikeCount}/${config.maxStrikes})`,
								strikeCount: newStrikeCount,
								maxStrikes: config.maxStrikes,
							});

							if (existingStrike) {
								txPendingStrikeDeletions.set(itemIdStr, existingStrike.id);
							}
						} else {
							if (priorStrike) {
								await tx.queueCleanerStrike.update({
									where: { id: priorStrike.id },
									data: {
										downloadFingerprint,
										downloadHash: normalizeDownloadId(source.downloadId),
										...(!existingStrike
											? {
													importAttempts: 0,
													lastImportAttempt: null,
													lastImportError: null,
													firstStrikeAt: now,
													downloadTitle: item.title,
												}
											: {}),
										strikeCount: newStrikeCount,
										lastRule: item.rule,
										lastReason: item.reason,
									},
								});
							} else {
								await tx.queueCleanerStrike.create({
									data: {
										instanceId: instance.id,
										downloadId: itemIdStr,
										downloadTitle: item.title,
										downloadFingerprint,
										downloadHash: normalizeDownloadId(source.downloadId),
										strikeCount: 1,
										lastRule: item.rule,
										lastReason: item.reason,
									},
								});
							}

							txWarned.push({
								...item,
								reason: `${item.reason} (strike ${newStrikeCount}/${config.maxStrikes})`,
								strikeCount: newStrikeCount,
								maxStrikes: config.maxStrikes,
							});
						}
					}

					const strikesToDelete = existingStrikes.filter((s) => !queueItemIds.has(s.downloadId));
					if (strikesToDelete.length > 0) {
						await tx.queueCleanerStrike.deleteMany({
							where: { id: { in: strikesToDelete.map((s) => s.id) } },
						});
					}

					return {
						toRemoveItems: txToRemove,
						warnedItems: txWarned,
						pendingStrikeDeletions: txPendingStrikeDeletions,
					};
				},
			);

			toRemove = toRemoveItems;
			warned.push(...warnedItems);
			for (const [downloadId, strikeId] of pendingStrikeDeletions) {
				strikesToDeleteAfterRemoval.set(downloadId, strikeId);
			}
		} catch (error) {
			const isPrismaError = error && typeof error === "object" && "code" in error;
			const errorMessage = getErrorMessage(error, "Unknown error");

			if (isPrismaError) {
				log.error(
					{ err: error, instanceId: instance.id },
					"Strike system database error - aborting clean for safety",
				);
			} else {
				log.error(
					{ err: error, instanceId: instance.id },
					"Unexpected error in strike system (possible bug) - aborting clean for safety",
				);
			}

			const errorType = isPrismaError ? "database error" : "unexpected error";
			return {
				itemsCleaned: 0,
				itemsSkipped: matched.length + skipped.length,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [
					...matched.map((item) => ({
						...item,
						reason: `Skipped (strike system unavailable): ${item.reason}`,
					})),
					...skipped,
				],
				warnedItems: [],
				isDryRun: config.dryRunMode,
				status: "error",
				message: `Strike system ${errorType}: ${errorMessage}. No items removed for safety.`,
			};
		}
	} else {
		toRemove = matched;
	}

	// Dry run mode: return preview
	if (config.dryRunMode) {
		const dryRunWarned: CleanerResultItem[] = [];
		let dryRunToRemove: CleanerResultItem[] = [];
		const existingStrikes = await app.prisma.queueCleanerStrike.findMany({
			where: { instanceId: instance.id },
		});
		const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));

		if (config.strikeSystemEnabled) {
			for (const item of matched) {
				const priorStrike = strikeMap.get(String(item.id));
				const existingStrike =
					priorStrike?.downloadFingerprint === queueItemFingerprint(queueItemMap.get(item.id)!)
						? priorStrike
						: undefined;
				const simulatedStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;

				if (simulatedStrikeCount >= config.maxStrikes) {
					dryRunToRemove.push({
						...item,
						strikeCount: simulatedStrikeCount,
						maxStrikes: config.maxStrikes,
					});
				} else {
					dryRunWarned.push({
						...item,
						strikeCount: simulatedStrikeCount,
						maxStrikes: config.maxStrikes,
					});
				}
			}
		} else {
			dryRunToRemove = matched;
		}

		const policyBlocked = dryRunToRemove.filter((item) =>
			isUnsafeRetainedTorrentAction(item, config),
		);
		const authorizedCandidates = dryRunToRemove.filter(
			(item) => !isUnsafeRetainedTorrentAction(item, config),
		);
		const plannedActions = applyPreviewActionLimits(
			authorizedCandidates.map((item) => {
				const source = queueItemMap.get(item.id)!;
				const priorStrike = strikeMap.get(String(item.id));
				const existingStrike =
					priorStrike?.downloadFingerprint === queueItemFingerprint(source) ? priorStrike : null;
				const wouldImport =
					(item.rule === "import_pending" || item.rule === "import_blocked") &&
					typeof source.downloadId === "string" &&
					!!source.downloadId &&
					evaluateAutoImportEligibility(collectStatusTexts(source), config, existingStrike, now)
						.eligible;
				return { ...item, action: wouldImport ? ("import" as const) : ("remove" as const) };
			}),
			config,
		);
		const previewRemoveCount = plannedActions.filter((item) => item.action === "remove").length;
		const previewImportCount = plannedActions.filter((item) => item.action === "import").length;

		return {
			itemsCleaned: 0,
			itemsSkipped: plannedActions.length + policyBlocked.length + skipped.length,
			itemsWarned: dryRunWarned.length,
			cleanedItems: [],
			skippedItems: [
				...plannedActions.map(({ action, ...item }) => ({
					...item,
					reason:
						action === "import"
							? `[DRY RUN] ${IMPORT_PREVIEW_DETAIL}`
							: action === "remove"
								? `[DRY RUN] Would remove: ${item.reason}${item.strikeCount ? ` (strike ${item.strikeCount}/${item.maxStrikes})` : ""}`
								: item.reason,
				})),
				...policyBlocked.map((item) => ({
					...item,
					reason: RETAINED_TORRENT_BLOCKLIST_ERROR,
				})),
				...skipped,
			],
			warnedItems: dryRunWarned.map((i) => ({
				...i,
				reason: `[DRY RUN] Would warn: ${i.reason} (strike ${i.strikeCount}/${i.maxStrikes})`,
			})),
			isDryRun: true,
			status: "completed",
			message:
				previewRemoveCount > 0 || previewImportCount > 0
					? `Dry run: would remove ${previewRemoveCount} item(s), attempt import of ${previewImportCount} item(s) with source retained${dryRunWarned.length > 0 ? `, warn ${dryRunWarned.length}` : ""}`
					: dryRunWarned.length > 0
						? `Dry run: would warn ${dryRunWarned.length} item(s)`
						: policyBlocked.length > 0
							? `Dry run: would skip ${policyBlocked.length} item(s) blocked by the retained-torrent policy`
							: "Dry run: no admitted actions; matching sources retained",
		};
	}

	const policyBlocked = toRemove.filter((item) => isUnsafeRetainedTorrentAction(item, config));
	const authorizedToRemove = toRemove.filter(
		(item) => !isUnsafeRetainedTorrentAction(item, config),
	);
	for (const item of policyBlocked) {
		skipped.push({ ...item, reason: RETAINED_TORRENT_BLOCKLIST_ERROR });
	}

	// The cap throttles authorized mutations; policy-blocked items do not consume it.
	const cappedToRemove = authorizedToRemove.slice(0, config.maxRemovalsPerRun);
	const cappedSkip = authorizedToRemove.slice(config.maxRemovalsPerRun);
	for (const item of cappedSkip) {
		skipped.push({
			...item,
			reason: `Exceeded max removals per run (${config.maxRemovalsPerRun})`,
		});
	}

	// Live mode: remove items (with auto-import support)
	let removeErrors = 0;
	const autoImportSuccesses = reconciledImports.length;
	const cleaned: CleanerResultItem[] = [];
	const autoImported: CleanerResultItem[] = [...reconciledImports];

	const downloadIdMap = new Map<number, string>();
	for (const queueItem of queueRecords) {
		const queueId = typeof queueItem.id === "number" ? queueItem.id : 0;
		const downloadId = typeof queueItem.downloadId === "string" ? queueItem.downloadId : null;
		if (queueId > 0) {
			if (downloadId) {
				downloadIdMap.set(queueId, downloadId);
			}
		}
	}

	const strikesForAutoImport = await app.prisma.queueCleanerStrike.findMany({
		where: { instanceId: instance.id },
	});
	const strikeMapForAutoImport = new Map(strikesForAutoImport.map((s) => [s.downloadId, s]));

	let autoImportAttemptsThisRun = 0;

	for (const item of cappedToRemove) {
		const observed = queueItemMap.get(item.id);
		const releaseSource = observed ? acquireQueueSourceAction(instance.userId, observed) : null;
		if (!releaseSource) {
			safetyDeferrals++;
			skipped.push({
				...item,
				reason:
					"Source identity is unavailable or another source action is still in progress; action deferred.",
			});
			continue;
		}
		try {
			const currentQueueItem = await revalidate(item);
			if (!currentQueueItem) continue;
			const isImportItem = item.rule === "import_pending" || item.rule === "import_blocked";
			const downloadId = downloadIdMap.get(item.id) ?? null;

			if (isImportItem && downloadId) {
				const itemIdStr = String(item.id);
				const priorStrike = strikeMapForAutoImport.get(itemIdStr);
				const downloadFingerprint = queueItemFingerprint(currentQueueItem)!;
				const existingStrike =
					priorStrike?.downloadFingerprint === downloadFingerprint ? priorStrike : undefined;

				const statusTexts = collectStatusTexts(currentQueueItem);

				const eligibility = evaluateAutoImportEligibility(
					statusTexts,
					config,
					existingStrike ?? null,
					now,
				);

				if (eligibility.eligible) {
					if (autoImportAttemptsThisRun >= MAX_AUTO_IMPORTS_PER_RUN) {
						safetyDeferrals++;
						skipped.push({
							...item,
							reason: "Per-run import budget exhausted; eligible source retained for a later run.",
						});
						continue;
					}
					log.info(
						{ category: "automatic-import-admission" },
						"Preparing automatic import; source retained until verified",
					);

					autoImportAttemptsThisRun++;
					const importResult = await attemptAutoImport(app, instance, downloadId, item.title, {
						queueId: item.id,
						queueFingerprint: downloadFingerprint,
						attemptOrdinal: (existingStrike?.importAttempts ?? 0) + 1,
						sourcePermit: releaseSource,
						currentQueueGate: async (_current, preparedOperationId) =>
							(await revalidate(item, preparedOperationId)) !== null,
					});
					// The shared lifecycle owns persistence and per-file reconciliation.
					// Acknowledgement, failure, or unavailable preparation never permits
					// this invocation to fall through to removal or increment twice.
					safetyDeferrals++;
					skipped.push({
						...item,
						reason: importResult.safetyBlocked
							? "Auto-import identity or media mapping, policy, or preparation is unavailable; source retained."
							: importResult.commandState === "pending"
								? "Auto-import command accepted but pending; source retained."
								: importResult.commandState === "failed"
									? "Auto-import command failed or partially completed; source retained for explicit review."
									: "Auto-import outcome or per-file completion is unverified; source retained. Observe import progress.",
					});
					continue;
				}
				log.debug(
					{ instanceId: instance.id, downloadId, reason: eligibility.reason },
					"Auto-import not eligible",
				);
			}

			// A preparation hint is never removal permission. Recheck the unconditional
			// source fence under the held source permit: policy/counter snapshots may
			// differ between fresh import admission and the removal fallthrough.
			let removalProtected = true;
			try {
				const sourceKey = queueDownloadKey(currentQueueItem);
				removalProtected =
					!sourceKey ||
					(await findImportSourceProtection(app.prisma, instance.userId, [sourceKey])).length > 0;
			} catch {
				// Unknown protection is not permission to delete or expose database detail.
			}
			if (removalProtected) {
				safetyDeferrals++;
				skipped.push({
					...item,
					reason:
						"Import protection prevents removal or is unavailable; source retained. Review import progress or resolve the source in ARR before cleanup.",
				});
				continue;
			}

			// Normal removal flow: no import's partial failure/non-submission authorizes deletion.
			try {
				const isTorrent = item.protocol === "torrent";
				const isFilePolicyRemoval = item.rule === "disallowed_file_extension";
				const useChangeCategory = !isFilePolicyRemoval && config.changeCategoryEnabled && isTorrent;
				if (isUnsafeRetainedTorrentAction(item, config)) {
					skipped.push({ ...item, reason: RETAINED_TORRENT_BLOCKLIST_ERROR });
					continue;
				}

				await client.queue.delete(item.id, {
					removeFromClient: isFilePolicyRemoval ? true : config.removeFromClient,
					blocklist: config.addToBlocklist,
					skipRedownload: !config.searchAfterRemoval,
					changeCategory: useChangeCategory,
				});
				cleaned.push(item);
			} catch (error) {
				const errMsg = getErrorMessage(error, "Unknown error");
				if (errMsg.includes("404") || errMsg.includes("Not Found")) {
					removeErrors++;
					skipped.push({
						...item,
						reason: "Removal outcome is unverified: target was unavailable.",
					});
				} else {
					removeErrors++;
					skipped.push({ ...item, reason: `Remove failed: ${errMsg}` });
					log.warn(
						{ err: error, itemId: item.id, title: item.title },
						"Failed to remove queue item",
					);
				}
			}
		} finally {
			releaseSource();
		}
	}

	// Clean up strike records for successfully removed items
	if (strikesToDeleteAfterRemoval.size > 0 && cleaned.length > 0) {
		const successfullyRemovedIds = new Set(cleaned.map((item) => String(item.id)));
		const strikeIdsToDelete: string[] = [];

		for (const [downloadId, strikeId] of strikesToDeleteAfterRemoval) {
			if (successfullyRemovedIds.has(downloadId)) {
				strikeIdsToDelete.push(strikeId);
			}
		}

		if (strikeIdsToDelete.length > 0) {
			try {
				await app.prisma.queueCleanerStrike.deleteMany({
					where: { id: { in: strikeIdsToDelete } },
				});
			} catch (error) {
				log.warn(
					{ err: error, strikeCount: strikeIdsToDelete.length },
					"Failed to clean up strike records after removal - will be cleaned on next run",
				);
			}
		}
	}

	const status = removeErrors > 0 || safetyDeferrals > 0 ? "partial" : "completed";
	const errorSuffix = removeErrors > 0 ? ` (${removeErrors} removal errors)` : "";
	const deferredSuffix =
		safetyDeferrals > 0
			? ` (${safetyDeferrals} action(s) deferred for unavailable or changed safety evidence)`
			: "";
	const warnSuffix = warned.length > 0 ? `, ${warned.length} warned` : "";
	const autoImportSuffix = autoImportSuccesses > 0 ? `, ${autoImportSuccesses} auto-imported` : "";

	const totalHandled = cleaned.length + autoImportSuccesses;

	return {
		itemsCleaned: totalHandled,
		itemsSkipped: skipped.length,
		itemsWarned: warned.length,
		cleanedItems: [...cleaned, ...autoImported],
		skippedItems: skipped,
		warnedItems: warned,
		isDryRun: false,
		status,
		message: `Removed ${cleaned.length} item(s) from queue${autoImportSuffix}${warnSuffix}${errorSuffix}${deferredSuffix}`,
	};
}

/**
 * Execute an enhanced dry-run preview for the preview modal.
 * Returns rich data including queue state, detailed item context, and rule breakdown.
 */
export async function executeEnhancedPreview(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: QueueCleanerConfig,
): Promise<EnhancedPreviewResult> {
	const client = app.arrClientFactory.create(instance) as QueueCapableClient;
	const now = new Date();
	let allowedFileExtensions: string[] = [];
	const instanceService = instance.service.toLowerCase() as
		| "sonarr"
		| "radarr"
		| "lidarr"
		| "readarr";

	// Parse whitelist patterns
	let whitelistPatterns: WhitelistPattern[] = [];
	if (config.whitelistEnabled && config.whitelistPatterns) {
		try {
			whitelistPatterns = JSON.parse(config.whitelistPatterns);
		} catch (error) {
			log.error(
				{ instanceId: instance.id, err: error },
				"Invalid whitelist patterns JSON - preview aborted for safety",
			);
			return {
				instanceId: instance.id,
				instanceLabel: instance.label,
				instanceService,
				instanceReachable: true,
				errorMessage:
					"Whitelist configuration is invalid. Please fix whitelist patterns in settings.",
				queueSummary: {
					totalItems: 0,
					downloading: 0,
					paused: 0,
					queued: 0,
					seeding: 0,
					importPending: 0,
					failed: 0,
				},
				wouldRemove: 0,
				wouldImport: 0,
				wouldWarn: 0,
				wouldSkip: 0,
				previewItems: [],
				ruleSummary: {},
				previewGeneratedAt: now.toISOString(),
				configSnapshot: {
					dryRunMode: config.dryRunMode,
					strikeSystemEnabled: config.strikeSystemEnabled,
					maxStrikes: config.maxStrikes,
					maxRemovalsPerRun: config.maxRemovalsPerRun,
				},
			};
		}
	}

	// Validate error patterns upfront
	if (config.errorPatternsEnabled && config.errorPatterns) {
		try {
			const parsed = JSON.parse(config.errorPatterns);
			if (!Array.isArray(parsed)) {
				throw new Error("Error patterns must be an array");
			}
		} catch (error) {
			log.error(
				{ instanceId: instance.id, err: error },
				"Invalid error patterns JSON - preview aborted for safety",
			);
			return {
				instanceId: instance.id,
				instanceLabel: instance.label,
				instanceService,
				instanceReachable: true,
				errorMessage:
					"Error patterns configuration is invalid. Please fix error patterns in settings.",
				queueSummary: {
					totalItems: 0,
					downloading: 0,
					paused: 0,
					queued: 0,
					seeding: 0,
					importPending: 0,
					failed: 0,
				},
				wouldRemove: 0,
				wouldImport: 0,
				wouldWarn: 0,
				wouldSkip: 0,
				previewItems: [],
				ruleSummary: {},
				previewGeneratedAt: now.toISOString(),
				configSnapshot: {
					dryRunMode: config.dryRunMode,
					strikeSystemEnabled: config.strikeSystemEnabled,
					maxStrikes: config.maxStrikes,
					maxRemovalsPerRun: config.maxRemovalsPerRun,
				},
			};
		}
	}

	if (config.fileExtensionAllowlistEnabled) {
		const parsed = parseAllowedFileExtensions(config.allowedFileExtensions);
		if (!parsed.ok || parsed.extensions.length === 0) {
			log.error(
				{ instanceId: instance.id },
				"Invalid torrent file allowlist - preview aborted for safety",
			);
			return {
				instanceId: instance.id,
				instanceLabel: instance.label,
				instanceService,
				instanceReachable: true,
				errorMessage:
					"Torrent file allowlist configuration is invalid. Add at least one valid extension.",
				queueSummary: {
					totalItems: 0,
					downloading: 0,
					paused: 0,
					queued: 0,
					seeding: 0,
					importPending: 0,
					failed: 0,
				},
				wouldRemove: 0,
				wouldImport: 0,
				wouldWarn: 0,
				wouldSkip: 0,
				previewItems: [],
				ruleSummary: {},
				previewGeneratedAt: now.toISOString(),
				configSnapshot: {
					dryRunMode: config.dryRunMode,
					strikeSystemEnabled: config.strikeSystemEnabled,
					maxStrikes: config.maxStrikes,
					maxRemovalsPerRun: config.maxRemovalsPerRun,
				},
			};
		}
		allowedFileExtensions = parsed.extensions;
	}

	// Try to fetch queue
	// For Radarr, include items that can't be matched to a known movie.
	let queueRecords: Array<RawQueueItem & { id: number }>;

	try {
		queueRecords = await readCompleteQueue(client, instance.service);
	} catch (error) {
		const errorMessage = getErrorMessage(error, "Unknown error");
		log.warn(
			{ err: error, instanceId: instance.id, instanceLabel: instance.label },
			"Failed to fetch queue for enhanced preview",
		);
		return {
			instanceId: instance.id,
			instanceLabel: instance.label,
			instanceService,
			instanceReachable: false,
			errorMessage,
			queueSummary: {
				totalItems: 0,
				downloading: 0,
				paused: 0,
				queued: 0,
				seeding: 0,
				importPending: 0,
				failed: 0,
			},
			wouldRemove: 0,
			wouldImport: 0,
			wouldWarn: 0,
			wouldSkip: 0,
			previewItems: [],
			ruleSummary: {},
			previewGeneratedAt: now.toISOString(),
			configSnapshot: {
				dryRunMode: config.dryRunMode,
				strikeSystemEnabled: config.strikeSystemEnabled,
				maxStrikes: config.maxStrikes,
				maxRemovalsPerRun: config.maxRemovalsPerRun,
			},
		};
	}

	const queueSummary = calculateQueueSummary(queueRecords);
	const previewItems: EnhancedPreviewItem[] = [];
	const ruleSummary: Record<string, number> = {};
	const isSonarrPreview = instance.service === "SONARR";
	const filePolicyResults = await evaluateFilePolicyForEligibleItems(
		app,
		instance,
		config,
		queueRecords,
		now,
		whitelistPatterns,
		allowedFileExtensions,
	);
	const previewGateReasons = await resolveSafetyGateReasons(
		app,
		instance,
		config,
		queueRecords,
		now,
		whitelistPatterns,
	);

	const existingStrikes = await app.prisma.queueCleanerStrike.findMany({
		where: { instanceId: instance.id },
	});
	const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));
	const importReceipts = await app.prisma.queueCleanerImportReceipt.findMany({
		where: { instance: { userId: instance.userId }, state: { in: PROTECTED_IMPORT_STATES } },
	});
	for (const receipt of importReceipts) {
		for (const current of queueRecords.filter(
			(item) => queueDownloadKey(item) === receipt.downloadKey,
		)) {
			previewGateReasons.set(
				String(current.id),
				"Auto-import receipt requires provider reconciliation; source retained",
			);
		}
	}

	for (const item of queueRecords) {
		const id = typeof item.id === "number" ? item.id : 0;
		const title = typeof item.title === "string" ? item.title : "Unknown";
		const added = parseDate(item.added);
		const ageMins = added ? Math.round((now.getTime() - added.getTime()) / (60 * 1000)) : 0;
		const size = typeof item.size === "number" ? item.size : 0;
		const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : 0;
		const progress = size > 0 ? Math.round(((size - sizeleft) / size) * 100) : 0;

		// Age guard check
		if (added && ageMins < config.minQueueAgeMins) {
			previewItems.push({
				id,
				title,
				action: "skip",
				rule: "too_young",
				reason: `In queue for ${ageMins}m (min: ${config.minQueueAgeMins}m)`,
				detailedReason:
					`This item has only been in the queue for ${ageMins} minutes. ` +
					`Items must be at least ${config.minQueueAgeMins} minutes old before being evaluated.`,
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
			continue;
		}

		// Tag/profile pre-filters (skip items that don't match)
		if (shouldSkipByTagFilter(item, config) || shouldSkipByProfileFilter(item, config)) {
			previewItems.push({
				id,
				title,
				action: "skip",
				rule: "healthy",
				reason: "Excluded by tag/profile filter",
				detailedReason:
					"This item was excluded from evaluation because it does not match the configured tag or quality profile filters.",
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
			continue;
		}

		// Skip future episodes (Sonarr only)
		if (isSonarrPreview && config.skipFutureEpisodes && isFutureEpisode(item, now)) {
			ruleSummary.future_episode = (ruleSummary.future_episode ?? 0) + 1;
			previewItems.push({
				id,
				title,
				action: "skip",
				rule: "future_episode",
				reason: "Future episode (hasn't aired yet)",
				detailedReason:
					"This download is for an episode that hasn't aired yet. " +
					"Future episodes are skipped to prevent the cleaner from removing pre-grabbed downloads. " +
					"Disable 'Skip future episodes' in settings to include these items.",
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
			continue;
		}

		// Whitelist check
		if (whitelistPatterns.length > 0) {
			const whitelistResult = checkWhitelist(item, whitelistPatterns);
			if (whitelistResult.matched) {
				ruleSummary.whitelisted = (ruleSummary.whitelisted ?? 0) + 1;
				previewItems.push({
					id,
					title,
					action: "whitelist",
					rule: "whitelisted",
					reason: whitelistResult.reason ?? "Matches whitelist",
					detailedReason: generateDetailedReason("whitelisted", item, config, now),
					queueAge: ageMins,
					size,
					sizeleft,
					progress,
					protocol: typeof item.protocol === "string" ? item.protocol : undefined,
					indexer: typeof item.indexer === "string" ? item.indexer : undefined,
					downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
					status:
						typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
					downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
				});
				continue;
			}
		}

		// Evaluate against rules. A file-policy violation takes precedence
		// because its removal semantics must delete the full torrent payload.
		const filePolicy = filePolicyResults.get(item);
		const standardEvaluation = evaluateQueueItem(item, config, now);
		if (filePolicy?.status === "deferred") {
			ruleSummary.file_policy_deferred = (ruleSummary.file_policy_deferred ?? 0) + 1;
			previewItems.push({
				id,
				title,
				action: "skip",
				rule: "file_policy_deferred",
				reason: filePolicy.reason,
				detailedReason:
					`${filePolicy.reason}. No removal decision was made; ` +
					"the cleaner will retry on a later run.",
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
			continue;
		}
		const evaluation =
			filePolicy?.status === "violation"
				? {
						rule: "disallowed_file_extension" as const,
						reason: filePolicy.reason,
					}
				: standardEvaluation;

		if (evaluation) {
			ruleSummary[evaluation.rule] = (ruleSummary[evaluation.rule] ?? 0) + 1;
			const gateReason = previewGateReasons.get(String(id));
			if (gateReason) {
				previewItems.push({
					id,
					title,
					action: "skip",
					rule: evaluation.rule,
					reason: `${evaluation.reason} — skipped (${gateReason})`,
					detailedReason:
						`${generateDetailedReason(evaluation.rule, item, config, now)} ` +
						`The action is currently blocked by ${gateReason}.`,
					queueAge: ageMins,
					size,
					sizeleft,
					progress,
					protocol: typeof item.protocol === "string" ? item.protocol : undefined,
					indexer: typeof item.indexer === "string" ? item.indexer : undefined,
					downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
					status:
						typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
					downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
				});
				continue;
			}

			const priorStrike = strikeMap.get(String(id));
			const existingStrike =
				priorStrike?.downloadFingerprint === queueItemFingerprint(item) ? priorStrike : undefined;
			const simulatedStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;
			const wouldTriggerRemoval =
				!config.strikeSystemEnabled || simulatedStrikeCount >= config.maxStrikes;
			if (
				wouldTriggerRemoval &&
				isUnsafeRetainedTorrentAction(
					{
						protocol: typeof item.protocol === "string" ? item.protocol : undefined,
						rule: evaluation.rule,
					},
					config,
				)
			) {
				previewItems.push({
					id,
					title,
					action: "skip",
					rule: evaluation.rule,
					reason: RETAINED_TORRENT_BLOCKLIST_ERROR,
					detailedReason: `${generateDetailedReason(evaluation.rule, item, config, now)} ${RETAINED_TORRENT_BLOCKLIST_ERROR}.`,
					queueAge: ageMins,
					size,
					sizeleft,
					progress,
					protocol: typeof item.protocol === "string" ? item.protocol : undefined,
					indexer: typeof item.indexer === "string" ? item.indexer : undefined,
					downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
					status:
						typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
					downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
				});
				continue;
			}

			let autoImportEligible: boolean | undefined;
			let autoImportReason: string | undefined;

			if (evaluation.rule === "import_pending" || evaluation.rule === "import_blocked") {
				const statusTexts = collectStatusTexts(item);
				const eligibility = evaluateAutoImportEligibility(
					statusTexts,
					config,
					existingStrike ?? null,
					now,
				);
				autoImportEligible =
					eligibility.eligible && typeof item.downloadId === "string" && !!item.downloadId;
				autoImportReason = eligibility.reason;
			}

			previewItems.push({
				id,
				title,
				action: !wouldTriggerRemoval ? "warn" : autoImportEligible ? "import" : "remove",
				rule: evaluation.rule,
				reason: evaluation.reason,
				detailedReason:
					wouldTriggerRemoval && autoImportEligible
						? IMPORT_PREVIEW_DETAIL
						: generateDetailedReason(evaluation.rule, item, config, now),
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
				strikeInfo: config.strikeSystemEnabled
					? {
							currentStrikes: simulatedStrikeCount,
							maxStrikes: config.maxStrikes,
							wouldTriggerRemoval,
						}
					: undefined,
				autoImportEligible,
				autoImportReason,
			});
		} else {
			previewItems.push({
				id,
				title,
				action: "skip",
				rule: "healthy",
				reason: "No issues detected",
				detailedReason:
					"This download is progressing normally and doesn't match any removal rules.",
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status:
					typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
		}
	}

	const plannedItems = applyPreviewActionLimits(previewItems, config);
	const wouldRemove = plannedItems.filter((i) => i.action === "remove").length;
	const wouldImport = plannedItems.filter((i) => i.action === "import").length;
	const wouldWarn = plannedItems.filter((i) => i.action === "warn").length;
	const wouldSkip = plannedItems.filter(
		(i) => i.action === "skip" || i.action === "whitelist",
	).length;

	return {
		instanceId: instance.id,
		instanceLabel: instance.label,
		instanceService,
		instanceReachable: true,
		queueSummary,
		wouldRemove,
		wouldImport,
		wouldWarn,
		wouldSkip,
		previewItems: plannedItems,
		ruleSummary,
		previewGeneratedAt: now.toISOString(),
		configSnapshot: {
			dryRunMode: config.dryRunMode,
			strikeSystemEnabled: config.strikeSystemEnabled,
			maxStrikes: config.maxStrikes,
			maxRemovalsPerRun: config.maxRemovalsPerRun,
		},
	};
}
