import type { LibraryItem } from "@arr/shared";
import { useMemo } from "react";

/**
 * Type mapping for enrichable items.
 * Different APIs expect different type strings for series:
 * - Seerr/Overseerr uses "tv"
 * - Plex uses "series"
 */
export interface EnrichableTypeMapping<M extends string = string, S extends string = string> {
	movie: M;
	series: S;
}

export interface EnrichableResult<T extends string = string> {
	tmdbIds: number[];
	types: T[];
	key: string;
	hasItems: boolean;
}

/** Default mapping uses Seerr conventions */
const DEFAULT_TYPE_MAPPING: EnrichableTypeMapping<"movie", "tv"> = {
	movie: "movie",
	series: "tv",
};

/**
 * Extracts enrichable items (sonarr/radarr with tmdbId) from a library page.
 *
 * Shared between useSeerr's useLibraryEnrichment and usePlex's useWatchEnrichment
 * to eliminate duplicated filtering and key-building logic.
 *
 * @param items - Library items from the current page
 * @param typeMapping - How to map item types to API-specific strings
 * @returns Memoized arrays of tmdbIds and types, plus a stable deduplication key
 */
export function useEnrichableItems<M extends string, S extends string>(
	items: LibraryItem[],
	typeMapping: EnrichableTypeMapping<M, S>,
): EnrichableResult<M | S>;
export function useEnrichableItems(
	items: LibraryItem[],
): EnrichableResult<"movie" | "tv">;
export function useEnrichableItems<M extends string = "movie", S extends string = "tv">(
	items: LibraryItem[],
	typeMapping: EnrichableTypeMapping<M, S> = DEFAULT_TYPE_MAPPING as EnrichableTypeMapping<M, S>,
): EnrichableResult<M | S> {
	return useMemo(() => {
		if (items.length === 0) return { tmdbIds: [], types: [], key: "", hasItems: false };

		const tmdbIds: number[] = [];
		const types: (M | S)[] = [];

		for (const item of items) {
			if ((item.service === "sonarr" || item.service === "radarr") && item.remoteIds?.tmdbId) {
				tmdbIds.push(item.remoteIds.tmdbId);
				types.push(item.type === "movie" ? typeMapping.movie : typeMapping.series);
			}
		}

		// Stable key for query deduplication — includes types so movie/tv with same ID don't collide
		const key = tmdbIds.map((id, i) => `${types[i]}:${id}`).join(",");
		return { tmdbIds, types, key, hasItems: tmdbIds.length > 0 };
	}, [items, typeMapping.movie, typeMapping.series]);
}
