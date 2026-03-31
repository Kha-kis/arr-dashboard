"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import {
	BookOpen,
	Clock,
	Disc3,
	ExternalLink,
	Eye,
	EyeOff,
	Film,
	HardDrive,
	Tv,
} from "lucide-react";
import { getLinuxIsoName, getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { BRAND_COLORS, SERVICE_GRADIENTS, getServiceGradient } from "../../../lib/theme-gradients";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";
import {
	buildExternalLink,
	extractEventDetails,
	formatEpisodeCode,
	formatEventTitle,
	formatTime,
} from "../lib/calendar-formatters";

interface CalendarEventCardProps {
	event: DeduplicatedCalendarItem;
	serviceMap: Map<string, ServiceInstanceSummary>;
	onOpenExternal: (href: string) => void;
	plexUrlMap: Map<string, string>;
	index?: number;
}

const SERVICE_LABELS: Record<string, string> = {
	sonarr: "Sonarr",
	radarr: "Radarr",
	lidarr: "Lidarr",
	readarr: "Readarr",
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
	episode: Tv,
	movie: Film,
	album: Disc3,
	book: BookOpen,
};

/**
 * External link badge with brand-colored styling
 */
const ExternalBadge = ({
	label,
	href,
	color,
	textColor,
}: {
	label: string;
	href: string;
	color: string;
	textColor: string;
}) => (
	<a
		href={href}
		target="_blank"
		rel="noopener noreferrer"
		className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-all hover:brightness-125 hover:scale-[1.02]"
		style={{
			backgroundColor: `${color}12`,
			color: textColor,
			border: `1px solid ${color}18`,
		}}
	>
		{label}
		<ExternalLink className="h-2.5 w-2.5 opacity-60" />
	</a>
);

/**
 * Metadata chip with optional icon and muted variant
 */
const MetaChip = ({
	icon: Icon,
	children,
	variant = "default",
}: {
	icon?: React.ComponentType<{
		className?: string;
		style?: React.CSSProperties;
	}>;
	children: React.ReactNode;
	variant?: "default" | "muted";
}) => (
	<span
		className={`inline-flex items-center gap-1 text-[11px] ${
			variant === "muted"
				? "text-muted-foreground/30"
				: "text-muted-foreground/50"
		}`}
	>
		{Icon && <Icon className="h-3 w-3 shrink-0" />}
		{children}
	</span>
);

export const CalendarEventCard = ({
	event,
	serviceMap,
	onOpenExternal,
	plexUrlMap,
	index = 0,
}: CalendarEventCardProps) => {
	const [incognitoMode] = useIncognitoMode();
	const instance = serviceMap.get(event.instanceId);
	const externalLink = buildExternalLink(event, instance);
	const details = extractEventDetails(event);
	const rawTitle = formatEventTitle(event);
	const title = incognitoMode ? getLinuxIsoName(rawTitle) : rawTitle;
	const serviceGradient = getServiceGradient(event.service);
	const serviceLabel = SERVICE_LABELS[event.service] ?? event.service;
	const TypeIcon = TYPE_ICONS[event.type] ?? Film;

	// Plex deep link — lookup by "type:tmdbId" key
	const plexUrl =
		event.tmdbId != null && (event.service === "sonarr" || event.service === "radarr")
			? plexUrlMap.get(
					`${event.service === "radarr" ? "movie" : "series"}:${event.tmdbId}`,
				)
			: undefined;

	const episodeCode =
		event.type === "episode"
			? formatEpisodeCode(event.seasonNumber, event.episodeNumber)
			: undefined;

	const hasMultipleInstances = event.allInstances.length > 1;
	const instancesDisplay = incognitoMode
		? (hasMultipleInstances
			? event.allInstances.map((inst) => getLinuxInstanceName(inst.instanceName)).join(", ")
			: getLinuxInstanceName(event.instanceName))
		: (hasMultipleInstances
			? event.allInstances.map((inst) => inst.instanceName).join(", ")
			: event.instanceName);

	const hasPoster = !incognitoMode && !!event.posterUrl;

	return (
		<div
			className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
			style={{
				border: `1px solid ${serviceGradient.from}10`,
				animationDelay: `${index * 50}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Service-tinted background with diagonal gradient */}
			<div
				className="absolute inset-0 pointer-events-none"
				style={{
					background: `linear-gradient(135deg, ${serviceGradient.from}05, transparent 60%)`,
				}}
			/>

			{/* Hover glow effect */}
			<div
				className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
				style={{
					background: `radial-gradient(ellipse at top left, ${serviceGradient.from}06, transparent 50%)`,
				}}
			/>

			<div className="relative flex">
				{/* Service accent bar */}
				<div
					className="absolute left-0 top-0 bottom-0 w-[3px]"
					style={{
						background: `linear-gradient(180deg, ${serviceGradient.from}, ${serviceGradient.to}70)`,
					}}
				/>

				{/* Content */}
				<div className="flex-1 min-w-0 pr-4 py-3.5 pl-5">
					{/* Top row: service + instance + time + action */}
					<div className="flex items-center justify-between gap-2 mb-2">
						<div className="flex items-center gap-2 min-w-0">
							{/* Service pill with glow */}
							<span
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
								style={{
									backgroundColor: `${serviceGradient.from}12`,
									color: serviceGradient.from,
									boxShadow: `0 0 10px ${serviceGradient.from}08`,
								}}
							>
								<TypeIcon className="h-2.5 w-2.5" />
								{serviceLabel}
							</span>

							{/* Instance name */}
							<span
								className="text-[10px] text-muted-foreground/35 truncate"
								title={
									hasMultipleInstances
										? `In ${event.allInstances.length} instances: ${instancesDisplay}`
										: undefined
								}
							>
								{instancesDisplay}
								{hasMultipleInstances && (
									<span
										className="ml-1 font-bold"
										style={{ color: serviceGradient.from }}
									>
										({event.allInstances.length})
									</span>
								)}
							</span>

							{/* Separator dot */}
							<span
								className="h-[3px] w-[3px] rounded-full shrink-0"
								style={{
									backgroundColor: `${serviceGradient.from}30`,
								}}
							/>

							{/* Time */}
							<MetaChip icon={Clock}>
								{formatTime(
									event.airDateUtc ??
										event.airDate ??
										event.releaseDate,
								)}
							</MetaChip>
						</div>

						{/* Open in service — hover reveal */}
						{externalLink && (
							<button
								type="button"
								onClick={() => onOpenExternal(externalLink)}
								className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold transition-all opacity-0 group-hover:opacity-100 hover:bg-white/[0.06]"
								style={{ color: serviceGradient.from }}
							>
								Open
								<ExternalLink className="h-2.5 w-2.5" />
							</button>
						)}
					</div>

					{/* Title row with poster thumbnail */}
					<div className="flex items-start gap-3">
						{hasPoster && (
							<div
								className="shrink-0 w-[44px] h-[64px] rounded-md overflow-hidden shadow-md shadow-black/20 ring-1 ring-white/[0.06]"
								style={{
									boxShadow: `0 2px 8px ${serviceGradient.from}10, 0 4px 12px rgba(0,0,0,0.2)`,
								}}
							>
								{/* eslint-disable-next-line @next/next/no-img-element -- Remote poster from arr instance */}
								<img
									src={event.posterUrl}
									alt=""
									className="h-full w-full object-cover"
								/>
							</div>
						)}
						<div className="flex-1 min-w-0">
							<h3 className="text-[14px] font-semibold text-foreground leading-snug">
								{title}
								{episodeCode && (
									<span
										className="inline-flex ml-2 px-1.5 py-[1px] text-[10px] font-mono font-bold rounded-[4px] align-middle"
										style={{
											backgroundColor: `${serviceGradient.from}12`,
											color: `${serviceGradient.from}`,
										}}
									>
										{episodeCode}
									</span>
								)}
							</h3>

							{/* Overview */}
							{event.overview && !incognitoMode && (
								<p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground/45 line-clamp-2">
									{event.overview}
								</p>
							)}
						</div>
					</div>

					{/* Metadata row */}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
						{details.runtime && (
							<MetaChip icon={Clock}>{details.runtime} min</MetaChip>
						)}
						{details.network && !incognitoMode && <MetaChip>{details.network}</MetaChip>}
						{details.status && <MetaChip>{details.status}</MetaChip>}
						{details.monitoring !== undefined && (
							<MetaChip
								icon={
									details.monitoring === "Monitored" ? Eye : EyeOff
								}
								variant={
									details.monitoring === "Monitored"
										? "default"
										: "muted"
								}
							>
								{details.monitoring}
							</MetaChip>
						)}
						{details.library !== undefined && (
							<MetaChip
								icon={HardDrive}
								variant={
									details.library === "In library"
										? "default"
										: "muted"
								}
							>
								{details.library}
							</MetaChip>
						)}
						{details.genres && <MetaChip>{details.genres}</MetaChip>}
						{details.albumType && (
							<MetaChip>{details.albumType}</MetaChip>
						)}
					</div>

					{/* External links */}
					{(details.tmdbLink ||
						details.imdbLink ||
						details.musicBrainzLink ||
						details.goodreadsLink ||
						plexUrl) && (
						<div className="flex items-center gap-1.5 mt-2.5">
							{plexUrl && (
								<ExternalBadge
									label="Plex"
									href={plexUrl}
									color={SERVICE_GRADIENTS.plex.from}
									textColor={SERVICE_GRADIENTS.plex.from}
								/>
							)}
							{details.tmdbLink && details.tmdbId && (
								<ExternalBadge
									label="TMDB"
									href={details.tmdbLink}
									color={BRAND_COLORS.tmdb.border}
									textColor={BRAND_COLORS.tmdb.text}
								/>
							)}
							{details.imdbLink && details.imdbId && (
								<ExternalBadge
									label="IMDb"
									href={details.imdbLink}
									color={BRAND_COLORS.imdb.border}
									textColor={BRAND_COLORS.imdb.text}
								/>
							)}
							{details.musicBrainzLink && details.musicBrainzId && (
								<ExternalBadge
									label="MusicBrainz"
									href={details.musicBrainzLink}
									color="#ba478f"
									textColor="#ba478f"
								/>
							)}
							{details.goodreadsLink && details.goodreadsId && (
								<ExternalBadge
									label="Goodreads"
									href={details.goodreadsLink}
									color="#553b08"
									textColor="#8b6914"
								/>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
