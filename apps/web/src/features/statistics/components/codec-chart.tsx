"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useCodecAnalytics } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { FileVideo } from "lucide-react";

// ============================================================================
// Donut Chart (reused pattern from transcode-chart)
// ============================================================================

interface DonutSegment {
	label: string;
	value: number;
	color: string;
}

const DONUT_COLORS = [
	SERVICE_GRADIENTS.plex.from,
	SEMANTIC_COLORS.success.text,
	SEMANTIC_COLORS.warning.text,
	SEMANTIC_COLORS.info.text,
	SERVICE_GRADIENTS.sonarr.from,
	SERVICE_GRADIENTS.radarr.from,
];

const DonutChart = ({ segments, size = 120, label }: { segments: DonutSegment[]; size?: number; label: string }) => {
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	if (total === 0) return null;

	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 6;
	const strokeWidth = 16;
	const circumference = 2 * Math.PI * radius;

	let cumulativePercent = 0;

	return (
		<div className="flex flex-col items-center gap-2">
			<div className="relative inline-flex items-center justify-center">
				<svg width={size} height={size} className="-rotate-90">
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
					<span className="text-[9px] text-muted-foreground">sessions</span>
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
	<div className="space-y-1.5">
		{segments.slice(0, 6).map((seg) => (
			<div key={seg.label} className="flex items-center gap-2 text-xs">
				<div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
				<span className="text-muted-foreground flex-1 truncate">{seg.label}</span>
				<span className="font-medium tabular-nums">{seg.value.toLocaleString()}</span>
			</div>
		))}
	</div>
);

// ============================================================================
// Resolution Bars
// ============================================================================

const ResolutionBars = ({ resolutions, color }: { resolutions: Array<{ resolution: string; count: number; percent: number }>; color: string }) => {
	const max = Math.max(...resolutions.map((r) => r.count), 1);

	return (
		<div className="space-y-2">
			{resolutions.slice(0, 6).map((res, i) => (
				<div key={res.resolution} className="flex items-center gap-3 text-xs">
					<span className="w-14 text-right text-muted-foreground font-mono">
						{res.resolution === "unknown" ? "?" : `${res.resolution}p`}
					</span>
					<div className="flex-1 h-4 rounded-full bg-muted/30 overflow-hidden">
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
	days: number;
	enabled: boolean;
}

export const CodecChart = ({ days, enabled }: CodecChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useCodecAnalytics(days, enabled);

	const videoSegments = useMemo((): DonutSegment[] => {
		if (!data?.videoCodecs) return [];
		return data.videoCodecs.slice(0, 6).map((c: { codec: string; count: number }, i: number) => ({
			label: c.codec,
			value: c.count,
			color: DONUT_COLORS[i % DONUT_COLORS.length]!,
		}));
	}, [data]);

	const audioSegments = useMemo((): DonutSegment[] => {
		if (!data?.audioCodecs) return [];
		return data.audioCodecs.slice(0, 6).map((c: { codec: string; count: number }, i: number) => ({
			label: c.codec,
			value: c.count,
			color: DONUT_COLORS[(i + 2) % DONUT_COLORS.length]!,
		}));
	}, [data]);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8">
					<PremiumSkeleton variant="line" className="h-[120px] w-[120px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[120px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={FileVideo}
				title="Failed to Load Codec Data"
				description="Could not fetch codec analytics."
			/>
		);
	}

	if (!data || data.totalSessions === 0) {
		return (
			<PremiumEmptyState
				icon={FileVideo}
				title="No Codec Data Yet"
				description="Codec data requires Tautulli enrichment. Ensure Tautulli is connected and sessions are being captured."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<FileVideo className="h-4 w-4" style={{ color: gradient.from }} />
				Codec &amp; Resolution
			</h3>

			{/* Donut charts row */}
			<div className="grid gap-6 md:grid-cols-2">
				<div className="flex items-start gap-4">
					<DonutChart segments={videoSegments} label="Video Codecs" />
					<SegmentLegend segments={videoSegments} />
				</div>
				<div className="flex items-start gap-4">
					<DonutChart segments={audioSegments} label="Audio Codecs" />
					<SegmentLegend segments={audioSegments} />
				</div>
			</div>

			{/* Resolution bars */}
			{data.resolutions.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Resolution Distribution</h4>
					<ResolutionBars resolutions={data.resolutions} color={gradient.from} />
				</div>
			)}
		</div>
	);
};
