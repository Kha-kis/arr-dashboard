"use client";

/**
 * Component for bulk actions on selected queue items
 * Premium glassmorphism toolbar with theme-aware styling
 */

import type { QueueItem } from "@arr/shared";
import { Download, RefreshCw, Tag, CheckCircle2 } from "lucide-react";
import { cn } from "../../../lib/utils";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import { RemoveActionMenu } from "./queue-action-buttons";

interface QueueSelectionToolbarProps {
	selectedItems: QueueItem[];
	manualImportItems: QueueItem[];
	retryItems: QueueItem[];
	pending?: boolean;
	onManualImport?: (items: QueueItem[]) => Promise<void> | void;
	onRetry?: (items: QueueItem[]) => Promise<void> | void;
	onRemove?: (items: QueueItem[], options?: QueueActionOptions) => Promise<void> | void;
	onChangeCategory?: (items: QueueItem[]) => Promise<void> | void;
}

/**
 * Premium toolbar displayed when items are selected
 * Features glassmorphism styling with theme-aware accent
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	if (selectedItems.length === 0) {
		return null;
	}

	const actionButtonClass = cn(
		"group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-all duration-300",
		"border-border/50 bg-card/50 text-muted-foreground backdrop-blur-sm",
		"hover:border-border hover:bg-card hover:text-foreground",
		"disabled:cursor-not-allowed disabled:opacity-50",
	);

	return (
		<div
			className="animate-in slide-in-from-top-2 fade-in duration-300 relative overflow-hidden rounded-xl border border-border/50 bg-card/80 backdrop-blur-xl"
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

			<div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
				{/* Selection count with icon */}
				<div className="flex items-center gap-2">
					<div
						className="flex h-6 w-6 items-center justify-center rounded-full"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						}}
					>
						<CheckCircle2
							className="h-3.5 w-3.5"
							style={{ color: themeGradient.from }}
						/>
					</div>
					<span className="text-sm font-medium text-foreground">
						{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} selected
					</span>
				</div>

				{/* Action buttons */}
				<div className="flex flex-wrap gap-2">
					{onManualImport && manualImportItems.length > 0 && (
						<button
							type="button"
							className={actionButtonClass}
							onClick={() => void onManualImport(manualImportItems)}
							disabled={pending}
						>
							<Download className="h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-110" />
							<span>Manual import</span>
						</button>
					)}
					{onRetry && retryItems.length > 0 && (
						<button
							type="button"
							className={actionButtonClass}
							onClick={() => void onRetry(retryItems)}
							disabled={pending}
						>
							<RefreshCw className="h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-180" />
							<span>Retry</span>
						</button>
					)}
					<RemoveActionMenu
						label="Remove"
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
							className={actionButtonClass}
							onClick={() => void onChangeCategory(selectedItems)}
							disabled={pending}
						>
							<Tag className="h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-110" />
							<span>Category</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
};
