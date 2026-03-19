/**
 * Queue cleaner rule evaluation pipeline.
 *
 * Functions that evaluate queue items against configured cleaner rules:
 * failed, stalled, slow, error patterns, import blocked/pending,
 * estimated completion, and seeding timeout.
 */

import { loggers } from "../logger.js";
import type { QueueCleanerConfig } from "../prisma.js";
import { isNumber, isString, parseJsonArray } from "../utils/json.js";
import {
	type CleanerResultItem,
	FAILURE_KEYWORDS,
	IMPORT_BLOCKED_REVIEW_KEYWORDS,
	IMPORT_BLOCKED_SAFE_KEYWORDS,
	IMPORT_BLOCKED_TECHNICAL_KEYWORDS,
	IMPORT_PENDING_RECOVERABLE_KEYWORDS,
	type ImportBlockCleanupLevel,
	type ImportBlockPatternMode,
	STALL_KEYWORDS,
} from "./constants.js";
import {
	collectStatusTexts,
	matchesKeywords,
	parseDate,
	type RawQueueItem,
} from "./queue-item-utils.js";

const log = loggers.queueCleaner;

/**
 * Check if a queue item should be removed due to seeding timeout.
 * Note: Only applies to torrents - usenet downloads don't seed.
 */
export function evaluateSeedingTimeout(
	item: RawQueueItem,
	config: QueueCleanerConfig,
	now: Date,
): { rule: "seeding_timeout"; reason: string } | null {
	if (!config.seedingTimeoutEnabled) return null;

	const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : "";
	if (protocol === "usenet") return null;

	const status =
		typeof item.trackedDownloadStatus === "string" ? item.trackedDownloadStatus.toLowerCase() : "";
	const state =
		typeof item.trackedDownloadState === "string" ? item.trackedDownloadState.toLowerCase() : "";
	const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : -1;

	const isSeeding =
		sizeleft === 0 || status === "seeding" || state === "importpending" || state === "importing";

	if (!isSeeding) return null;

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
export function matchesCustomImportBlockPatterns(
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
export function parseCustomPatterns(patternsJson: string | null, instanceId?: string): string[] {
	return parseJsonArray(patternsJson, isString, "importBlockPatterns", log, { instanceId });
}

/**
 * Evaluate import blocked/pending items using combined pattern matching approach.
 *
 * Mode behavior:
 * - "defaults": Use categorized keywords (SAFE/REVIEW/TECHNICAL) based on cleanup level
 * - "include": ONLY clean if custom patterns match (ignores category defaults)
 * - "exclude": Use category defaults BUT skip items matching exclusion patterns
 */
export function evaluateImportBlockState(
	statusTexts: string[],
	config: QueueCleanerConfig,
	stateType: "blocked" | "pending",
): { rule: "import_blocked" | "import_pending"; reason: string } | null {
	const cleanupLevel: ImportBlockCleanupLevel =
		((config as Record<string, unknown>).importBlockCleanupLevel as ImportBlockCleanupLevel) ??
		"safe";
	const patternMode: ImportBlockPatternMode =
		((config as Record<string, unknown>).importBlockPatternMode as ImportBlockPatternMode) ??
		"defaults";
	const customPatterns = parseCustomPatterns(
		(config as Record<string, unknown>).importBlockPatterns as string | null,
		config.instanceId,
	);

	const rule: "import_blocked" | "import_pending" =
		stateType === "blocked" ? "import_blocked" : "import_pending";
	const prefix = stateType === "blocked" ? "Import blocked" : "Import pending";

	if (patternMode === "include" && customPatterns.length > 0) {
		const customMatch = matchesCustomImportBlockPatterns(statusTexts, customPatterns);
		if (customMatch.matched) {
			return {
				rule,
				reason: `${prefix} (matched pattern): ${customMatch.pattern}`,
			};
		}
		return null;
	}

	if (patternMode === "exclude" && customPatterns.length > 0) {
		const exclusionMatch = matchesCustomImportBlockPatterns(statusTexts, customPatterns);
		if (exclusionMatch.matched) {
			return null;
		}
	}

	const safeMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_SAFE_KEYWORDS);
	if (safeMatch) {
		return {
			rule,
			reason: `${prefix} (safe to remove): ${safeMatch}`,
		};
	}

	const reviewMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_REVIEW_KEYWORDS);
	if (reviewMatch) {
		if (cleanupLevel === "moderate" || cleanupLevel === "aggressive") {
			return {
				rule,
				reason: `${prefix} (needs review): ${reviewMatch}`,
			};
		}
		return null;
	}

	const technicalMatch = matchesKeywords(statusTexts, IMPORT_BLOCKED_TECHNICAL_KEYWORDS);
	if (technicalMatch) {
		if (cleanupLevel === "aggressive") {
			return {
				rule,
				reason: `${prefix} (technical): ${technicalMatch}`,
			};
		}
		return null;
	}

	const statusSummary = statusTexts.length > 0 ? statusTexts[0] : "requires manual intervention";
	if (cleanupLevel === "moderate" || cleanupLevel === "aggressive") {
		return {
			rule,
			reason: `${prefix}: ${statusSummary}`,
		};
	}

	return null;
}

/**
 * Evaluate a single queue item against all cleaner rules.
 * Returns the matching rule and reason, or null if no rule matches.
 */
export function evaluateQueueItem(
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
		if (trackedStatus === "warning") {
			const stallMatch = matchesKeywords(statusTexts, STALL_KEYWORDS);
			if (stallMatch) {
				return { rule: "stalled", reason: `Stalled: ${stallMatch}` };
			}
		}

		const added = parseDate(item.added);
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			const size = typeof item.size === "number" ? item.size : 0;
			const sizeleft = typeof item.sizeleft === "number" ? item.sizeleft : 0;

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
			log.warn(
				{ instanceId: config.instanceId, err: error },
				"Invalid error patterns JSON - skipping error pattern rule",
			);
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

	// Rule 5: Import blocked detection (shares the importPendingEnabled flag)
	const importBlockEnabled = (config as Record<string, unknown>).importPendingEnabled ?? true;
	if (importBlockEnabled && trackedState === "importblocked") {
		const importBlockResult = evaluateImportBlockState(statusTexts, config, "blocked");
		if (importBlockResult) {
			return importBlockResult;
		}
		// Fallback: importBlocked state is definitive — the import cannot proceed.
		// Even if no keyword matched at the current cleanup level, flag it.
		const statusSummary =
			statusTexts.length > 0 ? statusTexts.slice(0, 2).join("; ") : "requires manual intervention";
		return {
			rule: "import_blocked",
			reason: `Import blocked: ${statusSummary}`,
		};
	}

	// Rule 5b: Failed-pending detection (import failures awaiting retry)
	// These are items Radarr/Sonarr mark as failed but haven't given up on yet.
	// Caught here so users who enable "Import Pending/Blocked" but not "Failed"
	// still see stuck import failures.
	if (importBlockEnabled && trackedState === "failedpending") {
		const importBlockResult = evaluateImportBlockState(statusTexts, config, "blocked");
		if (importBlockResult) {
			return importBlockResult;
		}
		const statusSummary =
			statusTexts.length > 0 ? statusTexts.slice(0, 2).join("; ") : "import failed, pending retry";
		return {
			rule: "import_blocked",
			reason: `Import failed (pending retry): ${statusSummary}`,
		};
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

			if (expectedDurationMs > 0 && actualDurationMs > expectedDurationMs * multiplier) {
				const exceededByMins = Math.round((actualDurationMs - expectedDurationMs) / (60 * 1000));
				return {
					rule: "stalled",
					reason: `Exceeded estimated completion by ${exceededByMins}m (${multiplier}x threshold)`,
				};
			}
		}
	}

	// Rule 7: Import pending analysis
	const importPendingEnabled = (config as Record<string, unknown>).importPendingEnabled ?? true;
	if (importPendingEnabled && trackedState === "importpending") {
		const recoverableMatch = matchesKeywords(statusTexts, IMPORT_PENDING_RECOVERABLE_KEYWORDS);
		if (recoverableMatch) {
			return null;
		}

		const importPendingResult = evaluateImportBlockState(statusTexts, config, "pending");
		if (importPendingResult) {
			return importPendingResult;
		}

		const added = parseDate(item.added);
		if (added) {
			const ageMins = (now.getTime() - added.getTime()) / (60 * 1000);
			const threshold = config.importPendingThresholdMins ?? 60;

			if (ageMins > threshold) {
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
// Tag / Profile Pre-filters
// ============================================================================

/**
 * Check if a queue item should be skipped based on tag filters.
 * Returns true if the item should be SKIPPED (excluded from cleaning).
 */
export function shouldSkipByTagFilter(item: RawQueueItem, config: QueueCleanerConfig): boolean {
	if (!config.tagFilterEnabled) return false;

	// Queue items may carry tags as an array of numbers
	const itemTags = Array.isArray(item.tags)
		? (item.tags as unknown[]).filter((t): t is number => typeof t === "number")
		: [];

	const includeTags = parseJsonArray(
		(config as Record<string, unknown>).includeTags as string | null | undefined,
		isNumber,
	);
	const excludeTags = parseJsonArray(
		(config as Record<string, unknown>).excludeTags as string | null | undefined,
		isNumber,
	);

	// Include filter: if set, item must have at least one matching tag
	if (includeTags.length > 0 && !itemTags.some((t) => includeTags.includes(t))) {
		return true; // skip — no matching include tag
	}

	// Exclude filter: if item has any excluded tag, skip it
	if (excludeTags.length > 0 && itemTags.some((t) => excludeTags.includes(t))) {
		return true; // skip — has excluded tag
	}

	return false;
}

/**
 * Check if a queue item should be skipped based on quality profile filters.
 * Returns true if the item should be SKIPPED (excluded from cleaning).
 */
export function shouldSkipByProfileFilter(item: RawQueueItem, config: QueueCleanerConfig): boolean {
	if (!config.profileFilterEnabled) return false;

	const profileId = typeof item.qualityProfileId === "number" ? item.qualityProfileId : null;
	if (profileId === null) return false; // Can't filter if no profile info

	const includeProfiles = parseJsonArray(
		(config as Record<string, unknown>).includeProfiles as string | null | undefined,
		isNumber,
	);
	const excludeProfiles = parseJsonArray(
		(config as Record<string, unknown>).excludeProfiles as string | null | undefined,
		isNumber,
	);

	// Include filter: item must have a matching profile
	if (includeProfiles.length > 0 && !includeProfiles.includes(profileId)) {
		return true; // skip
	}

	// Exclude filter: item must not have an excluded profile
	if (excludeProfiles.length > 0 && excludeProfiles.includes(profileId)) {
		return true; // skip
	}

	return false;
}
