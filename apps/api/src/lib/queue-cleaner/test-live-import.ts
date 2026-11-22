/**
 * Live Auto-Import Test
 *
 * Tests the actual auto-import flow against a real Sonarr item.
 * Run with: SONARR_API_KEY=xxx npx tsx src/lib/queue-cleaner/test-live-import.ts
 */

import { reportDiagnostic } from "./diagnostic-output.js";

const SONARR_URL = process.env.SONARR_URL || "http://localhost:8989";
const SONARR_API_KEY = process.env.SONARR_API_KEY;

if (!SONARR_API_KEY) {
	reportDiagnostic("live-import", "configuration-missing");
	process.exit(1);
}

interface QueueItem {
	id: number;
	title: string;
	downloadId: string;
	trackedDownloadState: string;
	trackedDownloadStatus: string;
	statusMessages?: Array<{ title?: string; messages?: string[] }>;
}

interface ManualImportItem {
	id: number;
	path: string;
	name: string;
	size: number;
	series?: { id: number; title: string };
	episodes?: Array<{ id: number; episodeNumber: number; seasonNumber: number }>;
	quality?: { quality: { name: string } };
	rejections?: Array<{ reason: string }>;
}

async function sonarrFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`${SONARR_URL}/api/v3${endpoint}`, {
		...options,
		headers: {
			"X-Api-Key": SONARR_API_KEY!,
			"Content-Type": "application/json",
			Accept: "application/json",
			...options?.headers,
		},
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Sonarr API error: ${response.status} - ${text}`);
	}

	return response.json();
}

async function findEligibleItem(): Promise<QueueItem | null> {
	reportDiagnostic("live-import", "started");
	const queue = await sonarrFetch<{ records: QueueItem[] }>("/queue?pageSize=200");

	// Find a Married at First Sight episode that's import blocked with the right status
	for (const item of queue.records) {
		if (!item.title.toLowerCase().includes("married")) continue;
		if (
			item.trackedDownloadState !== "importBlocked" &&
			item.trackedDownloadState !== "importPending"
		)
			continue;

		// Check for the safe pattern
		const messages: string[] = [];
		for (const msg of item.statusMessages ?? []) {
			if (msg.title) messages.push(msg.title);
			if (msg.messages) messages.push(...msg.messages);
		}

		const allText = messages.join(" ").toLowerCase();
		if (allText.includes("matched to series by id") || allText.includes("via grab history")) {
			return item;
		}
	}

	return null;
}

async function getManualImportPreview(downloadId: string): Promise<ManualImportItem[]> {
	reportDiagnostic("live-import", "preview-requested");
	return sonarrFetch<ManualImportItem[]>(
		`/manualimport?downloadId=${downloadId}&filterExistingFiles=true`,
	);
}

async function executeManualImport(
	items: ManualImportItem[],
	downloadId: string,
): Promise<{ id: number }> {
	reportDiagnostic("live-import", "import-started", { files: items.length });

	// Build the import command payload
	const files = items.map((item) => ({
		path: item.path,
		seriesId: item.series?.id,
		episodeIds: item.episodes?.map((e) => e.id) ?? [],
		quality: item.quality,
		// Use the existing parsed data
		releaseGroup: undefined,
		downloadId: downloadId,
	}));

	const command = {
		name: "ManualImport",
		files: files,
		importMode: "auto",
	};

	return sonarrFetch<{ id: number }>("/command", {
		method: "POST",
		body: JSON.stringify(command),
	});
}

async function checkCommandStatus(
	commandId: number,
): Promise<{ status: string; message?: string }> {
	return sonarrFetch<{ status: string; message?: string }>(`/command/${commandId}`);
}

async function main() {
	// Step 1: Find an eligible item
	const item = await findEligibleItem();

	if (!item) {
		reportDiagnostic("live-import", "no-eligible-items");
		return;
	}

	// Step 2: Get manual import preview
	const importItems = await getManualImportPreview(item.downloadId);

	reportDiagnostic("live-import", "import-preview", {
		files: importItems.length,
		rejectedFiles: importItems.filter((i) => i.rejections && i.rejections.length > 0).length,
	});

	// Check if any items have rejections
	const hasRejections = importItems.some((i) => i.rejections && i.rejections.length > 0);
	const hasValidItems = importItems.some((i) => i.series && i.episodes && i.episodes.length > 0);

	if (!hasValidItems) {
		reportDiagnostic("live-import", "no-valid-items");
		return;
	}

	if (hasRejections) {
		reportDiagnostic("live-import", "partial-import-warning");
	}

	// Filter to only items that can be imported (have series and episodes)
	const validItems = importItems.filter((i) => i.series && i.episodes && i.episodes.length > 0);

	if (validItems.length === 0) {
		reportDiagnostic("live-import", "no-valid-items");
		return;
	}

	// Execute the import
	reportDiagnostic("live-import", "eligibility-summary", { validFiles: validItems.length });

	try {
		const command = await executeManualImport(validItems, item.downloadId);
		reportDiagnostic("live-import", "command-queued");

		// Poll for completion

		let status: { status: string; message?: string } = { status: "queued" };
		let attempts = 0;
		const maxAttempts = 30; // 30 seconds max

		while (attempts < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			status = await checkCommandStatus(command.id);

			if (status.status === "completed") {
				reportDiagnostic("live-import", "command-completed");

				break;
			}
			if (status.status === "failed") {
				reportDiagnostic("live-import", "command-failed");
				break;
			}

			reportDiagnostic("live-import", "command-pending", { attempts });
			attempts++;
		}

		if (attempts >= maxAttempts) {
			reportDiagnostic("live-import", "command-timeout", { attempts });
		}

		reportDiagnostic("live-import", "command-status", {
			status:
				status.status === "completed" ||
				status.status === "failed" ||
				status.status === "queued" ||
				status.status === "started"
					? status.status
					: "unknown",
		});
	} catch {
		reportDiagnostic("live-import", "provider-failed");
	}
}

main().catch(() => reportDiagnostic("live-import", "provider-failed"));
