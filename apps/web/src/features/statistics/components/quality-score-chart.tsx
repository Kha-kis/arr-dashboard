"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useQualityScore } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Gauge } from "lucide-react";

// ============================================================================
// Circular Gauge (0-100)
// ============================================================================

const CircularGauge = ({
	score,
	size = 140,
	label,
	color,
}: {
	score: number;
	size?: number;
	label: string;
	color: string;
}) => {
	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 10;
	const strokeWidth = 8;
	const circumference = 2 * Math.PI * radius;
	const progress = Math.min(Math.max(score, 0), 100);
	const dashLength = (progress / 100) * circumference;

	return (
		<div className="flex flex-col items-center gap-1">
			<div className="relative inline-flex items-center justify-center">
				<svg width={size} height={size} className="-rotate-90">
					{/* Background track */}
					<circle
						cx={cx}
						cy={cy}
						r={radius}
						fill="none"
						stroke="currentColor"
						strokeWidth={strokeWidth}
						className="text-muted/20"
					/>
					{/* Progress arc */}
					<circle
						cx={cx}
						cy={cy}
						r={radius}
						fill="none"
						stroke={color}
						strokeWidth={strokeWidth}
						strokeDasharray={`${dashLength} ${circumference - dashLength}`}
						strokeLinecap="round"
						className="transition-all duration-700"
					/>
				</svg>
				<div className="absolute inset-0 flex flex-col items-center justify-center">
					<span className="text-2xl font-bold tabular-nums">{score}</span>
					<span className="text-[9px] text-muted-foreground">/100</span>
				</div>
			</div>
			<span className="text-[10px] text-muted-foreground font-medium">{label}</span>
		</div>
	);
};

// ============================================================================
// Sparkline for daily trend
// ============================================================================

const TrendSparkline = ({
	data,
	width = 600,
	height = 50,
	color,
}: {
	data: Array<{ date: string; score: number }>;
	width?: number;
	height?: number;
	color: string;
}) => {
	if (data.length < 2) return null;
	const values = data.map((d) => d.score);
	const max = Math.max(...values, 1);
	const min = Math.min(...values, 0);
	const range = max - min || 1;
	const padY = 4;
	const usableH = height - padY * 2;

	const points = values.map((v, i) => {
		const x = (i / (values.length - 1)) * width;
		const y = padY + usableH - ((v - min) / range) * usableH;
		return `${x},${y}`;
	});

	const linePath = `M${points.join(" L")}`;
	const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

	return (
		<svg width={width} height={height} className="overflow-visible">
			<path d={areaPath} fill={color} opacity={0.15} />
			<path
				d={linePath}
				fill="none"
				stroke={color}
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle
				cx={Number(points[points.length - 1]?.split(",")[0])}
				cy={Number(points[points.length - 1]?.split(",")[1])}
				r={3}
				fill={color}
			/>
		</svg>
	);
};

// ============================================================================
// Quality Score Chart
// ============================================================================

interface QualityScoreChartProps {
	days: number;
	enabled: boolean;
}

export const QualityScoreChart = ({ days, enabled }: QualityScoreChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useQualityScore(days, enabled);

	const scoreColor = useMemo(() => {
		if (!data) return gradient.from;
		if (data.overallScore >= 80) return SEMANTIC_COLORS.success.text;
		if (data.overallScore >= 50) return SEMANTIC_COLORS.warning.text;
		return SEMANTIC_COLORS.error.text;
	}, [data, gradient.from]);

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
				icon={Gauge}
				title="Failed to Load Quality Score"
				description="Could not fetch quality score analytics."
			/>
		);
	}

	if (!data || data.trend.length === 0) {
		return (
			<PremiumEmptyState
				icon={Gauge}
				title="No Quality Data Yet"
				description="Quality scores are computed from session snapshots with codec/resolution data."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Gauge className="h-4 w-4" style={{ color: gradient.from }} />
				Stream Quality Score
			</h3>

			<div className="flex flex-col md:flex-row gap-6 items-center">
				{/* Main gauge */}
				<CircularGauge score={data.overallScore} label="Overall" color={scoreColor} />

				{/* Sub-gauges */}
				<div className="flex gap-4">
					<CircularGauge
						score={data.breakdown.directPlayScore}
						size={90}
						label="Direct Play"
						color={SEMANTIC_COLORS.success.text}
					/>
					<CircularGauge
						score={data.breakdown.resolutionScore}
						size={90}
						label="Resolution"
						color={SERVICE_GRADIENTS.plex.from}
					/>
					<CircularGauge
						score={data.breakdown.transcodeScore}
						size={90}
						label="Low Transcode"
						color={SEMANTIC_COLORS.warning.text}
					/>
				</div>
			</div>

			{/* Daily trend */}
			{data.trend.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Quality Score Trend</h4>
					<div className="flex justify-center">
						<TrendSparkline data={data.trend} color={scoreColor} />
					</div>
					<div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-1">
						<span>{data.trend[0]?.date}</span>
						<span>{data.trend[data.trend.length - 1]?.date}</span>
					</div>
				</div>
			)}

			{/* Per-user scores */}
			{data.perUser.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Per-User Quality</h4>
					<div className="space-y-2">
						{data.perUser
							.slice(0, 8)
							.map((user: { username: string; score: number; sessions: number }) => (
								<div key={user.username} className="flex items-center gap-3 text-xs">
									<div
										className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
										style={{ backgroundColor: `${gradient.from}20`, color: gradient.from }}
									>
										{user.username.charAt(0).toUpperCase()}
									</div>
									<span className="w-20 truncate text-muted-foreground">{user.username}</span>
									<div className="flex-1 h-3 rounded-full bg-muted/30 overflow-hidden">
										<div
											className="h-full rounded-full transition-all duration-500"
											style={{
												width: `${user.score}%`,
												backgroundColor:
													user.score >= 80
														? SEMANTIC_COLORS.success.text
														: user.score >= 50
															? SEMANTIC_COLORS.warning.text
															: SEMANTIC_COLORS.error.text,
											}}
										/>
									</div>
									<span className="w-8 text-right font-medium tabular-nums">{user.score}</span>
									<span className="w-12 text-right text-muted-foreground tabular-nums">
										{user.sessions}s
									</span>
								</div>
							))}
					</div>
				</div>
			)}
		</div>
	);
};
