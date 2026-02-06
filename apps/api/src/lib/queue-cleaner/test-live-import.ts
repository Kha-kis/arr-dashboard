/**
 * Live Auto-Import Test
 *
 * Tests the actual auto-import flow against a real Sonarr item.
 * Run with: SONARR_API_KEY=xxx npx tsx src/lib/queue-cleaner/test-live-import.ts
 */

const SONARR_URL = process.env.SONARR_URL || "http://localhost:8989";
const SONARR_API_KEY = process.env.SONARR_API_KEY;

if (!SONARR_API_KEY) {
	console.error("❌ Please set SONARR_API_KEY environment variable");
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
	console.log("📋 Fetching Sonarr queue...");
	const queue = await sonarrFetch<{ records: QueueItem[] }>("/queue?pageSize=200");

	// Find a Married at First Sight episode that's import blocked with the right status
	for (const item of queue.records) {
		if (!item.title.toLowerCase().includes("married")) continue;
		if (item.trackedDownloadState !== "importBlocked" && item.trackedDownloadState !== "importPending") continue;

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
	console.log(`\n🔍 Getting manual import preview for downloadId: ${downloadId}`);
	return sonarrFetch<ManualImportItem[]>(`/manualimport?downloadId=${downloadId}&filterExistingFiles=true`);
}

async function executeManualImport(items: ManualImportItem[], downloadId: string): Promise<{ id: number }> {
	console.log(`\n🚀 Executing manual import for ${items.length} file(s)...`);

	// Build the import command payload
	const files = items.map(item => ({
		path: item.path,
		seriesId: item.series?.id,
		episodeIds: item.episodes?.map(e => e.id) ?? [],
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

	console.log("   Payload:", JSON.stringify(command, null, 2).substring(0, 500) + "...");

	return sonarrFetch<{ id: number }>("/command", {
		method: "POST",
		body: JSON.stringify(command),
	});
}

async function checkCommandStatus(commandId: number): Promise<{ status: string; message?: string }> {
	return sonarrFetch<{ status: string; message?: string }>(`/command/${commandId}`);
}

async function main() {
	console.log("🧪 Live Auto-Import Test");
	console.log("═".repeat(60));
	console.log(`   Sonarr URL: ${SONARR_URL}`);
	console.log("");

	// Step 1: Find an eligible item
	const item = await findEligibleItem();

	if (!item) {
		console.log("❌ No eligible Married at First Sight episodes found in queue");
		return;
	}

	console.log("\n✅ Found eligible item:");
	console.log(`   Title: ${item.title}`);
	console.log(`   State: ${item.trackedDownloadState}`);
	console.log(`   Download ID: ${item.downloadId}`);

	// Step 2: Get manual import preview
	const importItems = await getManualImportPreview(item.downloadId);

	console.log(`\n📦 Manual import preview returned ${importItems.length} item(s):`);

	for (const importItem of importItems) {
		console.log(`\n   File: ${importItem.name}`);
		console.log(`   Path: ${importItem.path}`);
		console.log(`   Size: ${(importItem.size / 1024 / 1024).toFixed(2)} MB`);

		if (importItem.series) {
			console.log(`   Series: ${importItem.series.title} (ID: ${importItem.series.id})`);
		}

		if (importItem.episodes && importItem.episodes.length > 0) {
			const eps = importItem.episodes.map(e => `S${e.seasonNumber}E${e.episodeNumber}`).join(", ");
			console.log(`   Episodes: ${eps}`);
		}

		if (importItem.quality) {
			console.log(`   Quality: ${importItem.quality.quality.name}`);
		}

		if (importItem.rejections && importItem.rejections.length > 0) {
			console.log(`   ⚠️ Rejections:`);
			for (const rej of importItem.rejections) {
				console.log(`      • ${rej.reason}`);
			}
		}
	}

	// Check if any items have rejections
	const hasRejections = importItems.some(i => i.rejections && i.rejections.length > 0);
	const hasValidItems = importItems.some(i => i.series && i.episodes && i.episodes.length > 0);

	if (!hasValidItems) {
		console.log("\n❌ No valid items to import (missing series/episode mapping)");
		return;
	}

	if (hasRejections) {
		console.log("\n⚠️  Some items have rejections - import may be partial");
	}

	// Step 3: Ask for confirmation before importing
	console.log("\n" + "═".repeat(60));
	console.log("⚡ Ready to execute import!");
	console.log("═".repeat(60));

	// Filter to only items that can be imported (have series and episodes)
	const validItems = importItems.filter(i => i.series && i.episodes && i.episodes.length > 0);

	if (validItems.length === 0) {
		console.log("\n❌ No valid items to import after filtering");
		return;
	}

	// Execute the import
	console.log(`\n🚀 Executing import for ${validItems.length} valid file(s)...`);

	try {
		const command = await executeManualImport(validItems, item.downloadId);
		console.log(`\n✅ Import command queued! Command ID: ${command.id}`);

		// Poll for completion
		console.log("\n⏳ Waiting for import to complete...");

		let status = { status: "queued", message: "" };
		let attempts = 0;
		const maxAttempts = 30; // 30 seconds max

		while (attempts < maxAttempts) {
			await new Promise(resolve => setTimeout(resolve, 1000));
			status = await checkCommandStatus(command.id);

			if (status.status === "completed") {
				console.log("\n🎉 SUCCESS! Import completed!");
				console.log("   The episode should now be in your library.");
				break;
			} else if (status.status === "failed") {
				console.log(`\n❌ FAILED: ${status.message || "Unknown error"}`);
				break;
			}

			process.stdout.write(".");
			attempts++;
		}

		if (attempts >= maxAttempts) {
			console.log("\n⚠️  Timeout waiting for import - check Sonarr Activity");
		}

		console.log(`\n   Final status: ${status.status}`);

	} catch (error) {
		console.log(`\n❌ Import failed: ${error}`);
	}
}

main().catch(console.error);
