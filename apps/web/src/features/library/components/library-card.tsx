"use client";

import type { LibraryItem } from "@arr/shared";
import {
	AlertCircle,
	ExternalLink,
	ListTree,
	Loader2,
	PauseCircle,
	PlayCircle,
	Search,
} from "lucide-react";
import { Button, Card, CardContent } from "../../../components/ui";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { LibraryBadge } from "./library-badge";
import { formatBytes, formatRuntime } from "../lib/library-utils";
import {
	useIncognitoMode,
	getLinuxIsoName,
	getLinuxInstanceName,
	getLinuxSavePath,
} from "../../../lib/incognito";

/**
 * Props for the LibraryCard component
 */
interface LibraryCardProps {
	/** The library item to display */
	item: LibraryItem;
	/** Callback to toggle monitoring status */
	onToggleMonitor: (item: LibraryItem) => void;
	/** Whether the monitor toggle action is pending */
	pending: boolean;
	/** External link to the item in the *arr service (optional) */
	externalLink?: string | null;
	/** Callback to view season details (for series only) */
	onViewSeasons?: (item: LibraryItem) => void;
	/** Callback to search for a movie (for movies only) */
	onSearchMovie?: (item: LibraryItem) => void;
	/** Whether the movie search is pending */
	movieSearchPending?: boolean;
	/** Callback to search for a series (for series only) */
	onSearchSeries?: (item: LibraryItem) => void;
	/** Whether the series search is pending */
	seriesSearchPending?: boolean;
	/** Callback to expand item details modal */
	onExpandDetails?: (item: LibraryItem) => void;
}

/**
 * LibraryCard displays a single library item (movie or series) with comprehensive information
 * and action buttons.
 *
 * The card shows:
 * - Poster/artwork
 * - Title, year, and instance name
 * - Overview with read more option
 * - Status badges (monitored, file status, missing episodes)
 * - Metadata (quality, size, runtime, episodes, etc.)
 * - Genres
 *
 * Available actions:
 * - View seasons (series only)
 * - Search for content
 * - Open in external service
 * - View full details
 * - Toggle monitoring status
 */
export const LibraryCard = ({
	item,
	onToggleMonitor,
	pending,
	externalLink,
	onViewSeasons,
	onSearchMovie,
	movieSearchPending = false,
	onSearchSeries,
	seriesSearchPending = false,
	onExpandDetails,
}: LibraryCardProps) => {
	const [incognitoMode] = useIncognitoMode();
	const monitored = item.monitored ?? false;
	const hasFile = item.hasFile ?? false;
	const sizeLabel = formatBytes(item.sizeOnDisk);
	const runtimeLabel = formatRuntime(item.runtime);
	const serviceLabel = item.service === "sonarr" ? "Sonarr" : "Radarr";
	const rawMovieFileName =
		item.type === "movie"
			? (item.movieFile?.relativePath ?? item.path)?.split(/[\\/]/g).pop()
			: undefined;
	const movieFileName = incognitoMode && rawMovieFileName
		? getLinuxIsoName(rawMovieFileName)
		: rawMovieFileName;

	const handleOpenExternal = () => {
		if (!externalLink) {
			return;
		}
		safeOpenUrl(externalLink);
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
		: (item.statistics?.episodeFileCount ?? 0);
	const effectiveTotalEpisodes = hasSeasonProgress
		? totalEpisodes
		: (item.statistics?.episodeCount ?? item.statistics?.totalEpisodeCount ?? 0);
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

	const statusBadges: Array<{
		tone: "green" | "blue" | "red" | "yellow";
		label: React.ReactNode;
	}> = [
		{
			tone: monitored ? "green" : "yellow",
			label: monitored ? "Monitored" : "Not monitored",
		},
	];

	if (item.type === "movie") {
		statusBadges.push({
			tone: hasFile ? "green" : "blue",
			label: hasFile ? "File present" : "Awaiting file",
		});
	}

	if (item.type === "series") {
		statusBadges.push({
			tone: hasFile ? "green" : "blue",
			label: hasFile ? "Files on disk" : "Awaiting import",
		});
		if (missingEpisodeTotals > 0) {
			statusBadges.push({
				tone: "red",
				label: `${missingEpisodeTotals} missing`,
			});
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
			metadata.push({
				label: "Missing (monitored)",
				value: missingEpisodeTotals,
			});
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
		const displayPath = incognitoMode ? getLinuxSavePath(item.path) : item.path;
		locationEntries.push({ label: "Location", value: displayPath });
	}
	if (movieFileName) {
		locationEntries.push({ label: "File", value: movieFileName });
	}
	if (item.rootFolderPath && item.rootFolderPath !== item.path) {
		const displayRoot = incognitoMode ? "/media" : item.rootFolderPath;
		locationEntries.push({ label: "Root", value: displayRoot });
	}

	const tagEntries = (item.tags ?? []).filter(Boolean);
	const genreEntries = (item.genres ?? []).filter(Boolean);

	return (
		<Card className="border-border bg-bg-subtle p-4">
			<CardContent className="flex flex-col gap-3">
				<div className="flex gap-3">
					<div className="h-36 w-24 overflow-hidden rounded-lg border border-border bg-bg-hover shadow-md flex-shrink-0">
						{item.poster ? (
							/* eslint-disable-next-line @next/next/no-img-element -- External poster from arr instance */
							<img src={item.poster} alt={item.title} className="h-full w-full object-cover" />
						) : (
							<div className="flex h-full w-full items-center justify-center text-xs text-fg-muted">
								{item.type === "movie" ? "Poster" : "Artwork"}
							</div>
						)}
					</div>

					<div className="flex-1 min-w-0 space-y-2">
						<div>
							<div className="flex flex-wrap items-baseline gap-2">
								<h3 className="text-base font-semibold text-fg">{item.title}</h3>
								{item.year && item.type === "movie" ? (
									<span className="text-xs text-fg-muted">{item.year}</span>
								) : null}
							</div>
							<p className="text-xs text-fg-muted">
							{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}
						</p>
						</div>

						{item.overview ? (
							<div className="group relative">
								<p className="text-xs leading-relaxed text-fg-muted line-clamp-2">
									{item.overview}
								</p>
								{item.overview.length > 120 && onExpandDetails ? (
									<button
										onClick={() => onExpandDetails(item)}
										className="mt-1 text-xs text-primary hover:text-primary-hover transition-colors"
									>
										Read more...
									</button>
								) : null}
							</div>
						) : null}

						<div className="flex flex-wrap gap-2">
							{statusBadges.map((badge, index) => (
								<LibraryBadge key={`${item.id}-badge-${index}`} tone={badge.tone}>
									{badge.label}
								</LibraryBadge>
							))}
						</div>

						<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
							{metadata.slice(0, 4).map((entry) => (
								<span key={`${item.id}-${entry.label}`}>
									<span className="text-fg-muted/70">{entry.label}:</span> {entry.value}
								</span>
							))}
						</div>

						{genreEntries.length > 0 ? (
							<div className="flex flex-wrap gap-1.5 text-xs">
								{genreEntries.slice(0, 3).map((genre) => (
									<span
										key={`${item.id}-genre-${genre}`}
										className="rounded-full border border-border bg-bg-hover px-2 py-0.5 text-fg-muted"
									>
										{genre}
									</span>
								))}
								{genreEntries.length > 3 && (
									<span className="text-fg-muted">+{genreEntries.length - 3} more</span>
								)}
							</div>
						) : null}
					</div>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
					<div className="flex flex-wrap gap-1.5">
						{item.type === "series" && hasSeasonProgress && onViewSeasons ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="flex items-center gap-1.5"
								onClick={() => onViewSeasons(item)}
							>
								<ListTree className="h-3.5 w-3.5" />
								<span>Seasons</span>
							</Button>
						) : null}

						{item.service === "sonarr" && onSearchSeries ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="flex items-center gap-1.5"
								onClick={() => onSearchSeries(item)}
								disabled={seriesSearchPending}
							>
								{seriesSearchPending ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<Search className="h-3.5 w-3.5" />
								)}
								<span>Search</span>
							</Button>
						) : null}

						{item.service === "radarr" && onSearchMovie ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="flex items-center gap-1.5"
								onClick={() => onSearchMovie(item)}
								disabled={movieSearchPending}
							>
								{movieSearchPending ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<Search className="h-3.5 w-3.5" />
								)}
								<span>Search</span>
							</Button>
						) : null}

						{externalLink ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="flex items-center gap-1.5"
								onClick={handleOpenExternal}
							>
								<ExternalLink className="h-3.5 w-3.5" />
								<span>{serviceLabel}</span>
							</Button>
						) : null}

						{item.remoteIds?.tmdbId ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="flex items-center gap-1.5 text-fg-muted hover:text-fg"
								onClick={() => safeOpenUrl(`https://www.themoviedb.org/${item.type === "movie" ? "movie" : "tv"}/${item.remoteIds?.tmdbId}`)}
							>
								<span>TMDB</span>
							</Button>
						) : null}

						{item.remoteIds?.imdbId ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="flex items-center gap-1.5 text-fg-muted hover:text-fg"
								onClick={() => safeOpenUrl(`https://www.imdb.com/title/${item.remoteIds?.imdbId}`)}
							>
								<span>IMDB</span>
							</Button>
						) : null}

						{item.remoteIds?.tvdbId ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="flex items-center gap-1.5 text-fg-muted hover:text-fg"
								onClick={() => safeOpenUrl(`https://www.thetvdb.com/dereferrer/series/${item.remoteIds?.tvdbId}`)}
							>
								<span>TVDB</span>
							</Button>
						) : null}

						{onExpandDetails ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="flex items-center gap-1.5"
								onClick={() => onExpandDetails(item)}
							>
								<AlertCircle className="h-3.5 w-3.5" />
								<span>Details</span>
							</Button>
						) : null}
					</div>

					<Button
						type="button"
						variant={monitored ? "secondary" : "primary"}
						size="sm"
						className="flex items-center gap-1.5"
						onClick={() => onToggleMonitor(item)}
						disabled={pending}
					>
						{pending ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : monitored ? (
							<PauseCircle className="h-3.5 w-3.5" />
						) : (
							<PlayCircle className="h-3.5 w-3.5" />
						)}
						{monitored ? "Unmonitor" : "Monitor"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
