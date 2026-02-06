import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "../../lib/prisma.js";
import { buildArtistItem } from "./artist-normalizer.js";
import { buildAuthorItem } from "./author-normalizer.js";
import { buildMovieItem } from "./movie-normalizer.js";
import { buildSeriesItem } from "./series-normalizer.js";

/**
 * Builds a library item from raw API data based on service type
 * @param instance - The service instance
 * @param service - The service type (sonarr, radarr, lidarr, or readarr)
 * @param raw - The raw API data (unknown object type allows flexible property access, safety enforced via normalizer functions)
 * @returns A normalized library item
 */
export const buildLibraryItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: Record<string, unknown>,
): LibraryItem => {
	switch (service) {
		case "radarr":
			return buildMovieItem(instance, service, raw);
		case "lidarr":
			return buildArtistItem(instance, service, raw);
		case "readarr":
			return buildAuthorItem(instance, service, raw);
		case "sonarr":
		default:
			return buildSeriesItem(instance, service, raw);
	}
};
