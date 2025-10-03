'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";
import { useMultiInstanceCalendarQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { CalendarGrid } from "./calendar-grid";

const SERVICE_FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "sonarr" as const, label: "Sonarr" },
  { value: "radarr" as const, label: "Radarr" },
];

const formatDateOnly = (date: Date): string => {
  const iso = date.toISOString();
  const index = iso.indexOf("T");
  return index === -1 ? iso : iso.slice(0, index);
};

const createMonthDate = (year: number, month: number): Date => new Date(Date.UTC(year, month, 1));

const formatMonthLabel = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);

const formatTime = (value?: string): string => {
  if (!value) {
    return "All day";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
};

const formatLongDate = (value: Date): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(value);

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const buildExternalLink = (
  event: CalendarItem,
  instance?: ServiceInstanceSummary,
): string | null => {
  if (!instance || !instance.baseUrl) {
    return null;
  }

  const baseUrl = normalizeBaseUrl(instance.baseUrl);

  if (event.service === "sonarr" && (event.seriesSlug || event.seriesId)) {
    const seriesSegment = event.seriesSlug ?? String(event.seriesId);
    return `${baseUrl}/series/${seriesSegment}`;
  }

  if (event.service === "radarr" && (event.movieSlug || event.movieId)) {
    const movieSegment = event.movieSlug ?? String(event.movieId);
    return `${baseUrl}/movie/${movieSegment}`;
  }

  return null;
};

const formatAirDateTime = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};

const formatEpisodeCode = (seasonNumber?: number, episodeNumber?: number): string | undefined => {
  const seasonPart = typeof seasonNumber === "number" ? `S${seasonNumber.toString().padStart(2, "0")}` : "";
  const episodePart = typeof episodeNumber === "number" ? `E${episodeNumber.toString().padStart(2, "0")}` : "";
  const combined = `${seasonPart}${episodePart}`.trim();
  return combined.length > 0 ? combined : undefined;
};

const formatMonitoringLabel = (monitored?: boolean): string | undefined => {
  if (typeof monitored !== "boolean") {
    return undefined;
  }
  return monitored ? "Monitored" : "Not monitored";
};

const formatLibraryLabel = (hasFile?: boolean): string | undefined => {
  if (typeof hasFile !== "boolean") {
    return undefined;
  }
  return hasFile ? "In library" : "Pending download";
};

const joinGenres = (genres?: string[]): string | undefined => {
  if (!Array.isArray(genres)) {
    return undefined;
  }
  const normalized = genres
    .map((genre) => (typeof genre === "string" ? genre.trim() : ""))
    .filter((genre) => genre.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.slice(0, 4).join(", ");
};

const humanizeLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const CalendarClient = () => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return createMonthDate(now.getUTCFullYear(), now.getUTCMonth());
  });
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [serviceFilter, setServiceFilter] = useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [includeUnmonitored, setIncludeUnmonitored] = useState(false);

  const { monthStart, monthEnd, calendarStart, calendarEnd } = useMemo(() => {
    const start = createMonthDate(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth());
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);

    const calendarStartDate = new Date(start);
    calendarStartDate.setUTCDate(calendarStartDate.getUTCDate() - calendarStartDate.getUTCDay());

    const calendarEndDate = new Date(end);
    calendarEndDate.setUTCDate(calendarEndDate.getUTCDate() + (6 - calendarEndDate.getUTCDay()));

    return {
      monthStart: start,
      monthEnd: end,
      calendarStart: calendarStartDate,
      calendarEnd: calendarEndDate,
    };
  }, [currentMonth]);

  const queryParams = useMemo(
    () => ({
      start: formatDateOnly(calendarStart),
      end: formatDateOnly(calendarEnd),
      unmonitored: includeUnmonitored,
    }),
    [calendarStart, calendarEnd, includeUnmonitored],
  );

  const { data, isLoading, error, refetch } = useMultiInstanceCalendarQuery(queryParams);

  const { data: services } = useServicesQuery();
  const serviceMap = useMemo(() => {
    const map = new Map<string, ServiceInstanceSummary>();
    for (const instance of services ?? []) {
      map.set(instance.id, instance);
    }
    return map;
  }, [services]);

  const handleOpenExternal = useCallback((href: string) => {
    if (!href) {
      return;
    }
    window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  const aggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
  const instances = useMemo(() => data?.instances ?? [], [data?.instances]);

  const instanceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const instance of instances) {
      map.set(instance.instanceId, instance.instanceName);
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [instances]);

  const filteredEvents = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return aggregated.filter((item) => {
      if (serviceFilter !== "all" && item.service !== serviceFilter) {
        return false;
      }
      if (instanceFilter !== "all" && item.instanceId !== instanceFilter) {
        return false;
      }
      if (term.length > 0) {
        const haystack = [
          item.title,
          item.seriesTitle,
          item.episodeTitle,
          item.movieTitle,
          item.overview,
        ]
          .filter(Boolean)
          .map((value) => value!.toLowerCase());
        if (!haystack.some((value) => value.includes(term))) {
          return false;
        }
      }
      return true;
    });
  }, [aggregated, serviceFilter, instanceFilter, searchTerm]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of filteredEvents) {
      const iso = item.airDateUtc ?? item.airDate;
      if (!iso) {
        continue;
      }
      const separatorIndex = iso.indexOf("T");
      const dateKey = separatorIndex === -1 ? iso : iso.slice(0, separatorIndex);
      const existing = map.get(dateKey);
      if (existing) {
        existing.push(item);
      } else {
        map.set(dateKey, [item]);
      }
    }
    for (const value of map.values()) {
      value.sort((a, b) => {
        const timeA = new Date(a.airDateUtc ?? a.airDate ?? 0).getTime();
        const timeB = new Date(b.airDateUtc ?? b.airDate ?? 0).getTime();
        if (timeA !== timeB) {
          return timeA - timeB;
        }
        return (a.title ?? "").localeCompare(b.title ?? "");
      });
    }
    return map;
  }, [filteredEvents]);

  const daysInView = useMemo(() => {
    const days: Date[] = [];
    const cursor = new Date(calendarStart);
    while (cursor.getTime() <= calendarEnd.getTime()) {
      days.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }, [calendarStart, calendarEnd]);

  useEffect(() => {
    if (!selectedDate) {
      const todayKey = formatDateOnly(new Date());
      for (const day of daysInView) {
        if (formatDateOnly(day) === todayKey) {
          setSelectedDate(day);
          return;
        }
      }
      setSelectedDate(daysInView[0] ?? null);
    }
  }, [daysInView, selectedDate]);

  const selectedKey = selectedDate ? formatDateOnly(selectedDate) : undefined;
  const selectedEvents = selectedKey ? eventsByDate.get(selectedKey) ?? [] : [];

  const handlePreviousMonth = () => {
    const prev = new Date(monthStart);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    setCurrentMonth(prev);
    setSelectedDate(null);
  };

  const handleNextMonth = () => {
    const next = new Date(monthStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    setCurrentMonth(next);
    setSelectedDate(null);
  };

  const handleGoToday = () => {
    const today = new Date();
    const month = createMonthDate(today.getUTCFullYear(), today.getUTCMonth());
    setCurrentMonth(month);
    setSelectedDate(null);
  };

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <p className="text-sm font-medium uppercase text-white/60">Schedule</p>
            <h1 className="text-3xl font-semibold text-white">Upcoming Releases</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handlePreviousMonth}>
              &larr; Prev
            </Button>
            <span className="min-w-[160px] text-center text-sm text-white/80">{formatMonthLabel(monthStart)}</span>
            <Button variant="ghost" onClick={handleNextMonth}>
              Next &rarr;
            </Button>
            <Button variant="ghost" onClick={handleGoToday}>
              Today
            </Button>
            <Button variant="ghost" onClick={() => void refetch()} disabled={isLoading}>
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-sm text-white/60">
          Combined calendar view for Sonarr and Radarr instances. Use the filters below to drill into specific services
          or hosts.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
        <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
          <label className="text-xs uppercase text-white/50" htmlFor="calendar-search">Search</label>
          <Input
            id="calendar-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search titles or descriptions"
            className="border-white/20 bg-slate-900/80 text-white placeholder:text-white/40"
          />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1 text-sm text-white/80">
          <label className="text-xs uppercase text-white/50" htmlFor="calendar-service-filter">Service</label>
          <select
            id="calendar-service-filter"
            value={serviceFilter}
            onChange={(event) => setServiceFilter(event.target.value as (typeof SERVICE_FILTERS)[number]["value"])}
            className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            style={{ color: "#f8fafc" }}
          >
            {SERVICE_FILTERS.map((option) => (
              <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
          <label className="text-xs uppercase text-white/50" htmlFor="calendar-instance-filter">Instance</label>
          <select
            id="calendar-instance-filter"
            value={instanceFilter}
            onChange={(event) => setInstanceFilter(event.target.value)}
            className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            style={{ color: "#f8fafc" }}
          >
            <option value="all" className="bg-slate-900 text-white">
              All instances
            </option>
            {instanceOptions.map((option) => (
              <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            checked={includeUnmonitored}
            onChange={(event) => setIncludeUnmonitored(event.target.checked)}
            className="h-4 w-4"
          />
          Include unmonitored items
        </label>
        <div className="ml-auto">
          <Button
            variant="ghost"
            onClick={() => {
              setSearchTerm("");
              setServiceFilter("all");
              setInstanceFilter("all");
              setIncludeUnmonitored(false);
            }}
            disabled={
              serviceFilter === "all" && instanceFilter === "all" && searchTerm.trim().length === 0 && !includeUnmonitored
            }
          >
            Reset filters
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Unable to load calendar data. Please refresh and try again.
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
        <CalendarGrid
          days={daysInView}
          currentMonth={monthStart}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          eventsByDate={eventsByDate}
          className="min-h-[520px]"
        />
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {selectedDate ? formatLongDate(selectedDate) : "Select a date"}
            </h2>
            <p className="text-xs uppercase text-white/40">
              {selectedEvents.length} scheduled item{selectedEvents.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        {selectedEvents.length === 0 ? (
          <p className="mt-4 text-sm text-white/60">No scheduled items for this date.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {selectedEvents.map((event) => {
              const instance = serviceMap.get(event.instanceId);
              const externalLink = buildExternalLink(event, instance);
              const airDateLabel = formatAirDateTime(event.airDateUtc ?? event.airDate);
              const episodeCode = formatEpisodeCode(event.seasonNumber, event.episodeNumber);
              const monitoringLabel = formatMonitoringLabel(event.monitored);
              const libraryLabel = formatLibraryLabel(event.hasFile);
              const genresLabel = joinGenres(event.genres);
              const statusSource = event.status ?? event.seriesStatus;
              const statusValue = statusSource ? humanizeLabel(statusSource) : undefined;
              const tmdbLink =
                event.tmdbId != null
                  ? `https://www.themoviedb.org/${event.service === "radarr" ? "movie" : "tv"}/${event.tmdbId}`
                  : undefined;
              const imdbLink = event.imdbId ? `https://www.imdb.com/title/${event.imdbId}` : undefined;

              const detailRows: Array<{ label: string; value: ReactNode }> = [];

              if (airDateLabel) {
                detailRows.push({ label: "Air Time", value: airDateLabel });
              }
              if (episodeCode && event.type === "episode") {
                detailRows.push({ label: "Episode", value: episodeCode });
              }
              if (event.runtime) {
                detailRows.push({ label: "Runtime", value: `${event.runtime} min` });
              }
              const networkLabel = event.network ?? event.studio;
              if (networkLabel) {
                detailRows.push({ label: event.service === "sonarr" ? "Network" : "Studio", value: networkLabel });
              }
              if (statusValue) {
                detailRows.push({ label: "Status", value: statusValue });
              }
              if (monitoringLabel) {
                detailRows.push({ label: "Monitoring", value: monitoringLabel });
              }
              if (libraryLabel) {
                detailRows.push({ label: "Library", value: libraryLabel });
              }
              if (genresLabel) {
                detailRows.push({ label: "Genres", value: genresLabel });
              }
              if (tmdbLink) {
                detailRows.push({
                  label: "TMDB",
                  value: (
                    <a href={tmdbLink} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200">
                      #{event.tmdbId}
                    </a>
                  ),
                });
              }
              if (imdbLink) {
                detailRows.push({
                  label: "IMDB",
                  value: (
                    <a href={imdbLink} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200">
                      {event.imdbId}
                    </a>
                  ),
                });
              }

              const title =
                event.type === "episode"
                  ? `${event.seriesTitle ?? "Unknown Series"}${event.episodeTitle ? " - " + event.episodeTitle : ""}`
                  : event.movieTitle ?? event.title ?? "Untitled";

              const serviceLabel = event.service === "sonarr" ? "Sonarr" : "Radarr";
              const actionLabel = event.service === "sonarr" ? "Open in Sonarr" : "Open in Radarr";

              return (
                <div
                  key={`${event.service}:${event.instanceId}:${String(event.id)}`}
                  className="rounded-xl border border-white/10 bg-white/5 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-white/60">
                      <span className="rounded-full bg-white/15 px-2 py-0.5 text-white/80">{serviceLabel}</span>
                      {event.instanceName && <span className="text-white/60">{event.instanceName}</span>}
                      <span aria-hidden="true" className="text-white/30">&bull;</span>
                      <span>{formatTime(event.airDateUtc ?? event.airDate)}</span>
                    </div>
                    {externalLink && (
                      <Button
                        variant="secondary"
                        className="h-8 rounded-md px-3 text-xs font-semibold text-white/90"
                        onClick={() => handleOpenExternal(externalLink)}
                      >
                        {actionLabel}
                      </Button>
                    )}
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-white">{title}</h3>
                  {event.overview && (
                    <p className="mt-2 text-sm leading-relaxed text-white/70">{event.overview}</p>
                  )}
                  {detailRows.length > 0 && (
                    <dl className="mt-3 grid gap-3 text-sm text-white/70 sm:grid-cols-2">
                      {detailRows.map((row) => (
                        <div key={row.label} className="flex flex-col gap-0.5">
                          <dt className="text-xs uppercase tracking-wide text-white/40">{row.label}</dt>
                          <dd className="text-white/80">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};

