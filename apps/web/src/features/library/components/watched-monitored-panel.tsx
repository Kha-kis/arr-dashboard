"use client";

import type { LibraryService } from "@arr/shared";
import { ChevronDown, Eye, Loader2, PauseCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServiceBadge, StatusBadge } from "../../../components/layout";
import { useLibraryMonitorMutation } from "../../../hooks/api/useLibrary";
import {
	type WatchedMonitoredItem,
	useWatchedMonitoredInsights,
} from "../../../hooks/api/useWatchedMonitoredInsights";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

/**
 * Watched + Monitored Insights Panel
 *
 * Shows library items that have Plex watch activity but are still monitored.
 * These are candidates for unmonitoring to stop unnecessary indexer searches.
 * Collapsed by default.
 */
export function WatchedMonitoredPanel({
	autoExpand = false,
	isDismissed,
	onDismiss,
}: {
	autoExpand?: boolean;
	isDismissed?: (instanceId: string, arrItemId: number) => boolean;
	onDismiss?: (instanceId: string, arrItemId: number) => void;
}) {
	const [incognitoMode] = useIncognitoMode();
	const [expanded, setExpanded] = useState(autoExpand);
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (autoExpand && panelRef.current) {
			setExpanded(true);
			panelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}, [autoExpand]);
	const monitorMutation = useLibraryMonitorMutation();
	const [pendingId, setPendingId] = useState<string | null>(null);

	const { data, isLoading } = useWatchedMonitoredInsights({ limit: 25 });

	const handleUnmonitor = async (item: WatchedMonitoredItem) => {
		const key = `${item.instanceId}:${item.arrItemId}`;
		setPendingId(key);
		try {
			await monitorMutation.mutateAsync({
				instanceId: item.instanceId,
				service: item.service as LibraryService,
				itemId: item.arrItemId,
				monitored: false,
			});
			toast.success(`${item.title} unmonitored`);
		} catch (error) {
			toast.error(getErrorMessage(error, "Failed to unmonitor"));
		} finally {
			setPendingId(null);
		}
	};

	const allItems = data?.data?.items ?? [];
	const items = isDismissed
		? allItems.filter((i) => !isDismissed(i.instanceId, i.arrItemId))
		: allItems;
	const hasPlexData = data?.data?.hasPlexData ?? false;

	if (isLoading || items.length === 0 || !hasPlexData) return null;

	return (
		<div ref={panelRef} className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-sm overflow-hidden">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/10 transition-colors"
			>
				<div className="flex items-center gap-3">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
						style={{
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.info.from}20, ${SEMANTIC_COLORS.info.to}20)`,
						}}
					>
						<Eye className="h-4 w-4" style={{ color: SEMANTIC_COLORS.info.from }} />
					</div>
					<span className="text-sm font-medium text-foreground">
						{items.length} watched item{items.length !== 1 ? "s" : ""} still monitored
					</span>
				</div>
				<ChevronDown
					className={cn(
						"h-4 w-4 text-muted-foreground transition-transform duration-200",
						expanded && "rotate-180",
					)}
				/>
			</button>

			{expanded && (
				<div className="border-t border-border/20 px-4 py-3 space-y-2">
					<p className="text-xs text-muted-foreground mb-3">
						Movies and ended series with Plex plays that are still monitored. Continuing series are excluded. Sorted by watch count.
					</p>
					{items.map((item) => (
						<WatchedRow
							key={`${item.instanceId}-${item.arrItemId}`}
							item={item}
							incognitoMode={incognitoMode}
							onUnmonitor={() => handleUnmonitor(item)}
							isPending={pendingId === `${item.instanceId}:${item.arrItemId}`}
							onDismiss={onDismiss ? () => onDismiss(item.instanceId, item.arrItemId) : undefined}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function WatchedRow({
	item,
	incognitoMode,
	onUnmonitor,
	isPending,
	onDismiss,
}: {
	item: WatchedMonitoredItem;
	incognitoMode: boolean;
	onUnmonitor: () => void;
	isPending: boolean;
	onDismiss?: () => void;
}) {
	return (
		<div className="group flex items-center gap-3 rounded-lg px-3 py-2 bg-muted/5 border border-border/10">
			<Eye
				className="h-3.5 w-3.5 shrink-0"
				style={{ color: SEMANTIC_COLORS.info.from }}
			/>
			<div className="flex-1 min-w-0">
				<span className="text-sm font-medium text-foreground truncate block">
					{incognitoMode ? getLinuxIsoName(item.title) : item.title}
					{item.year ? ` (${item.year})` : ""}
				</span>
				<span className="text-xs text-muted-foreground">
					{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}
					{item.lastWatchedAt && (
						<> · Last watched {new Date(item.lastWatchedAt).toLocaleDateString()}</>
					)}
				</span>
			</div>
			<ServiceBadge service={item.service} />
			<StatusBadge status="success">
				{item.watchCount} play{item.watchCount !== 1 ? "s" : ""}
			</StatusBadge>
			<button
				type="button"
				onClick={onUnmonitor}
				disabled={isPending}
				className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/20"
				title="Stop monitoring this item"
			>
				{isPending ? (
					<Loader2 className="h-3 w-3 animate-spin" />
				) : (
					<PauseCircle className="h-3 w-3" />
				)}
				Unmonitor
			</button>
			{onDismiss && (
				<button
					type="button"
					onClick={onDismiss}
					className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/10"
					title="Dismiss this item from insights"
				>
					<XCircle className="h-3 w-3" />
				</button>
			)}
		</div>
	);
}
