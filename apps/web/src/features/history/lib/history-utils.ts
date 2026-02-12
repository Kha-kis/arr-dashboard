import type { HistoryItem, ServiceInstanceSummary } from "@arr/shared";

export const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All services" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
	{ value: "prowlarr" as const, label: "Prowlarr" },
	{ value: "lidarr" as const, label: "Lidarr" },
	{ value: "readarr" as const, label: "Readarr" },
];

/**
 * Normalizes status from either status or eventType field
 */
export const normalizeStatus = (status?: string, eventType?: string): string =>
	(status ?? eventType ?? "Unknown").toLowerCase();

/**
 * Extracts instance options from history instances
 */
export const extractInstanceOptions = (
	instances: Array<{ instanceId: string; instanceName: string }>,
): Array<{ value: string; label: string }> => {
	const map = new Map<string, string>();
	for (const entry of instances) {
		map.set(entry.instanceId, entry.instanceName);
	}
	return Array.from(map.entries()).map(([value, label]) => ({
		value,
		label,
	}));
};

/**
 * Extracts unique status options from history items
 */
export const extractStatusOptions = (
	items: HistoryItem[],
): Array<{ value: string; label: string }> => {
	const seen = new Map<string, string>();
	for (const item of items) {
		const rawLabel = item.status ?? item.eventType ?? "Unknown";
		const value = rawLabel.toLowerCase();
		if (!seen.has(value)) {
			seen.set(value, rawLabel);
		}
	}
	return Array.from(seen.entries()).map(([value, label]) => ({
		value,
		label,
	}));
};

/**
 * Creates a summary of history items by service
 */
export const createServiceSummary = (items: HistoryItem[]): Map<HistoryItem["service"], number> => {
	const summary = new Map<HistoryItem["service"], number>();
	for (const item of items) {
		summary.set(item.service, (summary.get(item.service) ?? 0) + 1);
	}
	return summary;
};

/**
 * Creates a summary of history items by status
 */
export const createStatusSummary = (items: HistoryItem[]): Array<[string, number]> => {
	const summary = new Map<string, number>();
	for (const item of items) {
		const label = item.status ?? item.eventType ?? "Unknown";
		summary.set(label, (summary.get(label) ?? 0) + 1);
	}
	return Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
};

export interface HistoryGroup {
	items: HistoryItem[];
	downloadId?: string;
}

/**
 * Groups history items by download ID and related events
 */
export const groupHistoryItems = (
	items: HistoryItem[],
	groupByDownload: boolean,
): HistoryGroup[] => {
	if (!groupByDownload) {
		return items.map((item) => ({
			items: [item],
			downloadId: item.downloadId,
		}));
	}

	const groups = new Map<string, HistoryItem[]>();
	const deleteEvents: HistoryItem[] = [];
	const ungrouped: HistoryItem[] = [];

	// First pass: group all non-delete events
	for (const item of items) {
		const eventType = (item.eventType ?? "").toLowerCase();
		const isDeleteEvent = eventType.includes("delete");

		// Collect delete events for second pass
		if (isDeleteEvent) {
			deleteEvents.push(item);
			continue;
		}

		// Group RSS feed sync events by instance + rounded timestamp (within 5 minutes)
		if (item.service === "prowlarr" && (eventType.includes("rss") || eventType === "indexerrss")) {
			const date = item.date ? new Date(item.date) : new Date();
			const roundedTime = Math.floor(date.getTime() / (5 * 60 * 1000)); // Round to 5 min intervals
			const rssKey = `rss-${item.instanceId}-${roundedTime}`;
			const existing = groups.get(rssKey) ?? [];
			existing.push(item);
			groups.set(rssKey, existing);
			continue;
		}

		// For Sonarr/Radarr: use multi-tier grouping strategy
		if (item.service === "sonarr" || item.service === "radarr") {
			const downloadId = item.downloadId?.trim();
			const date = item.date ? new Date(item.date) : new Date();
			const quality = (item.quality as any)?.quality?.name ?? "unknown";
			let groupKey = "";

			// Check if downloadId looks valid (not just a number which is likely an event ID)
			const isValidDownloadId = downloadId && downloadId.length > 10 && !/^\d+$/.test(downloadId);

			if (isValidDownloadId) {
				// Use downloadId for grabbed/imported events
				groupKey = downloadId;
			} else if (item.service === "sonarr" && item.episodeId) {
				// For non-delete events without valid downloadId
				const roundedTime = Math.floor(date.getTime() / (30 * 60 * 1000));
				groupKey = `episode-${item.instanceId}-${item.episodeId}-${quality}-${roundedTime}`;
			} else if (item.service === "radarr" && item.movieId) {
				const roundedTime = Math.floor(date.getTime() / (30 * 60 * 1000));
				groupKey = `movie-${item.instanceId}-${item.movieId}-${quality}-${roundedTime}`;
			} else {
				// Fallback: group identical releases by sourceTitle or title + quality + exact time
				const title = (item.sourceTitle || item.title || "").trim();
				if (title) {
					const exactMinute = Math.floor(date.getTime() / (60 * 1000));
					groupKey = `release-${item.instanceId}-${title}-${quality}-${exactMinute}`;
				}
			}

			if (groupKey) {
				const existing = groups.get(groupKey) ?? [];
				existing.push(item);
				groups.set(groupKey, existing);
				continue;
			}
		}

		// For other services, try downloadId
		const downloadId = item.downloadId?.trim();
		if (downloadId) {
			const existing = groups.get(downloadId) ?? [];
			existing.push(item);
			groups.set(downloadId, existing);
			continue;
		}

		// Ungrouped
		ungrouped.push(item);
	}

	// Second pass: attach delete events to their matching groups
	for (const item of deleteEvents) {
		const date = item.date ? new Date(item.date) : new Date();
		let addedToGroup = false;

		// Find a matching group for this delete event (same episode/movie, within time window)
		for (const [_key, groupItems] of groups.entries()) {
			const firstInGroup = groupItems[0];
			if (!firstInGroup) continue;

			// Check if it's the same episode/movie and instance
			const sameEpisode =
				item.service === "sonarr" &&
				item.episodeId === firstInGroup.episodeId &&
				item.instanceId === firstInGroup.instanceId;
			const sameMovie =
				item.service === "radarr" &&
				item.movieId === firstInGroup.movieId &&
				item.instanceId === firstInGroup.instanceId;

			if (sameEpisode || sameMovie) {
				// Check if within 2 hour time window of any event in the group
				const withinTimeWindow = groupItems.some((groupItem) => {
					const groupDate = groupItem.date ? new Date(groupItem.date).getTime() : 0;
					const deleteDate = date.getTime();
					return Math.abs(groupDate - deleteDate) < 2 * 60 * 60 * 1000; // 2 hours
				});

				if (withinTimeWindow) {
					groupItems.push(item);
					addedToGroup = true;
					break;
				}
			}
		}

		if (!addedToGroup) {
			ungrouped.push(item);
		}
	}

	// Sort groups by most recent date descending
	const result: HistoryGroup[] = [];
	for (const groupItems of groups.values()) {
		groupItems.sort((a, b) => {
			const dateA = a.date ? new Date(a.date).getTime() : 0;
			const dateB = b.date ? new Date(b.date).getTime() : 0;
			return dateB - dateA;
		});
		result.push({
			items: groupItems,
			downloadId: groupItems[0]?.downloadId,
		});
	}

	// Add ungrouped items
	for (const item of ungrouped) {
		result.push({
			items: [item],
			downloadId: item.downloadId,
		});
	}

	// Sort all groups by most recent item in each group
	result.sort((a, b) => {
		const dateA = a.items[0]?.date ? new Date(a.items[0].date).getTime() : 0;
		const dateB = b.items[0]?.date ? new Date(b.items[0].date).getTime() : 0;
		return dateB - dateA;
	});

	return result;
};

/**
 * Removes trailing slashes from URL
 */
const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Builds external link to Sonarr/Radarr/Prowlarr for a history item
 * Links to the specific media item if available, otherwise to activity/history
 */
export const buildHistoryExternalLink = (
	item: HistoryItem,
	instance?: ServiceInstanceSummary,
): string | null => {
	if (!instance || !instance.baseUrl) {
		return null;
	}

	const baseUrl = normalizeBaseUrl(instance.baseUrl);

	// For Sonarr: link to series page if we have the slug/ID
	if (item.service === "sonarr") {
		if (item.seriesSlug) {
			return `${baseUrl}/series/${item.seriesSlug}`;
		}
		if (item.seriesId) {
			return `${baseUrl}/series/${item.seriesId}`;
		}
		// Fallback to history page
		return `${baseUrl}/activity/history`;
	}

	// For Radarr: link to movie page if we have the slug/ID
	if (item.service === "radarr") {
		if (item.movieSlug) {
			return `${baseUrl}/movie/${item.movieSlug}`;
		}
		if (item.movieId) {
			return `${baseUrl}/movie/${item.movieId}`;
		}
		// Fallback to history page
		return `${baseUrl}/activity/history`;
	}

	// For Prowlarr: link to main page (indexers)
	if (item.service === "prowlarr") {
		return baseUrl;
	}

	return null;
};

/**
 * Filters out Prowlarr RSS sync events
 */
export const filterProwlarrRss = (items: HistoryItem[]): HistoryItem[] =>
	items.filter((item) => {
		if (item.service !== "prowlarr") return true;
		const eventType = (item.eventType ?? "").toLowerCase();
		return !eventType.includes("rss");
	});

/**
 * Lifecycle stage for a download event
 */
export interface LifecycleStage {
	stage: string;
	label: string;
	color: "success" | "warning" | "error" | "info" | "default";
}

/**
 * Detects the lifecycle stages from a group of history items.
 * Returns stages in chronological order (oldest first).
 */
export const detectLifecycleStages = (items: HistoryItem[]): LifecycleStage[] => {
	if (items.length <= 1) return [];

	const sorted = [...items].sort((a, b) => {
		const dateA = a.date ? new Date(a.date).getTime() : 0;
		const dateB = b.date ? new Date(b.date).getTime() : 0;
		return dateA - dateB;
	});

	const seen = new Set<string>();
	const stages: LifecycleStage[] = [];

	for (const item of sorted) {
		const eventType = (item.eventType ?? item.status ?? "").toLowerCase();
		let stage: LifecycleStage | undefined;

		if (eventType.includes("grab")) {
			stage = { stage: "grabbed", label: "Grabbed", color: "info" };
		} else if (eventType.includes("import") || eventType.includes("download")) {
			stage = { stage: "imported", label: "Imported", color: "success" };
		} else if (eventType.includes("fail") || eventType.includes("error") || eventType.includes("reject")) {
			stage = { stage: "failed", label: "Failed", color: "error" };
		} else if (eventType.includes("delete") || eventType.includes("removed")) {
			stage = { stage: "deleted", label: "Deleted", color: "warning" };
		} else if (eventType.includes("upgrade")) {
			stage = { stage: "upgraded", label: "Upgraded", color: "success" };
		} else if (eventType.includes("renam")) {
			stage = { stage: "renamed", label: "Renamed", color: "default" };
		}

		if (stage && !seen.has(stage.stage)) {
			seen.add(stage.stage);
			stages.push(stage);
		}
	}

	return stages;
};

export { formatBytes } from "../../../lib/format-utils";

/**
 * Returns a display title for a history item, handling Prowlarr-specific data
 */
export const getDisplayTitle = (item: HistoryItem): string => {
	// For Prowlarr, try to extract meaningful info from data field
	if (item.service === "prowlarr") {
		const data = item.data as any;
		const eventType = (item.eventType ?? "").toLowerCase();

		// For release grabbed events, prioritize release title
		if (eventType.includes("grab") || eventType.includes("release")) {
			const release = data?.releaseTitle || data?.title || item.title || item.sourceTitle;
			if (release && release !== "Untitled" && release) return release;
		}

		// For query/RSS events, show the search term or category
		if (eventType.includes("query") || eventType.includes("rss")) {
			const query = data?.query || data?.searchTerm || data?.term;
			if (query) return `Search: "${query}"`;

			// For RSS with no query, show categories or "RSS Feed Sync"
			const categories = data?.categories;
			if (categories && Array.isArray(categories) && categories.length > 0) {
				return `RSS: ${categories.join(", ")}`;
			}

			return "RSS Feed Sync";
		}

		// Fallback: try release title, then query
		const release = data?.releaseTitle || data?.title;
		if (release && release !== "Untitled" && release) return release;

		const query = data?.query || data?.searchTerm;
		if (query) return `Search: "${query}"`;

		// If we still have nothing useful, show the event type context
		if (eventType.includes("rss")) return "RSS Feed Sync";
		if (eventType.includes("query")) return "Indexer Query";

		// Last resort: show application
		const app = data?.application || data?.source;
		if (app) return `${eventType} - ${app}`;
	}

	// For series, show "Series - Episode Title"
	if (item.service === "sonarr" && item.title) {
		return item.title;
	}
	// For movies, show movie title
	if (item.service === "radarr" && item.title) {
		return item.title;
	}
	// Fallback to sourceTitle or generic
	return item.sourceTitle ?? item.title ?? "Unknown";
};

/**
 * Maps event type to StatusBadge variant
 */
export const getEventTypeStatusBadge = (eventType: string): "success" | "warning" | "error" | "info" | "default" => {
	const normalized = eventType.toLowerCase();
	if (normalized.includes("download") || normalized.includes("import")) {
		return "success";
	}
	if (
		normalized.includes("fail") ||
		normalized.includes("error") ||
		normalized.includes("reject")
	) {
		return "error";
	}
	if (
		normalized.includes("delete") ||
		normalized.includes("removed")
	) {
		return "error";
	}
	if (
		normalized.includes("ignored") ||
		normalized.includes("skip") ||
		normalized.includes("renam") ||
		normalized.includes("upgrade")
	) {
		return "warning";
	}
	if (
		normalized.includes("grab") ||
		normalized.includes("indexerquery") ||
		normalized.includes("query") ||
		normalized.includes("rss")
	) {
		return "info";
	}
	return "default";
};

/**
 * Determines the source/client string for a history item based on event type.
 * Returns the raw (non-anonymized) value — callers handle incognito wrapping.
 */
export const getSourceClient = (item: HistoryItem): string => {
	const eventType = (item.eventType ?? item.status ?? "").toLowerCase();
	const isProwlarr = item.service === "prowlarr";
	const prowlarrData = isProwlarr ? (item.data as any) : null;

	let result = "";

	if (
		eventType.includes("grab") ||
		eventType.includes("query") ||
		eventType.includes("rss")
	) {
		result = isProwlarr
			? prowlarrData?.indexer || prowlarrData?.indexerName || item.indexer || ""
			: item.indexer || "";
	} else if (eventType.includes("download") || eventType.includes("import")) {
		result = item.downloadClient || "";
	} else {
		result = item.downloadClient || item.indexer || item.protocol || "";
	}

	if (result === "localhost" || result === "unknown") {
		return "";
	}
	return result;
};

/**
 * Identifies what kind of source a history item has, for incognito anonymization.
 * Returns "indexer", "client", or "other".
 */
export const getSourceClientKind = (item: HistoryItem): "indexer" | "client" | "other" => {
	const eventType = (item.eventType ?? item.status ?? "").toLowerCase();
	if (
		eventType.includes("grab") ||
		eventType.includes("query") ||
		eventType.includes("rss")
	) {
		return "indexer";
	}
	if (eventType.includes("download") || eventType.includes("import")) {
		return "client";
	}
	if (item.downloadClient) return "client";
	if (item.indexer) return "indexer";
	return "other";
};

export interface ActivitySummary {
	grabs: number;
	imports: number;
	failures: number;
}

/**
 * Counts grabs, imports, and failures in items from the last 24 hours
 */
export const createActivitySummary = (items: HistoryItem[]): ActivitySummary => {
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	const summary: ActivitySummary = { grabs: 0, imports: 0, failures: 0 };

	for (const item of items) {
		const dateMs = item.date ? new Date(item.date).getTime() : 0;
		if (dateMs < cutoff) continue;

		const eventType = (item.eventType ?? item.status ?? "").toLowerCase();
		if (eventType.includes("grab")) {
			summary.grabs += 1;
		} else if (eventType.includes("import") || eventType.includes("download")) {
			summary.imports += 1;
		} else if (eventType.includes("fail") || eventType.includes("error") || eventType.includes("reject")) {
			summary.failures += 1;
		}
	}

	return summary;
};
