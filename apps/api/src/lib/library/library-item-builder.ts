import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import { buildMovieItem } from "./movie-normalizer.js";
import { buildSeriesItem } from "./series-normalizer.js";

/**
 * Builds a library item from raw API data based on service type
 * @param instance - The service instance
 * @param service - The service type (radarr or sonarr)
 * @param raw - The raw API data
 * @returns A normalized library item
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buildLibraryItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: any,
): LibraryItem => {
	if (service === "radarr") {
		return buildMovieItem(instance, service, raw);
	}
	return buildSeriesItem(instance, service, raw);
};
