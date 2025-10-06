import type { HistoryItem } from "@arr/shared";

export const SERVICE_FILTERS = [
  { value: "all" as const, label: "All services" },
  { value: "sonarr" as const, label: "Sonarr" },
  { value: "radarr" as const, label: "Radarr" },
  { value: "prowlarr" as const, label: "Prowlarr" },
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
export const createServiceSummary = (
  items: HistoryItem[],
): Map<HistoryItem["service"], number> => {
  const summary = new Map<HistoryItem["service"], number>();
  for (const item of items) {
    summary.set(item.service, (summary.get(item.service) ?? 0) + 1);
  }
  return summary;
};

/**
 * Creates a summary of history items by status
 */
export const createStatusSummary = (
  items: HistoryItem[],
): Array<[string, number]> => {
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
    if (
      item.service === "prowlarr" &&
      (eventType.includes("rss") || eventType === "indexerrss")
    ) {
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
      const isValidDownloadId =
        downloadId && downloadId.length > 10 && !/^\d+$/.test(downloadId);

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
    for (const [key, groupItems] of groups.entries()) {
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
          const groupDate = groupItem.date
            ? new Date(groupItem.date).getTime()
            : 0;
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
