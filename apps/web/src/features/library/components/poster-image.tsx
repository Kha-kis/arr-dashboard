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

import { useEffect, useRef, useState } from "react";
import { getSeerrImageUrl, type PosterSize } from "../../discover/lib/seerr-image-utils";
import { observeLibraryPoster } from "./library-poster-queue";

interface PosterImageProps {
	/** TMDB poster path from Seerr enrichment (e.g. "/xyz123.jpg") */
	tmdbPosterPath?: string | null;
	/** Fallback poster URL from ARR instance */
	arrPosterUrl?: string | null;
	/** TMDB image size variant */
	size?: PosterSize;
	/** Alt text */
	alt: string;
	loading?: "eager" | "lazy";
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
	loading,
	imgClassName = "h-full w-full object-cover",
	placeholder = "Poster unavailable",
}: PosterImageProps) {
	const [failedUrls, setFailedUrls] = useState<string[]>([]);
	const resolvedUrl = [getSeerrImageUrl(tmdbPosterPath, size), arrPosterUrl].find(
		(url) => url && !failedUrls.includes(url),
	);

	if (resolvedUrl) {
		return (
			<PosterAttempt
				key={JSON.stringify([resolvedUrl, loading])}
				url={resolvedUrl}
				alt={alt}
				loading={loading}
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

interface PosterAttemptProps {
	url: string;
	alt: string;
	loading?: "eager" | "lazy";
	className: string;
	onError: () => void;
}

function PosterAttempt({ url, alt, loading, className, onError }: PosterAttemptProps) {
	const queued = loading === "lazy" && url.startsWith("/api/library/poster/");
	const image = useRef<HTMLImageElement>(null);
	const release = useRef<(() => void) | undefined>(undefined);
	useEffect(() => {
		const element = image.current;
		if (!queued || !element) return;
		if (typeof IntersectionObserver === "undefined") {
			element.src = url;
			return;
		}
		// The queue owns src for this mounted image so exits can release it
		// before admitting another poster in the same observer callback.
		const finish = observeLibraryPoster(element, url);
		release.current = finish;
		return () => {
			element.removeAttribute("src");
			finish();
		};
	}, [queued, url]);

	return (
		/* eslint-disable-next-line @next/next/no-img-element -- Browser loads the authorized poster URL directly */
		<img
			ref={image}
			src={queued ? undefined : url}
			alt={alt}
			loading={loading}
			className={queued ? `${className} [&:not([src])]:opacity-0` : className}
			onLoad={(event) => {
				if (event.currentTarget.hasAttribute("src")) release.current?.();
			}}
			onError={(event) => {
				if (!event.currentTarget.hasAttribute("src")) return;
				release.current?.();
				onError();
			}}
		/>
	);
}
