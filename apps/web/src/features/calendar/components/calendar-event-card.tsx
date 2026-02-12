import type { ServiceInstanceSummary } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";
import {
	buildExternalLink,
	extractEventDetails,
	formatEventTitle,
	formatTime,
} from "../lib/calendar-formatters";

interface CalendarEventCardProps {
	event: DeduplicatedCalendarItem;
	serviceMap: Map<string, ServiceInstanceSummary>;
	onOpenExternal: (href: string) => void;
}

export const CalendarEventCard = ({
	event,
	serviceMap,
	onOpenExternal,
}: CalendarEventCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const instance = serviceMap.get(event.instanceId);
	const externalLink = buildExternalLink(event, instance);
	const details = extractEventDetails(event);
	const title = formatEventTitle(event);

	// Service label and action label lookup
	const serviceLabelMap: Record<string, string> = {
		sonarr: "Sonarr",
		radarr: "Radarr",
		lidarr: "Lidarr",
		readarr: "Readarr",
	};
	const serviceLabel = serviceLabelMap[event.service] ?? event.service;
	const actionLabel = `Open in ${serviceLabel}`;

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
		// Network label varies by service type
		const networkLabelMap: Record<string, string> = {
			sonarr: "Network",
			radarr: "Studio",
			lidarr: "Label",
			readarr: "Publisher",
		};
		detailRows.push({
			label: networkLabelMap[details.serviceType] ?? "Network",
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
					className="transition-opacity hover:opacity-80"
					style={{ color: themeGradient.from }}
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
					className="transition-opacity hover:opacity-80"
					style={{ color: themeGradient.from }}
				>
					{details.imdbId}
				</a>
			),
		});
	}
	// Lidarr-specific: MusicBrainz link
	if (details.musicBrainzLink && details.musicBrainzId) {
		detailRows.push({
			label: "MusicBrainz",
			value: (
				<a
					href={details.musicBrainzLink}
					target="_blank"
					rel="noopener noreferrer"
					className="transition-opacity hover:opacity-80"
					style={{ color: themeGradient.from }}
				>
					{details.musicBrainzId.slice(0, 8)}...
				</a>
			),
		});
	}
	// Readarr-specific: Goodreads link
	if (details.goodreadsLink && details.goodreadsId) {
		detailRows.push({
			label: "Goodreads",
			value: (
				<a
					href={details.goodreadsLink}
					target="_blank"
					rel="noopener noreferrer"
					className="transition-opacity hover:opacity-80"
					style={{ color: themeGradient.from }}
				>
					#{details.goodreadsId}
				</a>
			),
		});
	}
	// Album type (for Lidarr)
	if (details.albumType) {
		detailRows.push({ label: "Album Type", value: details.albumType });
	}
	// Record label (for Lidarr)
	if (details.label) {
		detailRows.push({ label: "Label", value: details.label });
	}
	// Publisher (for Readarr)
	if (details.publisher) {
		detailRows.push({ label: "Publisher", value: details.publisher });
	}

	// Check if content appears in multiple instances
	const hasMultipleInstances = event.allInstances.length > 1;
	const instancesDisplay = hasMultipleInstances
		? event.allInstances.map((inst) => inst.instanceName).join(", ")
		: event.instanceName;

	return (
		<div
			key={`${event.service}:${event.instanceId}:${String(event.id)}`}
			className="rounded-xl border border-border bg-card p-4 shadow-sm"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
					<span className="rounded-full bg-background px-2 py-0.5 text-muted-foreground">{serviceLabel}</span>
					{instancesDisplay && (
						<span className="text-muted-foreground" title={hasMultipleInstances ? "Present in multiple instances" : undefined}>
							{instancesDisplay}
							{hasMultipleInstances && (
								<span className="ml-1" style={{ color: themeGradient.from }}>
									({event.allInstances.length})
								</span>
							)}
						</span>
					)}
					<span aria-hidden="true" className="text-muted-foreground">
						&bull;
					</span>
					<span>{formatTime(event.airDateUtc ?? event.airDate)}</span>
				</div>
				{externalLink && (
					<Button
						variant="secondary"
						className="h-8 rounded-md px-3 text-xs font-semibold text-foreground"
						onClick={() => onOpenExternal(externalLink)}
					>
						{actionLabel}
					</Button>
				)}
			</div>
			<h3 className="mt-3 text-base font-semibold text-foreground">{title}</h3>
			{event.overview && (
				<p className="mt-2 text-sm leading-relaxed text-muted-foreground">{event.overview}</p>
			)}
			{detailRows.length > 0 && (
				<dl className="mt-3 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
					{detailRows.map((row) => (
						<div key={row.label} className="flex flex-col gap-0.5">
							<dt className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</dt>
							<dd className="text-muted-foreground">{row.value}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
};
