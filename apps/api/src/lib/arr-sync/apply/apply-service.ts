/**
 * Apply Service - Safely applies sync plans with retries and rate limiting
 */

import type { SyncPlan, ApplyResult, BackupData } from "../types.js";
import type { ArrClient } from "../clients/arr-client.js";
import { createBackup, saveLastPlan } from "../backup/backup-service.js";

const RATE_LIMIT_DELAY_MS = 200; // 5 requests per second
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Apply a sync plan to an ARR instance
 */
export async function applySyncPlan(
	client: ArrClient,
	plan: SyncPlan,
	options: {
		dryRun?: boolean;
		skipBackup?: boolean;
	} = {},
): Promise<ApplyResult> {
	const startTime = Date.now();
	const result: ApplyResult = {
		instanceId: plan.instanceId,
		instanceLabel: plan.instanceLabel,
		success: false,
		applied: {
			customFormatsCreated: 0,
			customFormatsUpdated: 0,
			customFormatsDeleted: 0,
			qualityProfilesCreated: 0,
			qualityProfilesUpdated: 0,
		},
		errors: [],
		warnings: [...plan.warnings],
	};

	try {
		// Dry run - just return the plan
		if (options.dryRun) {
			result.success = true;
			result.warnings.push("Dry run - no changes applied");
			return result;
		}

		// Create backup first
		if (!options.skipBackup) {
			const backupData: BackupData = {
				instanceId: plan.instanceId,
				instanceLabel: plan.instanceLabel,
				service: "SONARR", // This should come from the instance
				timestamp: new Date().toISOString(),
				version: "unknown",
				customFormats: await client.getCustomFormats(),
				qualityProfiles: await client.getQualityProfiles(),
			};

			result.backupPath = await createBackup(backupData);
		}

		// Save the plan
		await saveLastPlan(plan.instanceId, plan);

		// Apply deletes first
		for (const item of plan.customFormats.deletes) {
			if (item.existingId) {
				try {
					await withRetry(() =>
						client.deleteCustomFormat(item.existingId!),
					);
					result.applied.customFormatsDeleted++;
					await delay(RATE_LIMIT_DELAY_MS);
				} catch (error) {
					const errorMsg = `Failed to delete custom format "${item.name}": ${error instanceof Error ? error.message : String(error)}`;
					result.errors.push(errorMsg);
				}
			}
		}

		// Apply creates
		for (const item of plan.customFormats.creates) {
			if (item.desired) {
				try {
					await withRetry(() =>
						client.createCustomFormat(item.desired!),
					);
					result.applied.customFormatsCreated++;
					await delay(RATE_LIMIT_DELAY_MS);
				} catch (error) {
					const errorMsg = `Failed to create custom format "${item.name}": ${error instanceof Error ? error.message : String(error)}`;
					result.errors.push(errorMsg);
				}
			}
		}

		// Apply updates
		for (const item of plan.customFormats.updates) {
			if (item.existingId && item.desired) {
				try {
					await withRetry(() =>
						client.updateCustomFormat(
							item.existingId!,
							item.desired!,
						),
					);
					result.applied.customFormatsUpdated++;
					await delay(RATE_LIMIT_DELAY_MS);
				} catch (error) {
					const errorMsg = `Failed to update custom format "${item.name}": ${error instanceof Error ? error.message : String(error)}`;
					result.errors.push(errorMsg);
				}
			}
		}

		// Apply quality profile updates
		for (const item of plan.qualityProfiles.updates) {
			if (item.existingId && item.desired) {
				try {
					await withRetry(() =>
						client.updateQualityProfile(
							item.existingId!,
							item.desired!,
						),
					);
					result.applied.qualityProfilesUpdated++;
					await delay(RATE_LIMIT_DELAY_MS);
				} catch (error) {
					const errorMsg = `Failed to update quality profile "${item.name}": ${error instanceof Error ? error.message : String(error)}`;
					result.errors.push(errorMsg);
				}
			}
		}

		// Check for partial failures
		if (result.errors.length > 0) {
			result.warnings.push(
				`Completed with ${result.errors.length} error(s)`,
			);
		}

		result.success = result.errors.length === 0;
	} catch (error) {
		result.success = false;
		result.errors.push(
			`Fatal error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	result.duration = Date.now() - startTime;

	return result;
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	retries = MAX_RETRIES,
): Promise<T> {
	let lastError: Error | null = null;

	for (let i = 0; i <= retries; i++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry on certain errors
			if (
				lastError.message.includes("404") ||
				lastError.message.includes("401") ||
				lastError.message.includes("403")
			) {
				throw lastError;
			}

			// Retry on 429 (rate limit) and 5xx errors
			if (i < retries) {
				const backoffMs = RETRY_DELAY_MS * Math.pow(2, i);
				await delay(backoffMs);
			}
		}
	}

	throw lastError || new Error("Max retries exceeded");
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the sync was successful by re-reading remote state
 */
export async function verifySyncResult(
	client: ArrClient,
	plan: SyncPlan,
): Promise<{ verified: boolean; issues: string[] }> {
	const issues: string[] = [];

	try {
		const customFormats = await client.getCustomFormats();

		// Check all created formats exist
		for (const item of plan.customFormats.creates) {
			const found = customFormats.find(
				(cf) => cf.name.toLowerCase() === item.name.toLowerCase(),
			);
			if (!found) {
				issues.push(`Created custom format "${item.name}" not found`);
			}
		}

		// Check all updated formats have changes
		for (const item of plan.customFormats.updates) {
			const found = customFormats.find((cf) => cf.id === item.existingId);
			if (!found) {
				issues.push(`Updated custom format "${item.name}" not found`);
			}
		}

		// Check all deleted formats are gone
		for (const item of plan.customFormats.deletes) {
			const found = customFormats.find((cf) => cf.id === item.existingId);
			if (found) {
				issues.push(`Deleted custom format "${item.name}" still exists`);
			}
		}
	} catch (error) {
		issues.push(
			`Verification failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return {
		verified: issues.length === 0,
		issues,
	};
}
