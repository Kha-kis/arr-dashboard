/**
 * Queue cleaner display/formatting helpers.
 *
 * Pure functions for generating detailed reason strings and
 * calculating queue state summaries. No side effects.
 */

import type { QueueCleanerConfig } from "../prisma.js";
import type { QueueStateSummary } from "./constants.js";
import { type RawQueueItem, parseDate, collectStatusTexts } from "./queue-item-utils.js";

/**
 * Generate detailed reason string based on rule and item context.
 */
export function generateDetailedReason(
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
export function calculateQueueSummary(queueRecords: RawQueueItem[]): QueueStateSummary {
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
