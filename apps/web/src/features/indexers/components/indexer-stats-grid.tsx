"use client";

import type { IndexerStats } from "../lib/indexers-utils";
import { numberFormatter } from "../lib/indexers-utils";
import {
	Globe,
	CheckCircle2,
	Download,
	Rss,
	Search,
	Wifi,
} from "lucide-react";
import { SEMANTIC_COLORS, PROTOCOL_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { GlassmorphicCard } from "../../../components/layout";

/**
 * Premium Stat Card Component
 */
const StatCard = ({
	icon: Icon,
	label,
	value,
	color,
	index,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value: number;
	color?: string;
	index: number;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const displayColor = color || themeGradient.from;

	return (
		<GlassmorphicCard
			padding="sm"
			animationDelay={index * 50}
			className="group transition-all duration-300 hover:bg-card/50 hover:shadow-lg hover:shadow-black/5"
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110"
						style={{
							background: `linear-gradient(135deg, ${displayColor}20, ${displayColor}10)`,
							border: `1px solid ${displayColor}30`,
						}}
					>
						<Icon className="h-5 w-5" style={{ color: displayColor }} />
					</div>
					<p className="text-sm font-medium text-muted-foreground">{label}</p>
				</div>
				<p
					className="text-2xl font-bold"
					style={{ color: displayColor }}
				>
					{numberFormatter.format(value)}
				</p>
			</div>
		</GlassmorphicCard>
	);
};

/**
 * Premium Indexer Stats Grid
 *
 * Displays aggregated indexer statistics with:
 * - Theme-aware gradient styling
 * - Animated cards with staggered entry
 * - Icon-based visual hierarchy
 * - Two-tier grid layout (4 primary + 2 secondary)
 */
export const IndexerStatsGrid = ({ stats }: { stats: IndexerStats }) => {
	const { gradient: _themeGradient } = useThemeGradient();

	return (
		<div className="space-y-4">
			{/* Primary Stats */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					icon={Globe}
					label="Total indexers"
					value={stats.total}
					index={0}
				/>
				<StatCard
					icon={CheckCircle2}
					label="Enabled"
					value={stats.enabled}
					color={SEMANTIC_COLORS.success.from}
					index={1}
				/>
				<StatCard
					icon={Download}
					label="Torrent"
					value={stats.torrent}
					color={PROTOCOL_COLORS.torrent}
					index={2}
				/>
				<StatCard
					icon={Wifi}
					label="Usenet"
					value={stats.usenet}
					color={PROTOCOL_COLORS.usenet}
					index={3}
				/>
			</div>

			{/* Secondary Stats */}
			<div className="grid gap-4 sm:grid-cols-2">
				<StatCard
					icon={Search}
					label="Search capable"
					value={stats.search}
					index={4}
				/>
				<StatCard
					icon={Rss}
					label="RSS capable"
					value={stats.rss}
					index={5}
				/>
			</div>
		</div>
	);
};
