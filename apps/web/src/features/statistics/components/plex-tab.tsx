"use client";

import { Activity, Info, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { useMediaAnalyticsReport } from "../../../hooks/api/useMediaAnalyticsReport";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { BandwidthChart } from "./bandwidth-chart";
import { CodecChart } from "./codec-chart";
import { DeviceChart } from "./device-chart";
import { ForecastChart } from "./forecast-chart";
import { QualityScoreChart } from "./quality-score-chart";
import { TopMediaChart } from "./top-media-chart";
import { TranscodeChart } from "./transcode-chart";
import { UserAnalyticsChart } from "./user-analytics-chart";
import { WatchHistoryWidget } from "./watch-history-widget";

const TIME_RANGES = [7, 14, 30] as const;

export const PlexTab = () => {
	const [timeRange, setTimeRange] = useState<number>(30);
	const { gradient } = useThemeGradient();

	// Detect Tautulli presence so we can surface enrichment status. Tautulli
	// is no longer required for analytics — it's an optional enrichment source
	// that adds richer codec/LAN-WAN/platform metadata when configured.
	const { data: services = [] } = useServicesQuery();
	const hasTautulli = useMemo(
		() => services.some((s) => s.service.toLowerCase() === "tautulli" && s.enabled),
		[services],
	);

	const reportQuery = useMediaAnalyticsReport("plex", timeRange);
	const report = reportQuery.data;
	const isUnavailable = reportQuery.isError && !report;
	const canRetry =
		reportQuery.isError ||
		(reportQuery.isFetching && reportQuery.errorUpdatedAt > reportQuery.dataUpdatedAt);

	return (
		<div className="space-y-6 animate-in fade-in duration-300">
			{/* Time Range Selector */}
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold flex items-center gap-2">
					<TrendingUp className="h-5 w-5" style={{ color: gradient.from }} />
					Watch Statistics
				</h2>
				<div className="inline-flex rounded-lg bg-muted/30 border border-border/50 p-1">
					{TIME_RANGES.map((range) => (
						<button
							key={range}
							type="button"
							onClick={() => setTimeRange(range)}
							className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
								timeRange === range
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{range}d
						</button>
					))}
				</div>
			</div>

			{/* Source banner — explain data origin and call out Tautulli enrichment when present */}
			<div className="rounded-xl border border-border/30 bg-card/30 p-4 flex items-start gap-3">
				<Activity className="h-4 w-4 mt-0.5 shrink-0" style={{ color: gradient.from }} />
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						Statistics are captured from Plex session snapshots taken every 5 minutes while streams
						are active. Data accumulates over time as users watch.
					</p>
					{hasTautulli && (
						<p className="text-xs text-muted-foreground flex items-center gap-1.5">
							<Info className="h-3 w-3 shrink-0" style={{ color: gradient.from }} />
							<span>
								Tautulli is configured as optional enrichment. When verified observations are
								available, they can add codec, LAN/WAN bandwidth, and platform metadata to captured
								sessions.
							</span>
						</p>
					)}
				</div>
			</div>

			{report && (reportQuery.isFetching || reportQuery.isError) && (
				<p
					role="status"
					className="rounded-xl border border-border/30 bg-card/30 p-4 text-xs text-muted-foreground"
				>
					{reportQuery.isFetching
						? "Showing last-known Statistics report while updating."
						: "Showing last-known Statistics report; refresh failed."}
				</p>
			)}
			{!report && canRetry && (
				<p
					role="alert"
					className="rounded-xl border border-border/30 bg-card/30 p-4 text-xs text-muted-foreground"
				>
					Statistics report unavailable.
				</p>
			)}
			{canRetry && (
				<button
					type="button"
					onClick={() => void reportQuery.refetch()}
					disabled={reportQuery.isFetching}
					className="rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/30 disabled:cursor-wait disabled:opacity-50"
				>
					Retry report
				</button>
			)}

			{/* Top Media Leaderboards (replaces Tautulli home-stats top_*) */}
			<TopMediaChart
				data={report?.topMedia.movie}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="movie"
				service="plex"
			/>
			<TopMediaChart
				data={report?.topMedia.series}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="series"
				service="plex"
			/>
			<TopMediaChart
				data={report?.topMedia.music}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="music"
				service="plex"
			/>

			{/* Popular Media (sorted by distinct watcher count) */}
			<TopMediaChart
				data={report?.popularMedia.movie}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="movie"
				metric="popularity"
				service="plex"
			/>
			<TopMediaChart
				data={report?.popularMedia.series}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="series"
				metric="popularity"
				service="plex"
			/>
			<TopMediaChart
				data={report?.popularMedia.music}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="music"
				metric="popularity"
				service="plex"
			/>

			{/* Session Snapshot Analytics */}
			<TranscodeChart
				data={report?.transcode}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>
			<BandwidthChart
				data={report?.bandwidth}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>

			{/* Tier 1: User Analytics + Watch History */}
			<UserAnalyticsChart
				data={report?.userAnalytics}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>
			<WatchHistoryWidget
				data={report?.watchHistory}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>

			{/* Tier 1/2: Codec + Device Analytics */}
			<div className="grid gap-6 md:grid-cols-2">
				<CodecChart
					data={report?.codec}
					isLoading={reportQuery.isLoading}
					isError={isUnavailable}
					service="plex"
				/>
				<DeviceChart
					data={report?.devices}
					isLoading={reportQuery.isLoading}
					isError={isUnavailable}
					service="plex"
				/>
			</div>

			{/* Tier 3: Quality Score + Forecast */}
			<QualityScoreChart
				data={report?.qualityScore}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>
			<ForecastChart
				data={report?.forecast}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="plex"
			/>
		</div>
	);
};
