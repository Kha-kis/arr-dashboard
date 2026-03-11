"use client";

import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useCollectionStats } from "../../../hooks/api/usePlex";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { FolderOpen } from "lucide-react";

// ============================================================================
// Collection Bar with watched overlay
// ============================================================================

const CollectionBar = ({
	name,
	totalItems,
	watchedItems,
	watchPercent,
	maxItems,
	color,
	watchedColor,
	index,
}: {
	name: string;
	totalItems: number;
	watchedItems: number;
	watchPercent: number;
	maxItems: number;
	color: string;
	watchedColor: string;
	index: number;
}) => {
	const totalWidth = (totalItems / maxItems) * 100;
	const watchedWidth = totalItems > 0 ? (watchedItems / totalItems) * 100 : 0;

	return (
		<div className="flex items-center gap-3 text-xs">
			<span className="w-28 truncate text-muted-foreground text-right" title={name}>
				{name}
			</span>
			<div className="flex-1 h-5 rounded-full bg-muted/30 overflow-hidden relative">
				<div
					className="h-full rounded-full transition-all duration-500 absolute inset-y-0 left-0"
					style={{
						width: `${totalWidth}%`,
						background: `${color}40`,
						animationDelay: `${index * 50}ms`,
					}}
				/>
				<div
					className="h-full rounded-full transition-all duration-500 absolute inset-y-0 left-0"
					style={{
						width: `${totalWidth * (watchedWidth / 100)}%`,
						background: `linear-gradient(90deg, ${watchedColor}, ${watchedColor}bb)`,
						animationDelay: `${index * 50}ms`,
					}}
				/>
			</div>
			<span className="w-10 text-right font-medium tabular-nums">{totalItems}</span>
			<span className="w-12 text-right text-muted-foreground tabular-nums">{watchPercent}%</span>
		</div>
	);
};

// ============================================================================
// Collection Stats Chart
// ============================================================================

interface CollectionStatsChartProps {
	enabled: boolean;
}

export const CollectionStatsChart = ({ enabled }: CollectionStatsChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useCollectionStats(enabled);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[120px] w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={FolderOpen}
				title="Failed to Load Collection Stats"
				description="Could not fetch collection statistics."
			/>
		);
	}

	if (!data || (data.collections.length === 0 && data.labels.length === 0)) {
		return (
			<PremiumEmptyState
				icon={FolderOpen}
				title="No Collection Data"
				description="Collection data appears once Plex library cache is populated with items that have collections or labels."
			/>
		);
	}

	const topCollections = data.collections.slice(0, 10);
	const topLabels = data.labels.slice(0, 10);
	const maxCollectionItems = Math.max(
		...topCollections.map((c: { totalItems: number }) => c.totalItems),
		1,
	);
	const maxLabelItems =
		topLabels.length > 0
			? Math.max(...topLabels.map((l: { totalItems: number }) => l.totalItems), 1)
			: 1;

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<FolderOpen className="h-4 w-4" style={{ color: gradient.from }} />
				Collections &amp; Labels
			</h3>

			{/* Legend */}
			<div className="flex gap-4 text-[10px] text-muted-foreground">
				<span className="flex items-center gap-1.5">
					<div
						className="h-2 w-4 rounded-sm"
						style={{ backgroundColor: SEMANTIC_COLORS.success.text }}
					/>
					Watched
				</span>
				<span className="flex items-center gap-1.5">
					<div className="h-2 w-4 rounded-sm" style={{ backgroundColor: `${gradient.from}40` }} />
					Total
				</span>
			</div>

			{/* Collections */}
			{topCollections.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Top Collections</h4>
					<div className="space-y-2">
						{topCollections.map(
							(
								c: { name: string; totalItems: number; watchedItems: number; watchPercent: number },
								i: number,
							) => (
								<CollectionBar
									key={c.name}
									{...c}
									maxItems={maxCollectionItems}
									color={gradient.from}
									watchedColor={SEMANTIC_COLORS.success.text}
									index={i}
								/>
							),
						)}
					</div>
				</div>
			)}

			{/* Labels */}
			{topLabels.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Labels</h4>
					<div className="space-y-2">
						{topLabels.map(
							(
								l: { name: string; totalItems: number; watchedItems: number; watchPercent: number },
								i: number,
							) => (
								<CollectionBar
									key={l.name}
									{...l}
									maxItems={maxLabelItems}
									color={gradient.to}
									watchedColor={SEMANTIC_COLORS.success.text}
									index={i}
								/>
							),
						)}
					</div>
				</div>
			)}
		</div>
	);
};
