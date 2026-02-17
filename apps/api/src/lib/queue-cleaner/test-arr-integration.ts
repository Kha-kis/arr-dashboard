/**
 * Multi-Instance ARR Integration Test
 *
 * Tests the queue cleaner auto-import feature against real ARR instances.
 * Run with: npx tsx src/lib/queue-cleaner/test-arr-integration.ts
 *
 * Environment variables (or edit the INSTANCES array below):
 *   SONARR_URL, SONARR_API_KEY
 *   RADARR_URL, RADARR_API_KEY
 *   LIDARR_URL, LIDARR_API_KEY
 */
import { getErrorMessage } from "../utils/error-message.js";

// ============================================================================
// CONFIGURATION - Edit these or use environment variables
// ============================================================================

interface ArrInstance {
	name: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	url: string;
	apiKey: string;
	apiVersion: string;
}

const INSTANCES: ArrInstance[] = [
	{
		name: "Sonarr",
		service: "sonarr",
		url: process.env.SONARR_URL || "http://localhost:8989",
		apiKey: process.env.SONARR_API_KEY || "YOUR_SONARR_API_KEY",
		apiVersion: "v3",
	},
	{
		name: "Radarr",
		service: "radarr",
		url: process.env.RADARR_URL || "http://localhost:7878",
		apiKey: process.env.RADARR_API_KEY || "YOUR_RADARR_API_KEY",
		apiVersion: "v3",
	},
	{
		name: "Lidarr",
		service: "lidarr",
		url: process.env.LIDARR_URL || "http://localhost:8686",
		apiKey: process.env.LIDARR_API_KEY || "YOUR_LIDARR_API_KEY",
		apiVersion: "v1",
	},
];

// ============================================================================
// AUTO-IMPORT PATTERNS (same as in constants.ts)
// ============================================================================

const AUTO_IMPORT_SAFE_KEYWORDS = [
	// Direct import requests
	"waiting for import",
	"import pending",
	"manual import required",
	"manual import",
	"waiting for manual",
	// ID-matched items (file correctly identified via grab history)
	"matched to series by id",
	"matched to movie by id",
	"matched to artist by id",
	"matched to album by id",
	"matched to book by id",
	// Grab history match (indicates proper tracking)
	"via grab history",
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

// ============================================================================
// TYPES
// ============================================================================

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

interface TestResult {
	instance: ArrInstance;
	success: boolean;
	error?: string;
	totalItems: number;
	stateBreakdown: Map<string, number>;
	importPendingCount: number;
	importBlockedCount: number;
	importFailedCount: number;
	autoImportEligible: number;
	items: Array<{
		id: number;
		title: string;
		state: string;
		status: string;
		statusMessages: string[];
		downloadId?: string;
		autoImportEligible: boolean;
		autoImportReason: string;
	}>;
}

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

async function fetchQueue(instance: ArrInstance): Promise<QueueResponse> {
	const response = await fetch(
		`${instance.url}/api/${instance.apiVersion}/queue?pageSize=100`,
		{
			headers: {
				"X-Api-Key": instance.apiKey,
				Accept: "application/json",
			},
		}
	);

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	return response.json();
}

async function testInstance(instance: ArrInstance): Promise<TestResult> {
	const result: TestResult = {
		instance,
		success: false,
		totalItems: 0,
		stateBreakdown: new Map(),
		importPendingCount: 0,
		importBlockedCount: 0,
		importFailedCount: 0,
		autoImportEligible: 0,
		items: [],
	};

	// Skip if no API key provided
	if (instance.apiKey === "YOUR_SONARR_API_KEY" ||
		instance.apiKey === "YOUR_RADARR_API_KEY" ||
		!instance.apiKey) {
		result.error = "API key not configured";
		return result;
	}

	try {
		const queue = await fetchQueue(instance);
		result.success = true;
		result.totalItems = queue.totalRecords;

		for (const item of queue.records ?? []) {
			const state = item.trackedDownloadState ?? "unknown";
			result.stateBreakdown.set(state, (result.stateBreakdown.get(state) ?? 0) + 1);

			// Track import states
			if (state === "importPending") result.importPendingCount++;
			if (state === "importBlocked") result.importBlockedCount++;
			if (state === "importFailed") result.importFailedCount++;

			// Collect import-related items for analysis
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

				// Check auto-import eligibility
				const allText = statusMessages.join(" ").toLowerCase();
				const hasSafe = AUTO_IMPORT_SAFE_KEYWORDS.some(k => allText.includes(k));
				const neverMatch = AUTO_IMPORT_NEVER_KEYWORDS.find(k => allText.includes(k));

				let autoImportEligible = false;
				let autoImportReason = "";

				if (state === "importFailed") {
					autoImportReason = "Not applicable (handled by Failed Downloads rule)";
				} else if (neverMatch) {
					autoImportReason = `Not eligible (matched: "${neverMatch}")`;
				} else if (hasSafe) {
					autoImportEligible = true;
					autoImportReason = "ELIGIBLE (has safe pattern)";
					result.autoImportEligible++;
				} else {
					autoImportReason = "Not eligible (no safe pattern matched)";
				}

				result.items.push({
					id: item.id,
					title: item.title ?? "Unknown",
					state,
					status: item.trackedDownloadStatus ?? "unknown",
					statusMessages: statusMessages.slice(0, 5),
					downloadId: item.downloadId,
					autoImportEligible,
					autoImportReason,
				});
			}
		}
	} catch (error) {
		result.error = getErrorMessage(error);
	}

	return result;
}

function printResult(result: TestResult) {
	const emoji = result.instance.service === "sonarr" ? "📺" :
				  result.instance.service === "radarr" ? "🎬" :
				  result.instance.service === "lidarr" ? "🎵" : "📚";

	console.log(`\n${"═".repeat(70)}`);
	console.log(`${emoji} ${result.instance.name} (${result.instance.url})`);
	console.log("═".repeat(70));

	if (!result.success) {
		console.log(`   ❌ Error: ${result.error}`);
		return;
	}

	console.log(`   📋 Total queue items: ${result.totalItems}`);

	// State breakdown
	if (result.stateBreakdown.size > 0) {
		console.log("\n   📊 State Breakdown:");
		for (const [state, count] of result.stateBreakdown) {
			const stateEmoji = state === "importPending" ? "⏳" :
							   state === "importBlocked" ? "🚫" :
							   state === "importFailed" ? "❌" :
							   state === "downloading" ? "⬇️" : "📦";
			console.log(`      ${stateEmoji} ${state}: ${count}`);
		}
	}

	// Auto-import summary
	console.log("\n   🔍 Auto-Import Analysis:");
	console.log(`      Import Pending: ${result.importPendingCount}`);
	console.log(`      Import Blocked: ${result.importBlockedCount}`);
	console.log(`      Import Failed:  ${result.importFailedCount}`);
	console.log(`      ✨ Auto-Import Eligible: ${result.autoImportEligible}`);

	// Show eligible items
	const eligibleItems = result.items.filter(i => i.autoImportEligible);
	if (eligibleItems.length > 0) {
		console.log("\n   ✨ Auto-Import Eligible Items:");
		for (const item of eligibleItems) {
			console.log(`      • ${item.title.substring(0, 50)}...`);
			if (item.statusMessages.length > 0) {
				console.log(`        Status: ${item.statusMessages[0]}`);
			}
		}
	}

	// Show pending/blocked items that are NOT eligible (first 3)
	const notEligibleItems = result.items.filter(
		i => !i.autoImportEligible && (i.state === "importPending" || i.state === "importBlocked")
	);
	if (notEligibleItems.length > 0) {
		console.log(`\n   ⚠️  Pending/Blocked but NOT eligible (${notEligibleItems.length} items):`);
		for (const item of notEligibleItems.slice(0, 3)) {
			console.log(`      • ${item.title.substring(0, 50)}...`);
			console.log(`        Reason: ${item.autoImportReason}`);
		}
		if (notEligibleItems.length > 3) {
			console.log(`      ... and ${notEligibleItems.length - 3} more`);
		}
	}
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log("🔍 ARR Queue Cleaner Auto-Import Integration Test");
	console.log("═".repeat(70));
	console.log("Testing auto-import eligibility across all configured instances...\n");

	const results: TestResult[] = [];

	for (const instance of INSTANCES) {
		process.stdout.write(`Testing ${instance.name}... `);
		const result = await testInstance(instance);
		results.push(result);
		console.log(result.success ? "✅" : `❌ ${result.error}`);
	}

	// Print detailed results
	for (const result of results) {
		printResult(result);
	}

	// Summary
	console.log(`\n${"═".repeat(70)}`);
	console.log("📈 OVERALL SUMMARY");
	console.log("═".repeat(70));

	let totalEligible = 0;
	let totalPending = 0;
	let totalBlocked = 0;
	let totalFailed = 0;

	for (const result of results) {
		if (result.success) {
			totalEligible += result.autoImportEligible;
			totalPending += result.importPendingCount;
			totalBlocked += result.importBlockedCount;
			totalFailed += result.importFailedCount;
		}
	}

	console.log(`   Instances tested: ${results.filter(r => r.success).length}/${results.length}`);
	console.log(`   Total importPending: ${totalPending}`);
	console.log(`   Total importBlocked: ${totalBlocked}`);
	console.log(`   Total importFailed: ${totalFailed}`);
	console.log(`   ✨ Total auto-import eligible: ${totalEligible}`);
	console.log("═".repeat(70));

	if (totalEligible > 0) {
		console.log("\n✅ Found items eligible for auto-import!");
		console.log("   The auto-import feature would attempt to import these automatically.");
	} else if (totalPending + totalBlocked > 0) {
		console.log("\n⚠️  Found pending/blocked items but none match safe patterns.");
		console.log("   These items don't have status messages indicating safe auto-import.");
	} else if (totalFailed > 0) {
		console.log("\n❌ Only found failed imports.");
		console.log("   Auto-import targets pending/blocked states, not failed.");
		console.log("   Failed items need the 'Failed Downloads' cleanup rule instead.");
	} else {
		console.log("\n✅ No import issues in any queue!");
	}
}

main().catch(console.error);
