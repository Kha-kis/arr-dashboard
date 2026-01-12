"use client";

/**
 * Component for rendering grouped queue items with expandable details
 * Premium glassmorphism styling with theme-aware accents
 */

import type { QueueItem } from "@arr/shared";
import { ChevronDown, Layers } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import type { InstanceUrlMap } from "./dashboard-client";
import type { QueueAction } from "./queue-action-buttons";
import { QueueActionButtons } from "./queue-action-buttons";
import type { IssueSummary } from "./queue-issue-badge";
import { QueueIssueBadge } from "./queue-issue-badge";
import { QueueProgress } from "./queue-progress";
import { QueueItemCard } from "./queue-item-card";
import { QueueItemMetadata } from "./queue-item-metadata";
import { buildKey, collectStatusLines } from "../lib/queue-utils";
import { useIncognitoMode, getLinuxIsoName } from "../../../lib/incognito";

interface QueueGroupCardProps {
	groupKey: string;
	title: string;
	service: QueueItem["service"];
	instanceName?: string;
	instanceUrl?: string;
	instanceUrlMap?: InstanceUrlMap;
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
	onItemAction: (item: QueueItem, action: QueueAction, options?: QueueActionOptions) => void;
	/** Prefetch manual import data on hover to reduce latency */
	onPrefetchManualImport?: (item: QueueItem) => void;
	isItemSelected: (item: QueueItem) => boolean;
	onToggleItemSelect: (item: QueueItem) => void;
}

/**
 * Premium card component for displaying a group of related queue items
 * Features glassmorphism styling with theme-aware accents
 */
export const QueueGroupCard = ({
	groupKey,
	title,
	service,
	instanceName,
	instanceUrl,
	instanceUrlMap,
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
	onPrefetchManualImport,
	isItemSelected,
	onToggleItemSelect,
}: QueueGroupCardProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { gradient: themeGradient } = useThemeGradient();

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
		<div
			className={cn(
				"group relative overflow-hidden rounded-xl border border-border/40 bg-card/50 backdrop-blur-sm transition-all duration-300",
				"hover:border-primary/30",
				expanded && "shadow-xl",
			)}
			style={{
				boxShadow: expanded
					? `0 8px 32px -8px ${themeGradient.glow}, inset 0 1px 0 0 rgba(255,255,255,0.05)`
					: `inset 0 1px 0 0 rgba(255,255,255,0.03)`,
			}}
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

			<div className="relative grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
				{/* Left column: checkbox, expand button, title, metadata */}
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
							checked={everySelected}
							onChange={onToggleSelect}
							disabled={pending}
						/>
					</div>
					<div className="min-w-0 flex-1 space-y-2">
						<button
							type="button"
							onClick={onToggleExpand}
							className="group/expand flex items-center gap-2 text-left transition-colors duration-300"
						>
							<div
								className="flex h-6 w-6 items-center justify-center rounded-md transition-all duration-300"
								style={{
									background: expanded
										? `linear-gradient(135deg, ${themeGradient.from}30, ${themeGradient.to}30)`
										: undefined,
									color: expanded ? themeGradient.from : undefined,
								}}
							>
								<ChevronDown
									className={cn(
										"h-4 w-4 transition-transform duration-300",
										!expanded && "-rotate-90",
										!expanded && "text-muted-foreground group-hover/expand:text-primary",
									)}
									style={expanded ? { color: themeGradient.from } : undefined}
								/>
							</div>
							<span
								className="font-semibold text-foreground transition-colors duration-300"
								style={{
									// Hover color handled by group
								}}
							>
								{incognitoMode ? getLinuxIsoName(title) : title}
							</span>
							{/* Group indicator with theme color */}
							<div
								className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all duration-300"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
									color: themeGradient.from,
								}}
							>
								<Layers className="h-3 w-3" />
								<span>{groupCount}</span>
							</div>
						</button>
						<QueueItemMetadata item={metadataItem} instanceUrl={instanceUrl} showGroupCount groupCount={groupCount} />
					</div>
				</div>

				{/* Right column: issue badge, progress, actions */}
				<div className="flex flex-col gap-3 lg:flex-shrink-0 lg:gap-4 lg:pl-4 lg:border-l lg:border-border/30">
					<div className="flex justify-end">
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

			{/* Expanded items with theme-aware background */}
			{expanded && (
				<div
					className="space-y-3 border-t border-border/30 p-4 animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						background: `linear-gradient(180deg, ${themeGradient.from}05, transparent)`,
					}}
				>
					{items.map((item, index) => {
						const itemUrl = instanceUrlMap?.get(item.instanceId);
						return (
							<div
								key={buildKey(item)}
								className="animate-in fade-in slide-in-from-top-1 duration-200"
								style={{
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
								}}
							>
								<QueueItemCard
									item={item}
									instanceUrl={itemUrl}
									issueLines={collectStatusLines(item)}
									selected={isItemSelected(item)}
									pending={pending}
									showChangeCategory={showChangeCategory}
									onToggleSelect={() => onToggleItemSelect(item)}
									onAction={(action, actionOptions) => void onItemAction(item, action, actionOptions)}
									onPrefetchManualImport={onPrefetchManualImport}
								/>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
