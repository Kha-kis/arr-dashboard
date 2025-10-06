"use client";

/**
 * Component for rendering individual queue items as cards
 */

import type { QueueItem } from "@arr/shared";
import { cn } from "../../../lib/utils/index";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { QueueAction } from "./queue-action-buttons";
import { QueueActionButtons } from "./queue-action-buttons";
import { QueueIssueBadge } from "./queue-issue-badge";
import { QueueProgress } from "./queue-progress";
import { QueueItemMetadata } from "./queue-item-metadata";
import { QueueStatusMessages } from "./queue-status-messages";
import type { StatusLine } from "../lib/queue-utils";
import {
  summarizeIssueCounts,
  computeProgressValue,
} from "../lib/queue-utils";

export interface QueueItemCardProps {
  item: QueueItem;
  issueLines: StatusLine[];
  selected: boolean;
  pending?: boolean;
  showChangeCategory: boolean;
  onToggleSelect: () => void;
  onAction: (action: QueueAction, options?: QueueActionOptions) => void;
  primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
}

/**
 * Card component for displaying a single queue item with actions
 */
export const QueueItemCard = ({
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

  // Determine if primary action is available
  const canManualImport = Boolean(item.actions?.canManualImport);
  const canRetry = item.actions?.canRetry ?? true;

  const effectivePrimaryAction =
    primaryAction ?? (canManualImport ? "manualImport" : canRetry ? "retry" : undefined);

  const primaryDisabled =
    !effectivePrimaryAction ||
    (effectivePrimaryAction === "manualImport" && !canManualImport) ||
    (effectivePrimaryAction === "retry" && !canRetry);

  return (
    <div
      className={cn(
        "rounded-xl border border-white/10 bg-white/5 p-4",
        selected && "border-white/40",
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        {/* Left column: checkbox, title, metadata, status messages */}
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
              <QueueItemMetadata item={item} />
            </div>
            {issueLines.length > 0 && (
              <QueueStatusMessages lines={issueLines} />
            )}
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
            primaryAction={effectivePrimaryAction}
            primaryDisabled={primaryDisabled}
          />
        </div>
      </div>
    </div>
  );
};
