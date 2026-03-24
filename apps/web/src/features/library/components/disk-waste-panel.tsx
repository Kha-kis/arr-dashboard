"use client";

import type { LibraryService } from "@arr/shared";
import { AlertTriangle, ChevronDown, HardDrive, Loader2, PauseCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServiceBadge } from "../../../components/layout";
import { useLibraryMonitorMutation } from "../../../hooks/api/useLibrary";
import {
	type DiskWasteItem,
	useDiskWasteInsights,
} from "../../../hooks/api/useDiskWasteInsights";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

function formatSize(bytes: number): string {
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Disk Waste Insights Panel
 *
 * Shows library items consuming significant disk space with zero Plex plays.
 * Collapsed by default — expands to show the list.
 */
export function DiskWastePanel({
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

	const { data, isLoading } = useDiskWasteInsights({
		minSizeGb: 1,
		minAgeDays: 30,
		limit: 25,
	});

	const allItems = data?.data?.items ?? [];
	const items = isDismissed
		? allItems.filter((i) => !isDismissed(i.instanceId, i.arrItemId))
		: allItems;
	const totalWasted = items.reduce((sum, r) => sum + r.sizeOnDisk, 0);
	const hasPlexData = data?.data?.hasPlexData ?? false;

	const handleUnmonitor = async (item: DiskWasteItem) => {
		if (!item.monitored) return;
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

	// Don't render if no items or still loading
	if (isLoading || items.length === 0) return null;

	return (
		<div ref={panelRef} className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-sm overflow-hidden">
			{/* Header — always visible */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/10 transition-colors"
			>
				<div className="flex items-center gap-3">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
						style={{
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
						}}
					>
						<AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
					</div>
					<div>
						<span className="text-sm font-medium text-foreground">
							{items.length} unwatched item{items.length !== 1 ? "s" : ""} using{" "}
							{formatSize(totalWasted)}
						</span>
						{!hasPlexData && (
							<span className="text-xs text-muted-foreground ml-2">(no Plex connected)</span>
						)}
					</div>
				</div>
				<ChevronDown
					className={cn(
						"h-4 w-4 text-muted-foreground transition-transform duration-200",
						expanded && "rotate-180",
					)}
				/>
			</button>

			{/* Expanded content */}
			{expanded && (
				<div className="border-t border-border/20 px-4 py-3 space-y-2">
					<p className="text-xs text-muted-foreground mb-3">
						Largest library items ({">"}1 GB) added over 30 days ago with zero Plex plays. Sorted by size.
					</p>
					{items.map((item) => (
						<DiskWasteRow
							key={`${item.instanceId}-${item.arrItemId}`}
							item={item}
							incognitoMode={incognitoMode}
							onUnmonitor={item.monitored ? () => handleUnmonitor(item) : undefined}
							isPending={pendingId === `${item.instanceId}:${item.arrItemId}`}
							onDismiss={onDismiss ? () => onDismiss(item.instanceId, item.arrItemId) : undefined}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function DiskWasteRow({
	item,
	incognitoMode,
	onUnmonitor,
	isPending,
	onDismiss,
}: {
	item: DiskWasteItem;
	incognitoMode: boolean;
	onUnmonitor?: () => void;
	isPending: boolean;
	onDismiss?: () => void;
}) {
	return (
		<div className="group flex items-center gap-3 rounded-lg px-3 py-2 bg-muted/5 border border-border/10">
			<HardDrive
				className="h-3.5 w-3.5 shrink-0"
				style={{ color: SEMANTIC_COLORS.warning.from }}
			/>
			<div className="flex-1 min-w-0">
				<span className="text-sm font-medium text-foreground truncate block">
					{incognitoMode ? getLinuxIsoName(item.title) : item.title}
					{item.year ? ` (${item.year})` : ""}
				</span>
				<span className="text-xs text-muted-foreground">
					{incognitoMode
						? getLinuxInstanceName(item.instanceName)
						: item.instanceName}
					{" · "}Added {item.addedDaysAgo}d ago
				</span>
			</div>
			<ServiceBadge service={item.service} />
			<span className="text-xs font-mono text-muted-foreground shrink-0">
				{formatSize(item.sizeOnDisk)}
			</span>
			{onUnmonitor && (
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
			)}
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
