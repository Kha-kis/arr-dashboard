"use client";

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
import { formatBytes, formatPercent } from "../lib/formatters";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

export const StatisticsClient = () => {
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
		<section className="flex flex-col gap-10">
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

			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to refresh one or more instances. Showing last known values.
					</AlertDescription>
				</Alert>
			)}

			<section className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-xl font-semibold text-fg">Sonarr</h2>
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
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<StatsCard
						title="Disk Usage"
						value={formatPercent(sonarrTotals.diskPercent)}
						description={`${formatBytes(sonarrTotals.diskUsed)} used / ${formatBytes(sonarrTotals.diskTotal)} total`}
					/>
					<StatsCard title="Avg Episode Size" value={formatBytes(sonarrTotals.averageEpisodeSize)} />
					<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
						<p className="mb-3 text-xs uppercase text-fg-muted">Quality Distribution</p>
						<QualityBreakdown breakdown={sonarrTotals.qualityBreakdown} />
					</div>
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
			</section>

			<section className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-xl font-semibold text-fg">Radarr</h2>
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
				<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3">
					<p className="mb-3 text-xs uppercase text-fg-muted">Quality Distribution</p>
					<QualityBreakdown breakdown={radarrTotals.qualityBreakdown} />
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
			</section>

			<section className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-xl font-semibold text-fg">Prowlarr</h2>
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
			</section>
		</section>
	);
};
