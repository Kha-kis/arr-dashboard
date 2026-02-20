"use client";

import { useRef } from "react";
import {
	X,
	Star,
	Clock,
	Calendar,
	Film,
	Tv,
	Play,
	Loader2,
	Layers,
	User,
	Check,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { SeerrRequest, SeerrCastMember, SeerrSeason } from "@arr/shared";
import { SEERR_REQUEST_STATUS, SEERR_MEDIA_STATUS } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { RATING_COLOR, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { StatusBadge, GradientButton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrMovieDetails,
	useSeerrTvDetails,
} from "../../../hooks/api/useSeerr";
import {
	getSeerrImageUrl,
	isAnimeFromKeywords,
	isValidYoutubeKey,
} from "../../discover/lib/seerr-image-utils";
import {
	getRequestStatusLabel,
	getRequestStatusVariant,
	getMediaStatusLabel,
	getMediaStatusVariant,
	formatRelativeTime,
} from "../lib/seerr-utils";

// ============================================================================
// Types
// ============================================================================

interface RequestDetailModalProps {
	request: SeerrRequest;
	instanceId: string;
	onClose: () => void;
	onApprove?: (requestId: number) => void;
	onDecline?: (requestId: number) => void;
	onRetry?: (requestId: number) => void;
	onDelete?: (requestId: number) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Build a Set of requested season numbers for quick lookup */
function getRequestedSeasonNumbers(seasons?: SeerrSeason[]): Set<number> {
	if (!seasons) return new Set();
	return new Set(seasons.map((s) => s.seasonNumber));
}

/** Get the request season's status by season number */
function getRequestSeasonStatus(seasons: SeerrSeason[] | undefined, seasonNumber: number) {
	return seasons?.find((s) => s.seasonNumber === seasonNumber);
}

function getSeasonStatusColor(status: number): string {
	switch (status) {
		case SEERR_MEDIA_STATUS.AVAILABLE:
			return "bg-emerald-400";
		case SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE:
			return "bg-sky-400";
		case SEERR_MEDIA_STATUS.PROCESSING:
			return "bg-amber-400";
		case SEERR_MEDIA_STATUS.PENDING:
			return "bg-amber-400/60";
		default:
			return "bg-muted-foreground/40";
	}
}

// ============================================================================
// Component
// ============================================================================

export const RequestDetailModal: React.FC<RequestDetailModalProps> = ({
	request,
	instanceId,
	onClose,
	onApprove,
	onDecline,
	onRetry,
	onDelete,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);
	const isMovie = request.type === "movie";
	const tmdbId = request.media.tmdbId;

	// Fetch full TMDB details
	const movieQuery = useSeerrMovieDetails(instanceId, isMovie ? tmdbId : 0);
	const tvQuery = useSeerrTvDetails(instanceId, !isMovie ? tmdbId : 0);

	const details = isMovie ? movieQuery.data : tvQuery.data;
	const isDetailsLoading = isMovie ? movieQuery.isLoading : tvQuery.isLoading;

	// Derived display values
	const title = details
		? isMovie
			? (details as NonNullable<typeof movieQuery.data>).title
			: (details as NonNullable<typeof tvQuery.data>).name
		: request.media.title ?? `${isMovie ? "Movie" : "Series"} #${tmdbId}`;

	const releaseDate = isMovie
		? (details as NonNullable<typeof movieQuery.data>)?.releaseDate
		: (details as NonNullable<typeof tvQuery.data>)?.firstAirDate;
	const year = releaseDate ? new Date(releaseDate).getFullYear() : null;

	const backdropUrl = getSeerrImageUrl(details?.backdropPath, "w1280");
	const posterUrl = getSeerrImageUrl(details?.posterPath ?? request.media.posterPath, "w342");

	const voteAverage = details
		? (isMovie
				? (details as NonNullable<typeof movieQuery.data>)
				: (details as NonNullable<typeof tvQuery.data>)
			).voteAverage
		: undefined;

	const runtime = isMovie
		? (details as NonNullable<typeof movieQuery.data>)?.runtime
		: undefined;
	const numberOfSeasons = !isMovie
		? (details as NonNullable<typeof tvQuery.data>)?.numberOfSeasons
		: undefined;

	const genres = details?.genres ?? [];

	// Anime detection (TV only)
	const tvDetails = !isMovie ? (details as NonNullable<typeof tvQuery.data>) : undefined;
	const isAnime = tvDetails?.keywords ? isAnimeFromKeywords(tvDetails.keywords) : false;

	// Cast (top 12)
	const cast = (details?.credits?.cast ?? []).slice(0, 12);

	// Trailer (validate key format to prevent URL injection from rogue Seerr data)
	const trailer = (details?.relatedVideos ?? []).find(
		(v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser") && isValidYoutubeKey(v.key),
	);

	// Seasons (TV only) — from TMDB details, merged with request seasons
	const detailSeasons = !isMovie
		? ((details as NonNullable<typeof tvQuery.data>)?.seasons ?? []).filter(
				(s) => s.seasonNumber > 0,
			)
		: [];
	const requestedSeasonNums = getRequestedSeasonNumbers(request.seasons);

	// Request status booleans
	const isPending = request.status === SEERR_REQUEST_STATUS.PENDING;
	const isFailed = request.status === SEERR_REQUEST_STATUS.FAILED;

	const showMediaStatus =
		request.status === SEERR_REQUEST_STATUS.APPROVED ||
		request.status === SEERR_REQUEST_STATUS.COMPLETED ||
		request.status === SEERR_REQUEST_STATUS.FAILED;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="request-detail-title"
		>
			{/* Backdrop overlay */}
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
								id="request-detail-title"
								className="text-2xl sm:text-3xl font-bold text-foreground leading-tight"
							>
								{title}
							</h2>

							{/* Meta row */}
							<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								{year && !Number.isNaN(year) && (
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
								{typeof voteAverage === "number" && voteAverage > 0 && (
									<span className="flex items-center gap-1" style={{ color: RATING_COLOR }}>
										<Star className="h-3.5 w-3.5 fill-yellow-400" />
										{voteAverage.toFixed(1)}
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

							{/* Request info row */}
							<div className="flex flex-wrap items-center gap-2">
								<StatusBadge status={getRequestStatusVariant(request.status)}>
									{getRequestStatusLabel(request.status)}
								</StatusBadge>
								{showMediaStatus && (
									<StatusBadge status={getMediaStatusVariant(request.media.status)}>
										{getMediaStatusLabel(request.media.status)}
									</StatusBadge>
								)}
								{request.is4k && (
									<span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400">
										4K
									</span>
								)}
								{isAnime && (
									<span className="rounded-md border border-pink-500/30 bg-pink-500/10 px-2 py-0.5 text-xs font-semibold text-pink-400">
										Anime
									</span>
								)}
							</div>

							{/* Requester info */}
							<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
								<span className="flex items-center gap-1.5">
									{request.requestedBy.avatar ? (
										/* eslint-disable-next-line @next/next/no-img-element */
										<img
											src={request.requestedBy.avatar}
											alt={request.requestedBy.displayName}
											className="h-5 w-5 rounded-full"
										/>
									) : (
										<User className="h-3.5 w-3.5" />
									)}
									<span className="font-medium text-foreground/80">{request.requestedBy.displayName}</span>
								</span>
								<span>{formatRelativeTime(request.createdAt)}</span>
								{request.modifiedBy && (
									<span className="text-muted-foreground/70">
										{request.status === SEERR_REQUEST_STATUS.APPROVED ||
										request.status === SEERR_REQUEST_STATUS.COMPLETED
											? "Approved"
											: request.status === SEERR_REQUEST_STATUS.DECLINED
												? "Declined"
												: "Modified"}{" "}
										by {request.modifiedBy.displayName}
									</span>
								)}
							</div>
						</div>
					</div>

					{/* Action buttons */}
					{(isPending || isFailed || onDelete) && (
						<div className="flex items-center gap-3">
							{isPending && onApprove && (
								<GradientButton
									size="sm"
									icon={Check}
									onClick={() => onApprove(request.id)}
								>
									Approve
								</GradientButton>
							)}
							{isPending && onDecline && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => onDecline(request.id)}
									className="gap-1.5 border-border/50 bg-card/50"
								>
									<X className="h-3.5 w-3.5" />
									Decline
								</Button>
							)}
							{isFailed && onRetry && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => onRetry(request.id)}
									className="gap-1.5 border-border/50 bg-card/50"
								>
									<RotateCcw className="h-3.5 w-3.5" />
									Retry
								</Button>
							)}
							{onDelete && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => onDelete(request.id)}
									className="gap-1.5 border-border/50 bg-card/50 text-destructive hover:text-destructive"
								>
									<Trash2 className="h-3.5 w-3.5" />
									Delete
								</Button>
							)}
						</div>
					)}

					{/* Genre pills */}
					{genres.length > 0 && (
						<div className="flex flex-wrap gap-1.5">
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

					{/* Seasons (TV only) — merged with request seasons */}
					{detailSeasons.length > 0 && (
						<div className="space-y-3">
							<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
								Seasons
							</h3>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
								{detailSeasons.map((season) => {
									const isRequested = requestedSeasonNums.has(season.seasonNumber);
									const requestSeason = getRequestSeasonStatus(request.seasons, season.seasonNumber);

									return (
										<div
											key={season.seasonNumber}
											className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
												isRequested
													? "border-border/80 bg-card/60"
													: "border-border/30 bg-card/20 opacity-60"
											}`}
										>
											<div className="flex items-center gap-2 min-w-0">
												{isRequested && requestSeason && (
													<span
														className={`inline-block h-2 w-2 shrink-0 rounded-full ${getSeasonStatusColor(requestSeason.status)}`}
														title={`Season ${season.seasonNumber} request status`}
													/>
												)}
												<Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
												<span className="text-sm font-medium text-foreground truncate">
													{season.name || `Season ${season.seasonNumber}`}
												</span>
											</div>
											<div className="flex items-center gap-2 shrink-0 ml-2">
												<span className="text-xs text-muted-foreground">
													{season.episodeCount} ep{season.episodeCount !== 1 ? "s" : ""}
												</span>
												{isRequested && (
													<span className="rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
														Requested
													</span>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Cast */}
					{cast.length > 0 && <CastSection cast={cast} />}

					{/* Trailer */}
					{trailer && (
						<div className="space-y-2">
							<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
								Trailer
							</h3>
							<a
								href={`https://www.youtube.com/watch?v=${trailer.key}`}
								target="_blank"
								rel="noopener noreferrer"
								className="group/trailer inline-flex items-center gap-2 rounded-xl border border-border/50 bg-card/40 px-4 py-3 text-sm text-foreground transition-all hover:border-border/80 hover:bg-card/60"
							>
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}, ${SEMANTIC_COLORS.error.to})`,
									}}
								>
									<Play className="h-4 w-4 text-white fill-white" />
								</div>
								<span className="font-medium">
									{trailer.name || "Watch Trailer"}
								</span>
							</a>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

// ============================================================================
// Cast Section (horizontal scroll) — mirrors discover-detail-modal pattern
// ============================================================================

const CastSection: React.FC<{ cast: SeerrCastMember[] }> = ({ cast }) => {
	const scrollRef = useRef<HTMLDivElement>(null);

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Cast
			</h3>
			<div
				ref={scrollRef}
				className="flex gap-3 overflow-x-auto pb-2 scrollbar-none"
				style={{
					maskImage: "linear-gradient(to right, black 95%, transparent)",
					WebkitMaskImage: "linear-gradient(to right, black 95%, transparent)",
				}}
			>
				{cast.map((member) => (
					<CastCard key={member.id} member={member} />
				))}
			</div>
		</div>
	);
};

const CastCard: React.FC<{ member: SeerrCastMember }> = ({ member }) => {
	const profileUrl = getSeerrImageUrl(member.profilePath, "w185");

	return (
		<div className="w-[100px] shrink-0 text-center space-y-1.5">
			<div className="mx-auto h-[100px] w-[100px] rounded-xl overflow-hidden bg-card/40 border border-border/30">
				{profileUrl ? (
					/* eslint-disable-next-line @next/next/no-img-element */
					<img
						src={profileUrl}
						alt={member.name}
						className="h-full w-full object-cover"
						loading="lazy"
					/>
				) : (
					<div className="flex h-full items-center justify-center text-2xl text-muted-foreground/50">
						{member.name.charAt(0)}
					</div>
				)}
			</div>
			<p className="text-xs font-medium text-foreground truncate">{member.name}</p>
			{member.character && (
				<p className="text-[10px] text-muted-foreground truncate">{member.character}</p>
			)}
		</div>
	);
};
