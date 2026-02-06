import type { FastifyInstance } from "fastify";
import { loggers } from "../logger.js";
import type { QueueCleanerConfig, QueueCleanerStrike, ServiceInstance } from "../prisma.js";
import {
	FAILURE_KEYWORDS,
	IMPORT_BLOCKED_SAFE_KEYWORDS,
	IMPORT_BLOCKED_REVIEW_KEYWORDS,
	IMPORT_BLOCKED_TECHNICAL_KEYWORDS,
	IMPORT_PENDING_RECOVERABLE_KEYWORDS,
	STALL_KEYWORDS,
	AUTO_IMPORT_SAFE_KEYWORDS,
	AUTO_IMPORT_NEVER_KEYWORDS,
	type ImportBlockCleanupLevel,
	type ImportBlockPatternMode,
	type WhitelistPattern,
	type CleanerRule,
	type PreviewRule,
	type CleanerResultItem,
	type EnhancedPreviewItem,
	type QueueStateSummary,
	type CleanerResult,
	type EnhancedPreviewResult,
} from "./constants.js";
import {
	autoImportByDownloadIdWithSdk,
	ManualImportError,
} from "../../routes/manual-import-utils.js";
import type { AutoImportResult } from "@arr/shared";

const log = loggers.queueCleaner;

// Re-export types for external use (EnhancedPreviewResult now comes from @arr/shared)
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
 * Raw queue item shape from the ARR API.
 * This interface documents expected fields but uses `unknown` for runtime safety.
 * All field access is guarded with explicit type checks in the codebase.
 */
interface RawQueueItem {
	id?: unknown;
	title?: unknown;
	added?: unknown;
	size?: unknown;
	sizeleft?: unknown;
	estimatedCompletionTime?: unknown;
	trackedDownloadStatus?: unknown;
	trackedDownloadState?: unknown;
	statusMessages?: unknown;
	errorMessage?: unknown;
	indexer?: unknown;
	protocol?: unknown;
	downloadClient?: unknown;
	downloadId?: unknown;
	tags?: unknown;
	/** Allow other properties we don't explicitly handle */
	[key: string]: unknown;
}

/**
 * Safely parse a date value from unknown, returning null if invalid.
 */
function parseDate(value: unknown): Date | null {
	if (!value) return null;
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	return null;
}

/**
 * Collect all status text from a queue item for keyword matching.
 */
function collectStatusTexts(item: RawQueueItem): string[] {
	const results: string[] = [];

	if (Array.isArray(item.statusMessages)) {
		for (const entry of item.statusMessages) {
			if (entry && typeof entry === "object") {
				if (typeof entry.title === "string" && entry.title.trim()) {
					results.push(entry.title.trim());
				}
				if (Array.isArray(entry.messages)) {
					for (const msg of entry.messages) {
						if (typeof msg === "string" && msg.trim()) {
							results.push(msg.trim());
						}
					}
				}
			}
		}
	}

	if (typeof item.errorMessage === "string" && item.errorMessage.trim()) {
		results.push(item.errorMessage.trim());
	}

	return results;
}

/**
 * Check if any status text matches the given keywords (case-insensitive).
 */
function matchesKeywords(texts: string[], keywords: readonly string[]): string | null {
	for (const text of texts) {
		const lower = text.toLowerCase();
		for (const keyword of keywords) {
			if (lower.includes(keyword)) {
				return text;
			}
		}
	}
	return null;
}

/**
 * Check if a queue item matches any whitelist pattern.
 */
function checkWhitelist(
	item: RawQueueItem,
	patterns: WhitelistPattern[],
): { matched: boolean; reason?: string } {
	for (const pattern of patterns) {
		if (!pattern.pattern || !pattern.pattern.trim()) continue;
		const lowerPattern = pattern.pattern.toLowerCase().trim();

		switch (pattern.type) {
			case "tracker": {
				// Check indexer name
				const indexer = typeof item.indexer === "string" ? item.indexer.toLowerCase() : "";
				if (indexer.includes(lowerPattern)) {
					return { matched: true, reason: `Tracker matches: ${pattern.pattern}` };
				}
				break;
			}
			case "tag": {
				// Check item tags array (from the media, not the download)
				if (Array.isArray(item.tags)) {
					for (const tag of item.tags) {
						const tagStr = typeof tag === "string" ? tag : (tag?.label ?? "");
						if (tagStr.toLowerCase().includes(lowerPattern)) {
							return { matched: true, reason: `Tag matches: ${pattern.pattern}` };
						}
					}
				}
				break;
			}
			case "category": {
				// Check download client or category
				const downloadClient =
					typeof item.downloadClient === "string" ? item.downloadClient.toLowerCase() : "";
				const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : "";
				if (downloadClient.includes(lowerPattern) || protocol.includes(lowerPattern)) {
					return { matched: true, reason: `Category matches: ${pattern.pattern}` };
				}
				break;
			}
			case "title": {
				// Check title
				const title = typeof item.title === "string" ? item.title.toLowerCase() : "";
				if (title.includes(lowerPattern)) {
					return { matched: true, reason: `Title matches: ${pattern.pattern}` };
				}
				break;
			}
		}
	}
	return { matched: false };
}

/**
 * Check if a queue item should be removed due to seeding timeout.
 * Note: Only applies to torrents - usenet downloads don't seed.
 */
function evaluateSeedingTimeout(
	item: RawQueueItem,
	config: QueueCleanerConfig,
	now: Date,
): { rule: "seeding_timeout"; reason: string } | null {
	if (!config.seedingTimeoutEnabled) return null;

	// Seeding timeout only applies to torrents - usenet doesn't seed
	const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : "";
	if (protocol === "usenet") return null;

	const status =
		typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus.toLowerCase() : "";
	const state =
		typeof item.trackedDownloadState === "string" ? item.trackedDownloadState.toLowerCase() : "";
	const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : -1;

	// Check if item is in seeding/completed state
	// sizeleft === 0 means download is complete
	// importPending means waiting for import (seeding)
	const isSeeding =
		sizeleft === 0 || status === "seeding" || state === "importpending" || state === "importing";

	if (!isSeeding) return null;

	// Calculate time since added to queue
	const added = parseDate(item.added);
	if (!added) return null;

	const hoursInQueue = (now.getTime() - added.getTime()) / (1000 * 60 * 60);

	if (hoursInQueue >= config.seedingTimeoutHours) {
		return {
			rule: "seeding_timeout",
			reason: `Seeding for ${Math.floor(hoursInQueue)}h (limit: ${config.seedingTimeoutHours}h)`,
		};
	}

	return null;
}

/**
 * Check if status texts match any custom import block patterns.
 * Used for Include/Exclude pattern matching mode.
 */
function matchesCustomImportBlockPatterns(
	statusTexts: string[],
	patterns: string[],
): { matched: boolean; pattern?: string } {
	const allText = statusTexts.join(" ").toLowerCase();

	for (const pattern of patterns) {
		if (typeof pattern !== "string" || !pattern.trim()) continue;
		const lowerPattern = pattern.toLowerCase().trim();

		if (allText.includes(lowerPattern)) {
			return { matched: true, pattern };
		}
	}
	return { matched: false };
}

/**
 * Parse JSON array of custom patterns from config, with error handling.
 */
function parseCustomPatterns(patternsJson: string | null, instanceId?: string): string[] {
	if (!patternsJson) return [];
	try {
		const parsed = JSON.parse(patternsJson);
		return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
	} catch (error) {
		log.warn({ instanceId, err: error }, "Invalid custom import block patterns JSON - using empty list");
		return [];
	}
}

/**
 * Evaluate import blocked/pending items using combined pattern matching approach.
 *
 * Mode behavior:
 * - "defaults": Use categorized keywords (SAFE/REVIEW/TECHNICAL) based on cleanup level
 * - "include": ONLY clean if custom patterns match (ignores category defaults)
 * - "exclude": Use category defaults BUT skip items matching exclusion patterns
 */
function evaluateImportBlockState(
	statusTexts: string[],
	config: QueueCleanerConfig,
	stateType: "blocked" | "pending",
): { rule: "import_blocked" | "import_pending"; reason: string } | null {
	// Get config values with defaults
	const cleanupLevel: ImportBlockCleanupLevel =
		(config as Record<string, unknown>).importBlockCleanupLevel as ImportBlockCleanupLevel ??
		"safe";
	const patternMode: ImportBlockPatternMode =
		(config as Record<string, unknown>).importBlockPatternMode as ImportBlockPatternMode ??
		"defaults";
	const customPatterns = parseCustomPatterns(
		(config as Record<string, unknown>).importBlockPatterns as string | null,
		config.instanceId,
	);

	// Determine the rule type based on state
	const rule: "import_blocked" | "import_pending" =
		stateType === "blocked" ? "import_blocked" : "import_pending";
	const prefix = stateType === "blocked" ? "Import blocked" : "Import pending";

	// MODE: "include" - ONLY clean if custom patterns match
	if (patternMode === "include" && customPatterns.length > 0) {
		const customMatch = matchesCustomImportBlockPatterns(statusTexts, customPatterns);
		if (customMatch.matched) {
			return {
				rule,
				reason: `${prefix} (matched pattern): ${customMatch.pattern}`,
			};
		}
		// No custom pattern matched - don't clean
		return null;
	}

	// MODE: "exclude" - Check if exclusion patterns match first
	if (patternMode === "exclude" && customPatterns.length > 0) {
		const exclusionMatch = matchesCustomImportBlockPatterns(statusTexts, customPatterns);
		if (exclusionMatch.matched) {
			// User wants to protect this item - don't clean
			return null;
		}
		// No exclusion matched - fall through to defaults
	}

	// MODE: "defaults" (or "exclude" that didn't match) - Use categorized keywords
	// Check categories in order of cleanup safety

	// SAFE keywords - always clean these
	const safeMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_SAFE_KEYWORDS);
	if (safeMatch) {
		return {
			rule,
			reason: `${prefix} (safe to remove): ${safeMatch}`,
		};
	}

	// REVIEW keywords - only clean on moderate/aggressive
	const reviewMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_REVIEW_KEYWORDS);
	if (reviewMatch) {
		if (cleanupLevel === "moderate" || cleanupLevel === "aggressive") {
			return {
				rule,
				reason: `${prefix} (needs review): ${reviewMatch}`,
			};
		}
		// Skip in safe mode
		return null;
	}

	// TECHNICAL keywords - only clean on aggressive
	const technicalMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_TECHNICAL_KEYWORDS);
	if (technicalMatch) {
		if (cleanupLevel === "aggressive") {
			return {
				rule,
				reason: `${prefix} (technical): ${technicalMatch}`,
			};
		}
		// Skip in safe/moderate mode
		return null;
	}

	// Unknown reason - use status text, treat as review-level
	const statusSummary =
		statusTexts.length > 0 ? statusTexts[0] : "requires manual intervention";
	if (cleanupLevel === "moderate" || cleanupLevel === "aggressive") {
		return {
			rule,
			reason: `${prefix}: ${statusSummary}`,
		};
	}

	// Unknown blocks skipped in safe mode
	return null;
}

/**
 * Evaluate a single queue item against all cleaner rules.
 * Returns the matching rule and reason, or null if no rule matches.
 */
function evaluateQueueItem(
	item: RawQueueItem,
	config: QueueCleanerConfig,
	now: Date,
): { rule: CleanerResultItem["rule"]; reason: string } | null {
	const statusTexts = collectStatusTexts(item);
	const trackedState = (
		typeof item.trackedDownloadState === "string" ? item.trackedDownloadState : ""
	).toLowerCase();
	const trackedStatus = (
		typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : ""
	).toLowerCase();

	// Rule 1: Failed downloads
	if (config.failedEnabled) {
		if (
			trackedState === "importfailed" ||
			trackedStatus === "error" ||
			trackedState.includes("failed")
		) {
			return {
				rule: "failed",
				reason: `Download failed (state: ${trackedState || trackedStatus})`,
			};
		}

		const failureMatch = matchesKeywords(statusTexts, FAILURE_KEYWORDS);
		if (failureMatch) {
			return { rule: "failed", reason: `Failed: ${failureMatch}` };
		}
	}

	// Rule 2: Stalled downloads
	if (config.stalledEnabled) {
		// Check stall keywords
		if (trackedStatus === "warning") {
			const stallMatch = matchesKeywords(statusTexts, STALL_KEYWORDS);
			if (stallMatch) {
				return { rule: "stalled", reason: `Stalled: ${stallMatch}` };
			}
		}

		// Check time-based stall (no progress for stalledThresholdMins)
		const added = parseDate(item.added);
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			const size = typeof item.size === "number" ? item.size : 0;
			const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : 0;

			// If download hasn't started (sizeleft == size) and it's been running longer than threshold
			if (size > 0 && sizeleft >= size && ageMins > config.stalledThresholdMins) {
				return {
					rule: "stalled",
					reason: `No progress for ${Math.round(ageMins)} minutes (threshold: ${config.stalledThresholdMins}m)`,
				};
			}
		}
	}

	// Rule 3: Slow downloads
	if (config.slowEnabled) {
		const added = parseDate(item.added);
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);

			// Only check speed after grace period
			if (ageMins > config.slowGracePeriodMins) {
				const size = typeof item.size === "number" ? item.size : 0;
				const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : 0;
				const downloaded = size - sizeleft;
				const elapsedSeconds = (now.getTime() - added.getTime()) / 1000;

				if (elapsedSeconds > 0 && size > 0 && sizeleft > 0) {
					const speedKBs = downloaded / 1024 / elapsedSeconds;

					if (speedKBs < config.slowSpeedThreshold) {
						return {
							rule: "slow",
							reason: `Speed: ${speedKBs.toFixed(1)} KB/s (threshold: ${config.slowSpeedThreshold} KB/s)`,
						};
					}
				}
			}
		}
	}

	// Rule 4: Error patterns
	if (config.errorPatternsEnabled && config.errorPatterns) {
		let patterns: string[] = [];
		try {
			patterns = JSON.parse(config.errorPatterns);
		} catch (error) {
			log.warn({ instanceId: config.instanceId, err: error }, "Invalid error patterns JSON - skipping error pattern rule");
		}

		if (patterns.length > 0) {
			const allText = statusTexts.join(" ").toLowerCase();
			const errorMsg = typeof item.errorMessage === "string" ? item.errorMessage.toLowerCase() : "";

			for (const pattern of patterns) {
				if (typeof pattern !== "string" || !pattern.trim()) continue;
				const lowerPattern = pattern.toLowerCase().trim();
				if (allText.includes(lowerPattern) || errorMsg.includes(lowerPattern)) {
					return {
						rule: "error_pattern",
						reason: `Matched error pattern: "${pattern}"`,
					};
				}
			}
		}
	}

	// Rule 5: Import blocked detection with combined pattern matching
	// Uses importPendingEnabled flag (same toggle controls both pending and blocked)
	const importBlockEnabled = (config as Record<string, unknown>).importPendingEnabled ?? true;
	if (importBlockEnabled && trackedState === "importblocked") {
		const importBlockResult = evaluateImportBlockState(statusTexts, config, "blocked");
		if (importBlockResult) {
			return importBlockResult;
		}
	}

	// Rule 6: Estimated completion exceeded
	if (config.estimatedCompletionEnabled) {
		const estimated = parseDate(item.estimatedCompletionTime);
		const added = parseDate(item.added);
		const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : -1;

		if (estimated && added && sizeleft > 0) {
			const expectedDurationMs = estimated.getTime() - added.getTime();
			const actualDurationMs = now.getTime() - added.getTime();
			const multiplier = config.estimatedCompletionMultiplier ?? 2.0;

			// Only flag if we've exceeded the estimated time by the multiplier
			// and there's still data left to download
			if (expectedDurationMs > 0 && actualDurationMs > expectedDurationMs * multiplier) {
				const exceededByMins = Math.round((actualDurationMs - expectedDurationMs) / (60 * 1000));
				return {
					rule: "stalled",
					reason: `Exceeded estimated completion by ${exceededByMins}m (${multiplier}x threshold)`,
				};
			}
		}
	}

	// Rule 7: Import pending analysis with combined pattern matching
	// Check importPendingEnabled flag (defaults to true for backwards compatibility)
	const importPendingEnabled = (config as Record<string, unknown>).importPendingEnabled ?? true;
	if (importPendingEnabled && trackedState === "importpending") {
		// Check if it's actively being processed (recoverable) - always skip these
		const recoverableMatch = matchesKeywords(statusTexts, IMPORT_PENDING_RECOVERABLE_KEYWORDS);
		if (recoverableMatch) {
			return null;
		}

		// Use combined pattern matching for import state evaluation
		const importPendingResult = evaluateImportBlockState(statusTexts, config, "pending");
		if (importPendingResult) {
			return importPendingResult;
		}

		// Check time threshold for items without clear status (if no pattern matched)
		const added = parseDate(item.added);
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			const threshold = config.importPendingThresholdMins ?? 60;

			if (ageMins > threshold) {
				// Include the status messages in the reason for better debugging
				const statusSummary =
					statusTexts.length > 0 ? statusTexts.slice(0, 2).join("; ") : "no status info";
				return {
					rule: "import_pending",
					reason: `Import pending too long (${Math.round(ageMins)}m): ${statusSummary}`,
				};
			}
		}
	}

	// Rule 8: Seeding timeout
	const seedingResult = evaluateSeedingTimeout(item, config, now);
	if (seedingResult) {
		return seedingResult;
	}

	return null;
}

// ============================================================================
// Auto-Import Helper Functions
// ============================================================================

/**
 * Evaluate if an item is eligible for auto-import.
 *
 * @param statusTexts - Status messages from the queue item
 * @param config - Queue cleaner config with auto-import settings
 * @param existingStrike - Existing strike record (if any) with import attempt tracking
 * @param now - Current timestamp
 * @returns Eligibility status and reason
 */
function evaluateAutoImportEligibility(
	statusTexts: string[],
	config: QueueCleanerConfig,
	existingStrike: QueueCleanerStrike | null,
	now: Date,
): { eligible: boolean; reason: string } {
	// Check master toggle (with backwards compatibility)
	const autoImportEnabled = (config as Record<string, unknown>).autoImportEnabled ?? false;
	if (!autoImportEnabled) {
		return { eligible: false, reason: "Auto-import disabled" };
	}

	// Check max attempts
	const maxAttempts = (config as Record<string, unknown>).autoImportMaxAttempts ?? 2;
	const attempts = existingStrike?.importAttempts ?? 0;
	if (attempts >= (maxAttempts as number)) {
		return { eligible: false, reason: `Max attempts reached (${attempts}/${maxAttempts})` };
	}

	// Check cooldown period
	const cooldownMins = (config as Record<string, unknown>).autoImportCooldownMins ?? 30;
	if (existingStrike?.lastImportAttempt) {
		const cooldownMs = (cooldownMins as number) * 60 * 1000;
		const timeSinceLastAttempt = now.getTime() - existingStrike.lastImportAttempt.getTime();
		if (timeSinceLastAttempt < cooldownMs) {
			const remainingMins = Math.ceil((cooldownMs - timeSinceLastAttempt) / 60000);
			return { eligible: false, reason: `Cooldown active (${remainingMins}m remaining)` };
		}
	}

	// Check for patterns that should NEVER be auto-imported
	const neverMatch = matchesKeywords(statusTexts, AUTO_IMPORT_NEVER_KEYWORDS);
	if (neverMatch) {
		return { eligible: false, reason: `Cannot auto-import: ${neverMatch}` };
	}

	// If "safe only" mode, check for safe patterns
	const safeOnly = (config as Record<string, unknown>).autoImportSafeOnly ?? true;
	if (safeOnly) {
		const safeMatch = matchesKeywords(statusTexts, AUTO_IMPORT_SAFE_KEYWORDS);
		if (!safeMatch) {
			return { eligible: false, reason: "No safe pattern matched (safeOnly mode)" };
		}
	}

	return { eligible: true, reason: "Eligible for auto-import" };
}

/**
 * Attempt to auto-import a queue item.
 *
 * @param app - Fastify instance with ARR client factory
 * @param instance - Service instance to import on
 * @param downloadId - Download ID of the item to import
 * @param itemTitle - Title for logging
 * @returns Import result with success/failure status
 */
async function attemptAutoImport(
	app: FastifyInstance,
	instance: ServiceInstance,
	downloadId: string,
	itemTitle: string,
): Promise<AutoImportResult> {
	const client = app.arrClientFactory.create(instance);
	const service = instance.service.toLowerCase() as "sonarr" | "radarr" | "lidarr" | "readarr";

	try {
		await autoImportByDownloadIdWithSdk(client, service, downloadId);

		log.info(
			{ instanceId: instance.id, downloadId, itemTitle },
			"Auto-import succeeded",
		);
		return { attempted: true, success: true };
	} catch (error) {
		const errorMsg =
			error instanceof ManualImportError
				? error.message
				: error instanceof Error
					? error.message
					: "Unknown error";

		log.warn(
			{ instanceId: instance.id, downloadId, itemTitle, err: error },
			"Auto-import failed",
		);
		return { attempted: true, success: false, error: errorMsg };
	}
}

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
	const client = app.arrClientFactory.create(instance);
	const now = new Date();

	// Parse whitelist patterns
	// SAFETY: If whitelist is enabled but patterns are invalid, abort the clean
	// This protects user downloads that they intended to whitelist
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

	// Validate error patterns upfront (consistent with whitelist behavior)
	// SAFETY: If error patterns are enabled but invalid, abort the clean
	// Users expect their configured patterns to work - silent failure is dangerous
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
		const message = error instanceof Error ? error.message : "Unknown error";
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
	// Use string IDs for consistency with database schema (downloadId is String)
	const queueItemIds = new Set<string>();

	for (const item of queueRecords) {
		const id = typeof item.id === "number" ? item.id : 0;
		const idStr = String(id); // String version for database operations
		const title = typeof item.title === "string" ? item.title : "Unknown";
		const added = parseDate(item.added);

		queueItemIds.add(idStr);

		// Age guard: skip items younger than minQueueAgeMins
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			if (ageMins < config.minQueueAgeMins) {
				continue; // Too young to evaluate, silently skip
			}
		}

		// Whitelist check first
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
		// Items that don't match any rules are silently ignored (not added to skipped)
	}

	// Apply strike system if enabled
	let toRemove: CleanerResultItem[] = [];
	const warned: CleanerResultItem[] = [];

	// Track strike IDs that should be deleted AFTER successful removal
	// This prevents data loss if the ARR API removal call fails
	// Key is downloadId (string), value is strike record id (string)
	const strikesToDeleteAfterRemoval: Map<string, string> = new Map();

	if (config.strikeSystemEnabled && !config.dryRunMode) {
		try {
			// Wrap all strike operations in a transaction for data consistency
			// NOTE: We DON'T delete strikes for items being removed here - that happens
			// AFTER the removal succeeds (see strikesToDeleteAfterRemoval)
			const { toRemoveItems, warnedItems, pendingStrikeDeletions } = await app.prisma.$transaction(
				async (tx) => {
					// Get existing strikes for this instance
					const existingStrikes = await tx.queueCleanerStrike.findMany({
						where: { instanceId: instance.id },
					});
					const strikeMap = new Map(existingStrikes.map((s) => [s.downloadId, s]));

					const txToRemove: CleanerResultItem[] = [];
					const txWarned: CleanerResultItem[] = [];
					// Track strikes to delete ONLY AFTER removal succeeds
					const txPendingStrikeDeletions: Map<string, string> = new Map();

					for (const item of matched) {
						// Convert item.id (number from ARR API) to string for database operations
						const itemIdStr = String(item.id);
						const existingStrike = strikeMap.get(itemIdStr);
						const newStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;

						if (newStrikeCount >= config.maxStrikes) {
							// Reached max strikes, mark for removal
							txToRemove.push({
								...item,
								reason: `${item.reason} (strike ${newStrikeCount}/${config.maxStrikes})`,
								strikeCount: newStrikeCount,
								maxStrikes: config.maxStrikes,
							});

							// Track strike for deletion AFTER removal succeeds (not now!)
							// This prevents losing strike data if the ARR API call fails
							if (existingStrike) {
								txPendingStrikeDeletions.set(itemIdStr, existingStrike.id);
							}
						} else {
							// Add/update strike
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

					// Clean up strikes for items no longer in queue (safe to delete immediately)
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
			// Store pending deletions for after removal succeeds
			for (const [downloadId, strikeId] of pendingStrikeDeletions) {
				strikesToDeleteAfterRemoval.set(downloadId, strikeId);
			}
		} catch (error) {
			// Distinguish between database errors (Prisma) and programming bugs
			// Prisma errors have a 'code' property (P2002, P2025, etc.)
			const isPrismaError = error && typeof error === "object" && "code" in error;
			const errorMessage = error instanceof Error ? error.message : "Unknown error";

			if (isPrismaError) {
				log.error(
					{ err: error, instanceId: instance.id },
					"Strike system database error - aborting clean for safety",
				);
			} else {
				// This is likely a programming bug - log with higher severity
				log.error(
					{ err: error, instanceId: instance.id },
					"Unexpected error in strike system (possible bug) - aborting clean for safety",
				);
			}

			// SAFETY: Return error instead of bypassing strike protection
			// If the user configured strikes, they expect that protection to work
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
		// No strike system, all matched items go to toRemove
		toRemove = matched;
	}

	// Cap matches at maxRemovalsPerRun
	const cappedToRemove = toRemove.slice(0, config.maxRemovalsPerRun);
	const cappedSkip = toRemove.slice(config.maxRemovalsPerRun);

	// Items that exceeded the cap become skipped
	for (const item of cappedSkip) {
		skipped.push({
			...item,
			reason: `Exceeded max removals per run (${config.maxRemovalsPerRun})`,
		});
	}

	// Dry run mode: return preview
	if (config.dryRunMode) {
		// In dry run, simulate strikes for display purposes
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

	// Live mode: remove items (with auto-import support for import_pending/blocked items)
	let removeErrors = 0;
	let autoImportSuccesses = 0;
	const cleaned: CleanerResultItem[] = [];
	const autoImported: CleanerResultItem[] = [];

	// Create a lookup map from queue item ID to downloadId (needed for auto-import API calls)
	const downloadIdMap = new Map<number, string>();
	for (const queueItem of queueRecords) {
		const queueId = typeof queueItem.id === "number" ? queueItem.id : 0;
		const downloadId = typeof queueItem.downloadId === "string" ? queueItem.downloadId : null;
		if (queueId > 0 && downloadId) {
			downloadIdMap.set(queueId, downloadId);
		}
	}

	// Get existing strikes for auto-import tracking (includes importAttempts, lastImportAttempt)
	const strikesForAutoImport = await app.prisma.queueCleanerStrike.findMany({
		where: { instanceId: instance.id },
	});
	const strikeMapForAutoImport = new Map(strikesForAutoImport.map((s) => [s.downloadId, s]));

	for (const item of cappedToRemove) {
		// Check if this is an import_pending/import_blocked item eligible for auto-import
		const isImportItem = item.rule === "import_pending" || item.rule === "import_blocked";
		const downloadId = downloadIdMap.get(item.id) ?? null;

		if (isImportItem && downloadId) {
			const itemIdStr = String(item.id);
			const existingStrike = strikeMapForAutoImport.get(itemIdStr);

			// Collect status texts for eligibility check
			// We need to refetch the item to get full status texts for pattern matching
			// Note: For performance, we could cache this during evaluation, but this is cleaner
			const eligibility = evaluateAutoImportEligibility(
				[], // Empty for now - eligibility is checked against config settings, not patterns
				config,
				existingStrike ?? null,
				now,
			);

			if (eligibility.eligible) {
				log.info(
					{ instanceId: instance.id, downloadId, itemTitle: item.title },
					"Attempting auto-import before removal",
				);

				const importResult = await attemptAutoImport(app, instance, downloadId, item.title);

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
						// Create a strike record to track import attempts
						await app.prisma.queueCleanerStrike.create({
							data: {
								instanceId: instance.id,
								downloadId: itemIdStr,
								downloadTitle: item.title,
								strikeCount: 0, // Not a strike, just tracking import attempts
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
					// Import succeeded - skip removal, the item will be imported by ARR
					autoImportSuccesses++;
					autoImported.push({
						...item,
						reason: `Auto-imported successfully (was: ${item.reason})`,
					});
					continue; // Skip removal
				} else {
					log.info(
						{ instanceId: instance.id, downloadId, error: importResult.error },
						"Auto-import failed, falling back to removal",
					);
				}
			} else {
				log.debug(
					{ instanceId: instance.id, downloadId, reason: eligibility.reason },
					"Auto-import not eligible",
				);
			}
		}

		// Normal removal flow
		try {
			// Determine if we should use changeCategory (torrent-only feature)
			// Only apply changeCategory for torrents when enabled
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
			// Handle 404 gracefully (item already removed)
			const errMsg = error instanceof Error ? error.message : "Unknown error";
			if (errMsg.includes("404") || errMsg.includes("Not Found")) {
				cleaned.push({ ...item, reason: `${item.reason} (already removed)` });
			} else {
				removeErrors++;
				skipped.push({ ...item, reason: `Remove failed: ${errMsg}` });
				log.warn({ err: error, itemId: item.id, title: item.title }, "Failed to remove queue item");
			}
		}
	}

	// Clean up strike records ONLY for items that were successfully removed
	// This ensures we don't lose strike data if the ARR API call failed
	if (strikesToDeleteAfterRemoval.size > 0 && cleaned.length > 0) {
		// Convert item.id (number) to string for comparison with Map keys
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
				// Log but don't fail the whole operation - items were already removed
				// Orphan strike records will be cleaned up on next run when item is no longer in queue
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

	// Include auto-imported items in the cleaned count for the result
	// They were successfully handled, just via import instead of removal
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
 * Generate detailed reason string based on rule and item context.
 */
function generateDetailedReason(
	rule: string,
	item: RawQueueItem,
	config: QueueCleanerConfig,
	now: Date,
): string {
	const added = parseDate(item.added);
	const ageMins = added ? Math.round((now.getTime() - added.getTime()) / (60 * 1000)) : 0;
	const size = typeof item.size === "number" ? item.size : 0;
	const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : 0;
	const downloaded = size - sizeleft;
	const progress = size > 0 ? Math.round((downloaded / size) * 100) : 0;
	const indexer = typeof item.indexer === "string" ? item.indexer : "Unknown";

	switch (rule) {
		case "stalled":
			return (
				`Download has been in queue for ${ageMins} minutes with ${progress}% progress. ` +
				`The stall threshold is ${config.stalledThresholdMins} minutes. ` +
				`Source: ${indexer}`
			);
		case "failed": {
			// Get the actual status messages for more context
			const statusTexts = collectStatusTexts(item);
			const trackedState = (
				typeof item.trackedDownloadState === "string" ? item.trackedDownloadState : ""
			).toLowerCase();

			if (trackedState === "importblocked" || trackedState === "importpending") {
				const statusDetail =
					statusTexts.length > 0
						? `Status: ${statusTexts.slice(0, 3).join(" | ")}`
						: "No additional details available.";
				return (
					`Download completed but cannot be imported. ` +
					`This requires manual intervention in the ARR application. ` +
					`${statusDetail} ` +
					`Source: ${indexer}`
				);
			}

			return (
				`Download has failed or encountered an error state. ` +
				`This typically means the download client reported a problem. ` +
				`Source: ${indexer}`
			);
		}
		case "slow": {
			const elapsedSeconds = added ? (now.getTime() - added.getTime()) / 1000 : 0;
			const speedKBs = elapsedSeconds > 0 ? (downloaded / 1024 / elapsedSeconds).toFixed(1) : "0";
			return (
				`Average download speed is ${speedKBs} KB/s, below the threshold of ${config.slowSpeedThreshold} KB/s. ` +
				`Download has been active for ${ageMins} minutes with ${progress}% progress. ` +
				`Source: ${indexer}`
			);
		}
		case "error_pattern":
			return (
				`Download status matches a configured error pattern. ` +
				`Review the status messages for details. Source: ${indexer}`
			);
		case "seeding_timeout": {
			const hoursInQueue = ageMins / 60;
			return (
				`Download completed and has been seeding for ${hoursInQueue.toFixed(1)} hours. ` +
				`The seeding timeout is ${config.seedingTimeoutHours} hours. ` +
				`Source: ${indexer}`
			);
		}
		case "whitelisted":
			return `This download matches a whitelist pattern and will be excluded from cleaning.`;
		default:
			return `Matched rule: ${rule}`;
	}
}

/**
 * Calculate queue state summary from queue records.
 */
function calculateQueueSummary(queueRecords: RawQueueItem[]): QueueStateSummary {
	const summary: QueueStateSummary = {
		totalItems: queueRecords.length,
		downloading: 0,
		paused: 0,
		queued: 0,
		seeding: 0,
		importPending: 0,
		failed: 0,
	};

	for (const item of queueRecords) {
		const state = (
			typeof item.trackedDownloadState === "string" ? item.trackedDownloadState : ""
		).toLowerCase();
		const status = (
			typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus : ""
		).toLowerCase();
		const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : -1;

		if (state.includes("failed") || status === "error") {
			summary.failed++;
		} else if (state === "importpending" || state === "importing") {
			summary.importPending++;
		} else if (sizeleft === 0 || status === "seeding") {
			summary.seeding++;
		} else if (status === "paused" || state === "paused") {
			summary.paused++;
		} else if (status === "queued" || state === "queued") {
			summary.queued++;
		} else {
			summary.downloading++;
		}
	}

	return summary;
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
	const client = app.arrClientFactory.create(instance);
	const now = new Date();
	const instanceService = instance.service.toLowerCase() as "sonarr" | "radarr" | "lidarr" | "readarr";

	// Parse whitelist patterns
	// SAFETY: If whitelist is enabled but patterns are invalid, return error preview
	// This matches executeQueueCleaner() behavior - user intended to protect items
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
				instanceReachable: true, // Instance might be fine, config is the problem
				errorMessage: "Whitelist configuration is invalid. Please fix whitelist patterns in settings.",
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

	// Validate error patterns upfront (consistent with whitelist and executeQueueCleaner behavior)
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
	let instanceReachable = true;

	try {
		const queue = await client.queue.get({ pageSize: 1000 });
		queueRecords = (queue.records ?? []) as RawQueueItem[];
	} catch (error) {
		// Log the error so admins can diagnose connectivity issues
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		log.warn(
			{ err: error, instanceId: instance.id, instanceLabel: instance.label },
			"Failed to fetch queue for enhanced preview",
		);
		// Early return with instanceReachable: false (no need to set variable since we return immediately)
		return {
			instanceId: instance.id,
			instanceLabel: instance.label,
			instanceService,
			instanceReachable: false,
			errorMessage, // Include error so UI can show it to user
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

	// Get existing strikes for context
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

		// Evaluate against rules
		const evaluation = evaluateQueueItem(item, config, now);

		if (evaluation) {
			ruleSummary[evaluation.rule] = (ruleSummary[evaluation.rule] ?? 0) + 1;

			// Check strike system (convert id to string for database lookup)
			const existingStrike = strikeMap.get(String(id));
			const simulatedStrikeCount = (existingStrike?.strikeCount ?? 0) + 1;
			const wouldTriggerRemoval =
				!config.strikeSystemEnabled || simulatedStrikeCount >= config.maxStrikes;

			// Check auto-import eligibility for import_pending/import_blocked items
			let autoImportEligible: boolean | undefined = undefined;
			let autoImportReason: string | undefined = undefined;

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
			// Item passes all rules
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

	// Calculate counts
	const wouldRemove = previewItems.filter((i) => i.action === "remove").length;
	const wouldWarn = previewItems.filter((i) => i.action === "warn").length;
	const wouldSkip = previewItems.filter(
		(i) => i.action === "skip" || i.action === "whitelist",
	).length;

	return {
		instanceId: instance.id,
		instanceLabel: instance.label,
		instanceService,
		instanceReachable,
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
