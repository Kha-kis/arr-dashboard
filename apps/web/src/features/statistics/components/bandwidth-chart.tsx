"use client";

import type { BandwidthAnalytics } from "@arr/shared";
import { Activity, ArrowUpDown, Users, Wifi } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { formatBandwidth, MiniStatCard, Sparkline } from "./chart-primitives";
import { hasMixedCollectionSamples } from "./collection-coverage";

// ============================================================================
// Bandwidth Chart Section
// ============================================================================

interface BandwidthChartProps {
	data: BandwidthAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const BandwidthChart = ({
	data,
	isLoading,
	isError,
	service = "plex",
}: BandwidthChartProps) => {
	const { gradient } = useThemeGradient();
	const serviceColor = SERVICE_GRADIENTS[service].from;
	const serviceLabel = service === "jellyfin" ? "Jellyfin" : "Plex";

	const chartDays = useMemo(() => {
		const days: Array<{ date: string; bandwidth: number | null; concurrent: number | null }> = [];
		for (const point of data?.timeSeries ?? []) {
			const previous = days[days.length - 1];
			if (previous) {
				const previousTime = Date.parse(previous.date);
				const gapDays = Math.floor((Date.parse(point.date) - previousTime) / 86_400_000);
				// The supported query window is at most 90 days. Missing days are
				// unknown, including days containing only idle/failure markers.
				for (let gap = 1; gap < gapDays && gap <= 90; gap++) {
					days.push({
						date: new Date(previousTime + gap * 86_400_000).toISOString().slice(0, 10),
						bandwidth: null,
						concurrent: null,
					});
				}
			}
			days.push(point);
		}
		return days;
	}, [data]);
	const bandwidthSeries = chartDays.map((day) => day.bandwidth);
	const concurrentSeries = chartDays.map((day) => day.concurrent);

	if (isLoading && !data) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
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

	if (isError && !data) {
		return (
			<PremiumEmptyState
				icon={Wifi}
				title="Failed to Load Bandwidth Data"
				description={`Could not fetch bandwidth analytics. Check your ${serviceLabel} connection and try again.`}
			/>
		);
	}

	if (!data) {
		return (
			<PremiumEmptyState
				icon={Wifi}
				title="No Bandwidth Data Yet"
				description="Bandwidth snapshots are recorded every 5 minutes during active streams. Data will appear here once sessions are captured."
			/>
		);
	}

	const dates = chartDays.map((d) => d.date);
	const measurement = data.measurement?.version === 1 ? data.measurement : undefined;
	const collection = measurement?.collection;
	const noActiveObservations = measurement?.observedSnapshots === 0;
	const collectionState = noActiveObservations
		? measurement.configuredSources === 0
			? `No configured ${serviceLabel} sources. Check Settings to configure a connection.`
			: hasMixedCollectionSamples(collection)
				? "Some samples failed. The available samples contain no active-stream bandwidth measurements."
				: collection && collection.failedSnapshots > 0
					? "Collection failed in this window. Check source settings and retry collection."
					: collection && collection.invalidSnapshots > 0
						? "Collection evidence is invalid in this window. Check source settings."
						: collection && collection.idleSnapshots > 0
							? "Successful idle observations recorded; no active-stream bandwidth average is available."
							: "No observations recorded in this window. Check source settings and the collection scheduler."
		: null;
	const basis =
		measurement?.bandwidthBasis === "encoding-estimate"
			? "Encoding estimate, not measured network traffic."
			: measurement?.bandwidthBasis === "provider-reported"
				? "Provider-reported bandwidth."
				: measurement?.bandwidthBasis === "mixed"
					? "Mixed measurement bases cannot be combined into one bandwidth rate."
					: "No native bandwidth basis available.";
	const rate = (value: number | null) => (value === null ? "Unknown" : formatBandwidth(value));

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Wifi className="h-4 w-4" style={{ color: gradient.from }} />
				Bandwidth &amp; Concurrency
			</h3>
			{isError && (
				<p role="status" className="text-xs text-warning">
					Last-known historical data retained; refresh failed. Check the connection and try again.
				</p>
			)}
			<div className="text-xs text-muted-foreground space-y-1">
				{measurement ? (
					<>
						<p>{basis}</p>
						<p>
							{measurement.measuredSessions} of {measurement.observedSessions} session observations
							have known rates; {measurement.measuredSnapshots} of {measurement.observedSnapshots}
							active snapshots contribute to the average.
							{measurement.status === "partial" &&
								" Values are known subtotals, not complete totals."}
						</p>
						{collection && (
							<p>
								Collection: {collection.failedSnapshots} failed, {collection.legacySnapshots}{" "}
								legacy/unverified,
								{collection.invalidSnapshots} invalid, {collection.idleSnapshots} idle observations.
							</p>
						)}
						{collectionState && <p role="status">{collectionState}</p>}
						{!collectionState && measurement.status === "unavailable" && (
							<p>
								Bandwidth measurements are unavailable. Check source settings; observed activity is
								retained.
							</p>
						)}
					</>
				) : (
					<p>Legacy/unverified measurements: this response has no measurement coverage evidence.</p>
				)}
				<p>
					Five-minute activity samples, not continuous playback history. Gaps are unknown, not zero.
				</p>
				<p>Peaks and averages are per-source snapshots, not a simultaneous total across servers.</p>
				<p>LAN/WAN attribution is unavailable without native network evidence.</p>
			</div>

			{/* Stat cards */}
			<div className="grid gap-4 md:grid-cols-3">
				<MiniStatCard
					icon={Users}
					label="Peak Observed Concurrent"
					value={data.peakConcurrent ?? "Unknown"}
					color={gradient.from}
				/>
				<MiniStatCard
					icon={ArrowUpDown}
					label="Peak Known Bandwidth"
					value={rate(data.peakBandwidth)}
					color={serviceColor}
				/>
				<MiniStatCard
					icon={Activity}
					label="Avg Known Bandwidth"
					value={rate(data.avgBandwidth)}
					color={gradient.to}
				/>
			</div>

			{/* Bandwidth sparkline */}
			{bandwidthSeries.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Average Known Bandwidth (per day)</h4>
					<div className="flex justify-center">
						<Sparkline
							data={bandwidthSeries}
							label="Average known bandwidth per day"
							width={600}
							height={60}
							color={serviceColor}
							fillColor={serviceColor}
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

			{/* Concurrent streams sparkline */}
			{concurrentSeries.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Peak Concurrent Streams (per day)</h4>
					<div className="flex justify-center">
						<Sparkline
							data={concurrentSeries}
							label="Peak observed concurrent streams per day"
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
