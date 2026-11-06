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

import { useState } from "react";
import { getSeerrImageUrl, type PosterSize } from "../../discover/lib/seerr-image-utils";

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

export function PosterImage(props: PosterImageProps) {
	// New artwork gets fresh attempts; late errors remain with the old source pair.
	return (
		<PosterImageWithFallback
			key={JSON.stringify([props.tmdbPosterPath, props.arrPosterUrl, props.size])}
			{...props}
		/>
	);
}

function PosterImageWithFallback({
	tmdbPosterPath,
	arrPosterUrl,
	size = "w185",
	alt,
	imgClassName = "h-full w-full object-cover",
	placeholder = "Poster unavailable",
}: PosterImageProps) {
	const [failedUrls, setFailedUrls] = useState<string[]>([]);
	const resolvedUrl = [getSeerrImageUrl(tmdbPosterPath, size), arrPosterUrl].find(
		(url) => url && !failedUrls.includes(url),
	);

	if (resolvedUrl) {
		return (
			/* eslint-disable-next-line @next/next/no-img-element -- External poster from TMDB or arr instance */
			<img
				key={resolvedUrl}
				src={resolvedUrl}
				alt={alt}
				className={imgClassName}
				onError={() => {
					setFailedUrls((previous) =>
						previous.includes(resolvedUrl) ? previous : [...previous, resolvedUrl],
					);
				}}
			/>
		);
	}

	return (
		<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
			{placeholder}
		</div>
	);
}
