"use client";

import { Lightbulb } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useDiskWasteInsights } from "../../../hooks/api/useDiskWasteInsights";
import { useRequestedUnwatchedInsights } from "../../../hooks/api/useRequestedUnwatchedInsights";
import { useWatchedMonitoredInsights } from "../../../hooks/api/useWatchedMonitoredInsights";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useInsightDismissals } from "../hooks/use-insight-dismissals";
import { DiskWastePanel } from "./disk-waste-panel";
import { RequestedUnwatchedPanel } from "./requested-unwatched-panel";
import { WatchedMonitoredPanel } from "./watched-monitored-panel";

/**
 * Library Insights Section
 *
 * Groups advisory insight panels under a shared heading.
 * Auto-hides entirely when no panels have content to show.
 */
export function LibraryInsightsSection() {
	const searchParams = useSearchParams();
	const insightParam = searchParams.get("insight");
	const { isDismissed, dismiss } = useInsightDismissals();

	// Check if any panel has data — used to control section visibility
	const diskWaste = useDiskWasteInsights({ minSizeGb: 1, minAgeDays: 30, limit: 25 });
	const watchedMonitored = useWatchedMonitoredInsights({ limit: 25 });
	const requestedUnwatched = useRequestedUnwatchedInsights({ minAgeDays: 7, limit: 25 });

	const diskWasteCount = diskWaste.data?.data?.items?.length ?? 0;
	const watchedMonitoredCount = watchedMonitored.data?.data?.items?.length ?? 0;
	const requestedUnwatchedCount = requestedUnwatched.data?.data?.items?.length ?? 0;
	const hasPlexData = watchedMonitored.data?.data?.hasPlexData ?? false;
	const hasSeerrData = requestedUnwatched.data?.data?.hasSeerrData ?? false;
	const hasRequestedPlexData = requestedUnwatched.data?.data?.hasPlexData ?? false;
	const isLoading = diskWaste.isLoading || watchedMonitored.isLoading || requestedUnwatched.isLoading;

	// Don't render the section if all panels are empty and done loading
	const hasContent =
		diskWasteCount > 0 ||
		(watchedMonitoredCount > 0 && hasPlexData) ||
		(requestedUnwatchedCount > 0 && hasSeerrData && hasRequestedPlexData);
	if (!isLoading && !hasContent) return null;
	if (isLoading) return null; // Don't flash the heading before data arrives

	// Effective counts — only count signals where the required services are configured
	const effectiveWatchedCount = hasPlexData ? watchedMonitoredCount : 0;
	const effectiveRequestedCount = hasSeerrData && hasRequestedPlexData ? requestedUnwatchedCount : 0;
	const totalCount = diskWasteCount + effectiveWatchedCount + effectiveRequestedCount;

	// Build breakdown segments (only non-zero)
	const segments: string[] = [];
	if (diskWasteCount > 0) segments.push(`${diskWasteCount} storage`);
	if (effectiveWatchedCount > 0) segments.push(`${effectiveWatchedCount} monitoring`);
	if (effectiveRequestedCount > 0) segments.push(`${effectiveRequestedCount} requests`);

	// Priority: requested-unwatched > watched-monitored > disk-waste
	// Only show cue when multiple signal types are active
	let priorityCue: string | null = null;
	if (segments.length > 1) {
		if (effectiveRequestedCount > 0) {
			priorityCue = "Start with requested items — someone is waiting";
		} else if (effectiveWatchedCount > 0) {
			priorityCue = "Start with watched items — reduce unnecessary searches";
		}
	}

	return (
		<div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
			{/* Section heading with summary */}
			<div className="flex items-center gap-2 flex-wrap">
				<Lightbulb className="h-4 w-4" style={{ color: SEMANTIC_COLORS.info.from }} />
				<h2 className="text-sm font-semibold text-foreground">Library Insights</h2>
				<span className="text-xs text-muted-foreground">
					{totalCount} item{totalCount !== 1 ? "s" : ""} need attention
				</span>
				{segments.length > 1 && (
					<span className="text-xs text-muted-foreground/60">
						— {segments.join(" · ")}
					</span>
				)}
			</div>
			{priorityCue && (
				<p className="text-xs text-muted-foreground/70 -mt-1 ml-6 italic">{priorityCue}</p>
			)}

			{/* Panels — ordered by priority: requests > monitoring > storage */}
			<div className="space-y-2">
				<RequestedUnwatchedPanel autoExpand={insightParam === "requested-unwatched"} isDismissed={isDismissed} onDismiss={dismiss} />
				<WatchedMonitoredPanel autoExpand={insightParam === "watched-monitored"} isDismissed={isDismissed} onDismiss={dismiss} />
				<DiskWastePanel autoExpand={insightParam === "disk-waste"} isDismissed={isDismissed} onDismiss={dismiss} />
			</div>
		</div>
	);
}
