/**
 * Direct Lidarr Integration Test
 *
 * This script tests the queue cleaner against a real Lidarr instance.
 * Run with: npx tsx src/lib/queue-cleaner/test-lidarr-integration.ts
 */

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
	console.log("🎵 Testing Lidarr Integration\n");
	console.log("=".repeat(60));

	// Fetch queue
	console.log("\n📋 Fetching Lidarr queue...");
	const queue = await fetchLidarrQueue();
	console.log(`   Total items in queue: ${queue.totalRecords}`);

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

	// Print state breakdown
	console.log("\n📊 Queue State Breakdown:");
	for (const [state, count] of stateMap) {
		const emoji = state === "importPending" ? "⏳" :
					  state === "importBlocked" ? "🚫" :
					  state === "importFailed" ? "❌" :
					  state === "downloading" ? "⬇️" : "📦";
		console.log(`   ${emoji} ${state}: ${count}`);
	}

	// Check for auto-import eligible items
	console.log("\n🔍 Auto-Import Eligibility Check:");

	const importPendingCount = stateMap.get("importPending") ?? 0;
	const importBlockedCount = stateMap.get("importBlocked") ?? 0;
	const importFailedCount = stateMap.get("importFailed") ?? 0;

	if (importPendingCount === 0 && importBlockedCount === 0) {
		console.log("   ⚠️  No importPending or importBlocked items found");
		console.log("   Auto-import targets these states specifically.");
		console.log("");
		if (importFailedCount > 0) {
			console.log(`   The ${importFailedCount} item(s) with importFailed state would be handled by`);
			console.log("   the 'Failed Downloads' rule instead of auto-import.");
		}
	} else {
		console.log(`   ✅ Found ${importPendingCount + importBlockedCount} eligible items!`);
	}

	// Show all import items with details
	if (importItems.length > 0) {
		console.log("\n📝 Import-Related Items Details:");
		console.log("─".repeat(60));

		for (const item of importItems) {
			const stateEmoji = item.state === "importPending" ? "⏳" :
							   item.state === "importBlocked" ? "🚫" : "❌";

			console.log(`\n${stateEmoji} [${item.state}] ${item.title.substring(0, 50)}...`);
			console.log(`   ID: ${item.id} | Status: ${item.status}`);
			if (item.downloadId) {
				console.log(`   DownloadID: ${item.downloadId}`);
			}

			if (item.statusMessages.length > 0) {
				console.log("   Messages:");
				for (const msg of item.statusMessages) {
					console.log(`      • ${msg}`);
				}
			}

			// Check auto-import eligibility
			const allText = item.statusMessages.join(" ").toLowerCase();
			const hasSafe = AUTO_IMPORT_SAFE_KEYWORDS.some(k => allText.includes(k));
			const neverMatch = AUTO_IMPORT_NEVER_KEYWORDS.find(k => allText.includes(k));

			if (item.state === "importPending" || item.state === "importBlocked") {
				if (neverMatch) {
					console.log(`   🚫 Auto-Import: NOT eligible (matched: "${neverMatch}")`);
				} else if (hasSafe) {
					console.log(`   ✨ Auto-Import: ELIGIBLE (has safe pattern)`);
				} else {
					console.log(`   ⚠️  Auto-Import: NOT eligible (no safe pattern matched)`);
				}
			} else {
				console.log(`   ℹ️  Auto-Import: Not applicable (handled by Failed Downloads rule)`);
			}
		}
	}

	// Test what queue cleaner would do
	console.log(`\n${"=".repeat(60)}`);
	console.log("🧹 Queue Cleaner Preview (simulated):");
	console.log("=".repeat(60));

	let wouldClean = 0;
	let autoImportEligible = 0;

	for (const item of importItems) {
		if (item.state === "importFailed") {
			wouldClean++;
			console.log(`\n   ❌ Would REMOVE (failed): ${item.title.substring(0, 40)}...`);
		} else if (item.state === "importPending" || item.state === "importBlocked") {
			// Check auto-import eligibility
			const allText = item.statusMessages.join(" ").toLowerCase();
			const hasSafe = AUTO_IMPORT_SAFE_KEYWORDS.some(k => allText.includes(k));
			const neverMatch = AUTO_IMPORT_NEVER_KEYWORDS.find(k => allText.includes(k));

			if (neverMatch) {
				console.log(`\n   🚫 Would REMOVE (blocked): ${item.title.substring(0, 40)}...`);
				console.log(`      Auto-import: Not eligible (matched: "${neverMatch}")`);
				wouldClean++;
			} else if (hasSafe) {
				console.log(`\n   ✨ Would AUTO-IMPORT: ${item.title.substring(0, 40)}...`);
				console.log(`      Status: ${item.statusMessages[0] ?? "N/A"}`);
				autoImportEligible++;
			} else {
				console.log(`\n   ⚠️  Would WARN (pending): ${item.title.substring(0, 40)}...`);
				console.log(`      Auto-import: Not eligible (no safe pattern)`);
			}
		}
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("📈 Summary:");
	console.log(`   Items that would be removed: ${wouldClean}`);
	console.log(`   Items eligible for auto-import: ${autoImportEligible}`);
	console.log(`   Total import-related items: ${importItems.length}`);
	console.log("=".repeat(60));

	// Additional: Try to fetch manual import to see if API is available
	console.log("\n🔧 Testing Manual Import API availability...");
	try {
		const miResponse = await fetch(`${LIDARR_URL}/api/v1/manualimport?downloadId=test`, {
			headers: {
				"X-Api-Key": LIDARR_API_KEY,
				Accept: "application/json",
			},
		});

		if (miResponse.ok) {
			console.log("   ✅ Manual Import API is available (GET /api/v1/manualimport)");
		} else {
			console.log(`   ⚠️  Manual Import API returned: ${miResponse.status}`);
		}
	} catch (error) {
		console.log(`   ❌ Manual Import API error: ${error}`);
	}
}

testLidarrIntegration().catch(console.error);
