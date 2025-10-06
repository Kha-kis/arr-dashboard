"use client";

/**
 * Component for bulk actions on selected queue items
 */

import type { QueueItem } from "@arr/shared";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import { RemoveActionMenu } from "./queue-action-buttons";

interface QueueSelectionToolbarProps {
  selectedItems: QueueItem[];
  manualImportItems: QueueItem[];
  retryItems: QueueItem[];
  pending?: boolean;
  onManualImport?: (items: QueueItem[]) => Promise<void> | void;
  onRetry?: (items: QueueItem[]) => Promise<void> | void;
  onRemove?: (
    items: QueueItem[],
    options?: QueueActionOptions,
  ) => Promise<void> | void;
  onChangeCategory?: (items: QueueItem[]) => Promise<void> | void;
}

/**
 * Toolbar displayed when items are selected, providing bulk action buttons
 */
export const QueueSelectionToolbar = ({
  selectedItems,
  manualImportItems,
  retryItems,
  pending,
  onManualImport,
  onRetry,
  onRemove,
  onChangeCategory,
}: QueueSelectionToolbarProps) => {
  if (selectedItems.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/10 px-4 py-2 text-sm text-white/80 lg:flex-row lg:items-center lg:justify-between">
      <span>
        {selectedItems.length} item{selectedItems.length === 1 ? "" : "s"}{" "}
        selected
      </span>
      <div className="flex flex-wrap gap-2">
        {onManualImport && manualImportItems.length > 0 && (
          <button
            type="button"
            className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-wide text-white/70 transition hover:border-white/40"
            onClick={() => void onManualImport(manualImportItems)}
            disabled={pending}
          >
            Manual import selected
          </button>
        )}
        {onRetry && retryItems.length > 0 && (
          <button
            type="button"
            className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-wide text-white/70 transition hover:border-white/40"
            onClick={() => void onRetry(retryItems)}
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
  );
};
