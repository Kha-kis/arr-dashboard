"use client";

import type { HistoryItem } from "@arr/shared";

interface HistoryGroup {
  downloadId?: string;
  groupType?: string;
  items: HistoryItem[];
}

interface HistoryTableProps {
  readonly groups: HistoryGroup[];
  readonly loading?: boolean;
  readonly emptyMessage?: string;
  readonly groupingEnabled: boolean;
}

const formatBytes = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatDateTime = (value?: string): string => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const getEventTypeBadgeClass = (eventType: string): string => {
  const normalized = eventType.toLowerCase();
  if (
    normalized.includes("grab") ||
    normalized.includes("indexerquery") ||
    normalized.includes("query")
  ) {
    return "bg-blue-500/20 text-blue-200";
  }
  if (normalized.includes("download") || normalized.includes("import")) {
    return "bg-emerald-500/20 text-emerald-200";
  }
  if (normalized.includes("delete") || normalized.includes("removed")) {
    return "bg-red-500/20 text-red-200";
  }
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("reject")
  ) {
    return "bg-red-500/20 text-red-200";
  }
  if (normalized.includes("renam") || normalized.includes("upgrade")) {
    return "bg-purple-500/20 text-purple-200";
  }
  if (normalized.includes("ignored") || normalized.includes("skip")) {
    return "bg-amber-500/20 text-amber-200";
  }
  return "bg-white/10 text-white/70";
};

const getDisplayTitle = (item: HistoryItem): string => {
  // For Prowlarr, try to extract meaningful info from data field
  if (item.service === "prowlarr") {
    const data = item.data as any;
    const eventType = (item.eventType ?? "").toLowerCase();

    // For release grabbed events, prioritize release title
    if (eventType.includes("grab") || eventType.includes("release")) {
      const release =
        data?.releaseTitle || data?.title || item.title || item.sourceTitle;
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

const getProwlarrDetails = (item: HistoryItem): string => {
  if (item.service !== "prowlarr") return "";

  const data = item.data as any;
  if (!data) return "";

  const parts: string[] = [];

  // Show number of results for queries
  if (
    typeof data.queryResults === "number" ||
    typeof data.numberOfResults === "number"
  ) {
    const count = data.queryResults ?? data.numberOfResults;
    parts.push(`${count} results`);
  }

  // Show successful status
  if (typeof data.successful === "boolean") {
    parts.push(data.successful ? "✓ Success" : "✗ Failed");
  }

  // Show elapsed time
  if (typeof data.elapsedTime === "number") {
    parts.push(`${data.elapsedTime}ms`);
  }

  // Show requesting application
  if (data.application || data.source) {
    parts.push(`via ${data.application ?? data.source}`);
  }

  return parts.join(" • ") || "-";
};

export const HistoryTable = ({
  groups,
  loading,
  emptyMessage,
  groupingEnabled,
}: HistoryTableProps) => {
  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        Fetching history records...
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        {emptyMessage ?? "No history records available."}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
      <table className="min-w-full divide-y divide-white/10 text-sm text-white/80">
        <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
          <tr>
            <th className="px-4 py-3">Event</th>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3">Quality</th>
            <th className="px-4 py-3">Source/Client</th>
            <th className="px-4 py-3 text-right">Size</th>
            <th className="px-4 py-3">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {groups.map((group, groupIndex) => {
            const isGrouped = groupingEnabled && group.items.length > 1;
            const isRssGroup = group.groupType === "rss";

            // For RSS groups, only show a summary row
            if (isRssGroup && isGrouped) {
              const firstItem = group.items[0];
              const key = `rss-group-${groupIndex}`;

              // Count total events in group
              const eventCount = group.items.length;

              return (
                <tr key={key} className="hover:bg-white/10">
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <div className="mb-1 text-xs text-sky-400 font-semibold">
                        📡 RSS Sync - {eventCount} feeds
                      </div>
                      <span className="inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-semibold bg-blue-500/20 text-blue-200">
                        indexerRss
                      </span>
                      <span className="text-xs text-white/50 capitalize">
                        {firstItem?.instanceName ?? "-"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white">
                    <div className="truncate">RSS Feed Sync</div>
                  </td>
                  <td className="px-4 py-3 text-white/70">-</td>
                  <td className="px-4 py-3 text-white/70">
                    <div className="text-xs text-white/50">
                      {eventCount} {eventCount === 1 ? "feed" : "feeds"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-white/70">-</td>
                  <td className="px-4 py-3 text-white/70 whitespace-nowrap">
                    {firstItem?.date ? formatDateTime(firstItem.date) : "-"}
                  </td>
                </tr>
              );
            }

            return group.items.map((item, itemIndex) => {
              const key = `${item.service}:${item.instanceId}:${String(item.id)}`;
              const eventType = item.eventType ?? item.status ?? "Unknown";
              const displayTitle = getDisplayTitle(item);

              // Determine what to show in Source/Client column (smart selection)
              const isProwlarr = item.service === "prowlarr";
              const prowlarrData = isProwlarr ? (item.data as any) : null;

              // For grabs/queries: show indexer
              // For downloads/imports: show download client
              const eventTypeLower = eventType.toLowerCase();
              let sourceClient = "";

              if (
                eventTypeLower.includes("grab") ||
                eventTypeLower.includes("query") ||
                eventTypeLower.includes("rss")
              ) {
                // Show indexer for search/grab events
                sourceClient = isProwlarr
                  ? prowlarrData?.indexer ||
                    prowlarrData?.indexerName ||
                    item.indexer ||
                    "-"
                  : item.indexer || "-";
              } else if (
                eventTypeLower.includes("download") ||
                eventTypeLower.includes("import")
              ) {
                // Show download client for download/import events
                sourceClient = item.downloadClient || "-";
              } else {
                // Fallback: show whatever is available
                sourceClient =
                  item.downloadClient || item.indexer || item.protocol || "-";
              }

              // Filter out useless values
              if (sourceClient === "localhost" || sourceClient === "unknown") {
                sourceClient = "-";
              }

              const isFirstInGroup = itemIndex === 0;
              const isLastInGroup = itemIndex === group.items.length - 1;

              return (
                <tr
                  key={key}
                  className={`hover:bg-white/10 ${isGrouped ? "border-l-2 border-l-sky-500/50" : ""} ${isGrouped && !isLastInGroup ? "border-b-0" : ""}`}
                >
                  <td
                    className={`px-4 py-3 ${isGrouped && !isFirstInGroup ? "pl-8" : ""}`}
                  >
                    <div className="flex flex-col gap-1">
                      {isFirstInGroup && isGrouped && (
                        <div className="mb-1 text-xs text-sky-400 font-semibold">
                          📦 {group.items.length} events
                        </div>
                      )}
                      <span
                        className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${getEventTypeBadgeClass(eventType)}`}
                      >
                        {eventType}
                      </span>
                      <span className="text-xs text-white/50">
                        {item.instanceName}
                      </span>
                    </div>
                  </td>
                  <td
                    className="max-w-xs px-4 py-3 text-white"
                    title={displayTitle}
                  >
                    <div className="truncate">{displayTitle}</div>
                  </td>
                  <td className="px-4 py-3 text-white/70">
                    {(item.quality as { quality?: { name?: string } })?.quality
                      ?.name ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-white/70">{sourceClient}</td>
                  <td className="px-4 py-3 text-right text-white/70">
                    {formatBytes(item.size)}
                  </td>
                  <td className="px-4 py-3 text-white/70 whitespace-nowrap">
                    {formatDateTime(item.date)}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
};
