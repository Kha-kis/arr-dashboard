/**
 * Hook for grouping queue items
 */

import { useMemo } from "react";
import type { QueueItem } from "@arr/shared";
import type { QueueAction } from "../components/queue-action-buttons.js";
import type { IssueSummary } from "../components/queue-issue-badge.js";
import {
  buildKey,
  getGroupKey,
  deriveTitle,
  collectStatusLines,
  summarizeIssueCounts,
  computeProgressValue,
  type StatusLine,
  type ActionCounts,
} from "../lib/queue-utils.js";

/**
 * Summary row representing either a group of items or a single item
 */
export type SummaryRow = {
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

/**
 * Filters items based on their action capabilities
 */
export const filterItemsForAction = (
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

/**
 * Summarizes action capabilities for a set of items
 */
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

/**
 * Creates a summary row for a group of items
 */
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

/**
 * Creates a summary row for a single item
 */
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

/**
 * Groups queue items by their natural grouping (downloadId, series, etc.)
 * Returns summary rows for display
 */
export const useQueueGrouping = (items: QueueItem[]) => {
  const summaryRows = useMemo<SummaryRow[]>(() => {
    const groupMap = new Map<string, QueueItem[]>();

    // Group items by their group key
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

    // Create summary rows, grouping items with 2+ members
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

  return summaryRows;
};
