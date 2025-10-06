"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { QueueItem } from "@arr/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import {
  QueueActionButtons,
  RemoveActionMenu,
  type QueueAction,
} from "./queue-action-buttons";
import {
  QueueIssueBadge,
  type IssueSummary,
  type MessageTone,
} from "./queue-issue-badge";
import { QueueProgress } from "./queue-progress";

type QueueActionHandler = (
  items: QueueItem[],
  options?: QueueActionOptions,
) => Promise<void> | void;

interface QueueTableProps {
  items: QueueItem[];
  loading?: boolean;
  pending?: boolean;
  onRetry?: QueueActionHandler;
  onManualImport?: QueueActionHandler;
  onRemove?: QueueActionHandler;
  onChangeCategory?: QueueActionHandler;
  emptyMessage?: string;
}

const buildKey = (item: QueueItem) =>
  `${item.service}:${item.instanceId}:${String(item.id)}`;

const getGroupKey = (item: QueueItem): string | null => {
  if (item.downloadId) {
    return `${item.service}:${item.instanceId}:download:${item.downloadId}`;
  }
  if (item.service === "sonarr" && item.seriesId) {
    const base = item.seriesId;
    const protocol = item.protocol ?? item.downloadProtocol ?? "unknown";
    const client = item.downloadClient ?? "unknown";
    return `${item.service}:${item.instanceId}:series:${base}:${protocol}:${client}`;
  }
  return null;
};

const deriveTitle = (items: QueueItem[]): string => {
  const [first] = items;
  if (!first) {
    return "Queue group";
  }
  return (
    first.series?.title ||
    first.movie?.title ||
    first.title ||
    first.instanceName ||
    "Queue group"
  );
};

const sumNumbers = (values: Array<number | undefined>): number => {
  let total = 0;
  values.forEach((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
    }
  });
  return total;
};

type StatusLine = {
  key: string;
  text: string;
  tone: MessageTone;
};

type CompactLine = {
  key: string;
  text: string;
  tone: MessageTone;
  count: number;
};

const resolveMessageTone = (text: string): MessageTone => {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("fail") ||
    normalized.includes("denied") ||
    normalized.includes("invalid") ||
    normalized.includes("unauthorised") ||
    normalized.includes("unauthorized")
  ) {
    return "error";
  }
  if (
    normalized.includes("warn") ||
    normalized.includes("retry") ||
    normalized.includes("missing") ||
    normalized.includes("stalled") ||
    normalized.includes("timeout") ||
    normalized.includes("delay") ||
    normalized.includes("pending")
  ) {
    return "warning";
  }
  return "info";
};

const looksLikeReleaseName = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const tokenMatch =
    /(s\d{1,2}e\d{1,3}|\.720p|\.1080p|\.2160p|\.480p|\.web[-_.]?dl|\.webrip|\.bluray|\.h\.264|\.h\.265|\.x264|\.x265|\.dvdrip|\.proper|\.repack|\.amzn|\.nf|\.hbo|\.dsnp)/i.test(
      lower,
    );
  if (!tokenMatch) {
    return false;
  }
  const dotSegments = trimmed
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return dotSegments.length >= 4 || !trimmed.includes(" ");
};
const messageToneClasses: Record<MessageTone, string> = {
  info: "border-white/20 bg-white/5 text-white/80",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-50",
  error: "border-red-500/40 bg-red-500/10 text-red-100",
};

const collectStatusLines = (item: QueueItem): StatusLine[] => {
  const lines: StatusLine[] = [];

  if (Array.isArray(item.statusMessages)) {
    item.statusMessages.forEach((entry, entryIndex) => {
      const title =
        typeof entry?.title === "string" ? entry.title.trim() : undefined;
      if (title) {
        lines.push({
          key: `${buildKey(item)}:status:${entryIndex}:title`,
          text: title,
          tone: resolveMessageTone(title),
        });
      }

      if (Array.isArray(entry?.messages)) {
        entry.messages.forEach((message, messageIndex) => {
          if (typeof message !== "string") {
            return;
          }
          const trimmed = message.trim();
          if (!trimmed) {
            return;
          }
          lines.push({
            key: `${buildKey(item)}:status:${entryIndex}:message:${messageIndex}`,
            text: trimmed,
            tone: resolveMessageTone(trimmed),
          });
        });
      }
    });
  }

  if (
    typeof item.errorMessage === "string" &&
    item.errorMessage.trim().length > 0
  ) {
    const trimmed = item.errorMessage.trim();
    lines.push({
      key: `${buildKey(item)}:error`,
      text: trimmed,
      tone: "error",
    });
  }

  return lines;
};

const summarizeLines = (lines: StatusLine[]): CompactLine[] => {
  const map = new Map<string, CompactLine>();

  lines.forEach((line, index) => {
    const trimmed = line.text.trim();
    if (!trimmed) {
      return;
    }

    const normalized = trimmed.toLowerCase();
    const looksLikeFile = /\.(mkv|mp4|avi|m4v|ts|rar|zip|7z)$/i.test(
      normalized,
    );
    if (looksLikeFile || looksLikeReleaseName(trimmed)) {
      return;
    }

    const existing = map.get(normalized);
    if (existing) {
      existing.count += 1;
      if (line.tone === "error" && existing.tone !== "error") {
        existing.tone = "error";
      } else if (line.tone === "warning" && existing.tone === "info") {
        existing.tone = "warning";
      }
    } else {
      map.set(normalized, {
        key: `${line.key}:${index}`,
        text: trimmed,
        tone: line.tone,
        count: 1,
      });
    }
  });

  return Array.from(map.values());
};

const renderCompactLines = (lines: StatusLine[]) => {
  const summary = summarizeLines(lines);
  return summary.map((entry) => (
    <div
      key={entry.key}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        entry.tone === "error" &&
          "border-red-500/40 bg-red-500/10 text-red-100",
        entry.tone === "warning" &&
          "border-amber-500/40 bg-amber-500/10 text-amber-50",
        entry.tone === "info" && "border-white/15 bg-white/5 text-white/70",
      )}
    >
      <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-white/40" />
      <span className="break-words leading-relaxed">{entry.text}</span>
    </div>
  ));
};

const summarizeIssueCounts = (lines: StatusLine[]): IssueSummary[] => {
  const filtered = summarizeLines(lines);
  const map = new Map<MessageTone, number>();
  filtered.forEach((entry) => {
    map.set(entry.tone, (map.get(entry.tone) ?? 0) + entry.count);
  });
  return Array.from(map.entries()).map(([tone, count]) => ({ tone, count }));
};

const computeProgressValue = (items: QueueItem[]): number | undefined => {
  const totalSize = sumNumbers(items.map((item) => item.size));
  const totalLeft = sumNumbers(items.map((item) => item.sizeleft));
  if (totalSize <= 0) {
    return undefined;
  }
  const completed = Math.max(0, totalSize - totalLeft);
  return Math.round((completed / totalSize) * 100);
};

type ActionCounts = {
  manualImport: number;
  retry: number;
};

const summarizeActionCapabilities = (
  items: QueueItem[],
): {
  counts: ActionCounts;
  primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
} => {
  let manualImport = 0;
  let retry = 0;

  for (const item of items) {
    const capabilities = item.actions;
    if (capabilities?.canManualImport) {
      manualImport += 1;
    }

    if (capabilities) {
      if (capabilities.canRetry) {
        retry += 1;
      }
    } else {
      // Assume retry is permitted when capabilities are not provided
      retry += 1;
    }
  }

  const primaryAction:
    | Extract<QueueAction, "retry" | "manualImport">
    | undefined =
    manualImport > 0 ? "manualImport" : retry > 0 ? "retry" : undefined;

  return {
    counts: {
      manualImport,
      retry,
    },
    primaryAction,
  };
};

const filterItemsForAction = (
  items: QueueItem[],
  action: QueueAction,
): QueueItem[] => {
  if (action === "retry") {
    return items.filter((item) => {
      if (!item.actions) {
        return true;
      }
      return Boolean(item.actions.canRetry);
    });
  }

  if (action === "manualImport") {
    return items.filter((item) => Boolean(item.actions?.canManualImport));
  }

  return items;
};

type SummaryRow = {
  key: string;
  type: "group" | "item";
  title: string;
  service: QueueItem["service"];
  instanceName?: string;
  items: QueueItem[];
  issueLines: StatusLine[];
  issueSummary: IssueSummary[];
  statusLabel: string;
  progressValue?: number;
  detailAvailable: boolean;
  groupCount?: number;
  primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
  actionCounts: ActionCounts;
};

const createGroupSummary = (key: string, items: QueueItem[]): SummaryRow => {
  const [first] = items;
  const issueLines = items.flatMap((item) => collectStatusLines(item));
  const uniqueStatuses = new Set(
    items
      .map((item) => item.status?.trim())
      .filter((status): status is string => Boolean(status)),
  );
  const statusLabel =
    uniqueStatuses.size === 0
      ? "Pending"
      : uniqueStatuses.size === 1
        ? (uniqueStatuses.values().next().value ?? "Pending")
        : `${uniqueStatuses.size} statuses`;

  const actionSummary = summarizeActionCapabilities(items);

  return {
    key,
    type: "group",
    title: deriveTitle(items),
    service: (first?.service ?? "sonarr") as QueueItem["service"],
    instanceName: first?.instanceName,
    items,
    issueLines,
    issueSummary: summarizeIssueCounts(issueLines),
    statusLabel,
    progressValue: computeProgressValue(items),
    detailAvailable: true,
    groupCount: items.length,
    primaryAction: actionSummary.primaryAction,
    actionCounts: actionSummary.counts,
  };
};

const createItemSummary = (item: QueueItem): SummaryRow => {
  const issueLines = collectStatusLines(item);
  const statusLabel = item.status ?? "Pending";
  const actionSummary = summarizeActionCapabilities([item]);

  return {
    key: buildKey(item),
    type: "item",
    title: deriveTitle([item]),
    service: item.service,
    instanceName: item.instanceName,
    items: [item],
    issueLines,
    issueSummary: summarizeIssueCounts(issueLines),
    statusLabel,
    progressValue: computeProgressValue([item]),
    detailAvailable: issueLines.length > 0,
    primaryAction: actionSummary.primaryAction,
    actionCounts: actionSummary.counts,
  };
};

export const QueueTable = ({
  items,
  loading,
  pending,
  onRetry,
  onManualImport,
  onRemove,
  onChangeCategory,
  emptyMessage,
}: QueueTableProps) => {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedKeys((current) => {
      if (current.size === 0) {
        return current;
      }
      const validKeys = new Set(items.map(buildKey));
      const next = new Set<string>();
      for (const key of current) {
        if (validKeys.has(key)) {
          next.add(key);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const summaryRows = useMemo<SummaryRow[]>(() => {
    const groupMap = new Map<string, QueueItem[]>();

    for (const item of items) {
      const groupKey = getGroupKey(item);
      if (!groupKey) {
        continue;
      }
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey)!.push(item);
    }

    const addedGroups = new Set<string>();
    const rows: SummaryRow[] = [];

    for (const item of items) {
      const groupKey = getGroupKey(item);
      const groupItems = groupKey ? (groupMap.get(groupKey) ?? []) : [];

      if (groupKey && groupItems.length >= 2) {
        if (!addedGroups.has(groupKey)) {
          rows.push(createGroupSummary(groupKey, groupItems));
          addedGroups.add(groupKey);
        }
        continue;
      }

      rows.push(createItemSummary(item));
    }

    return rows;
  }, [items]);

  const selectedItems = useMemo(() => {
    if (selectedKeys.size === 0) {
      return [] as QueueItem[];
    }
    const keys = selectedKeys;
    return items.filter((item) => keys.has(buildKey(item)));
  }, [items, selectedKeys]);

  const selectedManualImportItems = useMemo(
    () => filterItemsForAction(selectedItems, "manualImport"),
    [selectedItems],
  );

  const selectedRetryItems = useMemo(
    () => filterItemsForAction(selectedItems, "retry"),
    [selectedItems],
  );

  const toggleRowExpansion = (rowKey: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const toggleSelectionForItems = (rowItems: QueueItem[]) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const keys = rowItems.map(buildKey);
      const everySelected = keys.every((key) => next.has(key));
      keys.forEach((key) => {
        if (everySelected) {
          next.delete(key);
        } else {
          next.add(key);
        }
      });
      return next;
    });
  };

  const toggleSingleSelection = (item: QueueItem) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const key = buildKey(item);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === items.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(items.map(buildKey)));
    }
  };

  const handleRowAction = async (
    row: SummaryRow,
    action: QueueAction,
    actionOptions?: QueueActionOptions,
  ) => {
    const actionableItems = filterItemsForAction(row.items, action);
    if (actionableItems.length === 0) {
      return;
    }

    if (action === "retry" && onRetry) {
      await onRetry(actionableItems);
    }

    if (action === "manualImport" && onManualImport) {
      await onManualImport(actionableItems);
    }

    if (action === "remove" && onRemove) {
      await onRemove(actionableItems, actionOptions);
    }

    if (action === "category" && onChangeCategory) {
      await onChangeCategory(actionableItems);
    }
  };

  const handleItemAction = async (
    item: QueueItem,
    action: QueueAction,
    actionOptions?: QueueActionOptions,
  ) => {
    const actionableItems = filterItemsForAction([item], action);
    if (actionableItems.length === 0) {
      return;
    }

    if (action === "retry" && onRetry) {
      await onRetry(actionableItems);
    }

    if (action === "manualImport" && onManualImport) {
      await onManualImport(actionableItems);
    }

    if (action === "remove" && onRemove) {
      await onRemove(actionableItems, actionOptions);
    }

    if (action === "category" && onChangeCategory) {
      await onChangeCategory(actionableItems);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        Fetching queue items...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        {emptyMessage ?? "Queue is empty across all instances."}
      </div>
    );
  }

  const allSelected =
    selectedKeys.size > 0 && selectedKeys.size === items.length;

  return (
    <div className="space-y-4">
      {selectedItems.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/10 px-4 py-2 text-sm text-white/80 lg:flex-row lg:items-center lg:justify-between">
          <span>
            {selectedItems.length} item{selectedItems.length === 1 ? "" : "s"}{" "}
            selected
          </span>
          <div className="flex flex-wrap gap-2">
            {onManualImport && selectedManualImportItems.length > 0 && (
              <button
                type="button"
                className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-wide text-white/70 transition hover:border-white/40"
                onClick={() => void onManualImport(selectedManualImportItems)}
                disabled={pending}
              >
                Manual import selected
              </button>
            )}
            {onRetry && selectedRetryItems.length > 0 && (
              <button
                type="button"
                className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-wide text-white/70 transition hover:border-white/40"
                onClick={() => void onRetry(selectedRetryItems)}
                disabled={pending}
              >
                Retry selected
              </button>
            )}
            <RemoveActionMenu
              label="Remove selected"
              variant="pill"
              disabled={pending || !onRemove}
              onSelect={(options) => {
                if (!onRemove) {
                  return;
                }
                void onRemove(selectedItems, options);
              }}
            />
            {onChangeCategory && (
              <button
                type="button"
                className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-wide text-white/70 transition hover:border-white/40"
                onClick={() => void onChangeCategory(selectedItems)}
                disabled={pending}
              >
                Change category
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {summaryRows.map((row) => {
          const rowKeys = row.items.map(buildKey);
          const everySelected = rowKeys.every((key) => selectedKeys.has(key));
          const issueSummary = row.issueSummary;

          if (row.type === "group") {
            const groupRow = row as SummaryRow & { type: "group" };
            const expanded = expandedRows.has(groupRow.key);
            return (
              <GroupCard
                key={groupRow.key}
                row={groupRow}
                expanded={expanded}
                pending={pending}
                showChangeCategory={Boolean(onChangeCategory)}
                everySelected={everySelected}
                onToggleExpand={() => toggleRowExpansion(groupRow.key)}
                onToggleSelect={() => toggleSelectionForItems(groupRow.items)}
                onAction={(action, actionOptions) =>
                  void handleRowAction(groupRow, action, actionOptions)
                }
                onItemAction={(item, action, actionOptions) =>
                  void handleItemAction(item, action, actionOptions)
                }
                isItemSelected={(item) => selectedKeys.has(buildKey(item))}
                onToggleItemSelect={(item) => toggleSingleSelection(item)}
                issueSummary={issueSummary}
              />
            );
          }

          return (
            <QueueItemCard
              key={row.key}
              item={row.items[0]!}
              issueLines={row.issueLines}
              selected={everySelected}
              pending={pending}
              showChangeCategory={Boolean(onChangeCategory)}
              onToggleSelect={() => toggleSingleSelection(row.items[0]!)}
              onAction={(action, actionOptions) =>
                void handleItemAction(row.items[0]!, action, actionOptions)
              }
              primaryAction={row.primaryAction}
            />
          );
        })}
      </div>
    </div>
  );
};

interface GroupCardProps {
  row: SummaryRow & { type: "group" };
  expanded: boolean;
  pending?: boolean;
  showChangeCategory: boolean;
  everySelected: boolean;
  issueSummary: IssueSummary[];
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onAction: (action: QueueAction, options?: QueueActionOptions) => void;
  onItemAction: (
    item: QueueItem,
    action: QueueAction,
    options?: QueueActionOptions,
  ) => void;
  isItemSelected: (item: QueueItem) => boolean;
  onToggleItemSelect: (item: QueueItem) => void;
}

const GroupCard = ({
  row,
  expanded,
  pending,
  showChangeCategory,
  everySelected,
  issueSummary,
  onToggleExpand,
  onToggleSelect,
  onAction,
  onItemAction,
  isItemSelected,
  onToggleItemSelect,
}: GroupCardProps) => {
  const primaryActionItems = row.primaryAction
    ? filterItemsForAction(row.items, row.primaryAction)
    : [];

  const primaryDisabled = !row.primaryAction || primaryActionItems.length === 0;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5">
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="flex min-w-0 items-start gap-3 lg:pr-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={everySelected}
            onChange={onToggleSelect}
            disabled={pending}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <button
              type="button"
              onClick={onToggleExpand}
              className="flex items-center gap-2 text-left text-white"
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <span className="font-semibold">{row.title}</span>
            </button>
            <div className="flex flex-wrap gap-2 text-xs text-white/60">
              <span className="capitalize">{row.service}</span>
              {row.instanceName && <span>{row.instanceName}</span>}
              <span>{row.groupCount} items</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:flex-shrink-0 lg:gap-4 lg:pl-4">
          <div className="flex justify-end text-xs text-white/60">
            <QueueIssueBadge summary={issueSummary} size="sm" />
          </div>
          <QueueProgress value={row.progressValue} size="sm" />
          <QueueActionButtons
            onAction={onAction}
            disabled={pending}
            showChangeCategory={showChangeCategory}
            fullWidth
            primaryAction={row.primaryAction}
            primaryDisabled={primaryDisabled}
          />
        </div>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-white/10 p-4">
          {row.items.map((item) => (
            <QueueItemCard
              key={buildKey(item)}
              item={item}
              issueLines={collectStatusLines(item)}
              selected={isItemSelected(item)}
              pending={pending}
              showChangeCategory={showChangeCategory}
              onToggleSelect={() => onToggleItemSelect(item)}
              onAction={(action, actionOptions) =>
                void onItemAction(item, action, actionOptions)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface QueueItemCardProps {
  item: QueueItem;
  issueLines: StatusLine[];
  selected: boolean;
  pending?: boolean;
  showChangeCategory: boolean;
  onToggleSelect: () => void;
  onAction: (action: QueueAction, options?: QueueActionOptions) => void;
  primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
}

const QueueItemCard = ({
  item,
  issueLines,
  selected,
  pending,
  showChangeCategory,
  onToggleSelect,
  onAction,
  primaryAction,
}: QueueItemCardProps) => {
  const issueSummary = summarizeIssueCounts(issueLines);
  const progressValue = computeProgressValue([item]);
  const actionSummary = summarizeActionCapabilities([item]);
  const effectivePrimaryAction = primaryAction ?? actionSummary.primaryAction;
  const primaryActionItems = effectivePrimaryAction
    ? filterItemsForAction([item], effectivePrimaryAction)
    : [];
  const primaryDisabled =
    !effectivePrimaryAction || primaryActionItems.length === 0;

  return (
    <div
      className={cn(
        "rounded-xl border border-white/10 bg-white/5 p-4",
        selected && "border-white/40",
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="flex min-w-0 items-start gap-3 lg:pr-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={selected}
            onChange={onToggleSelect}
            disabled={pending}
          />
          <div className="min-w-0 space-y-2">
            <div>
              <p className="font-medium text-white">
                {item.title ?? "Unnamed item"}
              </p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-white/60">
                <span className="capitalize">{item.service}</span>
                {item.instanceName && <span>{item.instanceName}</span>}
                {item.downloadClient && <span>{item.downloadClient}</span>}
                {item.indexer && <span>{item.indexer}</span>}
                {typeof item.size === "number" && (
                  <span>{(item.size / 1024 ** 3).toFixed(2)} GB</span>
                )}
              </div>
            </div>
            {issueLines.length > 0 && (
              <div className="space-y-2 break-words">
                {renderCompactLines(issueLines)}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:flex-shrink-0 lg:gap-4 lg:pl-4">
          <div className="flex justify-end text-xs text-white/60">
            <QueueIssueBadge summary={issueSummary} size="sm" />
          </div>
          <QueueProgress value={progressValue} size="sm" />
          <QueueActionButtons
            onAction={onAction}
            disabled={pending}
            showChangeCategory={showChangeCategory}
            fullWidth
            primaryAction={effectivePrimaryAction}
            primaryDisabled={primaryDisabled}
          />
        </div>
      </div>
    </div>
  );
};
