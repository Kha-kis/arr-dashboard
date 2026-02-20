"use client";

/**
 * PosterImage — Shared poster component with TMDB → ARR → placeholder fallback.
 *
 * Used across library cards, detail modals, and enriched modals to provide
 * a consistent poster rendering strategy:
 * 1. TMDB poster via Seerr enrichment (highest quality, consistent with discover)
 * 2. ARR instance poster (local cache from Sonarr/Radarr)
 * 3. Text placeholder when no image is available
 */

import {
	getSeerrImageUrl,
	type PosterSize,
} from "../../discover/lib/seerr-image-utils";

interface PosterImageProps {
	/** TMDB poster path from Seerr enrichment (e.g. "/xyz123.jpg") */
	tmdbPosterPath?: string | null;
	/** Fallback poster URL from ARR instance */
	arrPosterUrl?: string | null;
	/** TMDB image size variant */
	size?: PosterSize;
	/** Alt text */
	alt: string;
	/** CSS classes applied to the img element (overrides default object-cover) */
	imgClassName?: string;
	/** Placeholder text when no image available */
	placeholder?: string;
}

export function PosterImage({
	tmdbPosterPath,
	arrPosterUrl,
	size = "w185",
	alt,
	imgClassName = "h-full w-full object-cover",
	placeholder = "Poster",
}: PosterImageProps) {
	const resolvedUrl = getSeerrImageUrl(tmdbPosterPath, size) ?? arrPosterUrl;

	if (resolvedUrl) {
		return (
			/* eslint-disable-next-line @next/next/no-img-element -- External poster from TMDB or arr instance */
			<img
				src={resolvedUrl}
				alt={alt}
				className={imgClassName}
			/>
		);
	}

	return (
		<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
			{placeholder}
		</div>
	);
}
