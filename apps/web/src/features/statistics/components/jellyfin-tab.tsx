"use client";

import { Activity, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
	useJellyfinBandwidthAnalytics,
	useJellyfinBandwidthForecast,
	useJellyfinCodecAnalytics,
	useJellyfinDeviceAnalytics,
	useJellyfinPopularMedia,
	useJellyfinQualityScore,
	useJellyfinTopMedia,
	useJellyfinTranscodeAnalytics,
	useJellyfinUserAnalytics,
	useJellyfinWatchHistory,
} from "../../../hooks/api/useJellyfin";
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

	// Session-snapshot analytics — Jellyfin/Emby instances write to the same
	// SessionSnapshot table as Plex (see session-snapshot-scheduler.ts), so
	// the analytics endpoints share aggregation logic with the Plex routes.
	const transcodeQuery = useJellyfinTranscodeAnalytics(timeRange);
	const bandwidthQuery = useJellyfinBandwidthAnalytics(timeRange);
	const userAnalyticsQuery = useJellyfinUserAnalytics(timeRange);
	const watchHistoryQuery = useJellyfinWatchHistory(timeRange, 20);
	const codecQuery = useJellyfinCodecAnalytics(timeRange);
	const deviceQuery = useJellyfinDeviceAnalytics(timeRange);
	const qualityQuery = useJellyfinQualityScore(timeRange);
	const forecastQuery = useJellyfinBandwidthForecast(timeRange);
	const topMoviesQuery = useJellyfinTopMedia("movie", timeRange);
	const topShowsQuery = useJellyfinTopMedia("series", timeRange);
	const topMusicQuery = useJellyfinTopMedia("music", timeRange);
	const popularMoviesQuery = useJellyfinPopularMedia("movie", timeRange);
	const popularShowsQuery = useJellyfinPopularMedia("series", timeRange);
	const popularMusicQuery = useJellyfinPopularMedia("music", timeRange);

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

			{/* Top Media Leaderboards (SessionSnapshot-derived) */}
			<TopMediaChart
				data={topMoviesQuery.data}
				isLoading={topMoviesQuery.isLoading}
				isError={topMoviesQuery.isError}
				mediaType="movie"
				service="jellyfin"
			/>
			<TopMediaChart
				data={topShowsQuery.data}
				isLoading={topShowsQuery.isLoading}
				isError={topShowsQuery.isError}
				mediaType="series"
				service="jellyfin"
			/>
			<TopMediaChart
				data={topMusicQuery.data}
				isLoading={topMusicQuery.isLoading}
				isError={topMusicQuery.isError}
				mediaType="music"
				service="jellyfin"
			/>

			{/* Popular Media (sorted by distinct watcher count) */}
			<TopMediaChart
				data={popularMoviesQuery.data}
				isLoading={popularMoviesQuery.isLoading}
				isError={popularMoviesQuery.isError}
				mediaType="movie"
				metric="popularity"
				service="jellyfin"
			/>
			<TopMediaChart
				data={popularShowsQuery.data}
				isLoading={popularShowsQuery.isLoading}
				isError={popularShowsQuery.isError}
				mediaType="series"
				metric="popularity"
				service="jellyfin"
			/>
			<TopMediaChart
				data={popularMusicQuery.data}
				isLoading={popularMusicQuery.isLoading}
				isError={popularMusicQuery.isError}
				mediaType="music"
				metric="popularity"
				service="jellyfin"
			/>

			{/* Session Snapshot Analytics */}
			<TranscodeChart
				data={transcodeQuery.data}
				isLoading={transcodeQuery.isLoading}
				isError={transcodeQuery.isError}
				service="jellyfin"
			/>
			<BandwidthChart
				data={bandwidthQuery.data}
				isLoading={bandwidthQuery.isLoading}
				isError={bandwidthQuery.isError}
				service="jellyfin"
			/>

			{/* Tier 1: User Analytics + Watch History */}
			<UserAnalyticsChart
				data={userAnalyticsQuery.data}
				isLoading={userAnalyticsQuery.isLoading}
				isError={userAnalyticsQuery.isError}
				service="jellyfin"
			/>
			<WatchHistoryWidget
				data={watchHistoryQuery.data}
				isLoading={watchHistoryQuery.isLoading}
				isError={watchHistoryQuery.isError}
				service="jellyfin"
			/>

			{/* Tier 1/2: Codec + Device Analytics */}
			<div className="grid gap-6 md:grid-cols-2">
				<CodecChart
					data={codecQuery.data}
					isLoading={codecQuery.isLoading}
					isError={codecQuery.isError}
					service="jellyfin"
				/>
				<DeviceChart
					data={deviceQuery.data}
					isLoading={deviceQuery.isLoading}
					isError={deviceQuery.isError}
					service="jellyfin"
				/>
			</div>

			{/* Tier 3: Quality Score + Forecast */}
			<QualityScoreChart
				data={qualityQuery.data}
				isLoading={qualityQuery.isLoading}
				isError={qualityQuery.isError}
				service="jellyfin"
			/>
			<ForecastChart
				data={forecastQuery.data}
				isLoading={forecastQuery.isLoading}
				isError={forecastQuery.isError}
				service="jellyfin"
			/>
		</div>
	);
};
