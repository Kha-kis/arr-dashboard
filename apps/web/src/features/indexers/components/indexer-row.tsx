"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { IndexerDetailsPanel } from "./indexer-details-panel";
import { protocolLabel } from "../lib/indexers-utils";
import { useIncognitoMode, getLinuxIndexer } from "../../../lib/incognito";
import {
	PlayCircle,
	ChevronDown,
	ChevronUp,
	Loader2,
	CheckCircle2,
	XCircle,
	Search,
	Rss,
	Download,
	Wifi,
} from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Capability Badge Component
 */
const CapabilityBadge = ({
	icon: Icon,
	label,
	color,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	color: string;
}) => (
	<span
		className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
		style={{
			backgroundColor: `${color}15`,
			border: `1px solid ${color}30`,
			color: color,
		}}
	>
		<Icon className="h-3 w-3" />
		{label}
	</span>
);

/**
 * Premium Indexer Row
 *
 * Single indexer display with:
 * - Glassmorphic card styling
 * - Protocol-based color coding
 * - Capability badges
 * - Animated test/details actions
 */
export const IndexerRow = ({
	indexer,
	instanceId,
	onTest,
	onUpdate,
	testing,
	expanded,
	onToggleDetails,
}: {
	indexer: ProwlarrIndexer;
	instanceId: string;
	onTest: (instanceId: string, indexerId: number) => void;
	onUpdate: (
		instanceId: string,
		indexerId: number,
		payload: ProwlarrIndexerDetails,
	) => Promise<ProwlarrIndexerDetails>;
	testing: boolean;
	expanded: boolean;
	onToggleDetails: () => void;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [incognitoMode] = useIncognitoMode();

	// Protocol-based colors
	const protocolColor = indexer.protocol === "torrent" ? "#f97316" : "#06b6d4";

	return (
		<div className="space-y-0 overflow-hidden">
			<div
				className={`rounded-xl border bg-card/40 backdrop-blur-sm p-4 transition-all duration-200 ${
					expanded ? "rounded-b-none border-b-0" : ""
				}`}
				style={{
					borderColor: expanded ? `${themeGradient.from}40` : "rgba(var(--border), 0.5)",
				}}
			>
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					{/* Indexer Info */}
					<div className="space-y-2 flex-1 min-w-0">
						<div className="flex items-center gap-3">
							{/* Enable Status Indicator */}
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
								style={{
									backgroundColor: indexer.enable
										? `${SEMANTIC_COLORS.success.from}15`
										: "rgba(var(--muted), 0.2)",
									border: `1px solid ${indexer.enable ? SEMANTIC_COLORS.success.from : "rgba(var(--muted), 0.3)"}30`,
								}}
							>
								{indexer.enable ? (
									<CheckCircle2 className="h-4 w-4" style={{ color: SEMANTIC_COLORS.success.from }} />
								) : (
									<XCircle className="h-4 w-4 text-muted-foreground" />
								)}
							</div>

							<div className="min-w-0">
								<h3 className="font-semibold text-foreground truncate">
									{incognitoMode ? getLinuxIndexer(indexer.name) : indexer.name}
								</h3>
								<p className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
									<span
										className="inline-flex items-center gap-1"
										style={{ color: protocolColor }}
									>
										{indexer.protocol === "torrent" ? (
											<Download className="h-3 w-3" />
										) : (
											<Wifi className="h-3 w-3" />
										)}
										{protocolLabel(indexer.protocol)}
									</span>
									<span className="text-muted-foreground/60">·</span>
									<span>Priority {indexer.priority ?? 0}</span>
								</p>
							</div>
						</div>

						{/* Capability Badges */}
						<div className="flex flex-wrap gap-1.5">
							{indexer.supportsSearch && (
								<CapabilityBadge
									icon={Search}
									label="Search"
									color={themeGradient.from}
								/>
							)}
							{indexer.supportsRss && (
								<CapabilityBadge
									icon={Rss}
									label="RSS"
									color={themeGradient.from}
								/>
							)}
							{Array.isArray(indexer.capabilities) && indexer.capabilities.length > 0 && (
								<span className="text-xs text-muted-foreground px-2 py-0.5">
									{indexer.capabilities.slice(0, 3).join(", ")}
									{indexer.capabilities.length > 3 && "..."}
								</span>
							)}
						</div>
					</div>

					{/* Actions */}
					<div className="flex items-center gap-2 shrink-0">
						{/* Test Button */}
						<button
							type="button"
							onClick={() => onTest(instanceId, indexer.id)}
							disabled={testing}
							className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
							style={{
								backgroundColor: `${themeGradient.from}15`,
								border: `1px solid ${themeGradient.from}30`,
								color: themeGradient.from,
							}}
						>
							{testing ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Testing...
								</>
							) : (
								<>
									<PlayCircle className="h-4 w-4" />
									Test
								</>
							)}
						</button>

						{/* Details Toggle */}
						<button
							type="button"
							onClick={onToggleDetails}
							className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 hover:bg-card/80"
							style={{
								border: "1px solid rgba(var(--border), 0.5)",
								color: expanded ? themeGradient.from : undefined,
							}}
						>
							{expanded ? (
								<>
									<ChevronUp className="h-4 w-4" />
									Hide
								</>
							) : (
								<>
									<ChevronDown className="h-4 w-4" />
									Details
								</>
							)}
						</button>
					</div>
				</div>
			</div>

			{/* Details Panel (renders below the row) */}
			<IndexerDetailsPanel
				instanceId={instanceId}
				indexer={indexer}
				expanded={expanded}
				onUpdate={onUpdate}
			/>
		</div>
	);
};
