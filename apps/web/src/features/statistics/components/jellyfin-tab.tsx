"use client";

import { Activity, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useMediaAnalyticsReport } from "../../../hooks/api/useMediaAnalyticsReport";
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

export const JellyfinTab = () => {
	const [timeRange, setTimeRange] = useState<number>(30);
	const { gradient } = useThemeGradient();

	const reportQuery = useMediaAnalyticsReport("jellyfin", timeRange);
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

			{/* Source banner — explain that data is captured from active sessions */}
			<div className="rounded-xl border border-border/30 bg-card/30 p-4 flex items-start gap-3">
				<Activity className="h-4 w-4 mt-0.5 shrink-0" style={{ color: gradient.from }} />
				<p className="text-xs text-muted-foreground">
					Statistics are captured from Jellyfin/Emby session snapshots taken every 5 minutes while
					streams are active. Data accumulates over time as users watch.
				</p>
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

			{/* Top Media Leaderboards (replaces Tautulli home-stats) */}
			<TopMediaChart
				data={report?.topMedia.movie}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="movie"
				service="jellyfin"
			/>
			<TopMediaChart
				data={report?.topMedia.series}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="series"
				service="jellyfin"
			/>
			<TopMediaChart
				data={report?.topMedia.music}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="music"
				service="jellyfin"
			/>

			{/* Popular Media (sorted by distinct watcher count) */}
			<TopMediaChart
				data={report?.popularMedia.movie}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="movie"
				metric="popularity"
				service="jellyfin"
			/>
			<TopMediaChart
				data={report?.popularMedia.series}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="series"
				metric="popularity"
				service="jellyfin"
			/>
			<TopMediaChart
				data={report?.popularMedia.music}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				mediaType="music"
				metric="popularity"
				service="jellyfin"
			/>

			{/* Session Snapshot Analytics */}
			<TranscodeChart
				data={report?.transcode}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>
			<BandwidthChart
				data={report?.bandwidth}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>

			{/* Tier 1: User Analytics + Watch History */}
			<UserAnalyticsChart
				data={report?.userAnalytics}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>
			<WatchHistoryWidget
				data={report?.watchHistory}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>

			{/* Tier 1/2: Codec + Device Analytics */}
			<div className="grid gap-6 md:grid-cols-2">
				<CodecChart
					data={report?.codec}
					isLoading={reportQuery.isLoading}
					isError={isUnavailable}
					service="jellyfin"
				/>
				<DeviceChart
					data={report?.devices}
					isLoading={reportQuery.isLoading}
					isError={isUnavailable}
					service="jellyfin"
				/>
			</div>

			{/* Tier 3: Quality Score + Forecast */}
			<QualityScoreChart
				data={report?.qualityScore}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>
			<ForecastChart
				data={report?.forecast}
				isLoading={reportQuery.isLoading}
				isError={isUnavailable}
				service="jellyfin"
			/>
		</div>
	);
};
