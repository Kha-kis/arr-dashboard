"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useBandwidthAnalytics } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Activity, ArrowUpDown, Users, Wifi } from "lucide-react";
import { Sparkline, MiniStatCard, formatBandwidth } from "./chart-primitives";

// LAN/WAN colors — Tautulli-enriched data distinction
const LAN_COLOR = SEMANTIC_COLORS.success.from;
const WAN_COLOR = SEMANTIC_COLORS.info.from;

// ============================================================================
// Bandwidth Chart Section
// ============================================================================

interface BandwidthChartProps {
	days: number;
	enabled: boolean;
}

export const BandwidthChart = ({ days, enabled }: BandwidthChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useBandwidthAnalytics(days, enabled);

	const bandwidthSeries = useMemo(() => data?.timeSeries.map((d) => d.bandwidth) ?? [], [data]);

	const concurrentSeries = useMemo(() => data?.timeSeries.map((d) => d.concurrent) ?? [], [data]);

	const hasLanWan = useMemo(
		() => data?.timeSeries.some((d) => d.lanBandwidth > 0 || d.wanBandwidth > 0) ?? false,
		[data],
	);

	const lanSeries = useMemo(
		() => (hasLanWan ? (data?.timeSeries.map((d) => d.lanBandwidth) ?? []) : []),
		[data, hasLanWan],
	);

	const wanSeries = useMemo(
		() => (hasLanWan ? (data?.timeSeries.map((d) => d.wanBandwidth) ?? []) : []),
		[data, hasLanWan],
	);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="grid gap-4 md:grid-cols-3 mb-4">
					{[0, 1, 2].map((i) => (
						<PremiumSkeleton
							key={i}
							variant="line"
							className="h-20"
							style={{ animationDelay: `${i * 50}ms` }}
						/>
					))}
				</div>
				<PremiumSkeleton variant="line" className="h-[60px] w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Wifi}
				title="Failed to Load Bandwidth Data"
				description="Could not fetch bandwidth analytics. Check your Plex connection and try again."
			/>
		);
	}

	if (!data || (data.peakConcurrent === 0 && data.peakBandwidth === 0)) {
		return (
			<PremiumEmptyState
				icon={Wifi}
				title="No Bandwidth Data Yet"
				description="Bandwidth snapshots are recorded every 5 minutes during active streams. Data will appear here once sessions are captured."
			/>
		);
	}

	const dates = data.timeSeries.map((d) => d.date);

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Wifi className="h-4 w-4" style={{ color: gradient.from }} />
				Bandwidth &amp; Concurrency
			</h3>

			{/* Stat cards */}
			<div className="grid gap-4 md:grid-cols-3">
				<MiniStatCard
					icon={Users}
					label="Peak Concurrent"
					value={data.peakConcurrent}
					color={gradient.from}
				/>
				<MiniStatCard
					icon={ArrowUpDown}
					label="Peak Bandwidth"
					value={formatBandwidth(data.peakBandwidth)}
					color={SERVICE_GRADIENTS.plex.from}
				/>
				<MiniStatCard
					icon={Activity}
					label="Avg Bandwidth"
					value={formatBandwidth(data.avgBandwidth)}
					color={gradient.to}
				/>
			</div>

			{/* Bandwidth sparkline */}
			{bandwidthSeries.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Average Bandwidth (per day)</h4>
					<div className="flex justify-center">
						<Sparkline
							data={bandwidthSeries}
							width={600}
							height={60}
							color={SERVICE_GRADIENTS.plex.from}
							fillColor={SERVICE_GRADIENTS.plex.from}
						/>
					</div>
					{dates.length > 1 && (
						<div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-1">
							<span>{dates[0]}</span>
							<span>{dates[dates.length - 1]}</span>
						</div>
					)}
				</div>
			)}

			{/* LAN/WAN overlay when Tautulli data is available */}
			{hasLanWan && lanSeries.length > 1 && (
				<div className="grid gap-4 md:grid-cols-2">
					<div>
						<h4 className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
							<div className="h-2 w-2 rounded-full" style={{ backgroundColor: LAN_COLOR }} />
							LAN Bandwidth
						</h4>
						<Sparkline
							data={lanSeries}
							width={280}
							height={50}
							color={LAN_COLOR}
							fillColor={LAN_COLOR}
						/>
					</div>
					<div>
						<h4 className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
							<div className="h-2 w-2 rounded-full" style={{ backgroundColor: WAN_COLOR }} />
							WAN Bandwidth
						</h4>
						<Sparkline
							data={wanSeries}
							width={280}
							height={50}
							color={WAN_COLOR}
							fillColor={WAN_COLOR}
						/>
					</div>
				</div>
			)}

			{/* Concurrent streams sparkline */}
			{concurrentSeries.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Peak Concurrent Streams (per day)</h4>
					<div className="flex justify-center">
						<Sparkline
							data={concurrentSeries}
							width={600}
							height={60}
							color={gradient.from}
							fillColor={gradient.from}
						/>
					</div>
					{dates.length > 1 && (
						<div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-1">
							<span>{dates[0]}</span>
							<span>{dates[dates.length - 1]}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
