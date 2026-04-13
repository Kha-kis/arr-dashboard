"use client";

import { ChevronDown, Inbox, User, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ServiceBadge, StatusBadge } from "../../../components/layout";
import {
	type RequestedUnwatchedItem,
	useRequestedUnwatchedInsights,
} from "../../../hooks/api/useRequestedUnwatchedInsights";
import { getLinuxInstanceName, getLinuxIsoName, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

/**
 * Requested but Unwatched Insights Panel
 *
 * Shows items that were requested via Seerr, are available in the library,
 * but have never been watched in Plex. Advisory only.
 */
export function RequestedUnwatchedPanel({
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

	const { data, isLoading } = useRequestedUnwatchedInsights({
		minAgeDays: 7,
		limit: 25,
	});

	const allItems = data?.data?.items ?? [];
	const items = isDismissed
		? allItems.filter((i) => !isDismissed(i.instanceId, i.arrItemId))
		: allItems;
	const hasSeerrData = data?.data?.hasSeerrData ?? false;
	const hasWatchData = data?.data?.hasWatchData ?? data?.data?.hasPlexData ?? false;

	if (isLoading || items.length === 0 || !hasSeerrData || !hasWatchData) return null;

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
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
						}}
					>
						<Inbox className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />
					</div>
					<span className="text-sm font-medium text-foreground">
						{items.length} requested item{items.length !== 1 ? "s" : ""} never watched
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
						Items requested via Seerr that are available but have never been watched after 7+ days.
					</p>
					{items.map((item) => (
						<RequestedRow
							key={`${item.instanceId}-${item.arrItemId}`}
							item={item}
							incognitoMode={incognitoMode}
							onDismiss={onDismiss ? () => onDismiss(item.instanceId, item.arrItemId) : undefined}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function RequestedRow({
	item,
	incognitoMode,
	onDismiss,
}: { item: RequestedUnwatchedItem; incognitoMode: boolean; onDismiss?: () => void }) {
	return (
		<div className="group flex items-center gap-3 rounded-lg px-3 py-2 bg-muted/5 border border-border/10">
			<Inbox
				className="h-3.5 w-3.5 shrink-0"
				style={{ color: SEMANTIC_COLORS.error.from }}
			/>
			<div className="flex-1 min-w-0">
				<span className="text-sm font-medium text-foreground truncate block">
					{incognitoMode ? getLinuxIsoName(item.title) : item.title}
					{item.year ? ` (${item.year})` : ""}
				</span>
				<span className="text-xs text-muted-foreground">
					{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}
					{" · "}Available {item.addedDaysAgo}d ago
				</span>
			</div>
			<ServiceBadge service={item.service} />
			<StatusBadge status="warning">
				<User className="h-2.5 w-2.5 mr-0.5" />
				{incognitoMode ? getLinuxUsername(item.requestedBy) : item.requestedBy}
			</StatusBadge>
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
