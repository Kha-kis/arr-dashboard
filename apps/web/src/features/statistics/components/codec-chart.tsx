"use client";

import type { CodecAnalytics } from "@arr/shared";
import { FileVideo } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// ============================================================================
// Donut Chart (reused pattern from transcode-chart)
// ============================================================================

interface DonutSegment {
	label: string;
	value: number;
	color: string;
}

function codecSegments(
	codecs: CodecAnalytics["videoCodecs"],
	colors: string[],
	offset = 0,
): DonutSegment[] {
	const categories =
		codecs.length > 6
			? [
					...codecs.slice(0, 5),
					{
						codec: "Other codecs",
						count: codecs.slice(5).reduce((sum, codec) => sum + codec.count, 0),
						percent: 0,
					},
				]
			: codecs;
	return categories.map((codec, index) => ({
		label: codec.codec,
		value: codec.count,
		color: colors[(index + offset) % colors.length]!,
	}));
}

function resolutionLabel(value: string): string {
	if (value === "unknown") return "Unknown";
	if (value === "sd") return "SD";
	return /^\d+$/.test(value) ? `${value}p` : value;
}

const DonutChart = ({
	segments,
	size = 120,
	label,
}: {
	segments: DonutSegment[];
	size?: number;
	label: string;
}) => {
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	if (total === 0) return null;

	const cx = size / 2;
	const cy = size / 2;
	const strokeWidth = 16;
	const radius = size / 2 - strokeWidth / 2;
	const circumference = 2 * Math.PI * radius;

	let cumulativePercent = 0;

	return (
		<div className="flex shrink-0 flex-col items-center gap-2">
			<div className="relative inline-flex items-center justify-center">
				<svg
					width={size}
					height={size}
					className="-rotate-90"
					role="img"
					aria-label={`${label}: ${total} observations, ${segments.map((segment) => `${segment.value} ${segment.label}`).join(", ")}`}
				>
					{segments.map((seg) => {
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
					<span className="text-lg font-bold tabular-nums">{total.toLocaleString()}</span>
					<span className="text-[9px] text-muted-foreground">observations</span>
				</div>
			</div>
			<span className="text-[10px] text-muted-foreground font-medium">{label}</span>
		</div>
	);
};

// ============================================================================
// Legend
// ============================================================================

const SegmentLegend = ({ segments }: { segments: DonutSegment[] }) => (
	<div className="min-w-0 flex-1 space-y-1.5">
		{segments.map((seg) => (
			<div key={seg.label} className="flex items-center gap-2 text-xs">
				<div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
				<span className="text-muted-foreground min-w-0 flex-1 break-all">{seg.label}</span>
				<span className="font-medium tabular-nums">{seg.value.toLocaleString()}</span>
			</div>
		))}
	</div>
);

// ============================================================================
// Resolution Bars
// ============================================================================

const ResolutionBars = ({
	resolutions,
	color,
}: {
	resolutions: Array<{ resolution: string; count: number; percent: number }>;
	color: string;
}) => {
	const max = Math.max(...resolutions.map((r) => r.count), 1);

	return (
		<div className="space-y-2">
			{resolutions.map((res, i) => (
				<div key={res.resolution} className="flex items-center gap-3 text-xs">
					<span className="w-24 shrink-0 break-all text-right text-muted-foreground font-mono">
						{resolutionLabel(res.resolution)}
					</span>
					<div className="min-w-0 flex-1 h-4 rounded-full bg-muted/30 overflow-hidden">
						<div
							className="h-full rounded-full transition-all duration-500"
							style={{
								width: `${(res.count / max) * 100}%`,
								background: `linear-gradient(90deg, ${color}, ${color}bb)`,
								animationDelay: `${i * 50}ms`,
							}}
						/>
					</div>
					<span className="w-12 text-right font-medium tabular-nums">{res.percent}%</span>
				</div>
			))}
		</div>
	);
};

// ============================================================================
// Codec Chart Section
// ============================================================================

interface CodecChartProps {
	data: CodecAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const CodecChart = ({ data, isLoading, isError, service = "plex" }: CodecChartProps) => {
	const { gradient } = useThemeGradient();

	const donutColors = useMemo(
		() => [
			SERVICE_GRADIENTS[service].from,
			SEMANTIC_COLORS.success.text,
			SEMANTIC_COLORS.warning.text,
			SEMANTIC_COLORS.info.text,
			SERVICE_GRADIENTS.sonarr.from,
			SERVICE_GRADIENTS.radarr.from,
		],
		[service],
	);

	const measurement = data?.measurement?.version === 1 ? data.measurement : undefined;
	const unknownCodecs =
		data && data.totalSessions > 0
			? [{ codec: "unknown", count: data.totalSessions, percent: 100 }]
			: [];
	const videoSegments = codecSegments(measurement ? data!.videoCodecs : unknownCodecs, donutColors);
	const audioSegments = codecSegments(
		measurement ? data!.audioCodecs : unknownCodecs,
		donutColors,
		2,
	);
	const resolutions = measurement
		? data!.resolutions
		: data && data.totalSessions > 0
			? [{ resolution: "unknown", count: data.totalSessions, percent: 100 }]
			: [];

	if (isLoading && !data) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8">
					<PremiumSkeleton variant="line" className="h-[120px] w-[120px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[120px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError && !data) {
		return (
			<PremiumEmptyState
				icon={FileVideo}
				title="Failed to Load Codec Data"
				description="Could not fetch codec analytics. Check the connection in Settings and try again."
			/>
		);
	}

	if (!data) {
		return (
			<PremiumEmptyState
				icon={FileVideo}
				title="Codec Evidence Unavailable"
				description="No observations are available. Check the connection in Settings and try again."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<FileVideo className="h-4 w-4" style={{ color: gradient.from }} />
				Codec &amp; Resolution
			</h3>
			{isError && (
				<p role="status" className="text-xs text-muted-foreground">
					Showing last-known codec observations; refresh failed. Check the connection in Settings
					and try again.
				</p>
			)}
			{measurement ? (
				<div className="space-y-2 text-xs text-muted-foreground">
					<p>
						Measured video codec: {measurement.videoCodecMeasuredSessions} of{" "}
						{measurement.observedSessions}; audio codec: {measurement.audioCodecMeasuredSessions} of{" "}
						{measurement.observedSessions}; resolution: {measurement.resolutionMeasuredSessions} of{" "}
						{measurement.observedSessions} observations.
					</p>
					<p>
						Sample observations, not continuous playback history. Unknown fields remain in each
						distribution.
					</p>
					<p>
						Collection: {measurement.collection.failedSnapshots} failed;{" "}
						{measurement.collection.legacySnapshots} legacy;{" "}
						{measurement.collection.invalidSnapshots} invalid;{" "}
						{measurement.collection.idleSnapshots} idle samples.
					</p>
					{measurement.invalidDetailSnapshots > 0 && (
						<p>
							{measurement.invalidDetailSnapshots} samples have invalid session detail; their
							unverified fields remain unknown.
						</p>
					)}
					{measurement.status === "unavailable" && data.totalSessions > 0 && (
						<p>
							Codec measurements are unavailable. Check the connection in Settings; new native
							observations are needed to establish coverage.
						</p>
					)}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					Legacy codec evidence is unverified. New native observations are needed; old categories
					are shown as unknown.
				</p>
			)}
			{data.totalSessions === 0 && (
				<p className="text-sm text-muted-foreground">
					{measurement?.configuredSources === 0
						? "No configured sources. Configure a media-server connection in Settings."
						: measurement && measurement.collection.failedSnapshots > 0
							? "Collection failed. Check the connection in Settings and try again."
							: measurement &&
									(measurement.collection.invalidSnapshots > 0 ||
										measurement.collection.legacySnapshots > 0)
								? "Collection evidence is unverified. Check the connection in Settings; new native observations are needed."
								: measurement && measurement.collection.idleSnapshots > 0
									? "Successful idle collection: no active sessions were observed."
									: "No observations yet. Check the connection in Settings; codec data appears after native sessions are captured."}
				</p>
			)}

			{/* Donut charts row */}
			<div className="grid gap-6 md:grid-cols-2">
				<div className="flex min-w-0 flex-wrap items-start gap-4">
					<DonutChart segments={videoSegments} label="Video Codecs" />
					<SegmentLegend segments={videoSegments} />
				</div>
				<div className="flex min-w-0 flex-wrap items-start gap-4">
					<DonutChart segments={audioSegments} label="Audio Codecs" />
					<SegmentLegend segments={audioSegments} />
				</div>
			</div>

			{/* Resolution bars */}
			{resolutions.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Resolution Distribution</h4>
					<ResolutionBars resolutions={resolutions} color={gradient.from} />
				</div>
			)}
		</div>
	);
};
