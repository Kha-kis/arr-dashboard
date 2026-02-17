/**
 * Queue item data utilities.
 *
 * Pure functions for parsing and matching queue item data from
 * the ARR API. No side effects, no external dependencies.
 */

import type { WhitelistPattern } from "./constants.js";

/**
 * Raw queue item shape from the ARR API.
 * This interface documents expected fields but uses `unknown` for runtime safety.
 * All field access is guarded with explicit type checks in the codebase.
 */
export interface RawQueueItem {
	id?: unknown;
	title?: unknown;
	added?: unknown;
	size?: unknown;
	sizeleft?: unknown;
	estimatedCompletionTime?: unknown;
	trackedDownloadStatus?: unknown;
	trackedDownloadState?: unknown;
	statusMessages?: unknown;
	errorMessage?: unknown;
	indexer?: unknown;
	protocol?: unknown;
	downloadClient?: unknown;
	downloadId?: unknown;
	tags?: unknown;
	/** Allow other properties we don't explicitly handle */
	[key: string]: unknown;
}

/**
 * Safely parse a date value from unknown, returning null if invalid.
 */
export function parseDate(value: unknown): Date | null {
	if (!value) return null;
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	return null;
}

/**
 * Collect all status text from a queue item for keyword matching.
 */
export function collectStatusTexts(item: RawQueueItem): string[] {
	const results: string[] = [];

	if (Array.isArray(item.statusMessages)) {
		for (const entry of item.statusMessages) {
			if (entry && typeof entry === "object") {
				if (typeof entry.title === "string" && entry.title.trim()) {
					results.push(entry.title.trim());
				}
				if (Array.isArray(entry.messages)) {
					for (const msg of entry.messages) {
						if (typeof msg === "string" && msg.trim()) {
							results.push(msg.trim());
						}
					}
				}
			}
		}
	}

	if (typeof item.errorMessage === "string" && item.errorMessage.trim()) {
		results.push(item.errorMessage.trim());
	}

	return results;
}

/**
 * Check if any status text matches the given keywords (case-insensitive).
 */
export function matchesKeywords(texts: string[], keywords: readonly string[]): string | null {
	for (const text of texts) {
		const lower = text.toLowerCase();
		for (const keyword of keywords) {
			if (lower.includes(keyword)) {
				return text;
			}
		}
	}
	return null;
}

/**
 * Check if a queue item matches any whitelist pattern.
 */
export function checkWhitelist(
	item: RawQueueItem,
	patterns: WhitelistPattern[],
): { matched: boolean; reason?: string } {
	for (const pattern of patterns) {
		if (!pattern.pattern || !pattern.pattern.trim()) continue;
		const lowerPattern = pattern.pattern.toLowerCase().trim();

		switch (pattern.type) {
			case "tracker": {
				const indexer = typeof item.indexer === "string" ? item.indexer.toLowerCase() : "";
				if (indexer.includes(lowerPattern)) {
					return { matched: true, reason: `Tracker matches: ${pattern.pattern}` };
				}
				break;
			}
			case "tag": {
				if (Array.isArray(item.tags)) {
					for (const tag of item.tags) {
						const tagStr = typeof tag === "string" ? tag : (tag?.label ?? "");
						if (tagStr.toLowerCase().includes(lowerPattern)) {
							return { matched: true, reason: `Tag matches: ${pattern.pattern}` };
						}
					}
				}
				break;
			}
			case "category": {
				const downloadClient =
					typeof item.downloadClient === "string" ? item.downloadClient.toLowerCase() : "";
				const protocol = typeof item.protocol === "string" ? item.protocol.toLowerCase() : "";
				if (downloadClient.includes(lowerPattern) || protocol.includes(lowerPattern)) {
					return { matched: true, reason: `Category matches: ${pattern.pattern}` };
				}
				break;
			}
			case "title": {
				const title = typeof item.title === "string" ? item.title.toLowerCase() : "";
				if (title.includes(lowerPattern)) {
					return { matched: true, reason: `Title matches: ${pattern.pattern}` };
				}
				break;
			}
		}
	}
	return { matched: false };
}
