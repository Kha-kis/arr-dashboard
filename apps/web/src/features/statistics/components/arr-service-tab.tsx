"use client";

import type { LucideIcon } from "lucide-react";
import { Activity, BarChart3, CheckCircle2, AlertTriangle, TrendingUp } from "lucide-react";
import { PremiumCard, StatCard } from "../../../components/layout";
import { QualityBreakdown } from "../../../components/presentational/quality-breakdown";
import { formatBytes, formatPercent, formatRuntime } from "../lib/formatters";
import type { ServiceGradient } from "../../../lib/theme-gradients";
import { useIncognitoMode, getLinuxInstanceName } from "../../../lib/incognito";
import type { useStatisticsData } from "../hooks/useStatisticsData";

const integer = new Intl.NumberFormat();

// ── Derived types from useStatisticsData ──

type StatisticsData = ReturnType<typeof useStatisticsData>;

type SonarrTotals = StatisticsData["sonarrTotals"];
type RadarrTotals = StatisticsData["radarrTotals"];
type LidarrTotals = StatisticsData["lidarrTotals"];
type ReadarrTotals = StatisticsData["readarrTotals"];

type SonarrRow = StatisticsData["sonarrRows"][number];
type RadarrRow = StatisticsData["radarrRows"][number];
type LidarrRow = StatisticsData["lidarrRows"][number];
type ReadarrRow = StatisticsData["readarrRows"][number];

type ArrTotals = SonarrTotals | RadarrTotals | LidarrTotals | ReadarrTotals;
type ArrRow = SonarrRow | RadarrRow | LidarrRow | ReadarrRow;

export type ArrServiceType = "sonarr" | "radarr" | "lidarr" | "readarr";

// ── Service variant definitions ──

// Generic for type-safe variant definitions; `any` defaults for type-erased component use.
// Each concrete variant is annotated with its service-specific types so field access
// (e.g. t.totalSeries, r.downloadedEpisodes) is compile-time checked.
// The `any` default is necessary because TypeScript's strict function parameter
// contravariance prevents narrower parameter types from widening to a union.
// biome-ignore lint/suspicious/noExplicitAny: Strategy pattern requires type erasure at the component boundary
interface ServiceVariant<TTotals = any, TRow = any> {
	/** Primary stat grid: 4 cards across the top */
	primaryStats: (totals: TTotals) => Array<{ value: string | number; label: string; icon: LucideIcon; animationDelay: number }>;
	/** Secondary stat grid: 4 cards in the second row */
	secondaryStats: (totals: TTotals) => Array<{ value: string | number; label: string; description?: string; animationDelay: number }>;
	/** Table column headers */
	columns: string[];
	/** Table row cells (must match columns order) */
	rowCells: (row: TRow) => Array<string | number>;
	/** Empty state message */
	emptyMessage: string;
	/** Instance table description */
	tableDescription: string;
	/** Primary count field for progress column */
	progressField: "downloadedPercentage";
}

const SONARR_VARIANT: ServiceVariant<SonarrTotals, SonarrRow> = {
	primaryStats: (t) => [
		{ value: t.totalSeries, label: "Series", icon: TrendingUp, animationDelay: 200 },
		{ value: t.monitoredSeries, label: "Monitored", icon: Activity, animationDelay: 250 },
		{ value: t.continuingSeries, label: "Continuing", icon: TrendingUp, animationDelay: 300 },
		{ value: t.endedSeries, label: "Ended", icon: CheckCircle2, animationDelay: 350 },
	],
	secondaryStats: (t) => [
		{ value: t.downloadedEpisodes, label: "Downloaded", description: "Episodes", animationDelay: 400 },
		{ value: t.missingEpisodes, label: "Missing", description: "Episodes", animationDelay: 450 },
		{ value: formatPercent(t.downloadPercent), label: "Complete", description: "Download progress", animationDelay: 500 },
		{ value: t.cutoffUnmetCount, label: "Cutoff Unmet", description: "Eligible for upgrade", animationDelay: 550 },
	],
	columns: ["Instance", "Series", "Monitored", "Downloaded", "Missing", "Progress"],
	rowCells: (r) => [r.totalSeries, r.monitoredSeries, r.downloadedEpisodes, r.missingEpisodes],
	emptyMessage: "No Sonarr instances configured.",
	tableDescription: "Per-instance breakdown of your Sonarr servers",
	progressField: "downloadedPercentage",
};

const RADARR_VARIANT: ServiceVariant<RadarrTotals, RadarrRow> = {
	primaryStats: (t) => [
		{ value: t.totalMovies, label: "Movies", icon: TrendingUp, animationDelay: 200 },
		{ value: t.monitoredMovies, label: "Monitored", icon: Activity, animationDelay: 250 },
		{ value: t.downloadedMovies, label: "Downloaded", icon: CheckCircle2, animationDelay: 300 },
		{ value: t.missingMovies, label: "Missing", icon: AlertTriangle, animationDelay: 350 },
	],
	secondaryStats: (t) => [
		{ value: formatPercent(t.downloadPercent), label: "Complete", description: "Download progress", animationDelay: 400 },
		{ value: t.cutoffUnmetCount, label: "Cutoff Unmet", description: "Eligible for upgrade", animationDelay: 450 },
		{ value: formatBytes(t.averageMovieSize), label: "Avg Size", description: "Per movie", animationDelay: 500 },
		{ value: formatRuntime(t.totalRuntime), label: "Runtime", description: "Total duration", animationDelay: 550 },
	],
	columns: ["Instance", "Movies", "Monitored", "Downloaded", "Missing", "Progress"],
	rowCells: (r) => [r.totalMovies, r.monitoredMovies, r.downloadedMovies, r.missingMovies],
	emptyMessage: "No Radarr instances configured.",
	tableDescription: "Per-instance breakdown of your Radarr servers",
	progressField: "downloadedPercentage",
};

const LIDARR_VARIANT: ServiceVariant<LidarrTotals, LidarrRow> = {
	primaryStats: (t) => [
		{ value: t.totalArtists, label: "Artists", icon: TrendingUp, animationDelay: 200 },
		{ value: t.monitoredArtists, label: "Monitored", icon: Activity, animationDelay: 250 },
		{ value: t.totalAlbums, label: "Albums", icon: TrendingUp, animationDelay: 300 },
		{ value: t.monitoredAlbums, label: "Monitored Albums", icon: Activity, animationDelay: 350 },
	],
	secondaryStats: (t) => [
		{ value: t.downloadedTracks, label: "Downloaded", description: "Tracks", animationDelay: 400 },
		{ value: t.missingTracks, label: "Missing", description: "Tracks", animationDelay: 450 },
		{ value: formatPercent(t.downloadPercent), label: "Complete", description: "Download progress", animationDelay: 500 },
		{ value: t.cutoffUnmetCount ?? 0, label: "Cutoff Unmet", description: "Eligible for upgrade", animationDelay: 550 },
	],
	columns: ["Instance", "Artists", "Albums", "Downloaded", "Missing", "Progress"],
	rowCells: (r) => [r.totalArtists, r.totalAlbums, r.downloadedTracks, r.missingTracks],
	emptyMessage: "No Lidarr instances configured.",
	tableDescription: "Per-instance breakdown of your Lidarr servers",
	progressField: "downloadedPercentage",
};

const READARR_VARIANT: ServiceVariant<ReadarrTotals, ReadarrRow> = {
	primaryStats: (t) => [
		{ value: t.totalAuthors, label: "Authors", icon: TrendingUp, animationDelay: 200 },
		{ value: t.monitoredAuthors, label: "Monitored", icon: Activity, animationDelay: 250 },
		{ value: t.totalBooks, label: "Books", icon: TrendingUp, animationDelay: 300 },
		{ value: t.monitoredBooks, label: "Monitored Books", icon: Activity, animationDelay: 350 },
	],
	secondaryStats: (t) => [
		{ value: t.downloadedBooks, label: "Downloaded", description: "Books", animationDelay: 400 },
		{ value: t.missingBooks, label: "Missing", description: "Books", animationDelay: 450 },
		{ value: formatPercent(t.downloadPercent), label: "Complete", description: "Download progress", animationDelay: 500 },
		{ value: t.cutoffUnmetCount ?? 0, label: "Cutoff Unmet", description: "Eligible for upgrade", animationDelay: 550 },
	],
	columns: ["Instance", "Authors", "Books", "Downloaded", "Missing", "Progress"],
	rowCells: (r) => [r.totalAuthors, r.totalBooks, r.downloadedBooks, r.missingBooks],
	emptyMessage: "No Readarr instances configured.",
	tableDescription: "Per-instance breakdown of your Readarr servers",
	progressField: "downloadedPercentage",
};

export const SERVICE_VARIANTS: Record<ArrServiceType, ServiceVariant> = {
	sonarr: SONARR_VARIANT,
	radarr: RADARR_VARIANT,
	lidarr: LIDARR_VARIANT,
	readarr: READARR_VARIANT,
};

// ── Component ──

interface ArrServiceTabProps {
	serviceType: ArrServiceType;
	icon: LucideIcon;
	gradient: ServiceGradient;
	totals: ArrTotals;
	rows: ArrRow[];
}

export const ArrServiceTab = ({
	serviceType,
	icon: ServiceIcon,
	gradient,
	totals,
	rows,
}: ArrServiceTabProps) => {
	const [incognitoMode] = useIncognitoMode();
	const variant = SERVICE_VARIANTS[serviceType];

	const primaryStats = variant.primaryStats(totals);
	const secondaryStats = variant.secondaryStats(totals);

	return (
		<div className="flex flex-col gap-6">
			{/* Primary Stats Grid */}
			<div
				className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{primaryStats.map((stat) => (
					<StatCard
						key={stat.label}
						value={stat.value}
						label={stat.label}
						icon={stat.icon}
						gradient={gradient}
						animationDelay={stat.animationDelay}
					/>
				))}
			</div>

			{/* Secondary Stats Grid */}
			<div
				className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
			>
				{secondaryStats.map((stat) => (
					<StatCard
						key={stat.label}
						value={stat.value}
						label={stat.label}
						description={stat.description}
						animationDelay={stat.animationDelay}
					/>
				))}
			</div>

			{/* Quality & Tags */}
			<div
				className="grid gap-6 lg:grid-cols-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
			>
				<PremiumCard title="Quality Distribution" icon={BarChart3} gradientIcon={false} showHeader>
					<QualityBreakdown breakdown={totals.qualityBreakdown} />
				</PremiumCard>
				{totals.tagBreakdown && Object.keys(totals.tagBreakdown).length > 0 && (
					<PremiumCard title="Tag Distribution" icon={BarChart3} gradientIcon={false} showHeader>
						<QualityBreakdown breakdown={totals.tagBreakdown} />
					</PremiumCard>
				)}
			</div>

			{/* Instance Table */}
			<PremiumCard
				title="Instance Details"
				description={variant.tableDescription}
				icon={ServiceIcon}
				gradientIcon={false}
				animationDelay={500}
			>
				{rows.length === 0 ? (
					<p className="text-muted-foreground text-center py-8">{variant.emptyMessage}</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border/50">
									{variant.columns.map((col) => (
										<th
											key={col}
											className={`${col === "Instance" ? "text-left" : "text-right"} py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide`}
										>
											{col}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-border/30">
								{rows.map((row) => {
									const cells = variant.rowCells(row);
									return (
										<tr key={row.instanceId} className="hover:bg-muted/20 transition-colors">
											<td className="py-3 px-4 font-medium">
												{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
											</td>
											{cells.map((cell, i) => (
												<td key={variant.columns[i + 1]} className="py-3 px-4 text-right">
													{integer.format(Number(cell))}
												</td>
											))}
											<td className="py-3 px-4 text-right">
												<span style={{ color: gradient.from }}>
													{formatPercent(row[variant.progressField])}
												</span>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</PremiumCard>
		</div>
	);
};
