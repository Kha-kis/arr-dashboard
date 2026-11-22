/**
 * Direct Lidarr Integration Test
 *
 * This script tests the queue cleaner against a real Lidarr instance.
 * Run with: npx tsx src/lib/queue-cleaner/test-lidarr-integration.ts
 */

import { reportDiagnostic } from "./diagnostic-output.js";

const LIDARR_URL = process.env.LIDARR_URL || "http://localhost:8686";
const LIDARR_API_KEY = process.env.LIDARR_API_KEY || "YOUR_API_KEY";

// Auto-import keyword patterns (same as in constants.ts)
const AUTO_IMPORT_SAFE_KEYWORDS = [
	"waiting for import",
	"import pending",
	"manual import",
] as const;

const AUTO_IMPORT_NEVER_KEYWORDS = [
	"no video files",
	"no files found",
	"sample only",
	"sample file",
	"password protected",
	"unpack required",
	"rar required",
	"unpacking failed",
	"quality not wanted",
	"not an upgrade",
	"cutoff already met",
	"not wanted in",
	"already exists",
	"already in library",
	"duplicate",
	// Audio-specific (for Lidarr/Readarr)
	"no audio files",
	"no tracks found",
] as const;

interface QueueRecord {
	id: number;
	title: string;
	trackedDownloadState?: string;
	trackedDownloadStatus?: string;
	statusMessages?: Array<{
		title?: string;
		messages?: string[];
	}>;
	downloadId?: string;
	size?: number;
	sizeleft?: number;
}

interface QueueResponse {
	totalRecords: number;
	records?: QueueRecord[];
}

async function fetchLidarrQueue(): Promise<QueueResponse> {
	const response = await fetch(`${LIDARR_URL}/api/v1/queue?pageSize=100`, {
		headers: {
			"X-Api-Key": LIDARR_API_KEY,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch queue: ${response.status} ${response.statusText}`);
	}

	return response.json();
}

async function testLidarrIntegration() {
	reportDiagnostic("lidarr-integration", "started");
	const queue = await fetchLidarrQueue();

	// Analyze queue states
	const stateMap = new Map<string, number>();
	const importItems: Array<{
		id: number;
		title: string;
		state: string;
		status: string;
		statusMessages: string[];
		downloadId?: string;
	}> = [];

	for (const item of queue.records ?? []) {
		const state = item.trackedDownloadState ?? "unknown";
		stateMap.set(state, (stateMap.get(state) ?? 0) + 1);

		// Collect import-related items
		if (state === "importPending" || state === "importBlocked" || state === "importFailed") {
			const statusMessages: string[] = [];
			if (Array.isArray(item.statusMessages)) {
				for (const msg of item.statusMessages) {
					if (msg?.title) statusMessages.push(msg.title);
					if (Array.isArray(msg?.messages)) {
						statusMessages.push(...msg.messages);
					}
				}
			}
			importItems.push({
				id: item.id,
				title: item.title ?? "Unknown",
				state,
				status: item.trackedDownloadStatus ?? "unknown",
				statusMessages: statusMessages.slice(0, 5), // First 5 messages
				downloadId: item.downloadId,
			});
		}
	}

	reportDiagnostic("lidarr-integration", "queue-summary", {
		totalItems: queue.totalRecords,
		pendingItems: stateMap.get("importPending") ?? 0,
		blockedItems: stateMap.get("importBlocked") ?? 0,
		failedItems: stateMap.get("importFailed") ?? 0,
		downloadingItems: stateMap.get("downloading") ?? 0,
		otherItems: [...stateMap.entries()]
			.filter(
				([state]) =>
					!["importPending", "importBlocked", "importFailed", "downloading"].includes(state),
			)
			.reduce((count, [, value]) => count + value, 0),
	});

	// Simulate the same queue cleaner choices without outputting selected items.
	let wouldClean = 0;
	let autoImportEligible = 0;
	let wouldWarn = 0;

	for (const item of importItems) {
		if (item.state === "importFailed") {
			wouldClean++;
		} else if (item.state === "importPending" || item.state === "importBlocked") {
			// Check auto-import eligibility
			const allText = item.statusMessages.join(" ").toLowerCase();
			const hasSafe = AUTO_IMPORT_SAFE_KEYWORDS.some((k) => allText.includes(k));
			const neverMatch = AUTO_IMPORT_NEVER_KEYWORDS.find((k) => allText.includes(k));

			if (neverMatch) {
				wouldClean++;
			} else if (hasSafe) {
				autoImportEligible++;
			} else {
				wouldWarn++;
			}
		}
	}
	reportDiagnostic("lidarr-integration", "preview-summary", {
		wouldRemoveItems: wouldClean,
		eligibleItems: autoImportEligible,
		wouldWarnItems: wouldWarn,
		importItems: importItems.length,
	});

	try {
		const miResponse = await fetch(`${LIDARR_URL}/api/v1/manualimport?downloadId=test`, {
			headers: {
				"X-Api-Key": LIDARR_API_KEY,
				Accept: "application/json",
			},
		});

		if (miResponse.ok) {
			reportDiagnostic("lidarr-integration", "manual-import-api", { available: true });
		} else {
			reportDiagnostic("lidarr-integration", "manual-import-api", { available: false });
		}
	} catch {
		reportDiagnostic("lidarr-integration", "provider-failed");
	}
}

testLidarrIntegration().catch(() => reportDiagnostic("lidarr-integration", "provider-failed"));
