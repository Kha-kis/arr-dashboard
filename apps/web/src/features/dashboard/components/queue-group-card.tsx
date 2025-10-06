"use client";

/**
 * Component for rendering grouped queue items with expandable details
 */

import type { QueueItem } from "@arr/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { QueueAction } from "./queue-action-buttons.js";
import { QueueActionButtons } from "./queue-action-buttons.js";
import type { IssueSummary } from "./queue-issue-badge.js";
import { QueueIssueBadge } from "./queue-issue-badge.js";
import { QueueProgress } from "./queue-progress.js";
import { QueueItemCard } from "./queue-item-card.js";
import { QueueItemMetadata } from "./queue-item-metadata.js";
import { buildKey, collectStatusLines } from "../lib/queue-utils.js";

interface QueueGroupCardProps {
  groupKey: string;
  title: string;
  service: QueueItem["service"];
  instanceName?: string;
  items: QueueItem[];
  groupCount: number;
  progressValue?: number;
  issueSummary: IssueSummary[];
  primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
  primaryDisabled: boolean;
  expanded: boolean;
  everySelected: boolean;
  pending?: boolean;
  showChangeCategory: boolean;
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

/**
 * Card component for displaying a group of related queue items
 * Supports expansion to show individual items
 */
export const QueueGroupCard = ({
  groupKey,
  title,
  service,
  instanceName,
  items,
  groupCount,
  progressValue,
  issueSummary,
  primaryAction,
  primaryDisabled,
  expanded,
  everySelected,
  pending,
  showChangeCategory,
  onToggleExpand,
  onToggleSelect,
  onAction,
  onItemAction,
  isItemSelected,
  onToggleItemSelect,
}: QueueGroupCardProps) => {
  // Create a minimal item for metadata display
  const firstItem = items[0];
  const metadataItem: QueueItem = firstItem
    ? {
        ...firstItem,
        downloadClient: undefined,
        indexer: undefined,
        size: undefined,
      }
    : ({} as QueueItem);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5">
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        {/* Left column: checkbox, expand button, title, metadata */}
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
              <span className="font-semibold">{title}</span>
            </button>
            <QueueItemMetadata
              item={metadataItem}
              showGroupCount
              groupCount={groupCount}
            />
          </div>
        </div>

        {/* Right column: issue badge, progress, actions */}
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
            primaryAction={primaryAction}
            primaryDisabled={primaryDisabled}
          />
        </div>
      </div>

      {/* Expanded items */}
      {expanded && (
        <div className="space-y-3 border-t border-white/10 p-4">
          {items.map((item) => (
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
