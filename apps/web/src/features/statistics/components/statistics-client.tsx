"use client";

import { useMemo } from "react";
import type { SonarrStatistics, RadarrStatistics, ProwlarrStatistics, ProwlarrIndexerStat } from "@arr/shared";
import { useDashboardStatisticsQuery } from "../../../hooks/api/useDashboard";
import { Button } from "../../../components/ui/button";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const formatBytes = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 100 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
};

const getQualityLabel = (key: string): string => {
  const labels: Record<string, string> = {
    uhd4k: "4K/UHD",
    fullHd1080p: "1080p",
    hd720p: "720p",
    sd: "SD",
    unknown: "Unknown",
  };
  return labels[key] ?? key;
};

const formatPercent = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${percentFormatter.format(value)}%`;
};

interface StatsCardProps {
  title: string;
  value: string | number;
  description?: string;
}

const StatsCard = ({ title, value, description }: StatsCardProps) => (
  <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80">
    <p className="text-xs uppercase text-white/50">{title}</p>
    <p className="text-2xl font-semibold text-white">{typeof value === "number" ? integer.format(value) : value}</p>
    {description ? <p className="text-xs text-white/50">{description}</p> : null}
  </div>
);

interface QualityBreakdownProps {
  breakdown?: {
    uhd4k: number;
    fullHd1080p: number;
    hd720p: number;
    sd: number;
    unknown: number;
  };
}

const QualityBreakdown = ({ breakdown }: QualityBreakdownProps) => {
  if (!breakdown) return null;

  const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
  if (total === 0) return <p className="text-sm text-white/50">No quality data</p>;

  return (
    <div className="space-y-2">
      {Object.entries(breakdown).map(([key, count]) => {
        if (count === 0) return null;
        const percentage = (count / total) * 100;
        return (
          <div key={key} className="flex items-center gap-3">
            <div className="w-20 text-xs text-white/70">{getQualityLabel(key)}</div>
            <div className="flex-1">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-blue-500/80"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
            <div className="w-16 text-right text-xs text-white/70">
              {integer.format(count)} ({percentFormatter.format(percentage)}%)
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface InstanceRow {
  instanceId: string;
  instanceName: string;
}

interface InstanceTableColumn<Row> {
  key: keyof Row;
  label: string;
  align?: "left" | "right";
  formatter?: (value: Row[keyof Row]) => string;
}

interface InstanceTableProps<Row extends InstanceRow> {
  rows: Row[];
  emptyMessage: string;
  columns: InstanceTableColumn<Row>[];
}

const InstanceTable = <Row extends InstanceRow>({ rows, emptyMessage, columns }: InstanceTableProps<Row>) => {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-white/60">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
      <table className="min-w-full divide-y divide-white/10 text-sm text-white/80">
        <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
          <tr>
            <th className="px-4 py-3">Instance</th>
            {columns.map((column) => (
              <th
                key={String(column.key)}
                className={`px-4 py-3 ${column.align === "left" ? "text-left" : "text-right"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((row) => (
            <tr key={row.instanceId} className="hover:bg-white/10">
              <td className="px-4 py-3 text-white">{row.instanceName}</td>
              {columns.map((column) => {
                const raw = row[column.key];
                const formatted = column.formatter
                  ? column.formatter(raw)
                  : typeof raw === "number"
                    ? integer.format(raw)
                    : String(raw ?? "-");
                return (
                  <td
                    key={String(column.key)}
                    className={`px-4 py-3 text-white/70 ${column.align === "left" ? "text-left" : "text-right"}`}
                  >
                    {formatted}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const sum = <T,>(rows: Array<{ data: T }>, selector: (value: T) => number | undefined) =>
  rows.reduce((total, row) => total + (selector(row.data) ?? 0), 0);

const calculatePercent = (numerator: number, denominator: number) =>
  denominator > 0 ? (numerator / denominator) * 100 : 0;

const buildSonarrRows = (
  instances: Array<{ instanceId: string; instanceName: string; data: SonarrStatistics }>,
) => instances.map((entry) => ({ instanceId: entry.instanceId, instanceName: entry.instanceName, ...entry.data }));

const buildRadarrRows = (
  instances: Array<{ instanceId: string; instanceName: string; data: RadarrStatistics }>,
) => instances.map((entry) => ({ instanceId: entry.instanceId, instanceName: entry.instanceName, ...entry.data }));

const buildProwlarrRows = (
  instances: Array<{ instanceId: string; instanceName: string; data: ProwlarrStatistics }>,
) => instances.map((entry) => ({ instanceId: entry.instanceId, instanceName: entry.instanceName, ...entry.data }));

export const StatisticsClient = () => {
  const { data, isLoading, isFetching, error, refetch } = useDashboardStatisticsQuery();

  const sonarrInstances = data?.sonarr.instances ?? [];
  const radarrInstances = data?.radarr.instances ?? [];
  const prowlarrInstances = data?.prowlarr.instances ?? [];

  const sonarrRows = useMemo(() => buildSonarrRows(sonarrInstances), [sonarrInstances]);
  const radarrRows = useMemo(() => buildRadarrRows(radarrInstances), [radarrInstances]);
  const prowlarrRows = useMemo(() => buildProwlarrRows(prowlarrInstances), [prowlarrInstances]);

  const sonarrAggregate = data?.sonarr.aggregate;
  const radarrAggregate = data?.radarr.aggregate;
  const prowlarrAggregate = data?.prowlarr.aggregate;

  const sonarrTotals = {
    totalSeries: sonarrAggregate?.totalSeries ?? sum(sonarrInstances, (stats) => stats.totalSeries),
    monitoredSeries: sonarrAggregate?.monitoredSeries ?? sum(sonarrInstances, (stats) => stats.monitoredSeries),
    downloadedEpisodes: sonarrAggregate?.downloadedEpisodes ?? sum(sonarrInstances, (stats) => stats.downloadedEpisodes),
    missingEpisodes: sonarrAggregate?.missingEpisodes ?? sum(sonarrInstances, (stats) => stats.missingEpisodes),
    downloadPercent:
      sonarrAggregate?.downloadedPercentage ??
      calculatePercent(
        sum(sonarrInstances, (stats) => stats.downloadedEpisodes),
        Math.max(sum(sonarrInstances, (stats) => stats.totalEpisodes), 1),
      ),
    diskUsed: sonarrAggregate?.diskUsed ?? sum(sonarrInstances, (stats) => stats.diskUsed),
    diskTotal: sonarrAggregate?.diskTotal ?? sum(sonarrInstances, (stats) => stats.diskTotal),
    diskPercent:
      sonarrAggregate?.diskUsagePercent ??
      calculatePercent(
        sum(sonarrInstances, (stats) => stats.diskUsed),
        Math.max(sum(sonarrInstances, (stats) => stats.diskTotal), 1),
      ),
    healthIssues: sonarrAggregate?.healthIssues ?? sum(sonarrInstances, (stats) => stats.healthIssues),
  };

  const radarrTotals = {
    totalMovies: radarrAggregate?.totalMovies ?? sum(radarrInstances, (stats) => stats.totalMovies),
    monitoredMovies: radarrAggregate?.monitoredMovies ?? sum(radarrInstances, (stats) => stats.monitoredMovies),
    downloadedMovies: radarrAggregate?.downloadedMovies ?? sum(radarrInstances, (stats) => stats.downloadedMovies),
    missingMovies: radarrAggregate?.missingMovies ?? sum(radarrInstances, (stats) => stats.missingMovies),
    downloadPercent:
      radarrAggregate?.downloadedPercentage ??
      calculatePercent(
        sum(radarrInstances, (stats) => stats.downloadedMovies),
        Math.max(sum(radarrInstances, (stats) => stats.monitoredMovies), 1),
      ),
    diskUsed: radarrAggregate?.diskUsed ?? sum(radarrInstances, (stats) => stats.diskUsed),
    diskTotal: radarrAggregate?.diskTotal ?? sum(radarrInstances, (stats) => stats.diskTotal),
    diskPercent:
      radarrAggregate?.diskUsagePercent ??
      calculatePercent(
        sum(radarrInstances, (stats) => stats.diskUsed),
        Math.max(sum(radarrInstances, (stats) => stats.diskTotal), 1),
      ),
    healthIssues: radarrAggregate?.healthIssues ?? sum(radarrInstances, (stats) => stats.healthIssues),
  };

  const prowlarrTotals = {
    totalIndexers: prowlarrAggregate?.totalIndexers ?? sum(prowlarrInstances, (stats) => stats.totalIndexers),
    activeIndexers: prowlarrAggregate?.activeIndexers ?? sum(prowlarrInstances, (stats) => stats.activeIndexers),
    pausedIndexers: prowlarrAggregate?.pausedIndexers ?? sum(prowlarrInstances, (stats) => stats.pausedIndexers),
    totalQueries: prowlarrAggregate?.totalQueries ?? sum(prowlarrInstances, (stats) => stats.totalQueries),
    totalGrabs: prowlarrAggregate?.totalGrabs ?? sum(prowlarrInstances, (stats) => stats.totalGrabs),
    successfulQueries: prowlarrAggregate?.successfulQueries ?? sum(prowlarrInstances, (stats) => stats.successfulQueries),
    failedQueries: prowlarrAggregate?.failedQueries ?? sum(prowlarrInstances, (stats) => stats.failedQueries),
    successfulGrabs: prowlarrAggregate?.successfulGrabs ?? sum(prowlarrInstances, (stats) => stats.successfulGrabs),
    failedGrabs: prowlarrAggregate?.failedGrabs ?? sum(prowlarrInstances, (stats) => stats.failedGrabs),
    grabRate: prowlarrAggregate?.grabRate,
    averageResponseTime: prowlarrAggregate?.averageResponseTime,
    healthIssues: prowlarrAggregate?.healthIssues ?? sum(prowlarrInstances, (stats) => stats.healthIssues),
    indexers: prowlarrAggregate?.indexers ?? [],
  };

  const totalHealthIssues = sonarrTotals.healthIssues + radarrTotals.healthIssues + prowlarrTotals.healthIssues;

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase text-white/60">Systems overview</p>
          <h1 className="text-3xl font-semibold text-white">Statistics</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-white/60">
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

      {totalHealthIssues > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="text-2xl font-semibold text-yellow-200">{totalHealthIssues}</div>
            <div className="flex-1">
              <p className="font-medium text-yellow-200">Health Issues Detected</p>
              <p className="text-sm text-yellow-200/70">
                {sonarrTotals.healthIssues > 0 && `Sonarr: ${sonarrTotals.healthIssues} `}
                {radarrTotals.healthIssues > 0 && `Radarr: ${radarrTotals.healthIssues} `}
                {prowlarrTotals.healthIssues > 0 && `Prowlarr: ${prowlarrTotals.healthIssues}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Unable to refresh one or more instances. Showing last known values.
        </div>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Sonarr</h2>
          <p className="text-sm text-white/60">Series coverage and disk utilisation.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard title="Series" value={sonarrTotals.totalSeries} />
          <StatsCard title="Monitored" value={sonarrTotals.monitoredSeries} />
          <StatsCard
            title="Continuing"
            value={sonarrAggregate?.continuingSeries ?? sum(sonarrInstances, (stats) => stats.continuingSeries)}
          />
          <StatsCard
            title="Ended"
            value={sonarrAggregate?.endedSeries ?? sum(sonarrInstances, (stats) => stats.endedSeries)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard title="Downloaded Episodes" value={sonarrTotals.downloadedEpisodes} />
          <StatsCard title="Missing Episodes" value={sonarrTotals.missingEpisodes} />
          <StatsCard title="Downloaded %" value={formatPercent(sonarrTotals.downloadPercent)} />
          <StatsCard
            title="Cutoff Unmet"
            value={sonarrAggregate?.cutoffUnmetCount ?? sum(sonarrInstances, (stats) => stats.cutoffUnmetCount)}
            description="Episodes eligible for upgrade"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatsCard
            title="Disk Usage"
            value={formatPercent(sonarrTotals.diskPercent)}
            description={`${formatBytes(sonarrTotals.diskUsed)} used / ${formatBytes(sonarrTotals.diskTotal)} total`}
          />
          <StatsCard
            title="Avg Episode Size"
            value={formatBytes(sonarrAggregate?.averageEpisodeSize)}
          />
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="mb-3 text-xs uppercase text-white/50">Quality Distribution</p>
            <QualityBreakdown breakdown={sonarrAggregate?.qualityBreakdown} />
          </div>
        </div>
        <InstanceTable
          rows={sonarrRows}
          emptyMessage="No Sonarr instances configured."
          columns={[
            { key: "totalSeries", label: "Series" },
            { key: "monitoredSeries", label: "Monitored" },
            { key: "downloadedEpisodes", label: "Downloaded" },
            { key: "missingEpisodes", label: "Missing" },
            { key: "downloadedPercentage", label: "Downloaded %", formatter: (value) => formatPercent(value as number) },
          ]}
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Radarr</h2>
          <p className="text-sm text-white/60">Movie library status and storage usage.</p>
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
            value={radarrAggregate?.cutoffUnmetCount ?? sum(radarrInstances, (stats) => stats.cutoffUnmetCount)}
            description="Movies eligible for upgrade"
          />
          <StatsCard
            title="Avg Movie Size"
            value={formatBytes(radarrAggregate?.averageMovieSize)}
          />
          <StatsCard
            title="Disk Usage"
            value={formatPercent(radarrTotals.diskPercent)}
            description={`${formatBytes(radarrTotals.diskUsed)} / ${formatBytes(radarrTotals.diskTotal)}`}
          />
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <p className="mb-3 text-xs uppercase text-white/50">Quality Distribution</p>
          <QualityBreakdown breakdown={radarrAggregate?.qualityBreakdown} />
        </div>
        <InstanceTable
          rows={radarrRows}
          emptyMessage="No Radarr instances configured."
          columns={[
            { key: "totalMovies", label: "Movies" },
            { key: "monitoredMovies", label: "Monitored" },
            { key: "downloadedMovies", label: "Downloaded" },
            { key: "missingMovies", label: "Missing" },
            { key: "downloadedPercentage", label: "Downloaded %", formatter: (value) => formatPercent(value as number) },
          ]}
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Prowlarr</h2>
          <p className="text-sm text-white/60">Indexer performance and activity.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard title="Indexers" value={prowlarrTotals.totalIndexers} />
          <StatsCard title="Active" value={prowlarrTotals.activeIndexers} />
          <StatsCard title="Paused" value={prowlarrTotals.pausedIndexers} />
          <StatsCard
            title="Avg Response"
            value={prowlarrTotals.averageResponseTime ? `${percentFormatter.format(prowlarrTotals.averageResponseTime)} ms` : "-"}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard title="Total Queries" value={prowlarrTotals.totalQueries} />
          <StatsCard
            title="Successful Queries"
            value={prowlarrTotals.successfulQueries ?? "-"}
            description={prowlarrTotals.totalQueries > 0 ? formatPercent(((prowlarrTotals.successfulQueries ?? 0) / prowlarrTotals.totalQueries) * 100) : undefined}
          />
          <StatsCard
            title="Failed Queries"
            value={prowlarrTotals.failedQueries ?? "-"}
            description={prowlarrTotals.totalQueries > 0 ? formatPercent(((prowlarrTotals.failedQueries ?? 0) / prowlarrTotals.totalQueries) * 100) : undefined}
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
          columns={[
            { key: "totalIndexers", label: "Indexers" },
            { key: "activeIndexers", label: "Active" },
            { key: "pausedIndexers", label: "Paused" },
            { key: "totalQueries", label: "Queries" },
            { key: "totalGrabs", label: "Grabs" },
          ]}
        />
        {prowlarrTotals.indexers.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <h3 className="text-lg font-semibold text-white">Top Indexers</h3>
            <table className="mt-3 w-full table-fixed text-sm text-white/80">
              <thead className="text-left text-xs uppercase tracking-wide text-white/60">
                <tr>
                  <th className="w-2/5 py-2">Name</th>
                  <th className="w-1/5 text-right">Queries</th>
                  <th className="w-1/5 text-right">Grabs</th>
                  <th className="w-1/5 text-right">Success</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {prowlarrTotals.indexers.map((indexer: ProwlarrIndexerStat) => (
                  <tr key={indexer.name}>
                    <td className="py-2 text-white">{indexer.name}</td>
                    <td className="py-2 text-right text-white/70">{integer.format(indexer.queries)}</td>
                    <td className="py-2 text-right text-white/70">{integer.format(indexer.grabs)}</td>
                    <td className="py-2 text-right text-white/70">{formatPercent(indexer.successRate)}</td>
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



