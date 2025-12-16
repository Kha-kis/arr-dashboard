"use client";

import { useState } from "react";
import type { ProwlarrIndexerStat } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription, AlertTitle, Skeleton } from "../../../components/ui";
import {
	useIncognitoMode,
	getLinuxIndexer,
	getLinuxInstanceName,
	anonymizeHealthMessage,
	getLinuxUrl,
} from "../../../lib/incognito";
import { useStatisticsData } from "../hooks/useStatisticsData";
import { StatsCard } from "../../../components/presentational/stats-card";
import { QualityBreakdown } from "../../../components/presentational/quality-breakdown";
import { InstanceTable } from "../../../components/presentational/instance-table";
import { formatBytes, formatPercent, formatRuntime } from "../lib/formatters";
import { StatisticsTabs, type StatisticsTab } from "./statistics-tabs";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

export const StatisticsClient = () => {
	const [activeTab, setActiveTab] = useState<StatisticsTab>("overview");
	const {
		isLoading,
		isFetching,
		error,
		refetch,
		sonarrRows,
		radarrRows,
		prowlarrRows,
		sonarrTotals,
		radarrTotals,
		prowlarrTotals,
		allHealthIssues,
	} = useStatisticsData();

	const [incognitoMode] = useIncognitoMode();

	if (isLoading) {
		return (
			<div className="flex h-64 items-center justify-center">
				<Skeleton className="h-10 w-10 rounded-full" />
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-6">
			<header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div>
					<p className="text-sm font-medium uppercase text-fg-muted">Systems overview</p>
					<h1 className="text-3xl font-semibold text-fg">Statistics</h1>
				</div>
				<div className="flex items-center gap-3 text-sm text-fg-muted">
					<span>Aggregated health and library metrics across all configured instances.</span>
					<Button
						variant="ghost"
						onClick={() => void refetch()}
						disabled={isFetching}
						aria-busy={isFetching}
					>
						{isFetching ? "Refreshing..." : "Refresh"}
					</Button>
				</div>
			</header>

			<StatisticsTabs
				activeTab={activeTab}
				onTabChange={setActiveTab}
				sonarrCount={sonarrRows.length}
				radarrCount={radarrRows.length}
				prowlarrCount={prowlarrRows.length}
				healthIssueCount={allHealthIssues.length}
			/>

			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to refresh one or more instances. Showing last known values.
					</AlertDescription>
				</Alert>
			)}

			{/* Overview Tab */}
			{activeTab === "overview" && (
				<div className="flex flex-col gap-8">
					{allHealthIssues.length > 0 && (
						<Alert variant="warning">
							<AlertTitle>
								{allHealthIssues.length} Health {allHealthIssues.length === 1 ? "Issue" : "Issues"}{" "}
								Detected
							</AlertTitle>
							<AlertDescription>
								<div className="mt-2 space-y-3">
									{allHealthIssues.map((issue) => (
										<div
											key={`${issue.service}-${issue.instanceId}-${issue.type}-${issue.message}`}
											className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
										>
											<div className="flex items-start gap-3">
												<span className="min-w-[80px] pt-1 text-xs uppercase text-fg-muted">
													{issue.service}
												</span>
												<div className="flex-1 space-y-2">
													<a
														href={`${incognitoMode ? getLinuxUrl(issue.instanceBaseUrl) : issue.instanceBaseUrl}/system/status`}
														target="_blank"
														rel="noopener noreferrer"
														className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-1.5 text-sm font-medium transition-colors hover:border-border hover:bg-bg-subtle/80"
													>
														<span>
															View in{" "}
															{incognitoMode
																? getLinuxInstanceName(issue.instanceName)
																: issue.instanceName}
														</span>
														<svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
															/>
														</svg>
													</a>
													<p className="text-sm">
														{incognitoMode ? anonymizeHealthMessage(issue.message) : issue.message}
													</p>
													{issue.source && <p className="text-xs text-fg-muted">Source: {issue.source}</p>}
												</div>
											</div>
										</div>
									))}
								</div>
							</AlertDescription>
						</Alert>
					)}

					{allHealthIssues.length === 0 && (
						<Alert variant="success">
							<AlertTitle>All Systems Healthy</AlertTitle>
							<AlertDescription>
								No health issues detected across all configured instances.
							</AlertDescription>
						</Alert>
					)}

					{/* Summary Cards */}
					<div className="space-y-4">
						<h2 className="text-lg font-semibold text-fg">Summary</h2>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<StatsCard
								title="Sonarr Instances"
								value={sonarrRows.length}
								description={`${sonarrTotals.totalSeries} series total`}
							/>
							<StatsCard
								title="Radarr Instances"
								value={radarrRows.length}
								description={`${radarrTotals.totalMovies} movies total`}
							/>
							<StatsCard
								title="Prowlarr Instances"
								value={prowlarrRows.length}
								description={`${prowlarrTotals.totalIndexers} indexers total`}
							/>
							<StatsCard
								title="Total Storage"
								value={formatBytes(sonarrTotals.diskUsed + radarrTotals.diskUsed)}
								description={`of ${formatBytes(sonarrTotals.diskTotal + radarrTotals.diskTotal)} available`}
							/>
						</div>
					</div>

					{/* Quick Stats per Service */}
					<div className="grid gap-6 lg:grid-cols-3">
						<div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
							<h3 className="text-sm font-semibold text-fg uppercase tracking-wide">Sonarr</h3>
							<div className="space-y-2 text-sm">
								<div className="flex justify-between">
									<span className="text-fg-muted">Series</span>
									<span className="text-fg">{integer.format(sonarrTotals.totalSeries)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Downloaded</span>
									<span className="text-fg">{formatPercent(sonarrTotals.downloadPercent)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Missing</span>
									<span className="text-fg">{integer.format(sonarrTotals.missingEpisodes)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Disk Usage</span>
									<span className="text-fg">{formatPercent(sonarrTotals.diskPercent)}</span>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="w-full"
								onClick={() => setActiveTab("sonarr")}
							>
								View Details
							</Button>
						</div>

						<div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
							<h3 className="text-sm font-semibold text-fg uppercase tracking-wide">Radarr</h3>
							<div className="space-y-2 text-sm">
								<div className="flex justify-between">
									<span className="text-fg-muted">Movies</span>
									<span className="text-fg">{integer.format(radarrTotals.totalMovies)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Downloaded</span>
									<span className="text-fg">{formatPercent(radarrTotals.downloadPercent)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Missing</span>
									<span className="text-fg">{integer.format(radarrTotals.missingMovies)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Disk Usage</span>
									<span className="text-fg">{formatPercent(radarrTotals.diskPercent)}</span>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="w-full"
								onClick={() => setActiveTab("radarr")}
							>
								View Details
							</Button>
						</div>

						<div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
							<h3 className="text-sm font-semibold text-fg uppercase tracking-wide">Prowlarr</h3>
							<div className="space-y-2 text-sm">
								<div className="flex justify-between">
									<span className="text-fg-muted">Indexers</span>
									<span className="text-fg">{integer.format(prowlarrTotals.totalIndexers)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Active</span>
									<span className="text-fg">{integer.format(prowlarrTotals.activeIndexers)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Total Queries</span>
									<span className="text-fg">{integer.format(prowlarrTotals.totalQueries)}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-fg-muted">Grab Rate</span>
									<span className="text-fg">{formatPercent(prowlarrTotals.grabRate)}</span>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="w-full"
								onClick={() => setActiveTab("prowlarr")}
							>
								View Details
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Sonarr Tab */}
			{activeTab === "sonarr" && (
				<div className="space-y-6">
					<div className="flex items-center justify-between">
						<h2 className="text-xl font-semibold text-fg">Sonarr Statistics</h2>
						<p className="text-sm text-fg-muted">Series coverage and disk utilisation.</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Series" value={sonarrTotals.totalSeries} />
						<StatsCard title="Monitored" value={sonarrTotals.monitoredSeries} />
						<StatsCard title="Continuing" value={sonarrTotals.continuingSeries} />
						<StatsCard title="Ended" value={sonarrTotals.endedSeries} />
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Downloaded Episodes" value={sonarrTotals.downloadedEpisodes} />
						<StatsCard title="Missing Episodes" value={sonarrTotals.missingEpisodes} />
						<StatsCard title="Downloaded %" value={formatPercent(sonarrTotals.downloadPercent)} />
						<StatsCard
							title="Cutoff Unmet"
							value={sonarrTotals.cutoffUnmetCount}
							description="Episodes eligible for upgrade"
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard
							title="Added (7 Days)"
							value={sonarrTotals.recentlyAdded7Days}
							description="Series added recently"
						/>
						<StatsCard
							title="Added (30 Days)"
							value={sonarrTotals.recentlyAdded30Days}
							description="Series added this month"
						/>
						<StatsCard
							title="Disk Usage"
							value={formatPercent(sonarrTotals.diskPercent)}
							description={`${formatBytes(sonarrTotals.diskUsed)} / ${formatBytes(sonarrTotals.diskTotal)}`}
						/>
						<StatsCard title="Avg Episode Size" value={formatBytes(sonarrTotals.averageEpisodeSize)} />
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
							<p className="mb-3 text-xs uppercase text-fg-muted">Quality Distribution</p>
							<QualityBreakdown breakdown={sonarrTotals.qualityBreakdown} />
						</div>
						{sonarrTotals.tagBreakdown && Object.keys(sonarrTotals.tagBreakdown).length > 0 && (
							<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
								<p className="mb-3 text-xs uppercase text-fg-muted">Tag Distribution</p>
								<QualityBreakdown breakdown={sonarrTotals.tagBreakdown} />
							</div>
						)}
					</div>
					<InstanceTable
						rows={sonarrRows}
						emptyMessage="No Sonarr instances configured."
						incognitoMode={incognitoMode}
						columns={[
							{ key: "totalSeries", label: "Series" },
							{ key: "monitoredSeries", label: "Monitored" },
							{ key: "downloadedEpisodes", label: "Downloaded" },
							{ key: "missingEpisodes", label: "Missing" },
							{
								key: "downloadedPercentage",
								label: "Downloaded %",
								formatter: (value) => formatPercent(value as number),
							},
						]}
					/>
				</div>
			)}

			{/* Radarr Tab */}
			{activeTab === "radarr" && (
				<div className="space-y-6">
					<div className="flex items-center justify-between">
						<h2 className="text-xl font-semibold text-fg">Radarr Statistics</h2>
						<p className="text-sm text-fg-muted">Movie library status and storage usage.</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Movies" value={radarrTotals.totalMovies} />
						<StatsCard title="Monitored" value={radarrTotals.monitoredMovies} />
						<StatsCard title="Downloaded" value={radarrTotals.downloadedMovies} />
						<StatsCard title="Missing" value={radarrTotals.missingMovies} />
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Downloaded %" value={formatPercent(radarrTotals.downloadPercent)} />
						<StatsCard
							title="Cutoff Unmet"
							value={radarrTotals.cutoffUnmetCount}
							description="Movies eligible for upgrade"
						/>
						<StatsCard title="Avg Movie Size" value={formatBytes(radarrTotals.averageMovieSize)} />
						<StatsCard
							title="Disk Usage"
							value={formatPercent(radarrTotals.diskPercent)}
							description={`${formatBytes(radarrTotals.diskUsed)} / ${formatBytes(radarrTotals.diskTotal)}`}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard
							title="Added (7 Days)"
							value={radarrTotals.recentlyAdded7Days}
							description="Movies added recently"
						/>
						<StatsCard
							title="Added (30 Days)"
							value={radarrTotals.recentlyAdded30Days}
							description="Movies added this month"
						/>
						<StatsCard
							title="Total Runtime"
							value={formatRuntime(radarrTotals.totalRuntime)}
							description="Combined movie duration"
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
							<p className="mb-3 text-xs uppercase text-fg-muted">Quality Distribution</p>
							<QualityBreakdown breakdown={radarrTotals.qualityBreakdown} />
						</div>
						{radarrTotals.tagBreakdown && Object.keys(radarrTotals.tagBreakdown).length > 0 && (
							<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
								<p className="mb-3 text-xs uppercase text-fg-muted">Tag Distribution</p>
								<QualityBreakdown breakdown={radarrTotals.tagBreakdown} />
							</div>
						)}
					</div>
					<InstanceTable
						rows={radarrRows}
						emptyMessage="No Radarr instances configured."
						incognitoMode={incognitoMode}
						columns={[
							{ key: "totalMovies", label: "Movies" },
							{ key: "monitoredMovies", label: "Monitored" },
							{ key: "downloadedMovies", label: "Downloaded" },
							{ key: "missingMovies", label: "Missing" },
							{
								key: "downloadedPercentage",
								label: "Downloaded %",
								formatter: (value) => formatPercent(value as number),
							},
						]}
					/>
				</div>
			)}

			{/* Prowlarr Tab */}
			{activeTab === "prowlarr" && (
				<div className="space-y-6">
					<div className="flex items-center justify-between">
						<h2 className="text-xl font-semibold text-fg">Prowlarr Statistics</h2>
						<p className="text-sm text-fg-muted">Indexer performance and activity.</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Indexers" value={prowlarrTotals.totalIndexers} />
						<StatsCard title="Active" value={prowlarrTotals.activeIndexers} />
						<StatsCard title="Paused" value={prowlarrTotals.pausedIndexers} />
						<StatsCard
							title="Avg Response"
							value={
								prowlarrTotals.averageResponseTime
									? `${percentFormatter.format(prowlarrTotals.averageResponseTime)} ms`
									: "-"
							}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatsCard title="Total Queries" value={prowlarrTotals.totalQueries} />
						<StatsCard
							title="Successful Queries"
							value={prowlarrTotals.successfulQueries ?? "-"}
							description={
								prowlarrTotals.totalQueries > 0
									? formatPercent(
											((prowlarrTotals.successfulQueries ?? 0) / prowlarrTotals.totalQueries) * 100,
										)
									: undefined
							}
						/>
						<StatsCard
							title="Failed Queries"
							value={prowlarrTotals.failedQueries ?? "-"}
							description={
								prowlarrTotals.totalQueries > 0
									? formatPercent(
											((prowlarrTotals.failedQueries ?? 0) / prowlarrTotals.totalQueries) * 100,
										)
									: undefined
							}
						/>
						<StatsCard title="Grab Rate" value={formatPercent(prowlarrTotals.grabRate)} />
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<StatsCard title="Total Grabs" value={prowlarrTotals.totalGrabs} />
						<StatsCard title="Successful Grabs" value={prowlarrTotals.successfulGrabs ?? "-"} />
					</div>
					<InstanceTable
						rows={prowlarrRows}
						emptyMessage="No Prowlarr instances configured."
						incognitoMode={incognitoMode}
						columns={[
							{ key: "totalIndexers", label: "Indexers" },
							{ key: "activeIndexers", label: "Active" },
							{ key: "pausedIndexers", label: "Paused" },
							{ key: "totalQueries", label: "Queries" },
							{ key: "totalGrabs", label: "Grabs" },
						]}
					/>
					{prowlarrTotals.indexers.length > 0 && (
						<div className="rounded-xl border border-border bg-bg-subtle p-4">
							<h3 className="text-lg font-semibold text-fg">Top Indexers</h3>
							<table className="mt-3 w-full table-fixed text-sm text-fg-muted">
								<thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
									<tr>
										<th className="w-2/5 py-2">Name</th>
										<th className="w-1/5 text-right">Queries</th>
										<th className="w-1/5 text-right">Grabs</th>
										<th className="w-1/5 text-right">Success</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border">
									{prowlarrTotals.indexers.map((indexer: ProwlarrIndexerStat, index: number) => (
										<tr key={`${index}-${indexer.name}`}>
											<td className="py-2 text-fg">
												{incognitoMode ? getLinuxIndexer(indexer.name) : indexer.name}
											</td>
											<td className="py-2 text-right text-fg-muted">{integer.format(indexer.queries)}</td>
											<td className="py-2 text-right text-fg-muted">{integer.format(indexer.grabs)}</td>
											<td className="py-2 text-right text-fg-muted">
												{formatPercent(indexer.successRate)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
		</section>
	);
};
