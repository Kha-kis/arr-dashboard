"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useBandwidthForecast } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { TrendingUp } from "lucide-react";
import { formatBandwidth } from "./chart-primitives";

// ============================================================================
// Combined Line Chart (historical + forecast dashed)
// ============================================================================

const ForecastLine = ({
	historicalData,
	forecastData,
	width = 600,
	height = 80,
	historicalColor,
	forecastColor,
}: {
	historicalData: number[];
	forecastData: number[];
	width?: number;
	height?: number;
	historicalColor: string;
	forecastColor: string;
}) => {
	const allData = [...historicalData, ...forecastData];
	if (allData.length < 2) return null;

	const max = Math.max(...allData, 1);
	const min = Math.min(...allData, 0);
	const range = max - min || 1;
	const padY = 4;
	const usableH = height - padY * 2;

	const allPoints = allData.map((v, i) => {
		const x = (i / (allData.length - 1)) * width;
		const y = padY + usableH - ((v - min) / range) * usableH;
		return { x, y };
	});

	const histPoints = allPoints.slice(0, historicalData.length);
	const forePoints = allPoints.slice(historicalData.length - 1); // Overlap by 1 for continuity

	const histLine = histPoints.map((p) => `${p.x},${p.y}`).join(" L");
	const histArea = `M${histLine} L${histPoints[histPoints.length - 1]!.x},${height} L0,${height} Z`;
	const foreLine = forePoints.map((p) => `${p.x},${p.y}`).join(" L");

	return (
		<svg width={width} height={height} className="overflow-visible">
			{/* Historical area + line */}
			<path d={histArea} fill={historicalColor} opacity={0.1} />
			<path d={`M${histLine}`} fill="none" stroke={historicalColor} strokeWidth={2} strokeLinecap="round" />
			{/* Forecast dashed line */}
			{forePoints.length > 1 && (
				<path
					d={`M${foreLine}`}
					fill="none"
					stroke={forecastColor}
					strokeWidth={2}
					strokeDasharray="6 4"
					strokeLinecap="round"
				/>
			)}
			{/* End dots */}
			{histPoints.length > 0 && (
				<circle cx={histPoints[histPoints.length - 1]!.x} cy={histPoints[histPoints.length - 1]!.y} r={3} fill={historicalColor} />
			)}
			{forePoints.length > 0 && (
				<circle cx={forePoints[forePoints.length - 1]!.x} cy={forePoints[forePoints.length - 1]!.y} r={3} fill={forecastColor} />
			)}
		</svg>
	);
};

// ============================================================================
// Peak Hours Heatmap (horizontal bars by hour)
// ============================================================================

const PeakHoursChart = ({
	peakHours,
	color,
}: {
	peakHours: Array<{ hour: number; avgConcurrent: number; avgBandwidth: number }>;
	color: string;
}) => {
	if (peakHours.length === 0) return null;
	const maxBw = Math.max(...peakHours.map((h) => h.avgBandwidth), 1);

	return (
		<div>
			<h4 className="text-xs text-muted-foreground mb-3">Peak Usage Hours</h4>
			<div className="flex items-end gap-[3px]" style={{ height: 60 }}>
				{peakHours.map((h) => {
					const barH = (h.avgBandwidth / maxBw) * 60;
					return (
						<div
							key={h.hour}
							className="flex-1 rounded-t-sm transition-all duration-300"
							style={{
								height: barH,
								backgroundColor: color,
								opacity: 0.3 + (h.avgBandwidth / maxBw) * 0.7,
							}}
							title={`${h.hour}:00 — ${formatBandwidth(h.avgBandwidth)} avg, ${h.avgConcurrent} streams`}
						/>
					);
				})}
			</div>
			<div className="flex justify-between text-[9px] text-muted-foreground mt-1">
				<span>0h</span>
				<span>6h</span>
				<span>12h</span>
				<span>18h</span>
				<span>23h</span>
			</div>
		</div>
	);
};

// ============================================================================
// Forecast Chart Section
// ============================================================================

interface ForecastChartProps {
	days: number;
	enabled: boolean;
}

export const ForecastChart = ({ days, enabled }: ForecastChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useBandwidthForecast(days, enabled);

	const historicalPeaks = useMemo(
		() => data?.historicalDaily.map((d: { peakBandwidth: number }) => d.peakBandwidth) ?? [],
		[data],
	);

	const forecastPeaks = useMemo(
		() => data?.forecast.map((d: { predictedPeak: number }) => d.predictedPeak) ?? [],
		[data],
	);

	const trendLabel = useMemo(() => {
		if (!data) return "";
		if (data.trend === "increasing") return "↗ Increasing";
		if (data.trend === "decreasing") return "↘ Decreasing";
		return "→ Stable";
	}, [data]);

	const trendColor = useMemo(() => {
		if (!data) return gradient.from;
		if (data.trend === "increasing") return SEMANTIC_COLORS.warning.text;
		if (data.trend === "decreasing") return SEMANTIC_COLORS.success.text;
		return gradient.from;
	}, [data, gradient.from]);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[80px] w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={TrendingUp}
				title="Failed to Load Forecast"
				description="Could not fetch bandwidth forecast data."
			/>
		);
	}

	if (!data || data.historicalDaily.length < 2) {
		return (
			<PremiumEmptyState
				icon={TrendingUp}
				title="Not Enough Data for Forecast"
				description="At least 2 days of session data are needed to generate a bandwidth forecast."
			/>
		);
	}

	const allDates = [...data.historicalDaily.map((d: { date: string }) => d.date), ...data.forecast.map((d: { date: string }) => d.date)];

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
					<TrendingUp className="h-4 w-4" style={{ color: gradient.from }} />
					Bandwidth Forecast
				</h3>
				<span
					className="text-xs font-medium px-2 py-0.5 rounded-full"
					style={{ backgroundColor: `${trendColor}20`, color: trendColor }}
				>
					{trendLabel}
				</span>
			</div>

			{/* Combined line chart */}
			<div>
				<div className="flex gap-4 text-[10px] text-muted-foreground mb-2">
					<span className="flex items-center gap-1.5">
						<div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: SERVICE_GRADIENTS.plex.from }} />
						Historical Peak
					</span>
					<span className="flex items-center gap-1.5">
						<div className="h-0.5 w-4 rounded-full border-dashed border-t-2" style={{ borderColor: SEMANTIC_COLORS.info.text }} />
						Projected
					</span>
				</div>
				<div className="flex justify-center">
					<ForecastLine
						historicalData={historicalPeaks}
						forecastData={forecastPeaks}
						historicalColor={SERVICE_GRADIENTS.plex.from}
						forecastColor={SEMANTIC_COLORS.info.text}
					/>
				</div>
				{allDates.length > 1 && (
					<div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-1">
						<span>{allDates[0]}</span>
						<span>{allDates[allDates.length - 1]}</span>
					</div>
				)}
			</div>

			{/* Peak hours heatmap */}
			<PeakHoursChart peakHours={data.peakHours} color={gradient.from} />
		</div>
	);
};
