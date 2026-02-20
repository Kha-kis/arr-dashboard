"use client";

/**
 * Shared presentational sections for media detail modals.
 *
 * Extracted from discover-detail-modal.tsx for reuse across:
 * - DiscoverDetailModal (discover feature)
 * - EnrichedDetailModal (library feature)
 */

import { useRef } from "react";
import { Star, Clock, Calendar, Film, Tv, Layers, Play, ExternalLink } from "lucide-react";
import type { SeerrCastMember } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { RATING_COLOR, SEMANTIC_COLORS, BRAND_COLORS } from "../../../lib/theme-gradients";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { getSeerrImageUrl, isValidYoutubeKey } from "../lib/seerr-image-utils";

// ============================================================================
// BackdropHero
// ============================================================================

interface BackdropHeroProps {
	backdropPath?: string | null;
	title: string;
}

/**
 * Full-width backdrop image with gradient overlay.
 * Falls back to a subtle theme-colored gradient when no image is available.
 */
export const BackdropHero: React.FC<BackdropHeroProps> = ({ backdropPath, title }) => {
	const { gradient: themeGradient } = useThemeGradient();
	const backdropUrl = getSeerrImageUrl(backdropPath, "w1280");

	return (
		<div className="relative h-[250px] sm:h-[300px] overflow-hidden">
			{backdropUrl ? (
				/* eslint-disable-next-line @next/next/no-img-element */
				<img src={backdropUrl} alt={title} className="h-full w-full object-cover" />
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
	);
};

// ============================================================================
// MediaMetaRow
// ============================================================================

interface MediaMetaRowProps {
	year?: number | null;
	runtime?: number;
	numberOfSeasons?: number;
	voteAverage?: number;
	isMovie: boolean;
	isAnime?: boolean;
}

/**
 * Horizontal row of media metadata chips: year, runtime/seasons, vote average, media type.
 */
export const MediaMetaRow: React.FC<MediaMetaRowProps> = ({
	year,
	runtime,
	numberOfSeasons,
	voteAverage,
	isMovie,
	isAnime,
}) => (
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
);

// ============================================================================
// CastSection + CastCard
// ============================================================================

interface CastSectionProps {
	cast: SeerrCastMember[];
}

/**
 * Horizontal scrollable section showing cast member cards with profile images.
 */
export const CastSection: React.FC<CastSectionProps> = ({ cast }) => {
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

// ============================================================================
// TrailerButton
// ============================================================================

interface TrailerButtonProps {
	videos?: { key: string; name?: string; site: string; type?: string }[];
}

/**
 * YouTube trailer link button. Finds the first valid YouTube trailer/teaser.
 * Renders nothing if no valid trailer is found.
 */
export const TrailerButton: React.FC<TrailerButtonProps> = ({ videos }) => {
	const trailer = (videos ?? []).find(
		(v) =>
			v.site === "YouTube" &&
			(v.type === "Trailer" || v.type === "Teaser") &&
			isValidYoutubeKey(v.key),
	);

	if (!trailer) return null;

	return (
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
				<span className="font-medium">{trailer.name || "Watch Trailer"}</span>
			</a>
		</div>
	);
};

// ============================================================================
// ExternalLinksSection
// ============================================================================

interface ExternalLinksSectionProps {
	tmdbId?: number | string | null;
	imdbId?: string | null;
	tvdbId?: number | string | null;
	mediaType: "movie" | "tv";
}

/**
 * Row of external link buttons (TMDB, IMDB, TVDB).
 * Uses the user's theme gradient for the TMDB button and BRAND_COLORS for the rest.
 * Renders nothing if no IDs are provided.
 */
export const ExternalLinksSection: React.FC<ExternalLinksSectionProps> = ({
	tmdbId,
	imdbId,
	tvdbId,
	mediaType,
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (!tmdbId && !imdbId && !tvdbId) return null;

	const btnClass = "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80";

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				External Links
			</h3>
			<div className="flex flex-wrap gap-2">
				{tmdbId && (
					<button
						type="button"
						className={btnClass}
						style={{
							backgroundColor: `${themeGradient.from}15`,
							border: `1px solid ${themeGradient.from}30`,
							color: themeGradient.from,
						}}
						onClick={() => safeOpenUrl(`https://www.themoviedb.org/${mediaType}/${tmdbId}`)}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						TMDB
					</button>
				)}
				{imdbId && (
					<button
						type="button"
						className={btnClass}
						style={{
							backgroundColor: BRAND_COLORS.imdb.bg,
							border: `1px solid ${BRAND_COLORS.imdb.border}`,
							color: BRAND_COLORS.imdb.text,
						}}
						onClick={() => safeOpenUrl(`https://www.imdb.com/title/${imdbId}`)}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						IMDB
					</button>
				)}
				{tvdbId && (
					<button
						type="button"
						className={btnClass}
						style={{
							backgroundColor: BRAND_COLORS.tvdb.bg,
							border: `1px solid ${BRAND_COLORS.tvdb.border}`,
							color: BRAND_COLORS.tvdb.text,
						}}
						onClick={() => safeOpenUrl(`https://www.thetvdb.com/dereferrer/series/${tvdbId}`)}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						TVDB
					</button>
				)}
			</div>
		</div>
	);
};
