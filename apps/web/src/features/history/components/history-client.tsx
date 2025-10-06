"use client";

import { useMemo, useState } from "react";
import type { HistoryItem } from "@arr/shared";
import { useMultiInstanceHistoryQuery } from "../../../hooks/api/useDashboard";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription } from "../../../components/ui";
import { HistoryTable } from "./history-table";

const SERVICE_FILTERS = [
  { value: "all" as const, label: "All services" },
  { value: "sonarr" as const, label: "Sonarr" },
  { value: "radarr" as const, label: "Radarr" },
  { value: "prowlarr" as const, label: "Prowlarr" },
];

const normalizeStatus = (status?: string, eventType?: string) =>
  (status ?? eventType ?? "Unknown").toLowerCase();

export const HistoryClient = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const { data, isLoading, error, refetch } = useMultiInstanceHistoryQuery({
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });
  const allAggregated = useMemo(
    () => data?.aggregated ?? [],
    [data?.aggregated],
  );
  const instances = useMemo(() => data?.instances ?? [], [data?.instances]);

  const [searchTerm, setSearchTerm] = useState("");
  const [serviceFilter, setServiceFilter] =
    useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [groupByDownload, setGroupByDownload] = useState(true);

  const instanceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of instances) {
      map.set(entry.instanceId, entry.instanceName);
    }
    return Array.from(map.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [instances]);

  const statusOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of allAggregated) {
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
  }, [allAggregated]);

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return allAggregated.filter((item) => {
      if (serviceFilter !== "all" && item.service !== serviceFilter) {
        return false;
      }
      if (instanceFilter !== "all" && item.instanceId !== instanceFilter) {
        return false;
      }
      const currentStatus = normalizeStatus(item.status, item.eventType);
      if (statusFilter !== "all" && currentStatus !== statusFilter) {
        return false;
      }
      if (term.length > 0) {
        const haystack = [
          item.title,
          item.sourceTitle,
          item.downloadClient,
          item.indexer,
          item.reason,
        ]
          .filter(Boolean)
          .map((value) => value!.toLowerCase());
        if (!haystack.some((value) => value.includes(term))) {
          return false;
        }
      }
      return true;
    });
  }, [allAggregated, serviceFilter, instanceFilter, statusFilter, searchTerm]);

  const serviceSummary = useMemo(() => {
    const summary = new Map<HistoryItem["service"], number>();
    for (const item of allAggregated) {
      summary.set(item.service, (summary.get(item.service) ?? 0) + 1);
    }
    return summary;
  }, [allAggregated]);

  const statusSummary = useMemo(() => {
    const summary = new Map<string, number>();
    for (const item of filteredItems) {
      const label = item.status ?? item.eventType ?? "Unknown";
      summary.set(label, (summary.get(label) ?? 0) + 1);
    }
    return Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
  }, [filteredItems]);

  const filtersActive =
    serviceFilter !== "all" ||
    instanceFilter !== "all" ||
    statusFilter !== "all" ||
    searchTerm.trim().length > 0 ||
    startDate ||
    endDate;

  const emptyMessage =
    filteredItems.length === 0 && allAggregated.length > 0
      ? "No history records match the current filters."
      : undefined;

  // Group items by downloadId when enabled
  const groupedItems = useMemo(() => {
    if (!groupByDownload) {
      return filteredItems.map((item) => ({
        items: [item],
        downloadId: item.downloadId,
      }));
    }

    const groups = new Map<string, HistoryItem[]>();
    const deleteEvents: HistoryItem[] = [];
    const ungrouped: HistoryItem[] = [];

    // First pass: group all non-delete events
    for (const item of filteredItems) {
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

      // If not added to any group, treat as ungrouped
      if (!addedToGroup) {
        ungrouped.push(item);
      }
    }

    // Convert to array and sort groups by most recent date
    const grouped = Array.from(groups.entries()).map(([key, items]) => ({
      downloadId: key.startsWith("rss-") ? undefined : key,
      groupType: key.startsWith("rss-") ? "rss" : "download",
      items: items.sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateA - dateB; // Oldest first within group
      }),
    }));

    // Add ungrouped items as single-item groups
    const ungroupedGroups = ungrouped.map((item) => ({
      items: [item],
      downloadId: undefined,
      groupType: undefined,
    }));

    // Sort by most recent event in each group
    const allGroups = [...grouped, ...ungroupedGroups].sort((a, b) => {
      const lastItemA = a.items[a.items.length - 1];
      const lastItemB = b.items[b.items.length - 1];
      const dateA = lastItemA?.date ? new Date(lastItemA.date).getTime() : 0;
      const dateB = lastItemB?.date ? new Date(lastItemB.date).getTime() : 0;
      return dateB - dateA; // Most recent groups first
    });

    return allGroups;
  }, [filteredItems, groupByDownload]);

  // Client-side pagination on groups
  const totalRecords = groupedItems.length;
  const totalPages = Math.ceil(totalRecords / pageSize);
  const showingFrom = totalRecords > 0 ? (page - 1) * pageSize + 1 : 0;
  const showingTo = Math.min(page * pageSize, totalRecords);
  const paginatedGroups = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    return groupedItems.slice(startIndex, startIndex + pageSize);
  }, [groupedItems, page, pageSize]);

  return (
    <section className="flex flex-col gap-10">
      <header className="space-y-2">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-white/60">
              Activity
            </p>
            <h1 className="text-3xl font-semibold text-white">
              Download History
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/60">
            <span>
              Tracking {allAggregated.length} event
              {allAggregated.length === 1 ? "" : "s"} across {instances.length}{" "}
              instance{instances.length === 1 ? "" : "s"}
            </span>
            <Button variant="ghost" onClick={() => void refetch()}>
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-sm text-white/60">
          Review recent activity from all configured Sonarr, Radarr, and
          Prowlarr instances.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SERVICE_FILTERS.filter((item) => item.value !== "all").map(
          (service) => {
            const count = serviceSummary.get(service.value) ?? 0;
            return (
              <div
                key={service.value}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80"
              >
                <p className="text-xs uppercase text-white/50">
                  {service.label}
                </p>
                <p className="text-2xl font-semibold text-white">{count}</p>
              </div>
            );
          },
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
        <div className="flex min-w-[140px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-start-date"
          >
            From Date
          </label>
          <Input
            id="history-start-date"
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
              setPage(1);
            }}
            className="border-white/20 bg-white/10 text-white"
          />
        </div>
        <div className="flex min-w-[140px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-end-date"
          >
            To Date
          </label>
          <Input
            id="history-end-date"
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
              setPage(1);
            }}
            className="border-white/20 bg-white/10 text-white"
          />
        </div>
        <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-search"
          >
            Search
          </label>
          <Input
            id="history-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search title, client, or indexer"
            className="border-white/20 bg-white/10 text-white placeholder:text-white/40"
          />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-service-filter"
          >
            Service
          </label>
          <select
            id="history-service-filter"
            value={serviceFilter}
            onChange={(event) =>
              setServiceFilter(
                event.target.value as (typeof SERVICE_FILTERS)[number]["value"],
              )
            }
            className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
          >
            {SERVICE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-instance-filter"
          >
            Instance
          </label>
          <select
            id="history-instance-filter"
            value={instanceFilter}
            onChange={(event) => setInstanceFilter(event.target.value)}
            className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
          >
            <option value="all">All instances</option>
            {instanceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
          <label
            className="text-xs uppercase text-white/50"
            htmlFor="history-status-filter"
          >
            Status
          </label>
          <select
            id="history-status-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
          >
            <option value="all">All statuses</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
            <input
              type="checkbox"
              checked={groupByDownload}
              onChange={(e) => {
                setGroupByDownload(e.target.checked);
                setPage(1);
              }}
              className="rounded border-white/20 bg-white/10 text-sky-500 focus:ring-sky-400"
            />
            Group by download
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              setSearchTerm("");
              setServiceFilter("all");
              setInstanceFilter("all");
              setStatusFilter("all");
              setStartDate("");
              setEndDate("");
              setPage(1);
            }}
            disabled={!filtersActive}
          >
            Reset
          </Button>
        </div>
      </div>

      {totalRecords > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-white/70">
          <div>
            Showing {showingFrom}-{showingTo} of {totalRecords} records
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || isLoading}
            >
              Previous
            </Button>
            <span className="px-3">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="secondary"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || isLoading}
            >
              Next
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="page-size" className="text-xs">
              Per page:
            </label>
            <select
              id="page-size"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white [&>option]:bg-slate-800 [&>option]:text-white"
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>
      )}

      {statusSummary.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {statusSummary.map(([label, count]) => (
            <div
              key={label}
              className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80"
            >
              <span className="text-xs uppercase text-white/50">{label}</span>
              <span className="text-lg font-semibold text-white">{count}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="danger">
          <AlertDescription>
            Unable to load history data. Please refresh and try again.
          </AlertDescription>
        </Alert>
      )}

      <HistoryTable
        groups={paginatedGroups}
        loading={isLoading}
        emptyMessage={emptyMessage}
        groupingEnabled={groupByDownload}
      />
    </section>
  );
};
