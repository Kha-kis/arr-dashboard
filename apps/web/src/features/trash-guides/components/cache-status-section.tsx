"use client";

import { RefreshCw, Database, Clock, AlertTriangle, Package } from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

interface CacheStatusEntry {
	serviceType: string;
	configType: string;
	version: number;
	itemCount: number;
	lastFetched: string;
	isStale: boolean;
}

interface CacheStatusSectionProps {
	serviceType: "RADARR" | "SONARR";
	statuses: CacheStatusEntry[];
	configTypeLabels: Record<string, string>;
	refreshing: boolean;
	onRefresh: () => void;
	isRefreshPending: boolean;
}

/**
 * Premium Cache Status Card
 */
const CacheStatusCard = ({
	configTypeLabel,
	version,
	itemCount,
	lastFetched,
	isStale,
}: {
	configTypeLabel: string;
	version: number;
	itemCount: number;
	lastFetched: string;
	isStale: boolean;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<article
			className="group rounded-2xl border p-5 transition-all duration-300 hover:shadow-lg hover:shadow-black/5"
			style={{
				backgroundColor: isStale ? SEMANTIC_COLORS.warning.bg : "rgba(var(--card), 0.3)",
				borderColor: isStale ? SEMANTIC_COLORS.warning.border : "rgba(var(--border), 0.5)",
			}}
		>
			<div className="flex items-start justify-between mb-4">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: isStale
								? `${SEMANTIC_COLORS.warning.from}20`
								: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: isStale
								? `1px solid ${SEMANTIC_COLORS.warning.border}`
								: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Package
							className="h-5 w-5"
							style={{ color: isStale ? SEMANTIC_COLORS.warning.from : themeGradient.from }}
						/>
					</div>
					<div>
						<h3 className="font-semibold text-foreground">{configTypeLabel}</h3>
						<p className="text-xs text-muted-foreground">Version {version}</p>
					</div>
				</div>
				{isStale && (
					<span
						className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
						style={{
							backgroundColor: SEMANTIC_COLORS.warning.bg,
							border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							color: SEMANTIC_COLORS.warning.text,
						}}
					>
						<AlertTriangle className="h-3 w-3" />
						Stale
					</span>
				)}
			</div>

			<div className="space-y-2.5">
				<div className="flex items-center gap-2.5 text-sm">
					<Database className="h-4 w-4 text-muted-foreground" />
					<span className="text-muted-foreground">
						<span className="font-medium text-foreground">{itemCount}</span> items cached
					</span>
				</div>
				<div className="flex items-center gap-2.5 text-sm">
					<Clock className="h-4 w-4 text-muted-foreground" />
					<span className="text-muted-foreground">
						Last fetched: <span className="text-foreground">{new Date(lastFetched).toLocaleString()}</span>
					</span>
				</div>
			</div>
		</article>
	);
};

/**
 * Premium Cache Status Section
 *
 * Displays cache status for a service type with:
 * - Theme-aware gradient header
 * - Premium card grid
 * - Animated refresh button
 * - Empty state handling
 */
export const CacheStatusSection = ({
	serviceType,
	statuses,
	configTypeLabels,
	refreshing,
	onRefresh,
	isRefreshPending,
}: CacheStatusSectionProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	// Service-specific colors (keep for identification)
	const serviceColor = serviceType === "RADARR" ? "#f97316" : "#06b6d4";

	return (
		<section className="space-y-6 animate-in fade-in duration-300">
			{/* Section Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `${serviceColor}20`,
							border: `1px solid ${serviceColor}30`,
						}}
					>
						<Database className="h-5 w-5" style={{ color: serviceColor }} />
					</div>
					<div>
						<h2
							className="text-xl font-bold"
							style={{ color: serviceColor }}
						>
							{serviceType}
						</h2>
						<p className="text-sm text-muted-foreground">
							{statuses.length} cache {statuses.length === 1 ? "entry" : "entries"}
						</p>
					</div>
				</div>

				<button
					type="button"
					onClick={onRefresh}
					disabled={refreshing || isRefreshPending}
					className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
					}}
				>
					<RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
					{refreshing ? "Refreshing..." : "Refresh All"}
				</button>
			</div>

			{/* Cache Cards Grid */}
			{statuses.length === 0 ? (
				<div
					className="rounded-2xl border border-dashed p-8 text-center"
					style={{
						borderColor: "rgba(var(--border), 0.5)",
						backgroundColor: "rgba(var(--card), 0.2)",
					}}
				>
					<Database className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
					<p className="text-muted-foreground font-medium">No cache entries for {serviceType}</p>
					<button
						type="button"
						onClick={onRefresh}
						disabled={refreshing || isRefreshPending}
						className="mt-4 text-sm font-medium transition-colors hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
						style={{ color: themeGradient.from }}
					>
						{refreshing ? "Initializing..." : "Click to initialize cache"}
					</button>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{statuses.map((status, index) => (
						<div
							key={`${status.serviceType}-${status.configType}`}
							className="animate-in fade-in slide-in-from-bottom-2"
							style={{
								animationDelay: `${index * 50}ms`,
								animationFillMode: "backwards",
							}}
						>
							<CacheStatusCard
								configTypeLabel={configTypeLabels[status.configType] ?? status.configType}
								version={status.version}
								itemCount={status.itemCount}
								lastFetched={status.lastFetched}
								isStale={status.isStale}
							/>
						</div>
					))}
				</div>
			)}
		</section>
	);
};
