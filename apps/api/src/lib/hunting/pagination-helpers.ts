import type { FastifyBaseLogger } from "fastify";

/**
 * API call counter passed through hunt functions to track actual API usage.
 */
export interface ApiCallCounter {
	count: number;
}

/**
 * Fetch a page of "wanted" records with automatic wrap-around.
 *
 * Calculates a page offset from the number of recently searched items so the
 * executor rotates through large libraries instead of always hitting page 1.
 * If the calculated page is empty (recentSearchCount exceeds total records),
 * it wraps around to page 1.
 *
 * @param fetcher  - Calls the appropriate wanted endpoint for a given page number
 * @param opts.recentSearchCount - Number of items recently searched (from history manager)
 * @param opts.fetchSize - Page size for the wanted request
 * @param opts.counter  - API call counter (incremented per fetch)
 * @param opts.logger   - Structured logger
 * @returns The records array from the wanted response
 */
export async function fetchWantedWithWrapAround<T>(
	fetcher: (page: number) => Promise<{ records?: T[] | null }>,
	opts: {
		recentSearchCount: number;
		fetchSize: number;
		counter: ApiCallCounter;
		logger: FastifyBaseLogger;
	},
): Promise<T[]> {
	const { recentSearchCount, fetchSize, counter, logger } = opts;

	let pageOffset = Math.floor(recentSearchCount / fetchSize) + 1;

	counter.count++;
	let data = await fetcher(pageOffset);
	let records = data.records ?? [];

	// If no records on calculated page and we're past page 1, wrap around to page 1
	// This handles the case where recentSearchCount exceeds total available items
	if (records.length === 0 && pageOffset > 1) {
		logger.debug(
			{ pageOffset, recentSearchCount, fetchSize },
			"No records on calculated page, wrapping to page 1",
		);
		pageOffset = 1;
		counter.count++;
		data = await fetcher(1);
		records = data.records ?? [];
	}

	return records;
}
