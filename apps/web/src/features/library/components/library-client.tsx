"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { LibraryItem, LibraryService, ServiceInstanceSummary } from "@arr/shared";
import {
  AlertCircle,
  ExternalLink,
  Film,
  Library as LibraryIcon,
  ListTree,
  Loader2,
  PauseCircle,
  PlayCircle,
  Search,
  Tv,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";
import {
  useLibraryMonitorMutation,
  useLibraryQuery,
  useLibrarySeasonSearchMutation,
  useLibraryMovieSearchMutation,
  useLibrarySeriesSearchMutation,
} from "../../../hooks/api/useLibrary";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";

const SERVICE_OPTIONS: Array<{ value: "all" | LibraryService; label: string; icon: JSX.Element }> = [
  { value: "all", label: "All", icon: <LibraryIcon className="h-4 w-4" /> },
  { value: "radarr", label: "Movies", icon: <Film className="h-4 w-4" /> },
  { value: "sonarr", label: "Series", icon: <Tv className="h-4 w-4" /> },
];

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "monitored", label: "Monitored" },
  { value: "unmonitored", label: "Not monitored" },
] as const;

const FILE_FILTERS = [
  { value: "all", label: "All files" },
  { value: "has-file", label: "Has file" },
  { value: "missing", label: "Missing file" },
] as const;

const formatBytes = (value?: number): string | null => {
  if (!value || value <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / Math.pow(1024, exponent);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[exponent]}`;
};

const formatRuntime = (value?: number | null): string | null => {
  if (!value || value <= 0) {
    return null;
  }

  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");
const buildLibraryExternalLink = (item: LibraryItem, instance?: ServiceInstanceSummary): string | null => {
  if (!instance || !instance.baseUrl) {
    return null;
  }

  const baseUrl = normalizeBaseUrl(instance.baseUrl);
  const idSegment = encodeURIComponent(String(item.id));
  const slugSegment = item.titleSlug ? encodeURIComponent(item.titleSlug) : idSegment;

  if (item.service === "sonarr") {
    return `${baseUrl}/series/${slugSegment}`;
  }

  if (item.service === "radarr") {
    return `${baseUrl}/movie/${idSegment}`;
  }

  return null;
};

const groupItemsByType = (items: LibraryItem[]) => ({
  movies: items.filter((item) => item.type === "movie"),
  series: items.filter((item) => item.type === "series"),
});

const LibraryBadge = ({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "green" | "blue" | "red" | "yellow";
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
      tone === "green" && "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
      tone === "blue" && "border-sky-400/40 bg-sky-500/10 text-sky-200",
      tone === "red" && "border-red-400/40 bg-red-500/10 text-red-200",
      tone === "yellow" && "border-yellow-400/40 bg-yellow-500/10 text-yellow-200",
    )}
  >
    {children}
  </span>
);

const LibraryCard = ({
  item,
  onToggleMonitor,
  pending,
  externalLink,
  onViewSeasons,
  onSearchMovie,
  movieSearchPending = false,
  onSearchSeries,
  seriesSearchPending = false,
}: {
  item: LibraryItem;
  onToggleMonitor: (item: LibraryItem) => void;
  pending: boolean;
  externalLink?: string | null;
  onViewSeasons?: (item: LibraryItem) => void;
  onSearchMovie?: (item: LibraryItem) => void;
  movieSearchPending?: boolean;
  onSearchSeries?: (item: LibraryItem) => void;
  seriesSearchPending?: boolean;
}) => {
  const monitored = item.monitored ?? false;
  const hasFile = item.hasFile ?? false;
  const sizeLabel = formatBytes(item.sizeOnDisk);
  const runtimeLabel = formatRuntime(item.runtime);
  const serviceLabel = item.service === "sonarr" ? "Sonarr" : "Radarr";
  const movieFileName =
    item.type === "movie"
      ? (item.movieFile?.relativePath ?? item.path)?.split(/[\\/]/g).pop()
      : undefined;

  const handleOpenExternal = () => {
    if (!externalLink) {
      return;
    }
    window.open(externalLink, "_blank", "noopener,noreferrer");
  };

  const seasonsExcludingSpecials =
    item.type === "series"
      ? (item.seasons?.filter((season) => season.seasonNumber !== 0) ?? [])
      : [];

  const monitoredSeasons = seasonsExcludingSpecials.filter((season) => season.monitored !== false);

  const downloadedEpisodes = monitoredSeasons.reduce(
    (total, season) => total + (season.episodeFileCount ?? 0),
    0,
  );
  const totalEpisodes = monitoredSeasons.reduce(
    (total, season) => total + (season.episodeCount ?? 0),
    0,
  );
  const hasSeasonProgress = seasonsExcludingSpecials.length > 0;
  const effectiveDownloadedEpisodes = hasSeasonProgress
    ? downloadedEpisodes
    : item.statistics?.episodeFileCount ?? 0;
  const effectiveTotalEpisodes = hasSeasonProgress
    ? totalEpisodes
    : item.statistics?.episodeCount ?? item.statistics?.totalEpisodeCount ?? 0;
  const missingEpisodeTotals =
    item.type === "series" && hasSeasonProgress
      ? Math.max(totalEpisodes - downloadedEpisodes, 0)
      : 0;
  const seasonCount = seasonsExcludingSpecials.length || item.statistics?.seasonCount || undefined;
  const episodeRuntimeLabel =
    item.type === "series" && !runtimeLabel && item.runtime
      ? formatRuntime(item.runtime)
      : runtimeLabel;
  const showEpisodeProgress = item.type === "series" && effectiveTotalEpisodes > 0;

  const statusBadges: Array<{ tone: "green" | "blue" | "red" | "yellow"; label: React.ReactNode }> = [
    { tone: monitored ? "green" : "yellow", label: monitored ? "Monitored" : "Not monitored" },
  ];

  if (item.type === "movie") {
    statusBadges.push({ tone: hasFile ? "green" : "blue", label: hasFile ? "File present" : "Awaiting file" });
  }

  if (item.type === "series") {
    statusBadges.push({ tone: hasFile ? "green" : "blue", label: hasFile ? "Files on disk" : "Awaiting import" });
    if (missingEpisodeTotals > 0) {
      statusBadges.push({ tone: "red", label: `${missingEpisodeTotals} missing` });
    }
  }

  if (item.status) {
    statusBadges.push({ tone: "blue", label: item.status });
  }

  const metadata: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Instance", value: item.instanceName },
    { label: "Service", value: serviceLabel },
  ];

  if (item.qualityProfileName) {
    metadata.push({ label: "Quality profile", value: item.qualityProfileName });
  }

  if (item.type === "movie") {
    const movieQuality = item.movieFile?.quality ?? item.qualityProfileName;
    if (movieQuality) {
      metadata.push({ label: "Current quality", value: movieQuality });
    }
    if (sizeLabel) {
      metadata.push({ label: "On disk", value: sizeLabel });
    }
    if (runtimeLabel) {
      metadata.push({ label: "Runtime", value: runtimeLabel });
    }
  } else {
    if (seasonCount) {
      metadata.push({ label: "Seasons", value: seasonCount });
    }
    if (showEpisodeProgress) {
      metadata.push({
        label: "Episodes",
        value: `${effectiveDownloadedEpisodes}/${effectiveTotalEpisodes}`,
      });
    }
    if (missingEpisodeTotals > 0) {
      metadata.push({ label: "Missing (monitored)", value: missingEpisodeTotals });
    }
    if (episodeRuntimeLabel) {
      metadata.push({ label: "Episode length", value: episodeRuntimeLabel });
    }
    if (sizeLabel) {
      metadata.push({ label: "On disk", value: sizeLabel });
    }
  }

  const locationEntries: Array<{ label: string; value: string }> = [];
  if (item.path) {
    locationEntries.push({ label: "Location", value: item.path });
  }
  if (movieFileName) {
    locationEntries.push({ label: "File", value: movieFileName });
  }
  if (item.rootFolderPath && item.rootFolderPath !== item.path) {
    locationEntries.push({ label: "Root", value: item.rootFolderPath });
  }

  const tagEntries = (item.tags ?? []).filter(Boolean);
  const genreEntries = (item.genres ?? []).filter(Boolean);

  return (
    <Card className="border-white/10 bg-white/5 p-5">
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="self-start h-44 w-32 overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-slate-700 to-slate-900 shadow-md flex-shrink-0">
            {item.poster ? (
              <img src={item.poster} alt={item.title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-white/40">
                {item.type === "movie" ? "Poster" : "Artwork"}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-lg font-semibold text-white md:text-xl">{item.title}</h3>
                {item.year && item.type === "movie" ? (
                  <span className="text-sm text-white/50">{item.year}</span>
                ) : null}
              </div>
              <p className="text-sm text-white/50">{item.instanceName}</p>
            </div>

            {item.overview ? (
              <p className="text-sm leading-6 text-white/70 md:pr-8 break-words">
                {item.overview}
              </p>
            ) : null}

            <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {metadata.map((entry) => (
                <div key={`${item.id}-${entry.label}`} className="space-y-1 min-w-0">
                  <p className="text-xs uppercase tracking-[0.2em] text-white/40">{entry.label}</p>
                  <div className="text-sm text-white break-words">{entry.value}</div>
                </div>
              ))}
            </div>

            {genreEntries.length > 0 ? (
              <div className="flex min-w-0 flex-wrap gap-2 text-xs uppercase tracking-wide text-white/50">
                {genreEntries.map((genre) => (
                  <span
                    key={`${item.id}-genre-${genre}`}
                    className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-white/70"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            ) : null}

            {tagEntries.length > 0 ? (
              <div className="flex min-w-0 flex-wrap gap-2 text-xs">
                {tagEntries.map((tag) => (
                  <span
                    key={`${item.id}-tag-${tag}`}
                    className="rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-sky-100"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            {locationEntries.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-3">
                {locationEntries.map((entry) => (
                  <div key={`${item.id}-${entry.label}`} className="space-y-1 min-w-0">
                    <p className="text-xs uppercase tracking-[0.2em] text-white/35">{entry.label}</p>
                    <p className="break-all font-mono text-xs text-white/70">{entry.value}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-white/10 pt-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            {statusBadges.map((badge, index) => (
              <LibraryBadge key={`${item.id}-badge-${index}`} tone={badge.tone}>
                {badge.label}
              </LibraryBadge>
            ))}
          </div>

          <div className="flex w-full flex-wrap justify-end gap-2">
            {item.type === "series" && hasSeasonProgress && onViewSeasons ? (
              <Button
                type="button"
                variant="ghost"
                className="flex items-center gap-2 text-sky-200 hover:text-white"
                onClick={() => onViewSeasons(item)}
              >
                <ListTree className="h-4 w-4" />
                <span>Season breakdown</span>
              </Button>
            ) : null}

            {item.service === "sonarr" && onSearchSeries ? (
              <Button
                type="button"
                variant="ghost"
                className="flex items-center gap-2 text-sky-200 hover:text-white"
                onClick={() => onSearchSeries(item)}
                disabled={seriesSearchPending}
              >
                {seriesSearchPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                <span>Search monitored</span>
              </Button>
            ) : null}

            {item.service === "radarr" && onSearchMovie ? (
              <Button
                type="button"
                variant="ghost"
                className="flex items-center gap-2 text-sky-200 hover:text-white"
                onClick={() => onSearchMovie(item)}
                disabled={movieSearchPending}
              >
                {movieSearchPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                <span>Search</span>
              </Button>
            ) : null}

            {externalLink ? (
              <Button
                type="button"
                variant="ghost"
                className="flex items-center gap-2 text-sky-200 hover:text-white"
                onClick={handleOpenExternal}
              >
                <ExternalLink className="h-4 w-4" />
                <span>Open in {serviceLabel}</span>
              </Button>
            ) : null}

            <Button
              type="button"
              variant={monitored ? "secondary" : "primary"}
              className="flex items-center gap-2"
              onClick={() => onToggleMonitor(item)}
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : monitored ? (
                <PauseCircle className="h-4 w-4" />
              ) : (
                <PlayCircle className="h-4 w-4" />
              )}
              {monitored ? "Unmonitor" : "Monitor"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};const SeasonBreakdownModal = ({
  item,
  onClose,
  onToggleSeason,
  onSearchSeason,
  pendingActionKey,
}: {
  item: LibraryItem;
  onClose: () => void;
  onToggleSeason: (seasonNumber: number, nextMonitored: boolean) => void;
  onSearchSeason: (seasonNumber: number) => void;
  pendingActionKey: string | null;
}) => {
  if (item.type !== "series" || !item.seasons?.length) {
    return null;
  }

  const totalMissing = item.seasons.reduce(
    (total, season) =>
      total + (season.missingEpisodeCount ?? Math.max((season.episodeCount ?? 0) - (season.episodeFileCount ?? 0), 0)),
    0,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-950/95 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-white">{item.title}</h2>
            <p className="text-sm text-white/60">
              {item.instanceName}
              {totalMissing > 0
                ? ` - ${totalMissing} missing episode${totalMissing === 1 ? "" : "s"}`
                : " - All monitored episodes available"}
            </p>
          </div>
          <Button type="button" variant="ghost" className="text-white/60 hover:text-white" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="mt-6 max-h-[440px] space-y-3 overflow-y-auto pr-2">
          {item.seasons.map((season) => {
            const total = season.episodeCount ?? 0;
            const downloaded = season.episodeFileCount ?? 0;
            const missing = season.monitored === false ? 0 : season.missingEpisodeCount ?? Math.max(total - downloaded, 0);
            const isSpecial = season.seasonNumber === 0;
            const label = isSpecial ? "Specials" : `Season ${season.seasonNumber}`;
            const seasonKey = `${item.instanceId}:${item.id}:${season.seasonNumber}`;
            const monitorKey = `monitor:${seasonKey}`;
            const searchKey = `search:${seasonKey}`;
            const seasonMonitorPending = pendingActionKey === monitorKey;
            const seasonSearchPending = pendingActionKey === searchKey;

            return (
              <div key={season.seasonNumber} className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">{label}</p>
                    {season.title && season.title !== label ? (
                      <p className="text-xs text-white/50">{season.title}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <LibraryBadge tone={missing > 0 ? "yellow" : "green"}>
                      {downloaded}/{total || "?"} episodes
                    </LibraryBadge>
                    {missing > 0 ? <LibraryBadge tone="red">{missing} missing</LibraryBadge> : null}
                    {season.monitored === false ? <LibraryBadge tone="blue">Unmonitored</LibraryBadge> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="flex items-center gap-2"
                      disabled={seasonMonitorPending}
                      onClick={() => onToggleSeason(season.seasonNumber, !(season.monitored ?? false))}
                    >
                      {seasonMonitorPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : season.monitored === false ? (
                        <span>Monitor season</span>
                      ) : (
                        <span>Unmonitor season</span>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="flex items-center gap-2 text-sky-200 hover:text-white"
                      disabled={seasonSearchPending}
                      onClick={() => onSearchSeason(season.seasonNumber)}
                    >
                      {seasonSearchPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      <span>Search</span>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const LibraryClient: React.FC = () => {
  const [serviceFilter, setServiceFilter] = useState<"all" | LibraryService>("all");
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]["value"]>("all");
  const [fileFilter, setFileFilter] = useState<(typeof FILE_FILTERS)[number]["value"]>("all");
  const [seasonDetail, setSeasonDetail] = useState<LibraryItem | null>(null);
  const [pendingSeasonAction, setPendingSeasonAction] = useState<string | null>(null);
  const [pendingMovieSearch, setPendingMovieSearch] = useState<string | null>(null);
  const [pendingSeriesSearch, setPendingSeriesSearch] = useState<string | null>(null);

  useEffect(() => {
    setInstanceFilter("all");
  }, [serviceFilter]);

  const libraryQuery = useLibraryQuery({
    service: serviceFilter === "all" ? undefined : serviceFilter,
    instanceId: instanceFilter === "all" ? undefined : instanceFilter,
  });

  const monitorMutation = useLibraryMonitorMutation();
  const seasonMonitorMutation = useLibraryMonitorMutation();
  const seasonSearchMutation = useLibrarySeasonSearchMutation();
  const seriesSearchMutation = useLibrarySeriesSearchMutation();
  const movieSearchMutation = useLibraryMovieSearchMutation();

  const items = libraryQuery.data?.aggregated ?? [];
  const instances = libraryQuery.data?.instances ?? [];
  const servicesQuery = useServicesQuery();
  const serviceLookup = useMemo<Record<string, ServiceInstanceSummary>>(() => {
    const lookup: Record<string, ServiceInstanceSummary> = {};
    for (const service of servicesQuery.data ?? []) {
      lookup[service.id] = service;
    }
    return lookup;
  }, [servicesQuery.data]);

  useEffect(() => {
    if (!seasonDetail) {
      return;
    }

    const updated = items.find(
      (candidate) =>
        candidate.instanceId === seasonDetail.instanceId &&
        candidate.service === seasonDetail.service &&
        String(candidate.id) === String(seasonDetail.id),
    );

    if (!updated || updated.type !== "series" || !updated.seasons?.length) {
      setSeasonDetail(null);
      return;
    }

    if (updated !== seasonDetail) {
      setSeasonDetail(updated);
    }
  }, [items, seasonDetail]);

  const handleViewSeasons = (item: LibraryItem) => {
    if (item.type !== "series" || !item.seasons?.length) {
      return;
    }
    setSeasonDetail(item);
  };

  const handleCloseSeasonDetail = () => {
    setSeasonDetail(null);
  };

  const handleSeasonMonitor = async (series: LibraryItem, seasonNumber: number, nextMonitored: boolean) => {
    if (series.service !== "sonarr") {
      toast.warning('Season monitoring actions are only available for Sonarr series.');
      return;
    }

    const seasonLabel = seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
    const seriesTitle = series.title ?? 'Series';
    const actionKey = `monitor:${series.instanceId}:${series.id}:${seasonNumber}`;
    setPendingSeasonAction(actionKey);
    try {
      await seasonMonitorMutation.mutateAsync({
        instanceId: series.instanceId,
        service: series.service,
        itemId: series.id,
        monitored: nextMonitored,
        seasonNumbers: [seasonNumber],
      });
      toast.success(`${seasonLabel} ${nextMonitored ? 'monitoring enabled' : 'monitoring disabled'} for ${seriesTitle}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to ${nextMonitored ? 'enable' : 'disable'} ${seasonLabel}: ${message}`);
    } finally {
      setPendingSeasonAction(null);
    }
  };

  const handleSeasonSearch = async (series: LibraryItem, seasonNumber: number) => {
    if (series.service !== "sonarr") {
      toast.warning('Season searches are only available for Sonarr series.');
      return;
    }

    const seasonLabel = seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
    const seriesTitle = series.title ?? 'Series';
    const actionKey = `search:${series.instanceId}:${series.id}:${seasonNumber}`;
    setPendingSeasonAction(actionKey);
    try {
      await seasonSearchMutation.mutateAsync({
        instanceId: series.instanceId,
        service: series.service,
        seriesId: series.id,
        seasonNumber,
      });
      toast.success(`${seasonLabel} search queued for ${seriesTitle}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to queue search for ${seasonLabel}: ${message}`);
    } finally {
      setPendingSeasonAction(null);
    }
  };

  const handleSeriesSearch = async (series: LibraryItem) => {
    if (series.service !== "sonarr") {
      toast.warning("Series searches are only available for Sonarr instances.");
      return;
    }

    const seriesTitle = series.title ?? "Series";
    const actionKey = `${series.instanceId}:${series.id}`;
    setPendingSeriesSearch(actionKey);
    try {
      await seriesSearchMutation.mutateAsync({
        instanceId: series.instanceId,
        service: "sonarr",
        seriesId: series.id,
      });
      toast.success(`${seriesTitle} search queued`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to queue search for ${seriesTitle}: ${message}`);
    } finally {
      setPendingSeriesSearch(null);
    }
  };

  const handleMovieSearch = async (movie: LibraryItem) => {
    if (movie.service !== "radarr") {
      toast.warning("Movie searches are only available for Radarr instances.");
      return;
    }

    const movieTitle = movie.title ?? "Movie";
    const actionKey = `${movie.instanceId}:${movie.id}`;
    setPendingMovieSearch(actionKey);
    try {
      await movieSearchMutation.mutateAsync({
        instanceId: movie.instanceId,
        service: "radarr",
        movieId: movie.id,
      });
      toast.success(`${movieTitle} search queued`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to queue search for ${movieTitle}: ${message}`);
    } finally {
      setPendingMovieSearch(null);
    }
  };

  const filteredItems = useMemo(() => {
    const text = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const haystack = [
        item.title,
        item.overview,
        item.instanceName,
        item.genres?.join(" "),
        item.tags?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesText = text.length === 0 || haystack.includes(text);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "monitored" && Boolean(item.monitored)) ||
        (statusFilter === "unmonitored" && !Boolean(item.monitored));

      const itemHasFile =
        item.type === "movie"
          ? Boolean(item.hasFile)
          : Boolean(item.hasFile) || ((item.statistics?.episodeFileCount ?? 0) > 0);
      const matchesFile =
        fileFilter === "all" ||
        (fileFilter === "has-file" && itemHasFile) ||
        (fileFilter === "missing" && !itemHasFile);

      return matchesText && matchesStatus && matchesFile;
    });
  }, [items, searchTerm, statusFilter, fileFilter]);

  const grouped = useMemo(() => groupItemsByType(filteredItems), [filteredItems]);

  const pendingKey = monitorMutation.isPending
    ? `${monitorMutation.variables?.service ?? ""}:${monitorMutation.variables?.itemId ?? ""}`
    : null;

  const handleToggleMonitor = (item: LibraryItem) => {
    monitorMutation.mutate({
      instanceId: item.instanceId,
      service: item.service,
      itemId: item.id,
      monitored: !(item.monitored ?? false),
    });
  };

  const instanceOptions = useMemo(() => {
    if (instances.length === 0) {
      return [];
    }

    return instances.map((entry) => ({
      id: entry.instanceId,
      label: `${entry.instanceName} - ${entry.service === "radarr" ? "Movies" : "Series"}`,
      service: entry.service,
    }));
  }, [instances]);

  return (
    <>
      <div className="space-y-12">
        <header className="space-y-8">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.4em] text-white/40">Library</p>
            <h1 className="text-3xl font-semibold text-white">Everything your *arr instances manage</h1>
            <p className="text-sm text-white/60">
              Browse, filter, and adjust monitoring for movies and series across every connected instance.
            </p>
          </div>

          <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-full bg-white/10 p-1">
                {SERVICE_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={serviceFilter === option.value ? "primary" : "secondary"}
                    className="flex items-center gap-2 px-4 py-2 text-sm"
                    onClick={() => setServiceFilter(option.value)}
                  >
                    {option.icon}
                    <span>{option.label}</span>
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs uppercase tracking-[0.3em] text-white/40">Instance</label>
                <select
                  value={instanceFilter}
                  onChange={(event) => setInstanceFilter(event.target.value)}
                  className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                  disabled={instanceOptions.length === 0}
                  style={{ color: "#f8fafc" }}
                >
                  <option value="all" className="bg-slate-900 text-white">
                    All instances
                  </option>
                  {instanceOptions
                    .filter((option) => serviceFilter === "all" || option.service === serviceFilter)
                    .map((option) => (
                      <option key={option.id} value={option.id} className="bg-slate-900 text-white">
                        {option.label}
                      </option>
                    ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs uppercase tracking-[0.3em] text-white/40">Status</label>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as (typeof STATUS_FILTERS)[number]["value"])}
                  className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                  style={{ color: "#f8fafc" }}
                >
                  {STATUS_FILTERS.map((option) => (
                    <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs uppercase tracking-[0.3em] text-white/40">Files</label>
                <select
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value as (typeof FILE_FILTERS)[number]["value"])}
                  className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                  style={{ color: "#f8fafc" }}
                >
                  {FILE_FILTERS.map((option) => (
                    <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="relative ml-auto w-full max-w-sm">
                <Input
                  placeholder="Filter by title, overview, or tag"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>
            </div>
          </div>
        </header>

        {libraryQuery.isLoading ? (
          <div className="flex items-center gap-3 text-white/60">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading library from your instances...
          </div>
        ) : null}

        {!libraryQuery.isLoading && filteredItems.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No items found</CardTitle>
              <CardDescription>
                Adjust your filters or add content from the Discover tab to populate your library.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {grouped.movies.length > 0 ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">Movies</h2>
              <span className="text-sm text-white/50">{grouped.movies.length} items</span>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              {grouped.movies.map((item) => (
                <LibraryCard
                  key={`${item.instanceId}:${item.id}`}
                  item={item}
                  onToggleMonitor={handleToggleMonitor}
                  pending={pendingKey === `${item.service}:${item.id}` && monitorMutation.isPending}
                  externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
                  onSearchMovie={handleMovieSearch}
                  movieSearchPending={pendingMovieSearch === `${item.instanceId}:${item.id}`}
                />
              ))}
            </div>
          </section>
        ) : null}

        {grouped.series.length > 0 ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">Series</h2>
              <span className="text-sm text-white/50">{grouped.series.length} items</span>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              {grouped.series.map((item) => (
                <LibraryCard
                  key={`${item.instanceId}:${item.id}`}
                  item={item}
                  onToggleMonitor={handleToggleMonitor}
                  pending={pendingKey === `${item.service}:${item.id}` && monitorMutation.isPending}
                  externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
                  onViewSeasons={handleViewSeasons}
                  onSearchSeries={handleSeriesSearch}
                  seriesSearchPending={pendingSeriesSearch === `${item.instanceId}:${item.id}`}
                />
              ))}
            </div>
          </section>
        ) : null}

        {libraryQuery.isError ? (
          <div className="flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <AlertCircle className="h-4 w-4" />
            {(libraryQuery.error as Error | undefined)?.message ?? "Failed to load library"}
          </div>
        ) : null}
      </div>

      {seasonDetail ? (
        <SeasonBreakdownModal
          item={seasonDetail}
          onClose={handleCloseSeasonDetail}
          onToggleSeason={(seasonNumber, nextMonitored) =>
            handleSeasonMonitor(seasonDetail, seasonNumber, nextMonitored)
          }
          onSearchSeason={(seasonNumber) => handleSeasonSearch(seasonDetail, seasonNumber)}
          pendingActionKey={pendingSeasonAction}
        />
      ) : null}
    </>
  );
};








