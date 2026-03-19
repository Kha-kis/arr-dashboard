"use client";

import {
	AlertTriangle,
	CheckCircle2,
	Download,
	Globe,
	HeartPulse,
	Rss,
	Search,
	Wifi,
	XCircle,
} from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PROTOCOL_COLORS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { IndexerStats } from "../lib/indexers-utils";
import { numberFormatter } from "../lib/indexers-utils";

/**
 * Compact stat pill — used in the horizontal stats ribbon
 */
const StatPill = ({
	icon: Icon,
	label,
	value,
	color,
	total,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value: number;
	color?: string;
	/** When set, shows a mini arc indicator for value/total ratio */
	total?: number;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const displayColor = color || themeGradient.from;
	const ratio = total && total > 0 ? value / total : 0;

	return (
		<div className="group flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-200 hover:bg-card/50">
			{/* Mini ratio arc */}
			<div className="relative h-8 w-8 flex items-center justify-center shrink-0">
				<svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90" role="img" aria-label={label}>
					<circle
						cx="18"
						cy="18"
						r="14"
						fill="none"
						stroke="rgba(var(--border), 0.15)"
						strokeWidth="2.5"
					/>
					{total !== undefined && total > 0 && (
						<circle
							cx="18"
							cy="18"
							r="14"
							fill="none"
							stroke={displayColor}
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeDasharray="87.96"
							strokeDashoffset={`${87.96 - 87.96 * Math.min(ratio, 1)}`}
							style={{
								transition: "stroke-dashoffset 0.8s ease-out",
								filter: `drop-shadow(0 0 2px ${displayColor}40)`,
							}}
						/>
					)}
				</svg>
				<Icon
					className="absolute h-3.5 w-3.5 transition-transform duration-200 group-hover:scale-110"
					style={{ color: displayColor }}
				/>
			</div>
			<div className="min-w-0">
				<p className="text-lg font-bold leading-tight tabular-nums" style={{ color: displayColor }}>
					{numberFormatter.format(value)}
				</p>
				<p className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground/70 leading-tight">
					{label}
				</p>
			</div>
		</div>
	);
};

/**
 * Health mini-bar — compact colored bar segment
 */
const HealthBar = ({
	healthy,
	degraded,
	failing,
	total,
}: {
	healthy: number;
	degraded: number;
	failing: number;
	total: number;
}) => {
	if (total <= 0) return null;
	const healthyPct = (healthy / total) * 100;
	const degradedPct = (degraded / total) * 100;
	const failingPct = (failing / total) * 100;

	return (
		<div className="flex items-center gap-3 px-3">
			<div className="flex-1 h-2 rounded-full overflow-hidden bg-muted/20 flex min-w-[80px]">
				{healthyPct > 0 && (
					<div
						className="h-full transition-all duration-700"
						style={{
							width: `${healthyPct}%`,
							backgroundColor: SEMANTIC_COLORS.success.from,
						}}
					/>
				)}
				{degradedPct > 0 && (
					<div
						className="h-full transition-all duration-700"
						style={{
							width: `${degradedPct}%`,
							backgroundColor: SEMANTIC_COLORS.warning.from,
						}}
					/>
				)}
				{failingPct > 0 && (
					<div
						className="h-full transition-all duration-700"
						style={{
							width: `${failingPct}%`,
							backgroundColor: SEMANTIC_COLORS.error.from,
						}}
					/>
				)}
			</div>
			<div className="flex items-center gap-2 text-[10px] font-medium shrink-0">
				{healthy > 0 && (
					<span className="inline-flex items-center gap-1" style={{ color: SEMANTIC_COLORS.success.from }}>
						<HeartPulse className="h-3 w-3" />
						{healthy}
					</span>
				)}
				{degraded > 0 && (
					<span className="inline-flex items-center gap-1" style={{ color: SEMANTIC_COLORS.warning.from }}>
						<AlertTriangle className="h-3 w-3" />
						{degraded}
					</span>
				)}
				{failing > 0 && (
					<span className="inline-flex items-center gap-1" style={{ color: SEMANTIC_COLORS.error.from }}>
						<XCircle className="h-3 w-3" />
						{failing}
					</span>
				)}
			</div>
		</div>
	);
};

/**
 * Horizontal Stats Ribbon
 *
 * A compact, scannable overview of all indexer statistics in a single
 * scrollable row. Each stat gets a mini SVG arc indicator showing its
 * proportion against the total. Health is shown as a stacked bar.
 */
export const IndexerStatsGrid = ({ stats }: { stats: IndexerStats }) => {
	const hasHealthData = stats.healthy > 0 || stats.degraded > 0 || stats.failing > 0;

	return (
		<div className="rounded-xl border border-border/30 bg-muted/10 overflow-hidden animate-in fade-in duration-300">
			<div className="flex items-center overflow-x-auto scrollbar-none">
				{/* Primary stats */}
				<StatPill icon={Globe} label="Total" value={stats.total} />
				<div className="w-px h-8 bg-border/20 shrink-0" />
				<StatPill
					icon={CheckCircle2}
					label="Enabled"
					value={stats.enabled}
					color={SEMANTIC_COLORS.success.from}
					total={stats.total}
				/>
				<div className="w-px h-8 bg-border/20 shrink-0" />
				<StatPill
					icon={Download}
					label="Torrent"
					value={stats.torrent}
					color={PROTOCOL_COLORS.torrent}
					total={stats.enabled}
				/>
				<StatPill
					icon={Wifi}
					label="Usenet"
					value={stats.usenet}
					color={PROTOCOL_COLORS.usenet}
					total={stats.enabled}
				/>
				<div className="w-px h-8 bg-border/20 shrink-0" />
				<StatPill icon={Search} label="Search" value={stats.search} total={stats.enabled} />
				<StatPill icon={Rss} label="RSS" value={stats.rss} total={stats.enabled} />

				{/* Health bar — inline at the end */}
				{hasHealthData && (
					<>
						<div className="w-px h-8 bg-border/20 shrink-0" />
						<HealthBar
							healthy={stats.healthy}
							degraded={stats.degraded}
							failing={stats.failing}
							total={stats.enabled}
						/>
					</>
				)}
			</div>
		</div>
	);
};
