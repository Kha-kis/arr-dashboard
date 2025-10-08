import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import { buildMovieItem } from "./movie-normalizer.js";
import { buildSeriesItem } from "./series-normalizer.js";

/**
 * Builds a library item from raw API data based on service type
 * @param instance - The service instance
 * @param service - The service type (radarr or sonarr)
 * @param raw - The raw API data (unknown object type allows flexible property access, safety enforced via normalizer functions)
 * @returns A normalized library item
 */
export const buildLibraryItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: Record<string, unknown>,
): LibraryItem => {
	if (service === "radarr") {
		return buildMovieItem(instance, service, raw);
	}
	return buildSeriesItem(instance, service, raw);
};
