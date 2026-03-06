/**
 * Shared Chart Primitives
 *
 * Reusable presentational components for statistics charts:
 * Sparkline, MiniStatCard, and formatBandwidth utility.
 */

// ============================================================================
// SVG Sparkline Component
// ============================================================================

interface SparklineProps {
	data: number[];
	width?: number;
	height?: number;
	color: string;
	fillColor?: string;
}

export const Sparkline = ({ data, width = 280, height = 60, color, fillColor }: SparklineProps) => {
	if (data.length < 2) return null;
	const max = Math.max(...data, 1);
	const min = Math.min(...data, 0);
	const range = max - min || 1;
	const padY = 4;
	const usableH = height - padY * 2;

	const points = data.map((v, i) => {
		const x = (i / (data.length - 1)) * width;
		const y = padY + usableH - ((v - min) / range) * usableH;
		return `${x},${y}`;
	});

	const linePath = `M${points.join(" L")}`;
	const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

	return (
		<svg width={width} height={height} className="overflow-visible">
			{fillColor && <path d={areaPath} fill={fillColor} opacity={0.15} />}
			<path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
			<circle cx={Number(points[points.length - 1]?.split(",")[0])} cy={Number(points[points.length - 1]?.split(",")[1])} r={3} fill={color} />
		</svg>
	);
};

// ============================================================================
// Mini Stat Card
// ============================================================================

interface MiniStatCardProps {
	icon: React.ComponentType<{ className?: string }>;
	label: string;
	value: string | number;
	color: string;
}

export const MiniStatCard = ({ icon: Icon, label, value, color }: MiniStatCardProps) => (
	<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-4">
		<div className="flex items-center gap-2 mb-2">
			<div
				className="h-8 w-8 rounded-lg flex items-center justify-center"
				style={{ backgroundColor: `${color}20` }}
			>
				<span style={{ color }}><Icon className="h-4 w-4" /></span>
			</div>
			<span className="text-xs text-muted-foreground">{label}</span>
		</div>
		<p className="text-xl font-bold tabular-nums">{value}</p>
	</div>
);

// ============================================================================
// Bandwidth Formatter
// ============================================================================

export function formatBandwidth(kbps: number): string {
	if (kbps === 0) return "0 kbps";
	if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(1)} Gbps`;
	if (kbps >= 1_000) return `${(kbps / 1_000).toFixed(1)} Mbps`;
	return `${kbps.toLocaleString()} kbps`;
}
