"use client";

import { Lightbulb } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { PlexQueryEvidenceNotice } from "../../../components/presentational/plex-evidence-notice";
import {
	ProviderObservationNotice,
	resolveProviderObservationUiCondition,
} from "../../../components/presentational/provider-observation-notice";
import { useDiskWasteInsights } from "../../../hooks/api/useDiskWasteInsights";
import { useRequestedUnwatchedInsights } from "../../../hooks/api/useRequestedUnwatchedInsights";
import { useWatchedMonitoredInsights } from "../../../hooks/api/useWatchedMonitoredInsights";
import { isCurrentAuthoritativePlexEvidence } from "../../../lib/plex-evidence";
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
	const diskWasteUnknownCount = diskWaste.data?.data?.unknownItems?.length ?? 0;
	const watchedMonitoredCount = watchedMonitored.data?.data?.items?.length ?? 0;
	const requestedUnwatchedCount = requestedUnwatched.data?.data?.items?.length ?? 0;
	const requestedUnwatchedUnknownCount = requestedUnwatched.data?.data?.unknownItems?.length ?? 0;
	const statusHints = [
		diskWaste.data?.data?.limited
			? "Disk insight results are bounded; more candidates may need review."
			: null,
		diskWaste.data?.data?.watchStatus === "partial"
			? "Disk watch evidence is partial; the list may be incomplete."
			: diskWaste.data?.data?.watchStatus === "unavailable"
				? "Disk watch status is unavailable; candidates remain unconfirmed."
				: diskWaste.data?.data?.watchStatus === "not-configured"
					? "No media server is configured for disk watch status."
					: null,
		requestedUnwatched.data?.data?.limited
			? "Requested insight results are bounded; more candidates may need review."
			: null,
		requestedUnwatched.data?.data?.requestStatus === "partial"
			? "Request evidence is partial; the list may be incomplete."
			: requestedUnwatched.data?.data?.requestStatus === "unavailable"
				? "Request evidence is unavailable; requested candidates remain unconfirmed."
				: requestedUnwatched.data?.data?.requestStatus === "not-configured"
					? "Seerr is not configured for requested item evidence."
					: null,
		requestedUnwatched.data?.data?.watchStatus === "partial"
			? "Requested item watch evidence is partial; the list may be incomplete."
			: requestedUnwatched.data?.data?.watchStatus === "unavailable"
				? "Requested item watch status is unavailable; candidates remain unconfirmed."
				: requestedUnwatched.data?.data?.watchStatus === "not-configured"
					? "No media server is configured for requested item watch status."
					: null,
	].filter((hint): hint is string => hint !== null);
	const hasWatchData =
		watchedMonitored.data?.data?.hasWatchData ?? watchedMonitored.data?.data?.hasPlexData ?? false;
	const hasSeerrData = requestedUnwatched.data?.data?.hasSeerrData ?? false;
	const hasRequestedWatchData =
		requestedUnwatched.data?.data?.hasWatchData ??
		requestedUnwatched.data?.data?.hasPlexData ??
		false;
	const hasSettledQuery = [diskWaste, watchedMonitored, requestedUnwatched].some(
		(query) => query.data !== undefined || query.error != null || query.isError,
	);
	const evidenceError = diskWaste.error ?? watchedMonitored.error ?? requestedUnwatched.error;
	const watchedEvidence = watchedMonitored.data?.evidence;
	const hasPlexCoverageGap =
		watchedEvidence !== undefined && !isCurrentAuthoritativePlexEvidence(watchedEvidence);
	const hasEvidenceError = evidenceError != null || hasPlexCoverageGap;
	const providerStatus = [
		diskWaste.data?.providerStatus,
		watchedMonitored.data?.providerStatus,
		requestedUnwatched.data?.providerStatus,
	] as const;
	const providerCondition = resolveProviderObservationUiCondition(providerStatus);
	const hasNonCurrentProvider = providerCondition !== undefined && providerCondition !== "current";

	// Don't render the section if all panels are empty and done loading
	const hasContent =
		diskWasteCount > 0 ||
		(watchedMonitoredCount > 0 && hasWatchData) ||
		(requestedUnwatchedCount > 0 && hasSeerrData && hasRequestedWatchData);
	const unknownCount = diskWasteUnknownCount + requestedUnwatchedUnknownCount;
	if (
		hasSettledQuery &&
		!hasContent &&
		unknownCount === 0 &&
		statusHints.length === 0 &&
		!hasEvidenceError &&
		!hasNonCurrentProvider
	)
		return null;
	if (!hasSettledQuery) return null; // Don't flash the heading before any query settles

	// Effective counts — only count signals where the required services are configured
	const effectiveWatchedCount = hasWatchData ? watchedMonitoredCount : 0;
	const effectiveRequestedCount =
		hasSeerrData && hasRequestedWatchData ? requestedUnwatchedCount : 0;
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
				{!hasEvidenceError && hasContent && (
					<span className="text-xs text-muted-foreground">
						{totalCount} item{totalCount !== 1 ? "s" : ""} need attention
					</span>
				)}
				{unknownCount > 0 && (
					<span className="text-xs text-muted-foreground">
						{unknownCount} item{unknownCount !== 1 ? "s" : ""} need watch status
					</span>
				)}
				{segments.length > 1 && (
					<span className="text-xs text-muted-foreground/60">— {segments.join(" · ")}</span>
				)}
			</div>
			<PlexQueryEvidenceNotice
				error={evidenceError}
				evidence={evidenceError ? undefined : watchedEvidence}
				hasDisplayedValues={
					watchedMonitoredCount > 0 && watchedMonitored.data?.data.hasPlexData === true
				}
				label="Plex-based library insights"
			/>
			<ProviderObservationNotice providerStatus={providerStatus} label="Library insights" />
			{priorityCue && (
				<p className="text-xs text-muted-foreground/70 -mt-1 ml-6 italic">{priorityCue}</p>
			)}
			{statusHints.map((hint) => (
				<span key={hint} className="text-xs text-muted-foreground">
					{hint}
				</span>
			))}

			{/* Panels — ordered by priority: requests > monitoring > storage */}
			<div className="space-y-2">
				<RequestedUnwatchedPanel
					queryData={requestedUnwatched.data}
					autoExpand={insightParam === "requested-unwatched"}
					isDismissed={isDismissed}
					onDismiss={dismiss}
				/>
				<WatchedMonitoredPanel
					queryData={watchedMonitored.data}
					autoExpand={insightParam === "watched-monitored"}
					isDismissed={isDismissed}
					onDismiss={dismiss}
				/>
				<DiskWastePanel
					queryData={diskWaste.data}
					autoExpand={insightParam === "disk-waste"}
					isDismissed={isDismissed}
					onDismiss={dismiss}
				/>
			</div>
		</div>
	);
}
