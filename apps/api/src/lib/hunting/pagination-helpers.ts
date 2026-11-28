import type { FastifyBaseLogger } from "fastify";

/**
 * API call counter passed through hunt functions to track actual API usage.
 */
export interface ApiCallCounter {
	count: number;
}

/**
 * Default page size for fetching wanted items.
 * Larger requested pages reduce API calls when the provider honors the size.
 * Provider totals, not an assumed server page-size limit, establish completion.
 */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Maximum pages to fetch to prevent runaway API calls on very large libraries.
 * 20 pages × 500 items = 10,000 items max, using at most 20 API calls (~20%
 * of the default hourlyApiCap of 100). Exhausting this budget is an explicit
 * unavailable inventory, never permission to search a silently truncated pool.
 */
const MAX_PAGES = 20;

/**
 * Fetch a complete wanted inventory within the bounded read budget.
 *
 * Uses large page sizes (500) to minimize API calls while loading the full
 * wanted list. Incomplete or inconsistent coverage throws before downstream
 * search logic runs. Large-inventory continuation is a separate contract;
 * this helper does not claim complete coverage over multiple hunt cycles.
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
	let expectedTotal: number | undefined;
	let complete = false;

	while (page <= MAX_PAGES) {
		counter.count++;
		const data = await fetcher(page, fetchSize);
		if (!data || !Array.isArray(data.records)) {
			throw new Error(
				"Wanted inventory is invalid; no searches were submitted. Retry after checking provider availability.",
			);
		}
		const records = data.records;
		if (data.totalRecords != null) {
			if (!Number.isSafeInteger(data.totalRecords) || data.totalRecords < 0) {
				throw new Error(
					"Wanted inventory total is invalid; no searches were submitted. Check provider availability.",
				);
			}
			if (expectedTotal !== undefined && expectedTotal !== data.totalRecords) {
				throw new Error(
					"Wanted inventory changed during pagination; no searches were submitted. Retry the hunt.",
				);
			}
			expectedTotal = data.totalRecords;
		} else {
			throw new Error(
				"Wanted inventory total is invalid; no searches were submitted. Retry the hunt.",
			);
		}
		totalRawSeen += records.length;
		if (expectedTotal !== undefined && totalRawSeen > expectedTotal) {
			throw new Error(
				"Wanted inventory coverage is invalid; no searches were submitted. Retry the hunt.",
			);
		}

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

		// A provider can clamp the requested page size. When a total exists,
		// only covering that total proves completion; projection drops must
		// never affect pagination. Missing totals are not evidence of completion.
		if (totalRawSeen === expectedTotal) {
			complete = true;
			break;
		}
		if (records.length === 0) break;

		page++;
	}
	if (!complete) {
		throw new Error(
			"Wanted inventory is incomplete within the bounded read budget; no searches were submitted. Retry or review Hunting coverage limits.",
		);
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
