/**
 * Analyze Status Message Patterns
 *
 * Helps understand what status messages are present in pending/blocked items
 * to determine if safe patterns list needs expansion.
 */

import { reportDiagnostic } from "./diagnostic-output.js";

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
	reportDiagnostic("status-patterns", "started");

	for (const provider of ["sonarr", "radarr"] as const) {
		const queue =
			provider === "sonarr"
				? await fetchQueue(SONARR_URL, SONARR_API_KEY, "v3")
				: await fetchQueue(RADARR_URL, RADARR_API_KEY, "v3");
		const patterns = new Map<string, number>();
		let pendingItems = 0;
		let blockedItems = 0;
		let eligibleItems = 0;
		let messageOccurrences = 0;

		for (const item of queue.records ?? []) {
			const state = item.trackedDownloadState ?? "unknown";
			if (state !== "importPending" && state !== "importBlocked") continue;
			if (state === "importPending") pendingItems++;
			else blockedItems++;
			const allText: string[] = [];

			if (Array.isArray(item.statusMessages)) {
				for (const msg of item.statusMessages) {
					if (msg?.title) {
						patterns.set(msg.title, (patterns.get(msg.title) ?? 0) + 1);
						messageOccurrences++;
						allText.push(msg.title);
					}
					if (provider === "radarr" && Array.isArray(msg?.messages)) {
						allText.push(...msg.messages.filter((m): m is string => typeof m === "string"));
						for (const message of msg.messages) {
							if (typeof message === "string" && message.trim()) {
								const key = message.substring(0, 60);
								patterns.set(key, (patterns.get(key) ?? 0) + 1);
								messageOccurrences++;
							}
						}
					}
				}
			}

			if (provider === "radarr") {
				const safeKeywords = ["waiting for import", "import pending", "manual import"];
				const hasSafe = safeKeywords.some((k) => allText.join(" ").toLowerCase().includes(k));
				if (hasSafe) eligibleItems++;
			}
		}

		reportDiagnostic("status-patterns", "pattern-summary", {
			provider,
			totalItems: queue.totalRecords,
			pendingItems,
			blockedItems,
			patterns: patterns.size,
			messageOccurrences,
			...(provider === "radarr" ? { eligibleItems } : {}),
		});
	}
}

// Only execute when run directly (not when imported)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	analyzeStatusMessages().catch(() => reportDiagnostic("status-patterns", "provider-failed"));
}
