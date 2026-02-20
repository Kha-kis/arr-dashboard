"use client";

/**
 * LibraryCard - Premium card component for library items
 *
 * Wrapped with React.memo for list performance optimization.
 */

import { memo } from "react";
import type { LibraryItem } from "@arr/shared";
import {
	AlertTriangle,
	ExternalLink,
	Info,
	ListTree,
	Loader2,
	PauseCircle,
	PlayCircle,
	Search,
	Star,
} from "lucide-react";
import { Button } from "../../../components/ui";
import {
	GlassmorphicCard,
	ServiceBadge,
	StatusBadge,
} from "../../../components/layout";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { RATING_COLOR, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { LibraryBadge } from "./library-badge";
import { PosterImage } from "./poster-image";
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
	/** Callback to search for a movie (for movies only) */
	onSearchMovie?: (item: LibraryItem) => void;
	/** Whether the movie search is pending */
	movieSearchPending?: boolean;
	/** Callback to search for a series (for series only) */
	onSearchSeries?: (item: LibraryItem) => void;
	/** Whether the series search is pending */
	seriesSearchPending?: boolean;
	/** Callback to view album details (for artists only) */
	onViewAlbums?: (item: LibraryItem) => void;
	/** Callback to search for an artist (for Lidarr only) */
	onSearchArtist?: (item: LibraryItem) => void;
	/** Whether the artist search is pending */
	artistSearchPending?: boolean;
	/** Callback to view book details (for authors only) */
	onViewBooks?: (item: LibraryItem) => void;
	/** Callback to search for an author (for Readarr only) */
	onSearchAuthor?: (item: LibraryItem) => void;
	/** Whether the author search is pending */
	authorSearchPending?: boolean;
	/** Callback to expand item details modal */
	onExpandDetails?: (item: LibraryItem) => void;
	/** TMDB vote average from Seerr enrichment (0-10 scale) */
	tmdbRating?: number | null;
	/** Number of open issues in Seerr for this media */
	openIssueCount?: number;
	/** TMDB poster path from Seerr enrichment (e.g. "/xyz123.jpg") */
	posterPath?: string | null;
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
 * - Search for content
 * - Open in external service
 * - View full details (poster/title click)
 * - Toggle monitoring status
 *
 * Memoized to prevent unnecessary re-renders when rendered in lists.
 * Parent components should memoize callback props with useCallback.
 */
export const LibraryCard = memo(function LibraryCard({
	item,
	onToggleMonitor,
	pending,
	externalLink,
	onSearchMovie,
	movieSearchPending = false,
	onSearchSeries,
	seriesSearchPending = false,
	onViewAlbums,
	onSearchArtist,
	artistSearchPending = false,
	onViewBooks,
	onSearchAuthor,
	authorSearchPending = false,
	onExpandDetails,
	tmdbRating,
	openIssueCount,
	posterPath,
}: LibraryCardProps) {
	const [incognitoMode] = useIncognitoMode();
	const monitored = item.monitored ?? false;
	const hasFile = item.hasFile ?? false;
	const sizeLabel = formatBytes(item.sizeOnDisk);
	const runtimeLabel = formatRuntime(item.runtime);
	const serviceType = item.service || "radarr";
	const serviceLabels: Record<string, string> = {
		sonarr: "Sonarr",
		radarr: "Radarr",
		lidarr: "Lidarr",
		readarr: "Readarr",
	};
	const serviceLabel = serviceLabels[item.service ?? "radarr"] ?? "Radarr";
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

	// Convert monitored status to StatusBadge status
	const monitoredStatus: "success" | "warning" = monitored ? "success" : "warning";

	const statusBadges: Array<{
		tone: "green" | "blue" | "red" | "yellow";
		label: React.ReactNode;
	}> = [];

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

	if (item.type === "artist") {
		const missingTracks = item.statistics?.missingTrackCount ?? 0;
		statusBadges.push({
			tone: hasFile ? "green" : "blue",
			label: hasFile ? "Tracks on disk" : "Awaiting tracks",
		});
		if (missingTracks > 0) {
			statusBadges.push({
				tone: "red",
				label: `${missingTracks} missing`,
			});
		}
	}

	if (item.type === "author") {
		const missingBooks = (item.statistics?.totalBookCount ?? 0) - (item.statistics?.bookFileCount ?? 0);
		statusBadges.push({
			tone: hasFile ? "green" : "blue",
			label: hasFile ? "Books on disk" : "Awaiting books",
		});
		if (missingBooks > 0) {
			statusBadges.push({
				tone: "red",
				label: `${missingBooks} missing`,
			});
		}
	}

	if (item.status) {
		statusBadges.push({ tone: "blue", label: item.status });
	}

	const metadata: Array<{ label: string; value: React.ReactNode }> = [
		{ label: "Instance", value: item.instanceName },
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
	} else if (item.type === "series") {
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
	} else if (item.type === "artist") {
		const albumCount = item.statistics?.albumCount ?? 0;
		const trackFileCount = item.statistics?.trackFileCount ?? 0;
		const totalTrackCount = item.statistics?.totalTrackCount ?? 0;
		if (albumCount > 0) {
			metadata.push({ label: "Albums", value: albumCount });
		}
		if (totalTrackCount > 0) {
			metadata.push({
				label: "Tracks",
				value: `${trackFileCount}/${totalTrackCount}`,
			});
		}
		if (sizeLabel) {
			metadata.push({ label: "On disk", value: sizeLabel });
		}
	} else if (item.type === "author") {
		const bookCount = item.statistics?.bookCount ?? 0;
		const bookFileCount = item.statistics?.bookFileCount ?? 0;
		const totalBookCount = item.statistics?.totalBookCount ?? 0;
		if (bookCount > 0) {
			metadata.push({ label: "Books", value: bookCount });
		}
		if (totalBookCount > 0) {
			metadata.push({
				label: "Downloaded",
				value: `${bookFileCount}/${totalBookCount}`,
			});
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

	const genreEntries = (item.genres ?? []).filter(Boolean);

	// Collect external links for the compact link row
	const externalLinks: Array<{ label: string; onClick: () => void }> = [];
	if (externalLink) {
		externalLinks.push({ label: serviceLabel, onClick: handleOpenExternal });
	}
	if (item.remoteIds?.tmdbId) {
		const tmdbType = item.type === "movie" ? "movie" : "tv";
		const tmdbId = item.remoteIds.tmdbId;
		externalLinks.push({
			label: "TMDB",
			onClick: () => safeOpenUrl(`https://www.themoviedb.org/${tmdbType}/${tmdbId}`),
		});
	}
	if (item.remoteIds?.imdbId) {
		const imdbId = item.remoteIds.imdbId;
		externalLinks.push({
			label: "IMDB",
			onClick: () => safeOpenUrl(`https://www.imdb.com/title/${imdbId}`),
		});
	}
	if (item.remoteIds?.tvdbId) {
		const tvdbId = item.remoteIds.tvdbId;
		externalLinks.push({
			label: "TVDB",
			onClick: () => safeOpenUrl(`https://www.thetvdb.com/dereferrer/series/${tvdbId}`),
		});
	}
	if (item.remoteIds?.musicBrainzId) {
		const mbId = item.remoteIds.musicBrainzId;
		externalLinks.push({
			label: "MusicBrainz",
			onClick: () => safeOpenUrl(`https://musicbrainz.org/artist/${mbId}`),
		});
	}
	if (item.remoteIds?.goodreadsId) {
		const grId = item.remoteIds.goodreadsId;
		externalLinks.push({
			label: "Goodreads",
			onClick: () => safeOpenUrl(`https://www.goodreads.com/author/show/${grId}`),
		});
	}

	return (
		<GlassmorphicCard padding="md" className="flex flex-col gap-3">
				<div className="flex gap-3">
					<button
						type="button"
						className="h-36 w-24 overflow-hidden rounded-lg border border-border bg-muted shadow-md shrink-0 transition-transform hover:scale-105 cursor-pointer"
						onClick={() => onExpandDetails?.(item)}
					>
						<PosterImage
							tmdbPosterPath={posterPath}
							arrPosterUrl={item.poster}
							size="w185"
							alt={item.title}
							placeholder={item.type === "movie" ? "Poster" : "Artwork"}
						/>
					</button>

					<div className="flex-1 min-w-0 space-y-2">
						<div>
							<div className="flex flex-wrap items-baseline gap-2">
								<h3
									className="text-base font-semibold text-foreground hover:text-primary cursor-pointer transition-colors"
									onClick={() => onExpandDetails?.(item)}
									role="button"
									tabIndex={0}
									onKeyDown={(e) => e.key === "Enter" && onExpandDetails?.(item)}
								>
									{item.title}
								</h3>
								{item.year && item.type === "movie" ? (
									<span className="text-xs text-muted-foreground">{item.year}</span>
								) : null}
							</div>
							<div className="flex flex-wrap items-center gap-2 mt-1">
								<p className="text-xs text-muted-foreground">
									{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}
								</p>
								<ServiceBadge service={serviceType} />
								<StatusBadge status={monitoredStatus}>
									{monitored ? "Monitored" : "Unmonitored"}
								</StatusBadge>
								{typeof tmdbRating === "number" && tmdbRating > 0 && (
									<span
										className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
										style={{
											backgroundColor: SEMANTIC_COLORS.warning.bg,
											border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
											color: RATING_COLOR,
										}}
									>
										<Star className="h-3 w-3 fill-current" />
										{tmdbRating.toFixed(1)}
									</span>
								)}
								{typeof openIssueCount === "number" && openIssueCount > 0 && (
									<span
										className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
										style={{
											backgroundColor: SEMANTIC_COLORS.error.bg,
											border: `1px solid ${SEMANTIC_COLORS.error.border}`,
											color: SEMANTIC_COLORS.error.text,
										}}
									>
										<AlertTriangle className="h-3 w-3" />
										{openIssueCount}
									</span>
								)}
							</div>
						</div>

						{item.overview ? (
							<div className="group relative">
								<p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
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

						<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
							{metadata.slice(0, 4).map((entry) => (
								<span key={`${item.id}-${entry.label}`}>
									<span className="text-muted-foreground/70">{entry.label}:</span> {entry.value}
								</span>
							))}
						</div>

						{genreEntries.length > 0 ? (
							<div className="flex flex-wrap gap-1.5 text-xs">
								{genreEntries.slice(0, 3).map((genre) => (
									<span
										key={`${item.id}-genre-${genre}`}
										className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground"
									>
										{genre}
									</span>
								))}
								{genreEntries.length > 3 && (
									<span className="text-muted-foreground">+{genreEntries.length - 3} more</span>
								)}
							</div>
						) : null}
					</div>
				</div>

				{/* Card footer — two tiers: action buttons + external links */}
				<div className="border-t border-border/50 pt-3 space-y-2">
					{/* Primary actions */}
					<div className="flex items-center justify-between gap-2">
						<div className="flex flex-wrap items-center gap-1.5">
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

							{item.type === "artist" && onViewAlbums && (item.statistics?.albumCount ?? 0) > 0 ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => onViewAlbums(item)}
								>
									<ListTree className="h-3.5 w-3.5" />
									<span>Albums</span>
								</Button>
							) : null}

							{item.service === "lidarr" && onSearchArtist ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => onSearchArtist(item)}
									disabled={artistSearchPending}
								>
									{artistSearchPending ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Search className="h-3.5 w-3.5" />
									)}
									<span>Search</span>
								</Button>
							) : null}

							{item.type === "author" && onViewBooks && (item.statistics?.bookCount ?? 0) > 0 ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => onViewBooks(item)}
								>
									<ListTree className="h-3.5 w-3.5" />
									<span>Books</span>
								</Button>
							) : null}

							{item.service === "readarr" && onSearchAuthor ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => onSearchAuthor(item)}
									disabled={authorSearchPending}
								>
									{authorSearchPending ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Search className="h-3.5 w-3.5" />
									)}
									<span>Search</span>
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
									<Info className="h-3.5 w-3.5" />
									<span>Details</span>
								</Button>
							) : null}
						</div>

						<Button
							type="button"
							variant={monitored ? "secondary" : "primary"}
							size="sm"
							className="flex items-center gap-1.5 shrink-0"
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

					{/* External links — subtle, dot-separated text */}
					{externalLinks.length > 0 && (
						<div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]">
							<ExternalLink className="h-3 w-3 text-muted-foreground/40 mr-0.5" />
							{externalLinks.map((link, i) => (
								<span key={link.label} className="inline-flex items-center gap-1">
									<button
										type="button"
										className="text-muted-foreground/60 hover:text-foreground transition-colors"
										onClick={link.onClick}
									>
										{link.label}
									</button>
									{i < externalLinks.length - 1 && (
										<span className="text-muted-foreground/30">·</span>
									)}
								</span>
							))}
						</div>
					)}
				</div>
		</GlassmorphicCard>
	);
});
