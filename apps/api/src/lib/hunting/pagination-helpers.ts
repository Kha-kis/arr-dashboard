import type { FastifyBaseLogger } from "fastify";

/**
 * API call counter passed through hunt functions to track actual API usage.
 */
export interface ApiCallCounter {
	count: number;
}

/**
 * Default page size for fetching wanted items.
 * Larger pages = fewer API calls to cover the full list.
 * Sonarr/Radarr support page sizes up to 10,000+.
 */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Maximum pages to fetch to prevent runaway API calls on very large libraries.
 * 20 pages × 500 items = 10,000 items max, using at most 20 API calls (~20%
 * of the default hourlyApiCap of 100). Libraries beyond 10K wanted items are
 * exceptionally rare for home server use.
 */
const MAX_PAGES = 20;

/**
 * Fetch ALL wanted records by paginating through the complete list.
 *
 * Uses large page sizes (500) to minimize API calls while loading the full
 * wanted list. This ensures every item is visible to the downstream filter
 * and search logic, guaranteeing complete coverage over multiple hunt cycles.
 *
 * The caller's filter logic (passesFilters, wasRecentlySearched) handles
 * deduplication and eligibility — this function just provides the full pool.
 *
 * @param fetcher  - Calls the appropriate wanted endpoint for a given page/pageSize
 * @param opts.counter  - API call counter (incremented per fetch)
 * @param opts.logger   - Structured logger
 * @param opts.fetchSize - Override page size (default 250)
 * @returns All records from the wanted endpoint
 */
export async function fetchWantedWithWrapAround<T>(
	fetcher: (page: number, pageSize: number) => Promise<{ records?: T[] | null; totalRecords?: number | null }>,
	opts: {
		recentSearchCount?: number; // kept for backward compat, no longer used
		fetchSize?: number; // now used as override, defaults to 250
		counter: ApiCallCounter;
		logger: FastifyBaseLogger;
	},
): Promise<T[]> {
	const { counter, logger, fetchSize = DEFAULT_PAGE_SIZE } = opts;
	const allRecords: T[] = [];
	let page = 1;

	while (page <= MAX_PAGES) {
		counter.count++;
		const data = await fetcher(page, fetchSize);
		const records = data.records ?? [];

		if (records.length > 0) {
			allRecords.push(...records);
		}

		// Stop if page was empty or partial (reached end of results)
		if (records.length < fetchSize) {
			break;
		}

		page++;
	}

	if (page > 1) {
		logger.debug(
			{ pages: page, totalFetched: allRecords.length, fetchSize },
			"Fetched complete wanted list",
		);
	}

	return allRecords;
}
