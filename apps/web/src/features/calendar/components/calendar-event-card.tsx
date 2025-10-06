import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import {
  buildExternalLink,
  extractEventDetails,
  formatEventTitle,
  formatTime,
} from "../lib/calendar-formatters";

interface CalendarEventCardProps {
  event: CalendarItem;
  serviceMap: Map<string, ServiceInstanceSummary>;
  onOpenExternal: (href: string) => void;
}

export const CalendarEventCard = ({
  event,
  serviceMap,
  onOpenExternal,
}: CalendarEventCardProps) => {
  const instance = serviceMap.get(event.instanceId);
  const externalLink = buildExternalLink(event, instance);
  const details = extractEventDetails(event);
  const title = formatEventTitle(event);
  const serviceLabel = event.service === "sonarr" ? "Sonarr" : "Radarr";
  const actionLabel =
    event.service === "sonarr" ? "Open in Sonarr" : "Open in Radarr";

  // Build detail rows with JSX
  const detailRows: Array<{ label: string; value: React.ReactNode }> = [];

  if (details.airDate) {
    detailRows.push({ label: "Air Time", value: details.airDate });
  }
  if (details.episodeCode) {
    detailRows.push({ label: "Episode", value: details.episodeCode });
  }
  if (details.runtime) {
    detailRows.push({ label: "Runtime", value: `${details.runtime} min` });
  }
  if (details.network) {
    detailRows.push({
      label: details.serviceType === "sonarr" ? "Network" : "Studio",
      value: details.network,
    });
  }
  if (details.status) {
    detailRows.push({ label: "Status", value: details.status });
  }
  if (details.monitoring) {
    detailRows.push({ label: "Monitoring", value: details.monitoring });
  }
  if (details.library) {
    detailRows.push({ label: "Library", value: details.library });
  }
  if (details.genres) {
    detailRows.push({ label: "Genres", value: details.genres });
  }
  if (details.tmdbLink && details.tmdbId) {
    detailRows.push({
      label: "TMDB",
      value: (
        <a
          href={details.tmdbLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-300 hover:text-sky-200"
        >
          #{details.tmdbId}
        </a>
      ),
    });
  }
  if (details.imdbLink && details.imdbId) {
    detailRows.push({
      label: "IMDB",
      value: (
        <a
          href={details.imdbLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-300 hover:text-sky-200"
        >
          {details.imdbId}
        </a>
      ),
    });
  }

  return (
    <div
      key={`${event.service}:${event.instanceId}:${String(event.id)}`}
      className="rounded-xl border border-white/10 bg-white/5 p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-white/60">
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-white/80">
            {serviceLabel}
          </span>
          {event.instanceName && (
            <span className="text-white/60">{event.instanceName}</span>
          )}
          <span aria-hidden="true" className="text-white/30">
            &bull;
          </span>
          <span>{formatTime(event.airDateUtc ?? event.airDate)}</span>
        </div>
        {externalLink && (
          <Button
            variant="secondary"
            className="h-8 rounded-md px-3 text-xs font-semibold text-white/90"
            onClick={() => onOpenExternal(externalLink)}
          >
            {actionLabel}
          </Button>
        )}
      </div>
      <h3 className="mt-3 text-base font-semibold text-white">{title}</h3>
      {event.overview && (
        <p className="mt-2 text-sm leading-relaxed text-white/70">
          {event.overview}
        </p>
      )}
      {detailRows.length > 0 && (
        <dl className="mt-3 grid gap-3 text-sm text-white/70 sm:grid-cols-2">
          {detailRows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-white/40">
                {row.label}
              </dt>
              <dd className="text-white/80">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};
