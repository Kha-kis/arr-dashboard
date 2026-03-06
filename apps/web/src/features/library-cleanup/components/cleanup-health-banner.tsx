"use client";

import type { CleanupStatusResponse, PrefetchSourceStatus } from "@arr/shared";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock } from "lucide-react";

interface CleanupHealthBannerProps {
	status: CleanupStatusResponse;
}

function sourceLabel(source: string): string {
	switch (source) {
		case "seerr": return "Seerr";
		case "tautulli": return "Tautulli";
		case "plex": return "Plex";
		default: return source;
	}
}

function sourceStatusIcon(status: PrefetchSourceStatus) {
	switch (status) {
		case "ok":
			return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
		case "failed":
			return <AlertCircle className="h-3.5 w-3.5 text-red-400" />;
		case "skipped":
			return <span className="h-3.5 w-3.5 rounded-full border border-border/50 inline-block" />;
	}
}

export function CleanupHealthBanner({ status }: CleanupHealthBannerProps) {
	const isError = status.lastResult === "error";
	const isPartial = status.lastResult === "partial";
	const isHealthy = status.lastResult === "completed";

	if (!status.enabled && !status.lastResult) return null;

	const bgClass = isError
		? "bg-red-500/10 border-red-500/20"
		: isPartial
			? "bg-amber-500/10 border-amber-500/20"
			: "bg-emerald-500/10 border-emerald-500/20";

	const textClass = isError
		? "text-red-400"
		: isPartial
			? "text-amber-400"
			: "text-emerald-400";

	return (
		<div className={`rounded-lg border px-4 py-3 ${bgClass}`}>
			<div className="flex items-start gap-3">
				{isError ? (
					<AlertCircle className={`h-5 w-5 mt-0.5 shrink-0 ${textClass}`} />
				) : isPartial ? (
					<AlertTriangle className={`h-5 w-5 mt-0.5 shrink-0 ${textClass}`} />
				) : (
					<CheckCircle2 className={`h-5 w-5 mt-0.5 shrink-0 ${textClass}`} />
				)}

				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className={`text-sm font-medium ${textClass}`}>
							{isError ? "Last run failed" : isPartial ? "Last run completed with warnings" : "Last run successful"}
						</span>
						{!status.enabled && (
							<span className="text-xs px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">
								Scheduler disabled
							</span>
						)}
					</div>

					{status.lastErrorMessage && (
						<p className="text-xs text-red-400/80 mt-1">{status.lastErrorMessage}</p>
					)}

					<div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
						{status.lastRunAt && (
							<span className="flex items-center gap-1">
								<Clock className="h-3 w-3" />
								Last: {new Date(status.lastRunAt).toLocaleString()}
							</span>
						)}
						{status.nextRunAt && status.enabled && (
							<span className="flex items-center gap-1">
								<Clock className="h-3 w-3" />
								Next: {new Date(status.nextRunAt).toLocaleString()}
							</span>
						)}
						{status.pendingApprovals > 0 && (
							<span className="text-amber-400">
								{status.pendingApprovals} pending approval{status.pendingApprovals > 1 ? "s" : ""}
							</span>
						)}
					</div>

					{/* Prefetch health indicators */}
					{status.prefetchHealth && (
						<div className="flex items-center gap-3 mt-2">
							<span className="text-xs text-muted-foreground">Data sources:</span>
							{(Object.entries(status.prefetchHealth) as Array<[string, PrefetchSourceStatus]>).map(([source, sourceStatus]) => (
								<span key={source} className="flex items-center gap-1 text-xs">
									{sourceStatusIcon(sourceStatus)}
									<span className={sourceStatus === "failed" ? "text-red-400" : "text-muted-foreground"}>
										{sourceLabel(source)}
									</span>
								</span>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
