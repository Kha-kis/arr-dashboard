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
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const displayColor = color || themeGradient.from;

	return (
		<article
			className="group rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-5 transition-all duration-300 hover:bg-card/50 hover:shadow-lg hover:shadow-black/5 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 50}ms`,
				animationFillMode: "backwards",
			}}
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
		</article>
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

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
					color="#f97316"
					index={2}
				/>
				<StatCard
					icon={Wifi}
					label="Usenet"
					value={stats.usenet}
					color="#06b6d4"
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
