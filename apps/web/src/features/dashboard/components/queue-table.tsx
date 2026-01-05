"use client";

import { useMemo } from "react";
import type { QueueItem } from "@arr/shared";
import { Inbox, Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { InstanceUrlMap } from "./dashboard-client";
import type { QueueAction } from "./queue-action-buttons";
import { QueueGroupCard } from "./queue-group-card";
import { QueueItemCard } from "./queue-item-card";
import { QueueSelectionToolbar } from "./queue-selection-toolbar";
import {
	useQueueSelection,
	useQueueExpansion,
	filterItemsForAction,
	type SummaryRow,
} from "../hooks";

type QueueActionHandler = (
	items: QueueItem[],
	options?: QueueActionOptions,
) => Promise<void> | void;

interface QueueTableProps {
	/** Raw queue items (used for selection state) */
	items: QueueItem[];
	/** Pre-grouped and paginated summary rows to display */
	summaryRows: SummaryRow[];
	/** Map of instanceId to baseUrl for linking */
	instanceUrlMap?: InstanceUrlMap;
	loading?: boolean;
	pending?: boolean;
	onRetry?: QueueActionHandler;
	onManualImport?: QueueActionHandler;
	onRemove?: QueueActionHandler;
	onChangeCategory?: QueueActionHandler;
	/** Prefetch manual import data on hover to reduce latency */
	onPrefetchManualImport?: (item: QueueItem) => void;
	emptyMessage?: string;
}

/**
 * Main queue table component that displays queue items with grouping and actions
 *
 * This component orchestrates the queue view by:
 * - Receiving pre-grouped summary rows (grouping happens BEFORE pagination in parent)
 * - Managing selection state across items and groups
 * - Handling expansion state for groups
 * - Delegating rendering to specialized card components
 * - Coordinating actions (retry, manual import, remove, change category)
 *
 * IMPORTANT: This component receives pre-paginated summaryRows to ensure
 * the correct number of cards are displayed per page (e.g., exactly 25 cards
 * when pageSize is 25, regardless of how items are grouped).
 *
 * The component maintains minimal local state while delegating most logic
 * to custom hooks and child components.
 */
export const QueueTable = ({
	items,
	summaryRows,
	instanceUrlMap,
	loading,
	pending,
	onRetry,
	onManualImport,
	onRemove,
	onChangeCategory,
	onPrefetchManualImport,
	emptyMessage,
}: QueueTableProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	// Custom hooks for state management
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

	// Loading state with premium styling
	if (loading) {
		return (
			<div
				className="relative overflow-hidden rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm p-8 text-center"
				style={{
					boxShadow: `0 4px 20px -4px ${themeGradient.glow}`,
				}}
			>
				{/* Gradient accent bar */}
				<div
					className="absolute inset-x-0 top-0 h-0.5"
					style={{
						background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
					}}
				/>
				<div className="flex flex-col items-center gap-3">
					<div
						className="flex h-12 w-12 items-center justify-center rounded-full"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						}}
					>
						<Loader2
							className="h-6 w-6 animate-spin"
							style={{ color: themeGradient.from }}
						/>
					</div>
					<p className="text-sm text-muted-foreground">Fetching queue items...</p>
				</div>
			</div>
		);
	}

	// Empty state with premium styling
	if (items.length === 0) {
		return (
			<div
				className="relative overflow-hidden rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm p-8 text-center"
				style={{
					boxShadow: `0 4px 20px -4px ${themeGradient.glow}`,
				}}
			>
				{/* Gradient accent bar */}
				<div
					className="absolute inset-x-0 top-0 h-0.5"
					style={{
						background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
					}}
				/>
				<div className="flex flex-col items-center gap-3">
					<div
						className="flex h-12 w-12 items-center justify-center rounded-full"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						}}
					>
						<Inbox
							className="h-6 w-6"
							style={{ color: themeGradient.from }}
						/>
					</div>
					<p className="text-sm text-muted-foreground">
						{emptyMessage ?? "Queue is empty across all instances."}
					</p>
				</div>
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

			{/* Queue items and groups with staggered animations */}
			<div className="space-y-4">
				{summaryRows.map((row, index) => {
					// Get instance URL from first item in the row
					const firstItem = row.items[0];
					const instanceUrl = firstItem && instanceUrlMap?.get(firstItem.instanceId);

					if (row.type === "group") {
						const primaryActionItems = row.primaryAction
							? filterItemsForAction(row.items, row.primaryAction)
							: [];

						return (
							<div
								key={row.key}
								className="animate-in fade-in slide-in-from-bottom-2 duration-300"
								style={{
									animationDelay: `${Math.min(index * 50, 300)}ms`,
									animationFillMode: "backwards",
								}}
							>
								<QueueGroupCard
									groupKey={row.key}
									title={row.title}
									service={row.service}
									instanceName={row.instanceName}
									instanceUrl={instanceUrl}
									instanceUrlMap={instanceUrlMap}
									items={row.items}
									groupCount={row.groupCount ?? 0}
									progressValue={row.progressValue}
									issueSummary={row.issueSummary}
									primaryAction={row.primaryAction}
									primaryDisabled={!row.primaryAction || primaryActionItems.length === 0}
									expanded={expansion.isRowExpanded(row.key)}
									everySelected={selection.areAllItemsSelected(row.items)}
									pending={pending}
									showChangeCategory={Boolean(onChangeCategory)}
									onToggleExpand={() => expansion.toggleRowExpansion(row.key)}
									onToggleSelect={() => selection.toggleSelectionForItems(row.items)}
									onAction={(action, actionOptions) =>
										void handleRowAction(row.items, action, actionOptions)
									}
									onItemAction={(item, action, actionOptions) =>
										void handleItemAction(item, action, actionOptions)
									}
									onPrefetchManualImport={onPrefetchManualImport}
									isItemSelected={selection.isItemSelected}
									onToggleItemSelect={selection.toggleSingleSelection}
								/>
							</div>
						);
					}

					// Single item row
					const item = row.items[0]!;
					return (
						<div
							key={row.key}
							className="animate-in fade-in slide-in-from-bottom-2 duration-300"
							style={{
								animationDelay: `${Math.min(index * 50, 300)}ms`,
								animationFillMode: "backwards",
							}}
						>
							<QueueItemCard
								item={item}
								instanceUrl={instanceUrl}
								issueLines={row.issueLines}
								selected={selection.isItemSelected(item)}
								pending={pending}
								showChangeCategory={Boolean(onChangeCategory)}
								onToggleSelect={() => selection.toggleSingleSelection(item)}
								onAction={(action, actionOptions) =>
									void handleItemAction(item, action, actionOptions)
								}
								onPrefetchManualImport={onPrefetchManualImport}
								primaryAction={row.primaryAction}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
};
