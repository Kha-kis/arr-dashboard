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
	data: Array<number | null>;
	width?: number;
	height?: number;
	color: string;
	fillColor?: string;
	label?: string;
}

export const Sparkline = ({
	data,
	width = 280,
	height = 60,
	color,
	fillColor,
	label = "Trend of recorded observations",
}: SparklineProps) => {
	if (data.length < 2) return null;
	const known = data.filter((value): value is number => value !== null && Number.isFinite(value));
	if (known.length === 0) return null;
	const max = Math.max(...known, 1);
	const min = Math.min(...known, 0);
	const range = max - min || 1;
	const padY = 4;
	const usableH = height - padY * 2;

	const segments: Array<Array<{ x: number; y: number }>> = [];
	let current: Array<{ x: number; y: number }> = [];
	for (const [i, v] of data.entries()) {
		if (v === null || !Number.isFinite(v)) {
			if (current.length > 0) segments.push(current);
			current = [];
			continue;
		}
		const x = (i / (data.length - 1)) * width;
		const y = padY + usableH - ((v - min) / range) * usableH;
		current.push({ x, y });
	}
	if (current.length > 0) segments.push(current);
	const paths = segments.map((points) => `M${points.map(({ x, y }) => `${x},${y}`).join(" L")}`);
	const linePath = paths.join(" ");
	const areaPath = paths
		.map((path, i) => {
			const points = segments[i]!;
			return `${path} L${points[points.length - 1]!.x},${height} L${points[0]!.x},${height} Z`;
		})
		.join(" ");

	return (
		<svg
			role="img"
			aria-label={`${label}; gaps indicate unknown data`}
			width="100%"
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			className="block max-w-full overflow-visible"
		>
			{fillColor && <path d={areaPath} fill={fillColor} opacity={0.15} />}
			<path
				d={linePath}
				fill="none"
				stroke={color}
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{segments.map((points) => {
				const end = points[points.length - 1]!;
				return <circle key={end.x} cx={end.x} cy={end.y} r={3} fill={color} />;
			})}
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
	<div className="rounded-xl border border-border/30 bg-card/30 p-4">
		<div className="flex items-center gap-2 mb-2">
			<div
				className="h-8 w-8 rounded-lg flex items-center justify-center"
				style={{ backgroundColor: `${color}20` }}
			>
				<span style={{ color }}>
					<Icon className="h-4 w-4" />
				</span>
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
