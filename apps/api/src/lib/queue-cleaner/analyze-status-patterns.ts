/**
 * Analyze Status Message Patterns
 *
 * Helps understand what status messages are present in pending/blocked items
 * to determine if safe patterns list needs expansion.
 */

const SONARR_URL = process.env.SONARR_URL || "http://localhost:8989";
const SONARR_API_KEY = process.env.SONARR_API_KEY || "YOUR_SONARR_API_KEY";
const RADARR_URL = process.env.RADARR_URL || "http://localhost:7878";
const RADARR_API_KEY = process.env.RADARR_API_KEY || "YOUR_RADARR_API_KEY";

interface QueueItem {
	id: number;
	title: string;
	trackedDownloadState?: string;
	statusMessages?: Array<{
		title?: string;
		messages?: string[];
	}>;
}

interface QueueResponse {
	totalRecords: number;
	records?: QueueItem[];
}

async function fetchQueue(url: string, apiKey: string, apiVersion: string): Promise<QueueResponse> {
	const response = await fetch(`${url}/api/${apiVersion}/queue?pageSize=200`, {
		headers: { "X-Api-Key": apiKey, Accept: "application/json" },
	});
	return response.json();
}

async function analyzeStatusMessages() {
	console.log("📊 Analyzing Status Message Patterns in Pending/Blocked Items\n");
	console.log("═".repeat(70));

	// Analyze Sonarr
	console.log("\n📺 SONARR Status Patterns:\n");
	const sonarrQueue = await fetchQueue(SONARR_URL, SONARR_API_KEY, "v3");
	const sonarrPatterns = new Map<string, { count: number; sample: string }>();

	for (const item of sonarrQueue.records ?? []) {
		const state = item.trackedDownloadState ?? "unknown";
		if (state !== "importPending" && state !== "importBlocked") continue;

		if (Array.isArray(item.statusMessages)) {
			for (const msg of item.statusMessages) {
				if (msg?.title) {
					const existing = sonarrPatterns.get(msg.title);
					if (existing) {
						existing.count++;
					} else {
						sonarrPatterns.set(msg.title, { count: 1, sample: item.title });
					}
				}
			}
		}
	}

	// Sort by count
	const sortedSonarr = [...sonarrPatterns.entries()].sort((a, b) => b[1].count - a[1].count);
	for (const [pattern, { count, sample }] of sortedSonarr) {
		console.log(`   (${count}x) "${pattern}"`);
		console.log(`         Sample: ${sample.substring(0, 50)}...`);
	}

	// Analyze Radarr
	console.log("\n" + "═".repeat(70));
	console.log("\n🎬 RADARR Status Patterns:\n");
	const radarrQueue = await fetchQueue(RADARR_URL, RADARR_API_KEY, "v3");
	const radarrPatterns = new Map<string, { count: number; sample: string }>();

	for (const item of radarrQueue.records ?? []) {
		const state = item.trackedDownloadState ?? "unknown";
		if (state !== "importPending" && state !== "importBlocked") continue;

		if (Array.isArray(item.statusMessages)) {
			for (const msg of item.statusMessages) {
				if (msg?.title) {
					const existing = radarrPatterns.get(msg.title);
					if (existing) {
						existing.count++;
					} else {
						radarrPatterns.set(msg.title, { count: 1, sample: item.title });
					}
				}
				// Also check nested messages
				if (Array.isArray(msg?.messages)) {
					for (const m of msg.messages) {
						if (typeof m === "string" && m.trim()) {
							const key = m.substring(0, 60);
							const existing = radarrPatterns.get(key);
							if (existing) {
								existing.count++;
							} else {
								radarrPatterns.set(key, { count: 1, sample: item.title });
							}
						}
					}
				}
			}
		}
	}

	const sortedRadarr = [...radarrPatterns.entries()].sort((a, b) => b[1].count - a[1].count);
	for (const [pattern, { count, sample }] of sortedRadarr) {
		console.log(`   (${count}x) "${pattern}"`);
		console.log(`         Sample: ${sample.substring(0, 50)}...`);
	}

	// Show the eligible Radarr item in detail
	console.log("\n" + "═".repeat(70));
	console.log("\n✨ ELIGIBLE RADARR ITEM (Full Details):\n");

	for (const item of radarrQueue.records ?? []) {
		const state = item.trackedDownloadState ?? "unknown";
		if (state !== "importPending" && state !== "importBlocked") continue;

		const allText: string[] = [];
		if (Array.isArray(item.statusMessages)) {
			for (const msg of item.statusMessages) {
				if (msg?.title) allText.push(msg.title);
				if (Array.isArray(msg?.messages)) {
					allText.push(...msg.messages.filter((m): m is string => typeof m === "string"));
				}
			}
		}

		const safeKeywords = ["waiting for import", "import pending", "manual import"];
		const hasSafe = safeKeywords.some(k => allText.join(" ").toLowerCase().includes(k));

		if (hasSafe) {
			console.log(`   Title: ${item.title}`);
			console.log(`   State: ${state}`);
			console.log(`   Status Messages:`);
			for (const text of allText) {
				console.log(`      • ${text}`);
			}
		}
	}

	console.log("\n" + "═".repeat(70));
	console.log("\n💡 RECOMMENDATION:");
	console.log("─".repeat(70));

	// Check if there are common patterns that could be added
	const commonPendingPatterns = [
		"series folder",
		"episode file",
		"no files found",
		"unknown series",
		"unknown movie",
	];

	console.log("\nCurrent safe patterns only match: 'waiting for import', 'import pending', 'manual import'");
	console.log("\nMost pending/blocked items don't have these patterns in their status.");
	console.log("This is expected - 'safe only' mode is conservative by design.\n");
	console.log("Options:");
	console.log("  1. Keep 'Safe patterns only' enabled (conservative, may miss items)");
	console.log("  2. Disable 'Safe patterns only' to auto-import all pending/blocked items");
	console.log("  3. Add more patterns to the safe list if we identify reliable ones\n");
}

analyzeStatusMessages().catch(console.error);
