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
import { loggers } from "../logger.js";
import type { QueueCleanerConfig, ServiceInstance } from "../prisma.js";
import {
	AUTO_IMPORT_DELAY_MS,
	MAX_AUTO_IMPORTS_PER_RUN,
	type WhitelistPattern,
	type CleanerResultItem,
	type EnhancedPreviewItem,
	type CleanerResult,
	type EnhancedPreviewResult,
} from "./constants.js";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { delay } from "../utils/delay.js";
import { type RawQueueItem, parseDate, collectStatusTexts, checkWhitelist } from "./queue-item-utils.js";
import { evaluateQueueItem } from "./rule-evaluators.js";
import { evaluateAutoImportEligibility, attemptAutoImport } from "./auto-import-handler.js";
import { generateDetailedReason, calculateQueueSummary } from "./cleaner-formatters.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.queueCleaner;

// Re-export types for external use
export type {
	CleanerRule,
	PreviewRule,
	CleanerResultItem,
	EnhancedPreviewItem,
	QueueStateSummary,
	CleanerResult,
	EnhancedPreviewResult,
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
	const client = app.arrClientFactory.create(instance) as QueueCapableClient;
	const now = new Date();

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
				message: "Whitelist configuration is invalid. Please fix whitelist patterns before running.",
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
				message: "Error patterns configuration is invalid. Please fix error patterns before running.",
			};
		}
	}

	// Fetch queue
	let queueRecords: RawQueueItem[];
	try {
		const queue = await client.queue.get({ pageSize: 1000 });
		queueRecords = (queue.records ?? []) as RawQueueItem[];
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

	if (queueRecords.length === 0) {
		return {
			itemsCleaned: 0,
			itemsSkipped: 0,
			itemsWarned: 0,
			cleanedItems: [],
			skippedItems: [],
			warnedItems: [],
			isDryRun: config.dryRunMode,
			status: "completed",
			message: "Queue is empty",
		};
	}

	const matched: CleanerResultItem[] = [];
	const skipped: CleanerResultItem[] = [];
	const queueItemIds = new Set<string>();

	for (const item of queueRecords) {
		const id = typeof item.id === "number" ? item.id : 0;
		const idStr = String(id);
		const title = typeof item.title === "string" ? item.title : "Unknown";
		const added = parseDate(item.added);

		queueItemIds.add(idStr);

		// Age guard
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			if (ageMins < config.minQueueAgeMins) {
				continue;
			}
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

		const evaluation = evaluateQueueItem(item, config, now);
		if (evaluation) {
			const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : undefined;
			matched.push({ id, title, reason: evaluation.reason, rule: evaluation.rule, protocol });
		}
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
						const existingStrike = strikeMap.get(itemIdStr);
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
							if (existingStrike) {
								await tx.queueCleanerStrike.update({
									where: { id: existingStrike.id },
									data: {
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

	// Cap matches at maxRemovalsPerRun
	const cappedToRemove = toRemove.slice(0, config.maxRemovalsPerRun);
	const cappedSkip = toRemove.slice(config.maxRemovalsPerRun);

	for (const item of cappedSkip) {
		skipped.push({
			...item,
			reason: `Exceeded max removals per run (${config.maxRemovalsPerRun})`,
		});
	}

	// Dry run mode: return preview
	if (config.dryRunMode) {
		const dryRunWarned: CleanerResultItem[] = [];
		let dryRunToRemove: CleanerResultItem[] = [];

		if (config.strikeSystemEnabled) {
			const existingStrikes = await app.prisma.queueCleanerStrike.findMany({
				where: { instanceId: instance.id },
			});
			const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));

			for (const item of matched) {
				const existingStrike = strikeMap.get(String(item.id));
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

		const previewRemove = dryRunToRemove.slice(0, config.maxRemovalsPerRun);

		return {
			itemsCleaned: 0,
			itemsSkipped: previewRemove.length + skipped.length,
			itemsWarned: dryRunWarned.length,
			cleanedItems: [],
			skippedItems: [
				...previewRemove.map((i) => ({
					...i,
					reason: `[DRY RUN] Would remove: ${i.reason}${i.strikeCount ? ` (strike ${i.strikeCount}/${i.maxStrikes})` : ""}`,
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
				previewRemove.length > 0
					? `Dry run: would remove ${previewRemove.length} item(s)${dryRunWarned.length > 0 ? `, warn ${dryRunWarned.length}` : ""}`
					: dryRunWarned.length > 0
						? `Dry run: would warn ${dryRunWarned.length} item(s)`
						: "Dry run: no items match removal rules",
		};
	}

	// Live mode: remove items (with auto-import support)
	let removeErrors = 0;
	let autoImportSuccesses = 0;
	const cleaned: CleanerResultItem[] = [];
	const autoImported: CleanerResultItem[] = [];

	const downloadIdMap = new Map<number, string>();
	const queueItemMap = new Map<number, RawQueueItem>();
	for (const queueItem of queueRecords) {
		const queueId = typeof queueItem.id === "number" ? queueItem.id : 0;
		const downloadId = typeof queueItem.downloadId === "string" ? queueItem.downloadId : null;
		if (queueId > 0) {
			queueItemMap.set(queueId, queueItem);
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
		const isImportItem = item.rule === "import_pending" || item.rule === "import_blocked";
		const downloadId = downloadIdMap.get(item.id) ?? null;

		if (isImportItem && downloadId && autoImportAttemptsThisRun < MAX_AUTO_IMPORTS_PER_RUN) {
			const itemIdStr = String(item.id);
			const existingStrike = strikeMapForAutoImport.get(itemIdStr);

			const fullQueueItem = queueItemMap.get(item.id);
			const statusTexts = fullQueueItem ? collectStatusTexts(fullQueueItem) : [];

			const eligibility = evaluateAutoImportEligibility(
				statusTexts,
				config,
				existingStrike ?? null,
				now,
			);

			if (eligibility.eligible) {
				log.info(
					{ instanceId: instance.id, downloadId, itemTitle: item.title },
					"Attempting auto-import before removal",
				);

				autoImportAttemptsThisRun++;
				const importResult = await attemptAutoImport(app, instance, downloadId, item.title);

				if (AUTO_IMPORT_DELAY_MS > 0) {
					await delay(AUTO_IMPORT_DELAY_MS);
				}

				// Update strike record with import attempt info
				try {
					if (existingStrike) {
						await app.prisma.queueCleanerStrike.update({
							where: { id: existingStrike.id },
							data: {
								importAttempts: existingStrike.importAttempts + 1,
								lastImportAttempt: now,
								lastImportError: importResult.success ? null : (importResult.error ?? "Unknown error"),
							},
						});
					} else {
						await app.prisma.queueCleanerStrike.create({
							data: {
								instanceId: instance.id,
								downloadId: itemIdStr,
								downloadTitle: item.title,
								strikeCount: 0,
								lastRule: item.rule,
								lastReason: item.reason,
								importAttempts: 1,
								lastImportAttempt: now,
								lastImportError: importResult.success ? null : (importResult.error ?? "Unknown error"),
							},
						});
					}
				} catch (dbError) {
					log.warn(
						{ err: dbError, instanceId: instance.id, downloadId },
						"Failed to update import attempt tracking",
					);
				}

				if (importResult.success) {
					autoImportSuccesses++;
					autoImported.push({
						...item,
						reason: `Auto-imported successfully (was: ${item.reason})`,
					});
					continue;
				}
					log.info(
						{ instanceId: instance.id, downloadId, error: importResult.error },
						"Auto-import failed, falling back to removal",
					);
			} else {
				log.debug(
					{ instanceId: instance.id, downloadId, reason: eligibility.reason },
					"Auto-import not eligible",
				);
			}
		}

		// Normal removal flow
		try {
			const isTorrent = item.protocol === "torrent";
			const useChangeCategory = config.changeCategoryEnabled && isTorrent;

			await client.queue.delete(item.id, {
				removeFromClient: config.removeFromClient,
				blocklist: config.addToBlocklist,
				skipRedownload: !config.searchAfterRemoval,
				changeCategory: useChangeCategory,
			});
			cleaned.push(item);
		} catch (error) {
			const errMsg = getErrorMessage(error, "Unknown error");
			if (errMsg.includes("404") || errMsg.includes("Not Found")) {
				cleaned.push({ ...item, reason: `${item.reason} (already removed)` });
			} else {
				removeErrors++;
				skipped.push({ ...item, reason: `Remove failed: ${errMsg}` });
				log.warn({ err: error, itemId: item.id, title: item.title }, "Failed to remove queue item");
			}
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

	const status = removeErrors > 0 ? "partial" : "completed";
	const errorSuffix = removeErrors > 0 ? ` (${removeErrors} removal errors)` : "";
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
		message: `Removed ${cleaned.length} item(s) from queue${autoImportSuffix}${warnSuffix}${errorSuffix}`,
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
	const instanceService = instance.service.toLowerCase() as "sonarr" | "radarr" | "lidarr" | "readarr";

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
				errorMessage: "Whitelist configuration is invalid. Please fix whitelist patterns in settings.",
				queueSummary: { totalItems: 0, downloading: 0, paused: 0, queued: 0, seeding: 0, importPending: 0, failed: 0 },
				wouldRemove: 0,
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
				errorMessage: "Error patterns configuration is invalid. Please fix error patterns in settings.",
				queueSummary: { totalItems: 0, downloading: 0, paused: 0, queued: 0, seeding: 0, importPending: 0, failed: 0 },
				wouldRemove: 0,
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

	// Try to fetch queue
	let queueRecords: RawQueueItem[];

	try {
		const queue = await client.queue.get({ pageSize: 1000 });
		queueRecords = (queue.records ?? []) as RawQueueItem[];
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
			queueSummary: { totalItems: 0, downloading: 0, paused: 0, queued: 0, seeding: 0, importPending: 0, failed: 0 },
			wouldRemove: 0,
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

	const existingStrikes = await app.prisma.queueCleanerStrike.findMany({
		where: { instanceId: instance.id },
	});
	const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));

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
				status: typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
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
					status: typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
					downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
				});
				continue;
			}
		}

		// Evaluate against rules
		const evaluation = evaluateQueueItem(item, config, now);

		if (evaluation) {
			ruleSummary[evaluation.rule] = (ruleSummary[evaluation.rule] ?? 0) + 1;

			const existingStrike = strikeMap.get(String(id));
			const simulatedStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;
			const wouldTriggerRemoval =
				!config.strikeSystemEnabled || simulatedStrikeCount >= config.maxStrikes;

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
				autoImportEligible = eligibility.eligible;
				autoImportReason = eligibility.reason;
			}

			previewItems.push({
				id,
				title,
				action: config.strikeSystemEnabled ? (wouldTriggerRemoval ? "remove" : "warn") : "remove",
				rule: evaluation.rule,
				reason: evaluation.reason,
				detailedReason: generateDetailedReason(evaluation.rule, item, config, now),
				queueAge: ageMins,
				size,
				sizeleft,
				progress,
				protocol: typeof item.protocol === "string" ? item.protocol : undefined,
				indexer: typeof item.indexer === "string" ? item.indexer : undefined,
				downloadClient: typeof item.downloadClient === "string" ? item.downloadClient : undefined,
				status: typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
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
				status: typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : undefined,
				downloadId: typeof item.downloadId === "string" ? item.downloadId : undefined,
			});
		}
	}

	const wouldRemove = previewItems.filter((i) => i.action === "remove").length;
	const wouldWarn = previewItems.filter((i) => i.action === "warn").length;
	const wouldSkip = previewItems.filter(
		(i) => i.action === "skip" || i.action === "whitelist",
	).length;

	return {
		instanceId: instance.id,
		instanceLabel: instance.label,
		instanceService,
		instanceReachable: true,
		queueSummary,
		wouldRemove: Math.min(wouldRemove, config.maxRemovalsPerRun),
		wouldWarn,
		wouldSkip: wouldSkip + Math.max(0, wouldRemove - config.maxRemovalsPerRun),
		previewItems,
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
