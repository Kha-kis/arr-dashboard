"use client";

/**
 * Component for rendering individual queue items as premium cards
 * Features glassmorphism styling with theme-aware accents
 *
 * Wrapped with React.memo for list performance optimization.
 */

import { memo } from "react";
import type { QueueItem } from "@arr/shared";
import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { QueueAction } from "./queue-action-buttons";
import { QueueActionButtons } from "./queue-action-buttons";
import { QueueIssueBadge } from "./queue-issue-badge";
import { QueueProgress } from "./queue-progress";
import { QueueItemMetadata } from "./queue-item-metadata";
import { QueueStatusMessages } from "./queue-status-messages";
import type { StatusLine } from "../lib/queue-utils";
import { summarizeIssueCounts, computeProgressValue } from "../lib/queue-utils";
import { useIncognitoMode, getLinuxIsoName } from "../../../lib/incognito";

export interface QueueItemCardProps {
	item: QueueItem;
	instanceUrl?: string;
	issueLines: StatusLine[];
	selected: boolean;
	pending?: boolean;
	showChangeCategory: boolean;
	onToggleSelect: () => void;
	onAction: (action: QueueAction, options?: QueueActionOptions) => void;
	/** Prefetch manual import data on hover to reduce latency */
	onPrefetchManualImport?: (item: QueueItem) => void;
	primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
}

/**
 * Premium card component for displaying a single queue item
 * Features glassmorphism styling with theme-aware accent colors
 *
 * Memoized to prevent unnecessary re-renders when rendered in lists.
 * Parent components should memoize callback props with useCallback.
 */
export const QueueItemCard = memo(function QueueItemCard({
	item,
	instanceUrl,
	issueLines,
	selected,
	pending,
	showChangeCategory,
	onToggleSelect,
	onAction,
	onPrefetchManualImport,
	primaryAction,
}: QueueItemCardProps) {
	const [incognitoMode] = useIncognitoMode();
	const { gradient: themeGradient } = useThemeGradient();
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

	// Prefetch manual import data when hovering over item with manual import available
	const handleMouseEnter = () => {
		if (canManualImport && onPrefetchManualImport) {
			onPrefetchManualImport(item);
		}
	};

	return (
		<div
			className={cn(
				"group relative overflow-hidden rounded-xl border border-border/40 bg-card/50 backdrop-blur-xs p-4 transition-all duration-300",
				selected && "ring-2 ring-primary/50 border-primary/50",
				"hover:border-primary/30 hover:shadow-xl",
			)}
			style={{
				boxShadow: selected
					? `0 0 24px -4px ${themeGradient.glow}, inset 0 1px 0 0 rgba(255,255,255,0.05)`
					: `inset 0 1px 0 0 rgba(255,255,255,0.03)`,
			}}
			onMouseEnter={handleMouseEnter}
		>
			{/* Theme gradient accent line on the left */}
			<div
				className="absolute inset-y-0 left-0 w-0.5 transition-all duration-300 group-hover:w-1"
				style={{
					background: `linear-gradient(180deg, ${themeGradient.from}, ${themeGradient.to})`,
				}}
			/>

			{/* Subtle gradient overlay on hover */}
			<div
				className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}05, transparent 50%)`,
				}}
			/>

			<div className="relative grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
				{/* Left column: checkbox, title, metadata, status messages */}
				<div className="flex min-w-0 items-start gap-3 lg:pr-4">
					<div className="relative mt-1">
						<input
							type="checkbox"
							className={cn(
								"h-4 w-4 rounded border-2 transition-all duration-200 cursor-pointer",
								"border-border/50 bg-card/50",
								"checked:border-primary checked:bg-primary",
								"focus:ring-2 focus:ring-primary/20 focus:ring-offset-0",
								"disabled:cursor-not-allowed disabled:opacity-50",
							)}
							checked={selected}
							onChange={onToggleSelect}
							disabled={pending}
						/>
					</div>
					<div className="min-w-0 space-y-3">
						<div>
							<p
								className="font-medium leading-tight transition-colors duration-300 group-hover:text-primary"
								style={{
									// Theme-aware hover color via CSS variable
								}}
							>
								{incognitoMode
									? getLinuxIsoName(item.title ?? "Unnamed item")
									: (item.title ?? "Unnamed item")}
							</p>
							<QueueItemMetadata item={item} instanceUrl={instanceUrl} />
						</div>
						{issueLines.length > 0 && <QueueStatusMessages lines={issueLines} />}
					</div>
				</div>

				{/* Right column: issue badge, progress, actions */}
				<div className="flex flex-col gap-3 lg:shrink-0 lg:gap-4 lg:pl-4 lg:border-l lg:border-border/30">
					<div className="flex justify-end">
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
});
