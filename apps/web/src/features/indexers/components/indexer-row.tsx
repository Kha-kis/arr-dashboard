"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import {
	Activity,
	ChevronRight,
	Download,
	Loader2,
	PlayCircle,
	Rss,
	Search,
	Wifi,
} from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxIndexer, useIncognitoMode } from "../../../lib/incognito";
import { PROTOCOL_COLORS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { protocolLabel } from "../lib/indexers-utils";
import { IndexerDetailsPanel } from "./indexer-details-panel";

// ============================================================================
// Health helpers
// ============================================================================

const getHealthColor = (rate: number | undefined): string | null => {
	if (rate === undefined) return null;
	const normalized = rate > 1 ? rate / 100 : rate;
	if (normalized >= 0.9) return SEMANTIC_COLORS.success.from;
	if (normalized >= 0.5) return SEMANTIC_COLORS.warning.from;
	return SEMANTIC_COLORS.error.from;
};

const relativeTime = (iso: string | undefined): string | null => {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	const diffMs = Date.now() - date.getTime();
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
};

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Protocol pill — compact colored indicator
 */
const ProtocolPill = ({ protocol }: { protocol: ProwlarrIndexer["protocol"] }) => {
	const color =
		protocol === "torrent" ? PROTOCOL_COLORS.torrent : PROTOCOL_COLORS.usenet;
	const Icon = protocol === "torrent" ? Download : Wifi;

	return (
		<span
			className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold shrink-0"
			style={{
				color,
				backgroundColor: `${color}12`,
			}}
		>
			<Icon className="h-2.5 w-2.5" />
			{protocolLabel(protocol)}
		</span>
	);
};

/**
 * Inline health mini-bar — shows a tiny colored bar segment proportional to success rate
 */
const HealthMiniBar = ({
	health,
}: {
	health?: { successRate?: number; averageResponseTime?: number; lastCheck?: string };
}) => {
	if (!health) return null;

	const color = getHealthColor(health.successRate);
	const lastCheck = relativeTime(health.lastCheck);
	const rate =
		health.successRate !== undefined
			? `${Math.round(health.successRate > 1 ? health.successRate : health.successRate * 100)}%`
			: null;
	const responseMs =
		health.averageResponseTime !== undefined
			? health.averageResponseTime >= 1000
				? `${(health.averageResponseTime / 1000).toFixed(1)}s`
				: `${Math.round(health.averageResponseTime)}ms`
			: null;

	if (!color && !lastCheck && !responseMs) return null;

	return (
		<div className="hidden sm:flex items-center gap-2 text-[11px] text-muted-foreground/70 shrink-0">
			{/* Health rate + colored dot */}
			{color && rate && (
				<span className="inline-flex items-center gap-1" style={{ color }}>
					<span
						className="h-1.5 w-1.5 rounded-full shrink-0 animate-pulse"
						style={{
							backgroundColor: color,
							boxShadow: `0 0 4px ${color}50`,
							animationDuration: color === SEMANTIC_COLORS.success.from ? "3s" : "1.5s",
						}}
					/>
					{rate}
				</span>
			)}
			{/* Avg response */}
			{responseMs && (
				<span className="inline-flex items-center gap-0.5">
					<Activity className="h-2.5 w-2.5" />
					{responseMs}
				</span>
			)}
			{/* Last checked */}
			{lastCheck && <span className="text-muted-foreground/50">{lastCheck}</span>}
		</div>
	);
};

/**
 * Highlights matching search term
 */
const HighlightedName = ({ name, term }: { name: string; term?: string }) => {
	if (!term?.trim()) return <>{name}</>;
	const lower = name.toLowerCase();
	const termLower = term.toLowerCase();
	const idx = lower.indexOf(termLower);
	if (idx === -1) return <>{name}</>;

	return (
		<>
			{name.slice(0, idx)}
			<mark
				className="bg-transparent font-bold"
				style={{
					color: "inherit",
					textDecoration: "underline",
					textDecorationThickness: "2px",
					textUnderlineOffset: "3px",
				}}
			>
				{name.slice(idx, idx + term.length)}
			</mark>
			{name.slice(idx + term.length)}
		</>
	);
};

/**
 * Capability dot — tiny inline indicator
 */
const CapDot = ({
	icon: Icon,
	label,
	color,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	color: string;
}) => (
	<span
		className="inline-flex items-center gap-0.5 text-[10px] font-medium"
		style={{ color }}
		title={label}
	>
		<Icon className="h-2.5 w-2.5" />
	</span>
);

// ============================================================================
// Main Component
// ============================================================================

/**
 * Indexer Row — Compact, Scannable
 *
 * Layout: [protocol pill] [name + capabilities] [health stats] [actions]
 * - Single-line for maximum scannability
 * - Protocol-colored left accent
 * - Health shown inline as tiny indicators
 * - Expand chevron rotates on open
 */
export const IndexerRow = ({
	indexer,
	instanceId,
	onTest,
	onUpdate,
	testing,
	expanded,
	onToggleDetails,
	searchTerm,
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
	searchTerm?: string;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const isDisabled = !indexer.enable;

	const protocolColor =
		indexer.protocol === "torrent" ? PROTOCOL_COLORS.torrent : PROTOCOL_COLORS.usenet;

	return (
		<div className="overflow-hidden">
			{/* Main row — clickable to expand */}
			<div
				className={`group flex items-center gap-3 px-4 py-3 transition-all duration-200 cursor-pointer select-none ${
					expanded ? "bg-card/50" : "hover:bg-card/30"
				} ${isDisabled ? "opacity-50" : ""}`}
				style={{
					borderLeft: `3px solid ${isDisabled ? "rgba(var(--border), 0.3)" : protocolColor}`,
				}}
				onClick={onToggleDetails}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onToggleDetails();
					}
				}}
				role="button"
				tabIndex={0}
			>
				{/* Protocol pill */}
				<ProtocolPill protocol={indexer.protocol} />

				{/* Name + capabilities */}
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{/* Enable/disable indicator */}
					<div
						className="h-1.5 w-1.5 rounded-full shrink-0"
						style={{
							backgroundColor: indexer.enable
								? SEMANTIC_COLORS.success.from
								: "rgba(var(--border), 0.5)",
							boxShadow: indexer.enable
								? `0 0 4px ${SEMANTIC_COLORS.success.from}40`
								: "none",
						}}
						title={indexer.enable ? "Enabled" : "Disabled"}
					/>

					<span className="font-medium text-sm text-foreground truncate">
						{incognitoMode ? (
							getLinuxIndexer(indexer.name)
						) : (
							<HighlightedName name={indexer.name} term={searchTerm} />
						)}
					</span>

					{/* Capability dots */}
					{indexer.enable && (
						<div className="hidden md:flex items-center gap-1 shrink-0">
							{indexer.supportsSearch && (
								<CapDot icon={Search} label="Search" color={`${themeGradient.from}80`} />
							)}
							{indexer.supportsRss && (
								<CapDot icon={Rss} label="RSS" color={`${themeGradient.from}80`} />
							)}
						</div>
					)}

					{/* Priority badge — only when non-default */}
					{typeof indexer.priority === "number" && indexer.priority > 0 && (
						<span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">
							P{indexer.priority}
						</span>
					)}
				</div>

				{/* Health indicators */}
				{indexer.enable && <HealthMiniBar health={indexer.health} />}

				{/* Actions — stop propagation to prevent row toggle */}
				<div className="flex items-center gap-1 shrink-0">
					{/* Test button — compact icon-only on small screens */}
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onTest(instanceId, indexer.id);
						}}
						disabled={testing}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-card/80"
						style={{
							color: themeGradient.from,
						}}
						title="Test indexer"
					>
						{testing ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<PlayCircle className="h-3.5 w-3.5" />
						)}
						<span className="hidden lg:inline">{testing ? "Testing" : "Test"}</span>
					</button>

					{/* Expand chevron */}
					<ChevronRight
						className={`h-4 w-4 text-muted-foreground/40 transition-transform duration-200 ${
							expanded ? "rotate-90" : "group-hover:text-muted-foreground"
						}`}
					/>
				</div>
			</div>

			{/* Details Panel */}
			<IndexerDetailsPanel
				instanceId={instanceId}
				indexer={indexer}
				expanded={expanded}
				onUpdate={onUpdate}
			/>
		</div>
	);
};
