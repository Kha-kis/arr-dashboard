"use client";

import { useMemo } from "react";
import type { QueueItem } from "@arr/shared";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { QueueAction } from "./queue-action-buttons.js";
import { QueueGroupCard } from "./queue-group-card.js";
import { QueueItemCard } from "./queue-item-card.js";
import { QueueSelectionToolbar } from "./queue-selection-toolbar.js";
import {
  useQueueSelection,
  useQueueGrouping,
  useQueueExpansion,
  filterItemsForAction,
} from "../hooks/index.js";

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

/**
 * Main queue table component that displays queue items with grouping and actions
 *
 * This component orchestrates the queue view by:
 * - Grouping related queue items together
 * - Managing selection state across items and groups
 * - Handling expansion state for groups
 * - Delegating rendering to specialized card components
 * - Coordinating actions (retry, manual import, remove, change category)
 *
 * The component maintains minimal local state while delegating most logic
 * to custom hooks and child components.
 */
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
  // Custom hooks for state management
  const summaryRows = useQueueGrouping(items);
  const selection = useQueueSelection(items);
  const expansion = useQueueExpansion();

  // Filter selected items by action capability
  const selectedManualImportItems = useMemo(
    () => filterItemsForAction(selection.selectedItems, "manualImport"),
    [selection.selectedItems],
  );

  const selectedRetryItems = useMemo(
    () => filterItemsForAction(selection.selectedItems, "retry"),
    [selection.selectedItems],
  );

  // Action handlers for rows (groups or items)
  const handleRowAction = async (
    rowItems: QueueItem[],
    action: QueueAction,
    actionOptions?: QueueActionOptions,
  ) => {
    const actionableItems = filterItemsForAction(rowItems, action);
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

  // Action handler for individual items
  const handleItemAction = async (
    item: QueueItem,
    action: QueueAction,
    actionOptions?: QueueActionOptions,
  ) => {
    await handleRowAction([item], action, actionOptions);
  };

  // Loading state
  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        Fetching queue items...
      </div>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        {emptyMessage ?? "Queue is empty across all instances."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Selection toolbar for bulk actions */}
      <QueueSelectionToolbar
        selectedItems={selection.selectedItems}
        manualImportItems={selectedManualImportItems}
        retryItems={selectedRetryItems}
        pending={pending}
        onManualImport={onManualImport}
        onRetry={onRetry}
        onRemove={onRemove}
        onChangeCategory={onChangeCategory}
      />

      {/* Queue items and groups */}
      <div className="space-y-4">
        {summaryRows.map((row) => {
          if (row.type === "group") {
            const primaryActionItems = row.primaryAction
              ? filterItemsForAction(row.items, row.primaryAction)
              : [];

            return (
              <QueueGroupCard
                key={row.key}
                groupKey={row.key}
                title={row.title}
                service={row.service}
                instanceName={row.instanceName}
                items={row.items}
                groupCount={row.groupCount ?? 0}
                progressValue={row.progressValue}
                issueSummary={row.issueSummary}
                primaryAction={row.primaryAction}
                primaryDisabled={
                  !row.primaryAction || primaryActionItems.length === 0
                }
                expanded={expansion.isRowExpanded(row.key)}
                everySelected={selection.areAllItemsSelected(row.items)}
                pending={pending}
                showChangeCategory={Boolean(onChangeCategory)}
                onToggleExpand={() => expansion.toggleRowExpansion(row.key)}
                onToggleSelect={() =>
                  selection.toggleSelectionForItems(row.items)
                }
                onAction={(action, actionOptions) =>
                  void handleRowAction(row.items, action, actionOptions)
                }
                onItemAction={(item, action, actionOptions) =>
                  void handleItemAction(item, action, actionOptions)
                }
                isItemSelected={selection.isItemSelected}
                onToggleItemSelect={selection.toggleSingleSelection}
              />
            );
          }

          // Single item row
          const item = row.items[0]!;
          return (
            <QueueItemCard
              key={row.key}
              item={item}
              issueLines={row.issueLines}
              selected={selection.isItemSelected(item)}
              pending={pending}
              showChangeCategory={Boolean(onChangeCategory)}
              onToggleSelect={() => selection.toggleSingleSelection(item)}
              onAction={(action, actionOptions) =>
                void handleItemAction(item, action, actionOptions)
              }
              primaryAction={row.primaryAction}
            />
          );
        })}
      </div>
    </div>
  );
};
