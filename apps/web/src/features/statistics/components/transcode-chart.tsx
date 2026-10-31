"use client";

import type { TranscodeAnalytics } from "@arr/shared";
import { CircleHelp, Cpu, MonitorPlay, Play, Radio } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// ============================================================================
// Donut Chart Component
// ============================================================================

interface DonutSegment {
	label: string;
	value: number;
	color: string;
}

const DonutChart = ({ segments, size = 140 }: { segments: DonutSegment[]; size?: number }) => {
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	if (total === 0) return null;

	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 8;
	const strokeWidth = 20;

	let cumulativePercent = 0;
	const circumference = 2 * Math.PI * radius;

	return (
		<div className="relative inline-flex items-center justify-center">
			<svg
				width={size}
				height={size}
				className="-rotate-90"
				role="img"
				aria-label={`Video processing observations: ${segments.map((segment) => `${segment.value} ${segment.label.toLowerCase()}`).join(", ")}`}
			>
				{segments.map((seg) => {
					if (seg.value === 0) return null;
					const percent = seg.value / total;
					const offset = circumference * cumulativePercent;
					const dash = circumference * percent;
					cumulativePercent += percent;

					return (
						<circle
							key={seg.label}
							cx={cx}
							cy={cy}
							r={radius}
							fill="none"
							stroke={seg.color}
							strokeWidth={strokeWidth}
							strokeDasharray={`${dash} ${circumference - dash}`}
							strokeDashoffset={-offset}
							strokeLinecap="round"
							className="transition-all duration-500"
						/>
					);
				})}
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="text-2xl font-bold tabular-nums">{total.toLocaleString()}</span>
				<span className="text-[10px] text-muted-foreground">observations</span>
			</div>
		</div>
	);
};

// ============================================================================
// Stacked Bar Chart for daily breakdown
// ============================================================================

interface DailyBreakdown {
	date: string;
	directPlay: number;
	transcode: number;
	directStream: number;
	unknown: number;
	measurement?: TranscodeAnalytics["measurement"];
}

const StackedBarChart = ({
	data,
	colors,
}: {
	data: DailyBreakdown[];
	colors: { directPlay: string; transcode: string; directStream: string; unknown: string };
}) => {
	if (data.length === 0) return null;

	const maxTotal = Math.max(
		...data.map((d) => d.directPlay + d.transcode + d.directStream + d.unknown),
		1,
	);
	const barWidth = Math.max(4, Math.min(12, Math.floor(600 / data.length) - 2));

	return (
		<div
			className="w-full overflow-x-auto"
			role="img"
			aria-label="Daily video processing observations, including unknown decisions"
		>
			<div className="flex items-end gap-[2px] min-w-0" style={{ height: 100 }}>
				{data.map((day) => {
					const total = day.directPlay + day.transcode + day.directStream + day.unknown;
					const h = (total / maxTotal) * 100;
					const dpH = total > 0 ? (day.directPlay / total) * h : 0;
					const dsH = total > 0 ? (day.directStream / total) * h : 0;
					const tcH = total > 0 ? (day.transcode / total) * h : 0;
					const unknownH = total > 0 ? (day.unknown / total) * h : 0;

					return (
						<div
							key={day.date}
							className="flex flex-col justify-end group relative"
							style={{ width: barWidth, height: "100%" }}
							title={
								total > 0
									? `${day.date}: ${day.directPlay} DP / ${day.directStream} DS / ${day.transcode} TC / ${day.unknown} unknown`
									: day.measurement?.collection.failedSnapshots
										? `${day.date}: collection failed; no observed video decisions`
										: day.measurement?.collection.idleSnapshots
											? `${day.date}: successful idle; no active video decisions`
											: `${day.date}: no observations; not measured zero`
							}
						>
							{dpH > 0 && (
								<div
									className="rounded-t-sm transition-all duration-300"
									style={{ height: `${dpH}%`, backgroundColor: colors.directPlay }}
								/>
							)}
							{dsH > 0 && (
								<div
									className="transition-all duration-300"
									style={{ height: `${dsH}%`, backgroundColor: colors.directStream }}
								/>
							)}
							{tcH > 0 && (
								<div
									className="rounded-b-sm transition-all duration-300"
									style={{ height: `${tcH}%`, backgroundColor: colors.transcode }}
								/>
							)}
							{unknownH > 0 && (
								<div style={{ height: `${unknownH}%`, backgroundColor: colors.unknown }} />
							)}
						</div>
					);
				})}
			</div>
			{data.length > 1 && (
				<div className="flex justify-between text-[10px] text-muted-foreground mt-1">
					<span>{data[0]?.date}</span>
					<span>{data[data.length - 1]?.date}</span>
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Transcode Chart Section
// ============================================================================

interface TranscodeChartProps {
	data: TranscodeAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const TranscodeChart = ({
	data,
	isLoading,
	isError,
	service = "plex",
}: TranscodeChartProps) => {
	const { gradient } = useThemeGradient();
	const serviceLabel = service === "jellyfin" ? "Jellyfin" : "Plex";

	const colors = useMemo(
		() => ({
			directPlay: SEMANTIC_COLORS.success.text,
			transcode: SEMANTIC_COLORS.warning.text,
			directStream: SERVICE_GRADIENTS[service].from,
			unknown: "var(--muted-foreground)",
		}),
		[service],
	);

	if (isLoading && !data) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8 items-center">
					<PremiumSkeleton variant="line" className="h-[140px] w-[140px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[100px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError && !data) {
		return (
			<PremiumEmptyState
				icon={Cpu}
				title="Failed to Load Transcode Data"
				description={`Could not fetch transcode analytics. Check your ${serviceLabel} connection and try again.`}
			/>
		);
	}

	if (!data) {
		return (
			<PremiumEmptyState
				icon={Cpu}
				title="No Transcode Data Yet"
				description={`Session data is collected every 5 minutes while streams are active. Check back once ${serviceLabel} has been in use.`}
			/>
		);
	}

	const measurement =
		data.measurement?.version === 1 && data.measurement.methodAxis === "video"
			? data.measurement
			: undefined;
	const counts = measurement
		? {
				directPlay: data.directPlay,
				directStream: data.directStream,
				transcode: data.transcode,
				unknown: data.unknown ?? Math.max(0, data.totalSessions - measurement.measuredSessions),
			}
		: { directPlay: 0, directStream: 0, transcode: 0, unknown: data.totalSessions };
	const segments: DonutSegment[] = [
		{ label: "Direct Play", value: counts.directPlay, color: colors.directPlay },
		{ label: "Direct Stream", value: counts.directStream, color: colors.directStream },
		{ label: "Transcode", value: counts.transcode, color: colors.transcode },
		{ label: "Unknown", value: counts.unknown, color: colors.unknown },
	];
	const collection = measurement?.collection;
	const collectionState =
		measurement?.observedSessions === 0
			? measurement.configuredSources === 0
				? `No configured ${serviceLabel} sources. Check Settings to configure a connection.`
				: collection && collection.failedSnapshots > 0
					? "Collection failed in this window. Check source settings and retry collection."
					: collection && collection.invalidSnapshots > 0
						? "Collection evidence is invalid in this window. Check source settings."
						: collection && collection.idleSnapshots > 0
							? "Successful idle observations recorded; no active video processing rate is available."
							: "No observations recorded in this window. Check source settings and the collection scheduler."
			: null;
	const measured = counts.directPlay + counts.directStream + counts.transcode;
	const dpPercent = measured > 0 ? Math.round((counts.directPlay / measured) * 100) : null;
	const observedDaily = data.dailyBreakdown.map((day) =>
		measurement
			? { ...day, unknown: day.unknown ?? 0 }
			: {
					date: day.date,
					directPlay: 0,
					directStream: 0,
					transcode: 0,
					unknown: day.directPlay + day.directStream + day.transcode + (day.unknown ?? 0),
				},
	);
	const daily: DailyBreakdown[] = [];
	for (const day of observedDaily) {
		const previous = daily[daily.length - 1];
		if (previous) {
			const previousTime = Date.parse(previous.date);
			const gapDays = Math.floor((Date.parse(day.date) - previousTime) / 86_400_000);
			for (let gap = 1; gap < gapDays && gap <= 90; gap++) {
				daily.push({
					date: new Date(previousTime + gap * 86_400_000).toISOString().slice(0, 10),
					directPlay: 0,
					directStream: 0,
					transcode: 0,
					unknown: 0,
				});
			}
		}
		daily.push(day);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Cpu className="h-4 w-4" style={{ color: gradient.from }} />
				Video Processing
			</h3>
			{isError && (
				<p role="status" className="text-xs text-warning">
					Last-known historical data retained; refresh failed. Check the connection and try again.
				</p>
			)}
			<div className="text-xs text-muted-foreground space-y-1">
				{measurement ? (
					<>
						<p>
							{measurement.measuredSessions} of {measurement.observedSessions} session observations
							have known video decisions.
							{measurement.status === "partial" &&
								" Known categories are a subset, not complete coverage."}
						</p>
						{collection && (
							<p>
								Collection: {collection.failedSnapshots} failed, {collection.legacySnapshots}{" "}
								legacy/unverified, {collection.invalidSnapshots} invalid, {collection.idleSnapshots}{" "}
								idle observations.
							</p>
						)}
						{measurement.invalidDetailSnapshots > 0 && (
							<p>
								{measurement.invalidDetailSnapshots} snapshots have invalid native detail evidence;
								unverified decisions remain unknown.
							</p>
						)}
						{collectionState && <p role="status">{collectionState}</p>}
						{!collectionState && measurement.status === "unavailable" && (
							<p>
								Video decisions are unavailable. Check source settings; observed activity is
								retained.
							</p>
						)}
					</>
				) : (
					<p>
						Legacy/unverified measurements: this response does not establish a native video basis.
						Categories remain unknown.
					</p>
				)}
				<p>
					Video processing only: audio-only transcoding with video copy is Direct Stream, not video
					Transcode.
				</p>
				<p>Five-minute activity samples, not continuous playback history or unique play counts.</p>
			</div>

			<div className="flex flex-col md:flex-row gap-6 items-center">
				{/* Donut */}
				<DonutChart segments={segments} />

				{/* Legend + stats */}
				<div className="flex-1 space-y-3">
					{[
						{
							icon: Play,
							label: "Direct Play",
							value: counts.directPlay,
							color: colors.directPlay,
						},
						{
							icon: Radio,
							label: "Direct Stream",
							value: counts.directStream,
							color: colors.directStream,
						},
						{
							icon: MonitorPlay,
							label: "Transcode",
							value: counts.transcode,
							color: colors.transcode,
						},
						{ icon: CircleHelp, label: "Unknown", value: counts.unknown, color: colors.unknown },
					].map((item) => {
						const Icon = item.icon;
						return (
							<div key={item.label} className="flex items-center gap-3">
								<div
									className="h-3 w-3 rounded-full shrink-0"
									style={{ backgroundColor: item.color }}
								/>
								<Icon className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-sm text-muted-foreground flex-1">{item.label}</span>
								<span className="text-sm font-medium tabular-nums">
									{item.value.toLocaleString()}
								</span>
							</div>
						);
					})}
					<div className="pt-2 border-t border-border/30 text-xs text-muted-foreground">
						{dpPercent === null
							? "Direct play rate: Unknown"
							: `${dpPercent}% direct play among known video decisions`}
					</div>
				</div>
			</div>

			{/* Daily stacked bars */}
			{data.dailyBreakdown.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Daily Breakdown</h4>
					<StackedBarChart data={daily} colors={colors} />
				</div>
			)}
		</div>
	);
};
