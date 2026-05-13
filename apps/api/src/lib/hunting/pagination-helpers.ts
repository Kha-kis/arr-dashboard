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
 * **Memory note (issue #427):** when callers can project each record to a
 * smaller shape, supply `opts.project`. The helper then keeps only the
 * projected (slim) record in the accumulator and lets each page's fat raw
 * records become GC-eligible at the iteration boundary. For a 50k-album
 * Lidarr the difference is ~150 MB vs ~5 MB resident. Without `project`,
 * the helper returns the raw records as-is for back-compat.
 *
 * @param fetcher  - Calls the appropriate wanted endpoint for a given page/pageSize
 * @param opts.counter   - API call counter (incremented per fetch)
 * @param opts.logger    - Structured logger
 * @param opts.fetchSize - Override page size (default 500)
 * @param opts.project   - Optional per-record projection; nulls are dropped
 * @returns All (projected) records from the wanted endpoint
 */
export async function fetchWantedWithWrapAround<TRaw, TProjected = TRaw>(
	fetcher: (
		page: number,
		pageSize: number,
	) => Promise<{ records?: TRaw[] | null; totalRecords?: number | null }>,
	opts: {
		fetchSize?: number;
		counter: ApiCallCounter;
		logger: FastifyBaseLogger;
		project?: (raw: TRaw) => TProjected | null;
	},
): Promise<TProjected[]> {
	const { counter, logger, fetchSize = DEFAULT_PAGE_SIZE, project } = opts;
	const allRecords: TProjected[] = [];
	let page = 1;
	let totalRawSeen = 0;

	while (page <= MAX_PAGES) {
		counter.count++;
		const data = await fetcher(page, fetchSize);
		const records = data.records ?? [];
		totalRawSeen += records.length;

		if (records.length > 0) {
			if (project) {
				// Project per-record so the fat raw record becomes unreachable
				// the moment the loop iteration ends — keeps peak heap bounded
				// by the slim accumulator, not the per-page fetch volume.
				for (const raw of records) {
					const slim = project(raw);
					if (slim !== null) allRecords.push(slim);
				}
			} else {
				allRecords.push(...(records as unknown as TProjected[]));
			}
		}

		// Stop when the page is empty or partial — page completion is judged
		// from the *raw* count so a fully-loaded page where projection drops
		// everything still advances correctly.
		if (records.length < fetchSize) {
			break;
		}

		page++;
	}

	// Log whenever we did any work so single-page fetches whose projection
	// dropped every record still leave a trace — without this, an
	// orphan-FK-heavy library would look like "no wanted items" to the
	// operator debugging a "stopped searching for X" symptom (issue #427).
	if (totalRawSeen > 0 || page > 1) {
		const droppedCount = totalRawSeen - allRecords.length;
		logger.debug(
			{
				pages: page,
				totalFetched: allRecords.length,
				totalRawSeen,
				droppedCount,
				fetchSize,
			},
			"Fetched complete wanted list",
		);
	}

	return allRecords;
}
