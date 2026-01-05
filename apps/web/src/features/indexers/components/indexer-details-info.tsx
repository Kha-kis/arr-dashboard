"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { DetailStat } from "./detail-stat";
import {
	formatDateTime,
	formatResponseTime,
	formatSuccessRate,
	protocolLabel,
} from "../lib/indexers-utils";
import { Zap, Tag } from "lucide-react";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Premium Capability/Category Badge
 */
const PremiumBadge = ({
	label,
	color,
}: {
	label: string;
	color: string;
}) => (
	<span
		className="rounded-full px-3 py-1 text-xs font-medium transition-transform duration-200 hover:scale-105"
		style={{
			backgroundColor: `${color}10`,
			border: `1px solid ${color}25`,
			color: color,
		}}
	>
		{label}
	</span>
);

/**
 * Premium Indexer Details Info
 *
 * Displays detailed indexer information including:
 * - Implementation and protocol info
 * - Statistics grid (success rate, response time, etc.)
 * - Capabilities and categories with premium badges
 */
export const IndexerDetailsInfo = ({
	detail,
	indexer,
}: {
	detail: ProwlarrIndexerDetails;
	indexer: ProwlarrIndexer;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const stats = detail.stats;
	const capabilities = detail.capabilities ?? indexer.capabilities ?? [];
	const categories = detail.categories ?? [];

	// Protocol-based colors
	const protocolColor = (detail.protocol ?? indexer.protocol) === "torrent" ? "#f97316" : "#06b6d4";

	return (
		<div className="space-y-5 flex-1">
			{/* Basic Info Grid */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<DetailStat label="Implementation" value={detail.implementationName ?? "Unknown"} />
				<DetailStat
					label="Protocol"
					value={protocolLabel(detail.protocol ?? indexer.protocol)}
					color={protocolColor}
				/>
				<DetailStat
					label="Priority"
					value={
						typeof detail.priority === "number"
							? detail.priority.toString()
							: detail.priority === 0
								? "0"
								: undefined
					}
				/>
				<DetailStat
					label="App profile"
					value={
						typeof detail.appProfileId === "number" ? detail.appProfileId.toString() : "Default"
					}
				/>
				<DetailStat label="Privacy" value={detail.privacy ?? undefined} />
				<DetailStat label="Language" value={detail.language ?? undefined} />
			</div>

			{/* Statistics Grid */}
			{stats && (
				<div className="rounded-xl border border-border/50 bg-card/20 p-4">
					<div className="flex items-center gap-2 mb-4">
						<Zap className="h-4 w-4" style={{ color: themeGradient.from }} />
						<h4 className="text-sm font-medium text-foreground">Performance Statistics</h4>
					</div>
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<DetailStat label="Success rate" value={formatSuccessRate(stats.successRate)} />
						<DetailStat
							label="Avg response"
							value={formatResponseTime(stats.averageResponseTime)}
						/>
						<DetailStat label="Last check" value={formatDateTime(stats.lastCheck)} />
						<DetailStat label="Last failure" value={formatDateTime(stats.lastFailure)} />
					</div>
				</div>
			)}

			{/* Capabilities */}
			{capabilities.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<Tag className="h-4 w-4 text-muted-foreground" />
						<p className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
							Capabilities
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						{capabilities.map((capability, index) => (
							<PremiumBadge
								key={`${index}-${capability}`}
								label={capability}
								color={themeGradient.from}
							/>
						))}
					</div>
				</div>
			)}

			{/* Categories */}
			{categories.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<Tag className="h-4 w-4 text-muted-foreground" />
						<p className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
							Categories
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						{categories.map((category, index) => (
							<PremiumBadge
								key={`${index}-${category}`}
								label={category}
								color={themeGradient.fromMuted || themeGradient.from}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
};
