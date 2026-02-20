"use client";

/**
 * EnrichedDetailModal — Rich library item modal with Seerr TMDB data.
 *
 * When a user has Seerr configured and clicks a Radarr/Sonarr library item,
 * this modal replaces the basic ItemDetailsModal with:
 * - TMDB backdrop hero image
 * - Cast section
 * - Trailer link
 * - Recommendations and similar carousels
 * - Plus all the standard ARR metadata (quality, size, paths, etc.)
 *
 * Falls back to ARR data if the Seerr detail fetch fails.
 */

import { useCallback, useState } from "react";
import type { LibraryItem, SeerrDiscoverResult } from "@arr/shared";
import {
	X,
	Film,
	HardDrive,
	Clock,
	FolderOpen,
	FileVideo,
	Tag,
	Layers,
	Loader2,
	ChevronDown,
	ChevronRight,
	Search,
	AlertTriangle,
	CheckCircle2,
} from "lucide-react";
import { Button } from "../../../components/ui";
import {
	useSeerrMovieDetails,
	useSeerrTvDetails,
} from "../../../hooks/api/useSeerr";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import {
	getSeerrImageUrl,
	getMediaStatusInfo,
	isAnimeFromKeywords,
} from "../../discover/lib/seerr-image-utils";
import { formatBytes, formatRuntime, SERVICE_COLORS } from "../lib/library-utils";
import { useMovieFileQuery } from "../../../hooks/api/useLibrary";
import { PosterImage } from "./poster-image";
import { SeasonEpisodeList } from "./season-episode-list";
import {
	BackdropHero,
	MediaMetaRow,
	CastSection,
	TrailerButton,
	ExternalLinksSection,
} from "../../discover/components/media-detail-sections";
import { DiscoverCarousel } from "../../discover/components/discover-carousel";
import {
	useIncognitoMode,
	getLinuxIsoName,
	getLinuxInstanceName,
	getLinuxSavePath,
} from "../../../lib/incognito";

export interface EnrichedDetailModalProps {
	item: LibraryItem;
	seerrInstanceId: string;
	onClose: () => void;
	onToggleSeason?: (seasonNumber: number, nextMonitored: boolean) => void;
	onSearchSeason?: (seasonNumber: number) => void;
	pendingSeasonAction?: string | null;
	/** Pre-fetched TMDB poster path from enrichment — avoids ARR→TMDB flash while detail query loads */
	enrichedPosterPath?: string | null;
}

export const EnrichedDetailModal: React.FC<EnrichedDetailModalProps> = ({
	item,
	seerrInstanceId,
	onClose,
	onToggleSeason,
	onSearchSeason,
	pendingSeasonAction,
	enrichedPosterPath,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);
	const [incognitoMode] = useIncognitoMode();
	const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());

	const isMovie = item.type === "movie";
	const tmdbId = item.remoteIds?.tmdbId ?? 0;

	// Fetch full Seerr details (cast, recommendations, trailer, etc.)
	const movieQuery = useSeerrMovieDetails(seerrInstanceId, isMovie ? tmdbId : 0);
	const tvQuery = useSeerrTvDetails(seerrInstanceId, !isMovie ? tmdbId : 0);

	// Fetch live movie file details from Radarr (not cached — includes codecs, custom formats, etc.)
	const movieFileQuery = useMovieFileQuery({
		instanceId: item.instanceId,
		movieId: item.id,
		enabled: isMovie && item.hasFile === true,
	});
	const liveMovieFile = movieFileQuery.data?.movieFile ?? null;
	const liveQualityProfileName = movieFileQuery.data?.qualityProfileName;

	const details = isMovie ? movieQuery.data : tvQuery.data;
	const isDetailsLoading = isMovie ? movieQuery.isLoading : tvQuery.isLoading;
	const isDetailsError = isMovie ? movieQuery.isError : tvQuery.isError;
	const isMovieFileFetchError = isMovie && item.hasFile === true && movieFileQuery.isError;

	const serviceColor = SERVICE_COLORS[item.service];

	// Title and overview — prefer Seerr TMDB data, fall back to ARR
	const title = details
		? isMovie
			? (details as NonNullable<typeof movieQuery.data>).title
			: (details as NonNullable<typeof tvQuery.data>).name
		: item.title;
	const overview = details?.overview ?? item.overview;

	// Backdrop
	const backdropPath = details?.backdropPath ?? null;

	// Poster — use detail fetch posterPath, fall back to enrichment posterPath (avoids flash), then ARR
	const tmdbPosterPath = details?.posterPath ?? enrichedPosterPath;
	const hasPoster = !!(tmdbPosterPath || item.poster);

	// Year
	const year = isMovie
		? (details as NonNullable<typeof movieQuery.data>)?.releaseDate
			? new Date((details as NonNullable<typeof movieQuery.data>).releaseDate!).getFullYear()
			: item.year
		: (details as NonNullable<typeof tvQuery.data>)?.firstAirDate
			? new Date((details as NonNullable<typeof tvQuery.data>).firstAirDate!).getFullYear()
			: item.year;

	// Runtime / Seasons
	const runtime = isMovie
		? (details as NonNullable<typeof movieQuery.data>)?.runtime
		: undefined;
	const numberOfSeasons = !isMovie
		? (details as NonNullable<typeof tvQuery.data>)?.numberOfSeasons
		: undefined;

	// Vote average
	const voteAverage = details?.voteAverage;

	// Genres — from Seerr or ARR
	const seerrGenres = details?.genres ?? [];
	const arrGenres = item.genres ?? [];

	// Seerr media status
	const mediaStatus = details?.mediaInfo?.status;
	const statusInfo = getMediaStatusInfo(mediaStatus);

	// Cast
	const cast = (details?.credits?.cast ?? []).slice(0, 12);

	// Recommendations and similar
	const recommendations = details?.recommendations?.results ?? [];
	const similar = details?.similar?.results ?? [];

	// Trailer
	const trailerVideos = details?.relatedVideos;

	// Anime detection
	const tvDetails = !isMovie ? (details as NonNullable<typeof tvQuery.data>) : undefined;
	const isAnime = tvDetails?.keywords
		? isAnimeFromKeywords(tvDetails.keywords)
		: false;

	// ----- ARR metadata (from the library item) -----
	const sizeLabel = formatBytes(item.sizeOnDisk);
	const runtimeLabel = formatRuntime(item.runtime);
	const resolvedQualityProfileName = liveQualityProfileName ?? item.qualityProfileName;

	// For movies: metadata is merged into a single combined section with file details.
	// For series: build a metadata grid (no per-file details available).
	const seriesMetadata: Array<{ label: string; value: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }> = [];
	if (!isMovie) {
		seriesMetadata.push({ label: "Instance", value: incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName });
		if (resolvedQualityProfileName) {
			seriesMetadata.push({ label: "Quality profile", value: resolvedQualityProfileName });
		}
		const seasonCount =
			item.seasons?.filter((s) => s.seasonNumber !== 0).length ||
			item.statistics?.seasonCount ||
			undefined;
		if (seasonCount) seriesMetadata.push({ label: "Seasons", value: seasonCount, icon: Layers });
		const episodeFileCount = item.statistics?.episodeFileCount ?? 0;
		const totalEpisodes = item.statistics?.episodeCount ?? item.statistics?.totalEpisodeCount ?? 0;
		if (totalEpisodes > 0) {
			seriesMetadata.push({ label: "Episodes", value: `${episodeFileCount}/${totalEpisodes}` });
		}
		if (runtimeLabel) seriesMetadata.push({ label: "Episode length", value: runtimeLabel, icon: Clock });
		if (sizeLabel) seriesMetadata.push({ label: "On disk", value: sizeLabel, icon: HardDrive });
		if (item.path) {
			const displayPath = incognitoMode ? getLinuxSavePath(item.path) : item.path;
			seriesMetadata.push({ label: "Location", value: displayPath, icon: FolderOpen });
		}
		if (item.rootFolderPath && item.rootFolderPath !== item.path) {
			const displayRoot = incognitoMode ? "/media" : item.rootFolderPath;
			seriesMetadata.push({ label: "Root", value: displayRoot, icon: FolderOpen });
		}
	}

	// For movies: resolve the best file data (live > cached)
	const mf = isMovie ? (liveMovieFile ?? item.movieFile) : null;

	const tagEntries = (item.tags ?? []).filter(Boolean);

	// Merge Sonarr seasons with Seerr season summaries for progress display
	const seerrSeasons = tvDetails?.seasons ?? [];
	const sonarrSeasons = item.seasons ?? [];
	const mergedSeasons =
		!isMovie && sonarrSeasons.length > 0
			? (() => {
					const seerrMap = new Map(
						seerrSeasons.map((s) => [s.seasonNumber, s]),
					);
					return sonarrSeasons
						.map((sonarr) => {
							const seerr = seerrMap.get(sonarr.seasonNumber);
							return {
								seasonNumber: sonarr.seasonNumber,
								name:
									seerr?.name ??
									sonarr.title ??
									(sonarr.seasonNumber === 0
										? "Specials"
										: `Season ${sonarr.seasonNumber}`),
								airDate: seerr?.airDate,
								posterPath: seerr?.posterPath,
								episodeFileCount: sonarr.episodeFileCount ?? 0,
								episodeCount:
									sonarr.episodeCount ?? seerr?.episodeCount ?? 0,
								monitored: sonarr.monitored ?? false,
							};
						})
						.sort((a, b) => {
							if (a.seasonNumber === 0) return 1;
							if (b.seasonNumber === 0) return -1;
							return a.seasonNumber - b.seasonNumber;
						});
				})()
			: [];

	// Overall season stats — use series-level statistics from Sonarr.
	// Series-level `episodeCount` already only counts monitored episodes,
	// so we get "monitored-only" progress without manual season filtering.
	// Per-season stats may be absent if the season `statistics` sub-object
	// wasn't populated in the library cache, but the series-level stats
	// are always reliable.
	const totalSeasonEpisodes =
		item.statistics?.episodeCount ??
		item.statistics?.totalEpisodeCount ??
		mergedSeasons.filter((s) => s.monitored).reduce((sum, s) => sum + s.episodeCount, 0);
	const totalSeasonDownloaded =
		item.statistics?.episodeFileCount ??
		mergedSeasons.filter((s) => s.monitored).reduce((sum, s) => sum + s.episodeFileCount, 0);
	const overallSeasonProgress =
		totalSeasonEpisodes > 0
			? Math.round((totalSeasonDownloaded / totalSeasonEpisodes) * 100)
			: 0;
	const totalSeasonMissing = Math.max(totalSeasonEpisodes - totalSeasonDownloaded, 0);

	const toggleSeasonExpanded = (seasonNumber: number) => {
		setExpandedSeasons((prev) => {
			const next = new Set(prev);
			if (next.has(seasonNumber)) {
				next.delete(seasonNumber);
			} else {
				next.add(seasonNumber);
			}
			return next;
		});
	};

	// Handle selecting a recommendation/similar item — open in TMDB
	const handleSelectRelated = useCallback(
		(relatedItem: SeerrDiscoverResult) => {
			const mediaType = relatedItem.mediaType === "movie" ? "movie" : "tv";
			safeOpenUrl(`https://www.themoviedb.org/${mediaType}/${relatedItem.id}`);
		},
		[],
	);

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="enriched-detail-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 scrollbar-none"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${serviceColor}15`,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close button */}
				<button
					type="button"
					onClick={onClose}
					className="absolute right-4 top-4 z-20 rounded-xl bg-black/50 p-2 text-white/80 backdrop-blur-sm transition-all hover:bg-black/70 hover:text-white hover:scale-110"
					aria-label="Close"
				>
					<X className="h-5 w-5" />
				</button>

				{/* Hero backdrop */}
				<BackdropHero backdropPath={backdropPath} title={title} />

				{/* Content */}
				<div className="relative -mt-24 px-6 pb-6 space-y-6">
					{/* Header: poster + info */}
					<div className="flex gap-5">
						{hasPoster && (
							<div className="shrink-0 w-[120px] rounded-xl overflow-hidden border border-border/50 shadow-xl hidden sm:block">
								<PosterImage
									tmdbPosterPath={tmdbPosterPath}
									arrPosterUrl={item.poster}
									size="w342"
									alt={title}
									imgClassName="w-full"
								/>
							</div>
						)}

						<div className="flex-1 min-w-0 space-y-3 pt-8 sm:pt-0">
							<h2
								id="enriched-detail-title"
								className="text-2xl sm:text-3xl font-bold text-foreground leading-tight"
							>
								{title}
							</h2>

							<MediaMetaRow
								year={year}
								runtime={runtime}
								numberOfSeasons={numberOfSeasons}
								voteAverage={voteAverage}
								isMovie={isMovie}
								isAnime={isAnime}
							/>

							{/* Genre pills */}
							{(seerrGenres.length > 0 || arrGenres.length > 0 || isAnime) && (
								<div className="flex flex-wrap gap-1.5">
									{isAnime && (
										<span className="rounded-md border border-pink-500/30 bg-pink-500/10 px-2 py-0.5 text-xs font-semibold text-pink-400">
											Anime
										</span>
									)}
									{seerrGenres.length > 0
										? seerrGenres.map((g) => (
												<span
													key={g.id}
													className="rounded-md border border-border/50 bg-card/60 px-2 py-0.5 text-xs text-muted-foreground"
												>
													{g.name}
												</span>
											))
										: arrGenres.map((genre) => (
												<span
													key={genre}
													className="rounded-md border border-border/50 bg-card/60 px-2 py-0.5 text-xs text-muted-foreground"
												>
													{genre}
												</span>
											))}
								</div>
							)}

							{/* Seerr status + monitored badges */}
							<div className="flex items-center gap-2 pt-1">
								{statusInfo && (
									<span
										className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
										style={{
											backgroundColor: statusInfo.bg,
											border: `1px solid ${statusInfo.border}`,
											color: statusInfo.text,
										}}
									>
										{statusInfo.label}
									</span>
								)}
								<span
									className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
									style={{
										backgroundColor: item.monitored
											? SEMANTIC_COLORS.success.bg
											: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${item.monitored ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.warning.border}`,
										color: item.monitored ? SEMANTIC_COLORS.success.from : SEMANTIC_COLORS.warning.text,
									}}
								>
									{item.monitored ? "Monitored" : "Unmonitored"}
								</span>
								<span
									className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
									style={{
										backgroundColor: `${serviceColor}15`,
										border: `1px solid ${serviceColor}30`,
										color: serviceColor,
									}}
								>
									{item.service === "sonarr" ? "Sonarr" : "Radarr"}
								</span>
							</div>
						</div>
					</div>

					{/* Loading spinner */}
					{isDetailsLoading && (
						<div className="flex items-center justify-center py-8">
							<Loader2
								className="h-6 w-6 animate-spin"
								style={{ color: themeGradient.from }}
							/>
						</div>
					)}

					{/* Error banner when Seerr detail fetch fails */}
					{isDetailsError && !isDetailsLoading && (
						<div
							className="rounded-lg px-4 py-2 text-sm"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
								color: SEMANTIC_COLORS.warning.text,
							}}
						>
							Could not load enriched details from Seerr. Showing basic metadata only.
						</div>
					)}

					{/* Overview */}
					{overview && (
						<div className="space-y-2">
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
								Overview
							</h3>
							<p className="text-sm text-foreground/80 leading-relaxed">{overview}</p>
						</div>
					)}

					{/* Movie: Single combined details section (metadata + file info) */}
					{isMovie && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								Media Details
							</h3>
							{isMovieFileFetchError && (
								<p className="text-xs text-amber-400/70 italic mb-2">
									Live file details unavailable — showing cached data
								</p>
							)}
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-3">
								{/* Key metadata row: instance + quality profile */}
								<div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
									<div>
										<p className="text-xs text-muted-foreground">Instance</p>
										<p className="font-medium text-foreground">{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}</p>
									</div>
									{resolvedQualityProfileName && (
										<div>
											<p className="text-xs text-muted-foreground">Quality Profile</p>
											<p className="font-medium text-foreground">{resolvedQualityProfileName}</p>
										</div>
									)}
									{runtimeLabel && (
										<div>
											<p className="text-xs text-muted-foreground">Runtime</p>
											<p className="font-medium text-foreground">{runtimeLabel}</p>
										</div>
									)}
								</div>

								{mf && (
									<>
										{/* Quality + release group + resolution + codecs */}
										<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm pt-2 border-t border-border/20">
											{mf.quality && (
												<span className="inline-flex items-center gap-1.5">
													<Film className="h-3.5 w-3.5 text-cyan-400/70" />
													<span className="font-medium text-foreground">{mf.quality}</span>
													{mf.releaseGroup && (
														<span className="text-muted-foreground/70">— {mf.releaseGroup}</span>
													)}
												</span>
											)}
											{mf.resolution && (
												<span className="text-foreground/80">
													{mf.resolution}
													{mf.videoDynamicRange && mf.videoDynamicRange !== "SDR" && (
														<span className="ml-1 text-amber-400/80 font-semibold">
															{mf.videoDynamicRange}
														</span>
													)}
												</span>
											)}
											{(mf.videoCodec || mf.audioCodec) && (
												<span className="text-muted-foreground/70">
													{[mf.videoCodec, mf.audioCodec].filter(Boolean).join(" / ")}
												</span>
											)}
										</div>

										{/* Languages + size + score */}
										<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
											{mf.languages && mf.languages.length > 0 && (
												<span>{mf.languages.join(", ")}</span>
											)}
											{mf.size != null && mf.size > 0 && (
												<span className="inline-flex items-center gap-1.5">
													<HardDrive className="h-3.5 w-3.5 text-muted-foreground/50" />
													{formatBytes(mf.size)}
												</span>
											)}
											{mf.customFormatScore != null && (
												<span className="font-medium text-foreground/70">
													Score: {mf.customFormatScore}
												</span>
											)}
										</div>

										{/* Custom format badges */}
										{mf.customFormats && mf.customFormats.length > 0 && (
											<div className="flex flex-wrap items-center gap-1.5">
												{mf.customFormats.map((cf) => (
													<span
														key={cf}
														className="rounded-full border border-purple-400/30 bg-purple-500/10 px-2 py-0.5 text-xs text-purple-300"
													>
														{cf}
													</span>
												))}
											</div>
										)}

										{/* File path + folder location */}
										{(mf.relativePath || item.path) && (
											<div className="space-y-1 pt-1 border-t border-border/20">
												{mf.relativePath && (
													<p className="break-all font-mono text-xs text-muted-foreground/60">
														<span className="inline-flex items-center gap-1">
															<FileVideo className="h-3 w-3 shrink-0" />
															{incognitoMode ? getLinuxIsoName(mf.relativePath) : mf.relativePath}
														</span>
													</p>
												)}
												{item.path && (
													<p className="break-all font-mono text-xs text-muted-foreground/40">
														<span className="inline-flex items-center gap-1">
															<FolderOpen className="h-3 w-3 shrink-0" />
															{incognitoMode ? getLinuxSavePath(item.path) : item.path}
														</span>
													</p>
												)}
											</div>
										)}
									</>
								)}

								{/* Fallback if no file yet: just show size if available */}
								{!mf && sizeLabel && (
									<div className="flex items-center gap-1.5 text-sm text-muted-foreground pt-2 border-t border-border/20">
										<HardDrive className="h-3.5 w-3.5 text-muted-foreground/50" />
										{sizeLabel}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Series: Metadata grid (no per-file details) */}
					{!isMovie && seriesMetadata.length > 0 && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								Media Details
							</h3>
							<div className="grid grid-cols-2 md:grid-cols-3 gap-4 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
								{seriesMetadata.map((entry) => (
									<div key={entry.label} className="space-y-1">
										<div className="flex items-center gap-1.5">
											{entry.icon && <entry.icon className="h-3 w-3 text-muted-foreground" />}
											<p className="text-xs uppercase tracking-wider text-muted-foreground">{entry.label}</p>
										</div>
										<p className="text-sm font-medium text-foreground">{entry.value}</p>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Season Breakdown */}
					{mergedSeasons.length > 0 && (
						<div>
							{/* Section header with overall progress */}
							<div className="mb-3">
								<div className="flex items-center justify-between mb-2">
									<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
										Seasons
									</h3>
									<div className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">
											{totalSeasonDownloaded}/{totalSeasonEpisodes} episodes ({overallSeasonProgress}%)
										</span>
										{totalSeasonMissing > 0 ? (
											<span
												className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
												style={{
													backgroundColor: SEMANTIC_COLORS.warning.bg,
													border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
													color: SEMANTIC_COLORS.warning.text,
												}}
											>
												<AlertTriangle className="h-2.5 w-2.5" />
												{totalSeasonMissing} missing
											</span>
										) : totalSeasonEpisodes > 0 ? (
											<span
												className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
												style={{
													backgroundColor: SEMANTIC_COLORS.success.bg,
													border: `1px solid ${SEMANTIC_COLORS.success.border}`,
													color: SEMANTIC_COLORS.success.text,
												}}
											>
												<CheckCircle2 className="h-2.5 w-2.5" />
												Complete
											</span>
										) : null}
									</div>
								</div>
								<div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
									<div
										className="h-full transition-all duration-500 rounded-full"
										style={{
											width: `${overallSeasonProgress}%`,
											background:
												totalSeasonMissing > 0
													? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
													: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
										}}
									/>
								</div>
							</div>

							{/* Individual season rows */}
							<div className="space-y-2">
								{mergedSeasons.map((season) => {
									const total = season.episodeCount;
									const downloaded = season.episodeFileCount;
									const missing = !season.monitored
										? 0
										: Math.max(total - downloaded, 0);
									const percent =
										total > 0
											? Math.round((downloaded / total) * 100)
											: 0;
									const isComplete = downloaded >= total && total > 0;
									const airYear = season.airDate
										? new Date(season.airDate).getFullYear()
										: undefined;
									const seasonPoster = getSeerrImageUrl(
										season.posterPath,
										"w92",
									);
									const isExpanded = expandedSeasons.has(
										season.seasonNumber,
									);
									const seasonKey = `${item.instanceId}:${item.id}:${season.seasonNumber}`;
									const monitorPending =
										pendingSeasonAction === `monitor:${seasonKey}`;
									const searchPending =
										pendingSeasonAction === `search:${seasonKey}`;

									return (
										<div
											key={season.seasonNumber}
											className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden transition-all duration-300 hover:border-border/80"
											style={
												isExpanded
													? { borderColor: `${themeGradient.from}40` }
													: undefined
											}
										>
											<div className="px-4 py-3">
												<div className="flex flex-wrap items-center justify-between gap-3">
													{/* Expand/collapse + poster + name */}
													<button
														type="button"
														onClick={() =>
															toggleSeasonExpanded(season.seasonNumber)
														}
														aria-expanded={isExpanded}
														className="flex items-center gap-2 text-left hover:text-foreground transition-colors group"
													>
														<div
															className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
															style={{
																background: isExpanded
																	? `${themeGradient.from}20`
																	: "transparent",
															}}
														>
															{isExpanded ? (
																<ChevronDown
																	className="h-4 w-4"
																	style={{
																		color: themeGradient.from,
																	}}
																/>
															) : (
																<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
															)}
														</div>
														{seasonPoster && (
															<div className="shrink-0 w-8 h-12 rounded overflow-hidden hidden sm:block">
																{/* eslint-disable-next-line @next/next/no-img-element */}
																<img
																	src={seasonPoster}
																	alt={season.name}
																	className="w-full h-full object-cover"
																/>
															</div>
														)}
														<div>
															<p className="text-sm font-medium text-foreground">
																{season.name}
															</p>
															{airYear && (
																<p className="text-xs text-muted-foreground">
																	{airYear}
																</p>
															)}
														</div>
													</button>

													{/* Badges */}
													<div className="flex flex-wrap items-center gap-1.5">
														<span
															className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
															style={{
																backgroundColor:
																	missing > 0
																		? SEMANTIC_COLORS.warning.bg
																		: SEMANTIC_COLORS.success.bg,
																border: `1px solid ${missing > 0 ? SEMANTIC_COLORS.warning.border : SEMANTIC_COLORS.success.border}`,
																color:
																	missing > 0
																		? SEMANTIC_COLORS.warning.text
																		: SEMANTIC_COLORS.success.text,
															}}
														>
															{downloaded}/{total || "?"} episodes
														</span>
														{missing > 0 && (
															<span
																className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
																style={{
																	backgroundColor:
																		SEMANTIC_COLORS.error.bg,
																	border: `1px solid ${SEMANTIC_COLORS.error.border}`,
																	color: SEMANTIC_COLORS.error.text,
																}}
															>
																{missing} missing
															</span>
														)}
														{!season.monitored && (
															<span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted/20 border border-border/50 text-muted-foreground">
																Unmonitored
															</span>
														)}
													</div>

													{/* Action buttons */}
													{(onToggleSeason || onSearchSeason) && (
														<div className="flex items-center gap-2">
															{onToggleSeason && (
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	className="gap-1.5"
																	disabled={monitorPending}
																	onClick={() =>
																		onToggleSeason(
																			season.seasonNumber,
																			!season.monitored,
																		)
																	}
																>
																	{monitorPending ? (
																		<Loader2 className="h-3.5 w-3.5 animate-spin" />
																	) : season.monitored ? (
																		"Unmonitor"
																	) : (
																		"Monitor"
																	)}
																</Button>
															)}
															{onSearchSeason && (
																<Button
																	type="button"
																	size="sm"
																	className="gap-1.5"
																	disabled={searchPending}
																	onClick={() =>
																		onSearchSeason(
																			season.seasonNumber,
																		)
																	}
																	style={{
																		background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																		boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
																	}}
																>
																	{searchPending ? (
																		<Loader2 className="h-3.5 w-3.5 animate-spin" />
																	) : (
																		<Search className="h-3.5 w-3.5" />
																	)}
																	Search
																</Button>
															)}
														</div>
													)}
												</div>

												{/* Per-season progress bar */}
												{total > 0 && (
													<div className="mt-3 space-y-1">
														<div className="flex items-center justify-between text-xs">
															<span className="text-muted-foreground">
																Progress
															</span>
															<span className="font-medium text-foreground">
																{percent}%
															</span>
														</div>
														<div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
															<div
																className="h-full rounded-full transition-all duration-500"
																style={{
																	width: `${percent}%`,
																	backgroundColor: isComplete
																		? SEMANTIC_COLORS.success.from
																		: themeGradient.from,
																}}
															/>
														</div>
													</div>
												)}
											</div>

											{/* Expanded: episode list */}
											{isExpanded && (
												<div
													className="border-t border-border/30 px-4 py-4"
													style={{
														background: `linear-gradient(135deg, ${themeGradient.from}05, transparent)`,
													}}
												>
													<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
														Episodes
													</h4>
													<SeasonEpisodeList
														instanceId={item.instanceId}
														seriesId={item.id}
														seasonNumber={season.seasonNumber}
													/>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Tags */}
					{tagEntries.length > 0 && (
						<div>
							<h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								<Tag className="h-3 w-3" />
								Tags
							</h3>
							<div className="flex flex-wrap gap-2">
								{tagEntries.map((tag, index) => (
									<span
										key={`${index}-${tag}`}
										className="rounded-full border border-border/50 bg-card/50 px-3 py-1 text-sm text-foreground"
									>
										{tag}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Cast */}
					{cast.length > 0 && <CastSection cast={cast} />}

					{/* Trailer */}
					<TrailerButton videos={trailerVideos} />

					{/* External Links */}
					<ExternalLinksSection
						tmdbId={item.remoteIds?.tmdbId}
						imdbId={item.remoteIds?.imdbId}
						tvdbId={item.remoteIds?.tvdbId}
						mediaType={isMovie ? "movie" : "tv"}
					/>

					{/* Recommendations */}
					{recommendations.length > 0 && (
						<DiscoverCarousel
							title="Recommendations"
							items={recommendations}
							onSelectItem={handleSelectRelated}
						/>
					)}

					{/* Similar */}
					{similar.length > 0 && (
						<DiscoverCarousel
							title="Similar"
							items={similar}
							onSelectItem={handleSelectRelated}
						/>
					)}
				</div>
			</div>
		</div>
	);
};
