/**
 * Auto-import handler for queue cleaner.
 *
 * Evaluates eligibility and attempts auto-import for stuck
 * import_pending/import_blocked queue items before removal.
 */

import type { FastifyInstance } from "fastify";
import type { QueueCleanerConfig, QueueCleanerStrike, ServiceInstance } from "../prisma.js";
import { loggers } from "../logger.js";
import {
	AUTO_IMPORT_SAFE_KEYWORDS,
	AUTO_IMPORT_NEVER_KEYWORDS,
} from "./constants.js";
import {
	autoImportByDownloadIdWithSdk,
	ManualImportError,
} from "../../routes/manual-import-utils.js";
import type { AutoImportResult } from "@arr/shared";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { parseJsonArray, isString } from "../utils/json.js";
import { matchesKeywords } from "./queue-item-utils.js";

const log = loggers.queueCleaner;

/**
 * Evaluate if an item is eligible for auto-import.
 *
 * @param statusTexts - Status messages from the queue item
 * @param config - Queue cleaner config with auto-import settings
 * @param existingStrike - Existing strike record (if any) with import attempt tracking
 * @param now - Current timestamp
 * @returns Eligibility status and reason
 */
export function evaluateAutoImportEligibility(
	statusTexts: string[],
	config: QueueCleanerConfig,
	existingStrike: QueueCleanerStrike | null,
	now: Date,
): { eligible: boolean; reason: string } {
	if (!config.autoImportEnabled) {
		return { eligible: false, reason: "Auto-import disabled" };
	}

	const maxAttempts = config.autoImportMaxAttempts;
	const attempts = existingStrike?.importAttempts ?? 0;
	if (attempts >= maxAttempts) {
		return { eligible: false, reason: `Max attempts reached (${attempts}/${maxAttempts})` };
	}

	const cooldownMins = config.autoImportCooldownMins;
	if (existingStrike?.lastImportAttempt) {
		const cooldownMs = cooldownMins * 60 * 1000;
		const timeSinceLastAttempt = now.getTime() - existingStrike.lastImportAttempt.getTime();
		if (timeSinceLastAttempt < cooldownMs) {
			const remainingMins = Math.ceil((cooldownMs - timeSinceLastAttempt) / 60000);
			return { eligible: false, reason: `Cooldown active (${remainingMins}m remaining)` };
		}
	}

	const neverMatch = matchesKeywords(statusTexts, AUTO_IMPORT_NEVER_KEYWORDS);
	if (neverMatch) {
		return { eligible: false, reason: `Cannot auto-import: ${neverMatch}` };
	}

	const customNeverPatterns = parseJsonArray(config.autoImportNeverPatterns, isString, "autoImportNeverPatterns", log, { configId: config.id });
	if (customNeverPatterns.length > 0) {
		const customNeverMatch = matchesKeywords(statusTexts, customNeverPatterns);
		if (customNeverMatch) {
			return { eligible: false, reason: `Blocked by custom pattern: ${customNeverMatch}` };
		}
	}

	if (config.autoImportSafeOnly) {
		const safeMatch = matchesKeywords(statusTexts, AUTO_IMPORT_SAFE_KEYWORDS);

		let customMatch: string | null = null;
		if (!safeMatch) {
			const customPatterns = parseJsonArray(config.autoImportCustomPatterns, isString, "autoImportCustomPatterns", log, { configId: config.id });
			if (customPatterns.length > 0) {
				customMatch = matchesKeywords(statusTexts, customPatterns);
			}
		}

		if (!safeMatch && !customMatch) {
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
export async function attemptAutoImport(
	app: FastifyInstance,
	instance: ServiceInstance,
	downloadId: string,
	itemTitle: string,
): Promise<AutoImportResult> {
	const serviceLower = instance.service.toLowerCase();
	const validServices = ["sonarr", "radarr", "lidarr", "readarr"] as const;
	if (!validServices.includes(serviceLower as typeof validServices[number])) {
		log.warn(
			{ instanceId: instance.id, service: instance.service },
			"Auto-import not supported for this service type",
		);
		return { attempted: false, success: false, skippedReason: `Unsupported service: ${instance.service}` };
	}
	const service = serviceLower as "sonarr" | "radarr" | "lidarr" | "readarr";

	const client = app.arrClientFactory.create(instance) as QueueCapableClient;

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
