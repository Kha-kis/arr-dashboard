"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useTranscodeAnalytics } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Cpu, MonitorPlay, Play, Radio } from "lucide-react";

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
				<span className="text-2xl font-bold tabular-nums">{total.toLocaleString()}</span>
				<span className="text-[10px] text-muted-foreground">sessions</span>
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
}

const StackedBarChart = ({
	data,
	colors,
}: {
	data: DailyBreakdown[];
	colors: { directPlay: string; transcode: string; directStream: string };
}) => {
	if (data.length === 0) return null;

	const maxTotal = Math.max(...data.map((d) => d.directPlay + d.transcode + d.directStream), 1);
	const barWidth = Math.max(4, Math.min(12, Math.floor(600 / data.length) - 2));

	return (
		<div className="w-full overflow-x-auto">
			<div className="flex items-end gap-[2px] min-w-0" style={{ height: 100 }}>
				{data.map((day) => {
					const total = day.directPlay + day.transcode + day.directStream;
					const h = (total / maxTotal) * 100;
					const dpH = total > 0 ? (day.directPlay / total) * h : 0;
					const dsH = total > 0 ? (day.directStream / total) * h : 0;
					const tcH = total > 0 ? (day.transcode / total) * h : 0;

					return (
						<div
							key={day.date}
							className="flex flex-col justify-end group relative"
							style={{ width: barWidth, height: "100%" }}
							title={`${day.date}: ${day.directPlay} DP / ${day.directStream} DS / ${day.transcode} TC`}
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
	days: number;
	enabled: boolean;
}

export const TranscodeChart = ({ days, enabled }: TranscodeChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useTranscodeAnalytics(days, enabled);

	const colors = useMemo(
		() => ({
			directPlay: SEMANTIC_COLORS.success.text,
			transcode: SEMANTIC_COLORS.warning.text,
			directStream: SERVICE_GRADIENTS.plex.from,
		}),
		[],
	);

	const segments: DonutSegment[] = useMemo(() => {
		if (!data) return [];
		return [
			{ label: "Direct Play", value: data.directPlay, color: colors.directPlay },
			{ label: "Direct Stream", value: data.directStream, color: colors.directStream },
			{ label: "Transcode", value: data.transcode, color: colors.transcode },
		].filter((s) => s.value > 0);
	}, [data, colors]);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8 items-center">
					<PremiumSkeleton variant="line" className="h-[140px] w-[140px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[100px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Cpu}
				title="Failed to Load Transcode Data"
				description="Could not fetch transcode analytics. Check your Plex connection and try again."
			/>
		);
	}

	if (!data || data.totalSessions === 0) {
		return (
			<PremiumEmptyState
				icon={Cpu}
				title="No Transcode Data Yet"
				description="Session data is collected every 5 minutes while streams are active. Check back once Plex has been in use."
			/>
		);
	}

	const dpPercent = data.totalSessions > 0 ? Math.round((data.directPlay / data.totalSessions) * 100) : 0;

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Cpu className="h-4 w-4" style={{ color: gradient.from }} />
				Transcode Decisions
			</h3>

			<div className="flex flex-col md:flex-row gap-6 items-center">
				{/* Donut */}
				<DonutChart segments={segments} />

				{/* Legend + stats */}
				<div className="flex-1 space-y-3">
					{[
						{ icon: Play, label: "Direct Play", value: data.directPlay, color: colors.directPlay },
						{ icon: Radio, label: "Direct Stream", value: data.directStream, color: colors.directStream },
						{ icon: MonitorPlay, label: "Transcode", value: data.transcode, color: colors.transcode },
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
								<span className="text-sm font-medium tabular-nums">{item.value.toLocaleString()}</span>
							</div>
						);
					})}
					<div className="pt-2 border-t border-border/30 text-xs text-muted-foreground">
						{dpPercent}% direct play rate
					</div>
				</div>
			</div>

			{/* Daily stacked bars */}
			{data.dailyBreakdown.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Daily Breakdown</h4>
					<StackedBarChart data={data.dailyBreakdown} colors={colors} />
				</div>
			)}
		</div>
	);
};
