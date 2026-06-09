"use client";

import type { CombinedDiskStats, HealthIssue } from "@arr/shared";
import {
	Activity,
	AlertTriangle,
	BookOpen,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Film,
	Globe,
	HardDrive,
	Music,
	Tv,
} from "lucide-react";
import { useMemo, useState } from "react";
import { StatCard } from "../../../components/layout";
import { useTautulliPlaysByDate, useTautulliStats } from "../../../hooks/api/useTautulli";
import {
	anonymizeHealthMessage,
	getLinuxInstanceName,
	getLinuxUrl,
	useIncognitoMode,
} from "../../../lib/incognito";
import { getServiceGradient, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import type { useStatisticsData } from "../hooks/useStatisticsData";
import { formatBytes, formatPercent } from "../lib/formatters";
import { DiskBreakdownPanel } from "./disk-breakdown-panel";
import { ServiceQuickCard } from "./service-quick-card";
import type { StatisticsTab } from "./statistics-tabs";

type StatisticsData = ReturnType<typeof useStatisticsData>;

interface OverviewTabProps {
	allHealthIssues: HealthIssue[];
	combinedDisk: CombinedDiskStats;
	sonarrRows: StatisticsData["sonarrRows"];
	radarrRows: StatisticsData["radarrRows"];
	lidarrRows: StatisticsData["lidarrRows"];
	readarrRows: StatisticsData["readarrRows"];
	prowlarrRows: StatisticsData["prowlarrRows"];
	sonarrTotals: StatisticsData["sonarrTotals"];
	radarrTotals: StatisticsData["radarrTotals"];
	lidarrTotals: StatisticsData["lidarrTotals"];
	readarrTotals: StatisticsData["readarrTotals"];
	prowlarrTotals: StatisticsData["prowlarrTotals"];
	hasTautulli: boolean;
	onSwitchTab: (tab: StatisticsTab) => void;
}

function formatDuration(seconds: number): string {
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.round((seconds % 3600) / 60);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remH = hours % 24;
		return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
	}
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export const OverviewTab = ({
	allHealthIssues,
	combinedDisk,
	sonarrRows,
	radarrRows,
	lidarrRows,
	readarrRows,
	prowlarrRows,
	sonarrTotals,
	radarrTotals,
	lidarrTotals,
	readarrTotals,
	prowlarrTotals,
	hasTautulli,
	onSwitchTab,
}: OverviewTabProps) => {
	const [incognitoMode] = useIncognitoMode();
	const [healthExpanded, setHealthExpanded] = useState(false);

	// Transparency for the combined storage figure (#495). When the root-folder
	// filter actually EXCLUDED non-media disks, surface that as "N of M disks
	// (media only)" so the headline number is auditable from the card itself;
	// the user can then expand the breakdown for the per-disk detail.
	//
	// The gate is "at least one no-matching-root-folder exclusion", NOT a raw
	// count comparison: the breakdown array also contains `deduplicated`
	// entries (the issue-#486 shared-array case), and for a 4-instances-on-1-
	// array user with no root-folder filtering, `disks.length (4) > diskCount
	// (1)` is true purely from dedup — that user must keep seeing the original
	// "1 disk across 4 instances" line, not a misleading "(media only)".
	const breakdownDisks = combinedDisk.disks ?? [];
	const reportedDiskCount = breakdownDisks.length;
	const hasNonMediaExclusions = breakdownDisks.some((d) => d.reason === "no-matching-root-folder");
	const storageDescription = (() => {
		const base = `of ${formatBytes(combinedDisk.diskTotal)} available`;
		const { diskCount, instanceCount } = combinedDisk;
		if (reportedDiskCount > 0 && diskCount && hasNonMediaExclusions) {
			return `${base} · ${diskCount} of ${reportedDiskCount} disks (media only)`;
		}
		if (!diskCount || !instanceCount || instanceCount <= 1) return base;
		const disks = `${diskCount} disk${diskCount === 1 ? "" : "s"}`;
		return `${base} · ${disks} across ${instanceCount} instances`;
	})();
	const [storageBreakdownOpen, setStorageBreakdownOpen] = useState(false);

	// Fetch Plex summary data when Tautulli is available
	const { data: tautulliStats } = useTautulliStats(30, hasTautulli);
	const { data: tautulliPlays } = useTautulliPlaysByDate(30, hasTautulli);

	const plexSummary = useMemo(() => {
		if (!tautulliStats?.userStats && !tautulliPlays?.series) return null;
		// Total plays from plays-by-date (matches Plex tab calculation)
		const totalPlays = tautulliPlays?.series
			? tautulliPlays.series.reduce(
					(acc: number, s: { data: number[] }) =>
						acc + s.data.reduce((a: number, b: number) => a + b, 0),
					0,
				)
			: 0;
		const totalDuration = tautulliStats?.userStats
			? tautulliStats.userStats.reduce(
					(acc: number, u: { totalDuration: number }) => acc + u.totalDuration,
					0,
				)
			: 0;
		return {
			activeUsers: tautulliStats?.userStats?.length ?? 0,
			totalPlays,
			totalDuration,
		};
	}, [tautulliStats, tautulliPlays]);

	return (
		<div className="flex flex-col gap-8">
			{/* Health Status — compact collapsible banner */}
			{allHealthIssues.length > 0 ? (
				<div
					className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
				>
					<button
						type="button"
						onClick={() => setHealthExpanded(!healthExpanded)}
						className="w-full flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-amber-500/[0.03]"
					>
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
							style={{
								background: "linear-gradient(135deg, #f59e0b20, #d9770620)",
							}}
						>
							<AlertTriangle className="h-4 w-4 text-amber-500" />
						</div>
						<div className="flex-1 text-left min-w-0">
							<span className="text-sm font-semibold text-amber-400">
								{allHealthIssues.length} Health {allHealthIssues.length === 1 ? "Issue" : "Issues"}
							</span>
							<span className="text-xs text-muted-foreground/50 ml-2">across your instances</span>
						</div>
						{healthExpanded ? (
							<ChevronUp className="h-4 w-4 text-muted-foreground/50 shrink-0" />
						) : (
							<ChevronDown className="h-4 w-4 text-muted-foreground/50 shrink-0" />
						)}
					</button>

					{healthExpanded && (
						<div className="px-5 pb-4 space-y-3 border-t border-amber-500/10 pt-3 animate-in fade-in slide-in-from-top-1 duration-200">
							{allHealthIssues.map((issue) => (
								<div
									key={`${issue.service}-${issue.instanceId}-${issue.type}-${issue.message}`}
									className="flex flex-col gap-2 p-3.5 rounded-xl bg-background/50 border border-border/50"
								>
									<div className="flex items-start justify-between gap-4">
										<div className="flex items-center gap-3">
											{(() => {
												const serviceGradient = getServiceGradient(issue.service);
												return (
													<span
														className="px-2 py-1 rounded-lg text-xs font-medium uppercase"
														style={{
															background: `linear-gradient(135deg, ${serviceGradient.from}20, ${serviceGradient.to}20)`,
															color: serviceGradient.from,
														}}
													>
														{issue.service}
													</span>
												);
											})()}
											<span className="text-sm text-muted-foreground">
												{incognitoMode
													? getLinuxInstanceName(issue.instanceName)
													: issue.instanceName}
											</span>
										</div>
										{(() => {
											// Prefer externalUrl so links resolve behind reverse proxies (#354);
											// baseUrl is only reachable from inside the LAN/container network.
											const instanceUrl = issue.instanceExternalUrl ?? issue.instanceBaseUrl;
											return (
												<a
													href={`${incognitoMode ? getLinuxUrl(instanceUrl) : instanceUrl}/system/status`}
													target="_blank"
													rel="noopener noreferrer"
													className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 bg-background/50 hover:bg-background transition-colors shrink-0"
												>
													View
													<ExternalLink className="h-3 w-3" />
												</a>
											);
										})()}
									</div>
									<p className="text-sm">
										{incognitoMode ? anonymizeHealthMessage(issue.message) : issue.message}
									</p>
									{issue.source && (
										<p className="text-xs text-muted-foreground">Source: {issue.source}</p>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			) : (
				<div
					className="flex items-center gap-4 p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
				>
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
						style={{
							background: "linear-gradient(135deg, #10b98120, #05966920)",
						}}
					>
						<CheckCircle2 className="h-4 w-4 text-emerald-400" />
					</div>
					<div>
						<span className="text-sm font-semibold text-emerald-400">All Systems Healthy</span>
						<span className="text-xs text-muted-foreground/50 ml-2">
							No issues detected across all instances
						</span>
					</div>
				</div>
			)}

			{/* Storage + Instance Summary — compact row */}
			<div
				className="grid gap-4 md:grid-cols-3 lg:grid-cols-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
			>
				<StatCard
					value={sonarrRows.length}
					label="Sonarr"
					description={`${sonarrTotals.totalSeries} series total`}
					icon={Tv}
					gradient={SERVICE_GRADIENTS.sonarr}
					onClick={() => onSwitchTab("sonarr")}
					animationDelay={300}
				/>
				<StatCard
					value={radarrRows.length}
					label="Radarr"
					description={`${radarrTotals.totalMovies} movies total`}
					icon={Film}
					gradient={SERVICE_GRADIENTS.radarr}
					onClick={() => onSwitchTab("radarr")}
					animationDelay={350}
				/>
				<StatCard
					value={lidarrRows.length}
					label="Lidarr"
					description={`${lidarrTotals.totalArtists} artists total`}
					icon={Music}
					gradient={SERVICE_GRADIENTS.lidarr}
					onClick={() => onSwitchTab("lidarr")}
					animationDelay={400}
				/>
				<StatCard
					value={readarrRows.length}
					label="Readarr"
					description={`${readarrTotals.totalAuthors} authors total`}
					icon={BookOpen}
					gradient={SERVICE_GRADIENTS.readarr}
					onClick={() => onSwitchTab("readarr")}
					animationDelay={450}
				/>
				<StatCard
					value={prowlarrRows.length}
					label="Prowlarr"
					description={`${prowlarrTotals.totalIndexers} indexers total`}
					icon={Globe}
					gradient={SERVICE_GRADIENTS.prowlarr}
					onClick={() => onSwitchTab("prowlarr")}
					animationDelay={500}
				/>
				<StatCard
					value={formatBytes(combinedDisk.diskUsed)}
					label="Storage"
					description={storageDescription}
					icon={HardDrive}
					animationDelay={550}
				/>
			</div>

			{/* Per-disk breakdown — explains how the combined storage figure was
			    computed (#495). Hidden by default; toggleable from the small text
			    affordance below. Skipped entirely if the backend didn't return any
			    breakdown entries (e.g. no instances reporting storage). */}
			{breakdownDisks.length > 0 ? (
				<div
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "600ms", animationFillMode: "backwards" }}
				>
					<button
						type="button"
						onClick={() => setStorageBreakdownOpen((v) => !v)}
						className="text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						{storageBreakdownOpen
							? "Hide storage breakdown ▴"
							: `Show storage breakdown (${breakdownDisks.length} disks) ▾`}
					</button>
					{storageBreakdownOpen ? (
						<div className="mt-3">
							<DiskBreakdownPanel disks={breakdownDisks} />
						</div>
					) : null}
				</div>
			) : null}

			{/* Service Quick Stats */}
			<div
				className={`grid gap-6 md:grid-cols-2 lg:grid-cols-3 ${hasTautulli ? "xl:grid-cols-3" : "xl:grid-cols-5"} animate-in fade-in slide-in-from-bottom-4 duration-500`}
				style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
			>
				<ServiceQuickCard
					name="Sonarr"
					icon={Tv}
					gradient={SERVICE_GRADIENTS.sonarr}
					onViewDetails={() => onSwitchTab("sonarr")}
					stats={[
						{ label: "Series", value: sonarrTotals.totalSeries },
						{
							label: "Downloaded",
							value: formatPercent(sonarrTotals.downloadPercent),
							highlight: true,
						},
						{ label: "Missing", value: sonarrTotals.missingEpisodes },
						{ label: "Disk Usage", value: formatPercent(sonarrTotals.diskPercent) },
					]}
				/>
				<ServiceQuickCard
					name="Radarr"
					icon={Film}
					gradient={SERVICE_GRADIENTS.radarr}
					onViewDetails={() => onSwitchTab("radarr")}
					stats={[
						{ label: "Movies", value: radarrTotals.totalMovies },
						{
							label: "Downloaded",
							value: formatPercent(radarrTotals.downloadPercent),
							highlight: true,
						},
						{ label: "Missing", value: radarrTotals.missingMovies },
						{ label: "Disk Usage", value: formatPercent(radarrTotals.diskPercent) },
					]}
				/>
				<ServiceQuickCard
					name="Lidarr"
					icon={Music}
					gradient={SERVICE_GRADIENTS.lidarr}
					onViewDetails={() => onSwitchTab("lidarr")}
					stats={[
						{ label: "Artists", value: lidarrTotals.totalArtists },
						{
							label: "Downloaded",
							value: formatPercent(lidarrTotals.downloadPercent),
							highlight: true,
						},
						{ label: "Missing", value: lidarrTotals.missingTracks },
						{ label: "Disk Usage", value: formatPercent(lidarrTotals.diskPercent) },
					]}
				/>
				<ServiceQuickCard
					name="Readarr"
					icon={BookOpen}
					gradient={SERVICE_GRADIENTS.readarr}
					onViewDetails={() => onSwitchTab("readarr")}
					stats={[
						{ label: "Authors", value: readarrTotals.totalAuthors },
						{
							label: "Downloaded",
							value: formatPercent(readarrTotals.downloadPercent),
							highlight: true,
						},
						{ label: "Missing", value: readarrTotals.missingBooks },
						{ label: "Disk Usage", value: formatPercent(readarrTotals.diskPercent) },
					]}
				/>
				<ServiceQuickCard
					name="Prowlarr"
					icon={Globe}
					gradient={SERVICE_GRADIENTS.prowlarr}
					onViewDetails={() => onSwitchTab("prowlarr")}
					stats={[
						{ label: "Indexers", value: prowlarrTotals.totalIndexers },
						{ label: "Active", value: prowlarrTotals.activeIndexers, highlight: true },
						{ label: "Total Queries", value: prowlarrTotals.totalQueries },
						{ label: "Grab Rate", value: formatPercent(prowlarrTotals.grabRate) },
					]}
				/>
				{hasTautulli && (
					<ServiceQuickCard
						name="Plex"
						icon={Activity}
						gradient={SERVICE_GRADIENTS.plex}
						onViewDetails={() => onSwitchTab("plex")}
						stats={[
							{ label: "Total Plays", value: plexSummary?.totalPlays ?? "—" },
							{
								label: "Active Users",
								value: plexSummary?.activeUsers ?? "—",
								highlight: true,
							},
							{
								label: "Watch Time",
								value: plexSummary ? formatDuration(plexSummary.totalDuration) : "—",
							},
							{ label: "Period", value: "30 days" },
						]}
					/>
				)}
			</div>
		</div>
	);
};
