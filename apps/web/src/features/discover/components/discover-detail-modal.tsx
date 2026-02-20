"use client";

import { useCallback } from "react";
import {
	X,
	Star,
	Clock,
	Calendar,
	Film,
	Tv,
	Send,
	Loader2,
	Layers,
} from "lucide-react";
import type { SeerrDiscoverResult } from "@arr/shared";
import { SEERR_MEDIA_STATUS } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { RATING_COLOR } from "../../../lib/theme-gradients";
import {
	useSeerrMovieDetails,
	useSeerrTvDetails,
} from "../../../hooks/api/useSeerr";
import {
	getSeerrImageUrl,
	getMediaStatusInfo,
	getDisplayTitle,
	getReleaseYear,
	isAnimeFromKeywords,
	isLikelyAnime,
} from "../lib/seerr-image-utils";
import { DiscoverCarousel } from "./discover-carousel";
import {
	CastSection,
	TrailerButton,
	ExternalLinksSection,
} from "./media-detail-sections";

interface DiscoverDetailModalProps {
	item: SeerrDiscoverResult;
	instanceId: string;
	onClose: () => void;
	onRequest: (item: SeerrDiscoverResult) => void;
	onSelectItem: (item: SeerrDiscoverResult) => void;
}

export const DiscoverDetailModal: React.FC<DiscoverDetailModalProps> = ({
	item,
	instanceId,
	onClose,
	onRequest,
	onSelectItem,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);
	const isMovie = item.mediaType === "movie";

	const movieQuery = useSeerrMovieDetails(instanceId, isMovie ? item.id : 0);
	const tvQuery = useSeerrTvDetails(instanceId, !isMovie ? item.id : 0);

	const details = isMovie ? movieQuery.data : tvQuery.data;
	const isDetailsLoading = isMovie ? movieQuery.isLoading : tvQuery.isLoading;

	const title = details
		? isMovie
			? (details as NonNullable<typeof movieQuery.data>).title
			: (details as NonNullable<typeof tvQuery.data>).name
		: getDisplayTitle(item);
	const year = getReleaseYear(
		isMovie
			? { releaseDate: (details as NonNullable<typeof movieQuery.data>)?.releaseDate ?? item.releaseDate }
			: { firstAirDate: (details as NonNullable<typeof tvQuery.data>)?.firstAirDate ?? item.firstAirDate },
	);
	const backdropUrl = getSeerrImageUrl(
		details?.backdropPath ?? item.backdropPath,
		"w1280",
	);
	const posterUrl = getSeerrImageUrl(
		details?.posterPath ?? item.posterPath,
		"w342",
	);

	const mediaStatus = details?.mediaInfo?.status ?? item.mediaInfo?.status;
	const statusInfo = getMediaStatusInfo(mediaStatus);
	const isAvailable = mediaStatus === SEERR_MEDIA_STATUS.AVAILABLE;
	const hasRequest =
		mediaStatus === SEERR_MEDIA_STATUS.PENDING ||
		mediaStatus === SEERR_MEDIA_STATUS.PROCESSING;

	// Recommendations and similar from details
	const recommendations = details?.recommendations?.results ?? [];
	const similar = details?.similar?.results ?? [];

	// Cast (top 12)
	const cast = (details?.credits?.cast ?? []).slice(0, 12);

	// Runtime
	const runtime = isMovie
		? (details as NonNullable<typeof movieQuery.data>)?.runtime
		: undefined;
	const numberOfSeasons = !isMovie
		? (details as NonNullable<typeof tvQuery.data>)?.numberOfSeasons
		: undefined;

	// Genres
	const genres = details?.genres ?? [];

	// Anime detection: definitive from keywords (detail), heuristic fallback (discover result)
	const tvDetails = !isMovie ? (details as NonNullable<typeof tvQuery.data>) : undefined;
	const isAnime = !isMovie
		? tvDetails?.keywords
			? isAnimeFromKeywords(tvDetails.keywords)
			: isLikelyAnime(item)
		: false;

	// Trailer videos (passed to shared TrailerButton which handles validation)
	const trailerVideos = details?.relatedVideos;

	// Seasons (TV only)
	const seasons = !isMovie
		? ((details as NonNullable<typeof tvQuery.data>)?.seasons ?? []).filter(
				(s) => s.seasonNumber > 0,
			)
		: [];

	// Handle selecting a recommendation/similar item — close this modal first
	const handleSelectRelated = useCallback(
		(relatedItem: SeerrDiscoverResult) => {
			onClose();
			// Small delay for animation before opening new detail
			setTimeout(() => onSelectItem(relatedItem), 150);
		},
		[onClose, onSelectItem],
	);

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="detail-modal-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 scrollbar-none"
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

				{/* Backdrop header */}
				<div className="relative h-[250px] sm:h-[300px] overflow-hidden">
					{backdropUrl ? (
						/* eslint-disable-next-line @next/next/no-img-element */
						<img
							src={backdropUrl}
							alt={title}
							className="h-full w-full object-cover"
						/>
					) : (
						<div
							className="h-full w-full"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}10)`,
							}}
						/>
					)}
					<div className="absolute inset-0 bg-gradient-to-t from-card/95 via-card/40 to-transparent" />
				</div>

				{/* Content */}
				<div className="relative -mt-24 px-6 pb-6 space-y-6">
					{/* Header row: poster + info */}
					<div className="flex gap-5">
						{/* Poster thumbnail */}
						{posterUrl && (
							<div className="shrink-0 w-[120px] rounded-xl overflow-hidden border border-border/50 shadow-xl hidden sm:block">
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img src={posterUrl} alt={title} className="w-full" />
							</div>
						)}

						<div className="flex-1 min-w-0 space-y-3 pt-8 sm:pt-0">
							{/* Title */}
							<h2
								id="detail-modal-title"
								className="text-2xl sm:text-3xl font-bold text-foreground leading-tight"
							>
								{title}
							</h2>

							{/* Meta row */}
							<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								{year && (
									<span className="flex items-center gap-1">
										<Calendar className="h-3.5 w-3.5" />
										{year}
									</span>
								)}
								{runtime && (
									<span className="flex items-center gap-1">
										<Clock className="h-3.5 w-3.5" />
										{runtime}m
									</span>
								)}
								{numberOfSeasons && (
									<span className="flex items-center gap-1">
										<Layers className="h-3.5 w-3.5" />
										{numberOfSeasons} Season{numberOfSeasons !== 1 ? "s" : ""}
									</span>
								)}
								{typeof item.voteAverage === "number" && item.voteAverage > 0 && (
									<span className="flex items-center gap-1" style={{ color: RATING_COLOR }}>
										<Star className="h-3.5 w-3.5 fill-yellow-400" />
										{item.voteAverage.toFixed(1)}
									</span>
								)}
								<span className="flex items-center gap-1 uppercase text-xs">
									{isMovie ? (
										<>
											<Film className="h-3.5 w-3.5" /> Movie
										</>
									) : (
										<>
											<Tv className="h-3.5 w-3.5" /> {isAnime ? "Anime" : "TV Series"}
										</>
									)}
								</span>
							</div>

							{/* Genre pills */}
							{(genres.length > 0 || isAnime) && (
								<div className="flex flex-wrap gap-1.5">
									{isAnime && (
										<span className="rounded-md border border-pink-500/30 bg-pink-500/10 px-2 py-0.5 text-xs font-semibold text-pink-400">
											Anime
										</span>
									)}
									{genres.map((g) => (
										<span
											key={g.id}
											className="rounded-md border border-border/50 bg-card/60 px-2 py-0.5 text-xs text-muted-foreground"
										>
											{g.name}
										</span>
									))}
								</div>
							)}

							{/* Action buttons */}
							<div className="flex items-center gap-3 pt-1">
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
								{!isAvailable && !hasRequest && (
									<button
										type="button"
										onClick={() => onRequest(item)}
										className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-all duration-200 hover:scale-105"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
										}}
									>
										<Send className="h-4 w-4" />
										Request
									</button>
								)}
							</div>
						</div>
					</div>

					{/* Loading state for details */}
					{isDetailsLoading && (
						<div className="flex items-center justify-center py-8">
							<Loader2
								className="h-6 w-6 animate-spin"
								style={{ color: themeGradient.from }}
							/>
						</div>
					)}

					{/* Overview */}
					{details?.overview && (
						<div className="space-y-2">
							<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
								Overview
							</h3>
							<p className="text-sm text-foreground/80 leading-relaxed">
								{details.overview}
							</p>
						</div>
					)}

					{/* Seasons (TV) */}
					{seasons.length > 0 && (
						<div className="space-y-3">
							<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
								Seasons
							</h3>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
								{seasons.map((season) => (
									<div
										key={season.seasonNumber}
										className="flex items-center justify-between rounded-lg border border-border/50 bg-card/40 px-3 py-2"
									>
										<div className="flex items-center gap-2 min-w-0">
											<Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
											<span className="text-sm font-medium text-foreground truncate">
												{season.name || `Season ${season.seasonNumber}`}
											</span>
										</div>
										<span className="text-xs text-muted-foreground shrink-0 ml-2">
											{season.episodeCount} ep{season.episodeCount !== 1 ? "s" : ""}
										</span>
									</div>
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
						tmdbId={item.id}
						imdbId={details?.externalIds?.imdbId}
						tvdbId={details?.externalIds?.tvdbId}
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

