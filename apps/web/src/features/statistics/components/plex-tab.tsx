"use client";

import { Activity, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
	useLastWatched as _useLastWatched,
	useMostConcurrent as _useMostConcurrent,
	usePlaysByDate as _usePlaysByDate,
	useBandwidthAnalytics,
	useBandwidthForecast,
	useCodecAnalytics,
	useDeviceAnalytics,
	usePopularMedia,
	useQualityScore,
	useTopMedia,
	useTranscodeAnalytics,
	useUserAnalytics,
	useWatchHistory,
} from "../../../hooks/api/usePlex";
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

// Phase A3/A4/A5 hooks aren't yet consumed visibly here — the WatchHistoryWidget
// covers last-watched, BandwidthChart covers most-concurrent's peak, and
// plays-by-date isn't surfaced in this tab today. They're imported so the
// hooks stay registered as call sites for future enrichment without churn.
void _useLastWatched;
void _useMostConcurrent;
void _usePlaysByDate;

export const PlexTab = () => {
	const [timeRange, setTimeRange] = useState<number>(30);
	const { gradient } = useThemeGradient();

	// Session-snapshot analytics — Plex instances write to SessionSnapshot
	// (Tautulli removed in 3.0 — ADR-0007). These hooks share aggregation
	// logic with the Jellyfin tab via routes/plex/lib/*-helpers.ts.
	const transcodeQuery = useTranscodeAnalytics(timeRange);
	const bandwidthQuery = useBandwidthAnalytics(timeRange);
	const userAnalyticsQuery = useUserAnalytics(timeRange);
	const watchHistoryQuery = useWatchHistory(timeRange, 20);
	const codecQuery = useCodecAnalytics(timeRange);
	const deviceQuery = useDeviceAnalytics(timeRange);
	const qualityQuery = useQualityScore(timeRange);
	const forecastQuery = useBandwidthForecast(timeRange);
	const topMoviesQuery = useTopMedia("movie", timeRange);
	const topShowsQuery = useTopMedia("series", timeRange);
	const topMusicQuery = useTopMedia("music", timeRange);
	const popularMoviesQuery = usePopularMedia("movie", timeRange);
	const popularShowsQuery = usePopularMedia("series", timeRange);
	const popularMusicQuery = usePopularMedia("music", timeRange);

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

			{/* Source banner — explain data origin */}
			<div className="rounded-xl border border-border/30 bg-card/30 p-4 flex items-start gap-3">
				<Activity className="h-4 w-4 mt-0.5 shrink-0" style={{ color: gradient.from }} />
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						Statistics are captured from Plex session snapshots taken every 5 minutes while streams
						are active. Data accumulates over time as users watch.
					</p>
				</div>
			</div>

			{/* Top Media Leaderboards (SessionSnapshot-derived) */}
			<TopMediaChart
				data={topMoviesQuery.data}
				isLoading={topMoviesQuery.isLoading}
				isError={topMoviesQuery.isError}
				mediaType="movie"
				service="plex"
			/>
			<TopMediaChart
				data={topShowsQuery.data}
				isLoading={topShowsQuery.isLoading}
				isError={topShowsQuery.isError}
				mediaType="series"
				service="plex"
			/>
			<TopMediaChart
				data={topMusicQuery.data}
				isLoading={topMusicQuery.isLoading}
				isError={topMusicQuery.isError}
				mediaType="music"
				service="plex"
			/>

			{/* Popular Media (sorted by distinct watcher count) */}
			<TopMediaChart
				data={popularMoviesQuery.data}
				isLoading={popularMoviesQuery.isLoading}
				isError={popularMoviesQuery.isError}
				mediaType="movie"
				metric="popularity"
				service="plex"
			/>
			<TopMediaChart
				data={popularShowsQuery.data}
				isLoading={popularShowsQuery.isLoading}
				isError={popularShowsQuery.isError}
				mediaType="series"
				metric="popularity"
				service="plex"
			/>
			<TopMediaChart
				data={popularMusicQuery.data}
				isLoading={popularMusicQuery.isLoading}
				isError={popularMusicQuery.isError}
				mediaType="music"
				metric="popularity"
				service="plex"
			/>

			{/* Session Snapshot Analytics */}
			<TranscodeChart
				data={transcodeQuery.data}
				isLoading={transcodeQuery.isLoading}
				isError={transcodeQuery.isError}
				service="plex"
			/>
			<BandwidthChart
				data={bandwidthQuery.data}
				isLoading={bandwidthQuery.isLoading}
				isError={bandwidthQuery.isError}
				service="plex"
			/>

			{/* Tier 1: User Analytics + Watch History */}
			<UserAnalyticsChart
				data={userAnalyticsQuery.data}
				isLoading={userAnalyticsQuery.isLoading}
				isError={userAnalyticsQuery.isError}
				service="plex"
			/>
			<WatchHistoryWidget
				data={watchHistoryQuery.data}
				isLoading={watchHistoryQuery.isLoading}
				isError={watchHistoryQuery.isError}
				service="plex"
			/>

			{/* Tier 1/2: Codec + Device Analytics */}
			<div className="grid gap-6 md:grid-cols-2">
				<CodecChart
					data={codecQuery.data}
					isLoading={codecQuery.isLoading}
					isError={codecQuery.isError}
					service="plex"
				/>
				<DeviceChart
					data={deviceQuery.data}
					isLoading={deviceQuery.isLoading}
					isError={deviceQuery.isError}
					service="plex"
				/>
			</div>

			{/* Tier 3: Quality Score + Forecast */}
			<QualityScoreChart
				data={qualityQuery.data}
				isLoading={qualityQuery.isLoading}
				isError={qualityQuery.isError}
				service="plex"
			/>
			<ForecastChart
				data={forecastQuery.data}
				isLoading={forecastQuery.isLoading}
				isError={forecastQuery.isError}
				service="plex"
			/>
		</div>
	);
};
