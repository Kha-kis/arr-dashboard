"use client";

import type { HealthIssue, CombinedDiskStats } from "@arr/shared";
import { PremiumCard, StatCard } from "../../../components/layout";
import {
	useIncognitoMode,
	getLinuxInstanceName,
	anonymizeHealthMessage,
	getLinuxUrl,
} from "../../../lib/incognito";
import { getServiceGradient, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { formatBytes, formatPercent } from "../lib/formatters";
import { ServiceQuickCard } from "./service-quick-card";
import {
	AlertTriangle,
	CheckCircle2,
	HardDrive,
	ExternalLink,
	Tv,
	Film,
	Globe,
	Music,
	BookOpen,
} from "lucide-react";
import type { useStatisticsData } from "../hooks/useStatisticsData";
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
	onSwitchTab: (tab: StatisticsTab) => void;
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
	onSwitchTab,
}: OverviewTabProps) => {
	const [incognitoMode] = useIncognitoMode();

	return (
		<div className="flex flex-col gap-8">
			{/* Health Status */}
			{allHealthIssues.length > 0 ? (
				<PremiumCard
					title={`${allHealthIssues.length} Health ${allHealthIssues.length === 1 ? "Issue" : "Issues"} Detected`}
					description="Review and resolve issues across your instances"
					icon={AlertTriangle}
					gradientIcon
					animationDelay={200}
				>
					<div className="space-y-4">
						{allHealthIssues.map((issue) => (
							<div
								key={`${issue.service}-${issue.instanceId}-${issue.type}-${issue.message}`}
								className="flex flex-col gap-3 p-4 rounded-xl bg-background/50 border border-border/50"
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
											{incognitoMode ? getLinuxInstanceName(issue.instanceName) : issue.instanceName}
										</span>
									</div>
									<a
										href={`${incognitoMode ? getLinuxUrl(issue.instanceBaseUrl) : issue.instanceBaseUrl}/system/status`}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 bg-background/50 hover:bg-background transition-colors"
									>
										View
										<ExternalLink className="h-3 w-3" />
									</a>
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
				</PremiumCard>
			) : (
				<div
					className="flex items-center gap-4 p-6 rounded-2xl border border-border/50 bg-emerald-500/10 backdrop-blur-xs animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
				>
					<div
						className="flex h-12 w-12 items-center justify-center rounded-xl"
						style={{
							background: "linear-gradient(135deg, #10b981, #059669)",
							boxShadow: "0 8px 24px -8px rgba(16, 185, 129, 0.5)",
						}}
					>
						<CheckCircle2 className="h-6 w-6 text-white" />
					</div>
					<div>
						<h3 className="text-lg font-semibold text-emerald-400">All Systems Healthy</h3>
						<p className="text-sm text-muted-foreground">
							No health issues detected across all configured instances
						</p>
					</div>
				</div>
			)}

			{/* Summary Stats Grid */}
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
					description={`of ${formatBytes(combinedDisk.diskTotal)} available`}
					icon={HardDrive}
					animationDelay={550}
				/>
			</div>

			{/* Service Quick Stats */}
			<div
				className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
			>
				<ServiceQuickCard
					name="Sonarr"
					icon={Tv}
					gradient={SERVICE_GRADIENTS.sonarr}
					onViewDetails={() => onSwitchTab("sonarr")}
					stats={[
						{ label: "Series", value: sonarrTotals.totalSeries },
						{ label: "Downloaded", value: formatPercent(sonarrTotals.downloadPercent), highlight: true },
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
						{ label: "Downloaded", value: formatPercent(radarrTotals.downloadPercent), highlight: true },
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
						{ label: "Downloaded", value: formatPercent(lidarrTotals.downloadPercent), highlight: true },
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
						{ label: "Downloaded", value: formatPercent(readarrTotals.downloadPercent), highlight: true },
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
			</div>
		</div>
	);
};
