export interface PaginationParams {
	page: number;
	pageSize: number;
	skip: number;
}

/**
 * Parse `page` and `pageSize` from a query-string record and return
 * clamped, validated pagination parameters.
 *
 * @param query  - Query-string object (values are strings or undefined)
 * @param defaults - Optional overrides for default page size (20) and max page size (100)
 */
export function parsePaginationQuery(
	query: { page?: string; pageSize?: string },
	defaults?: { defaultPageSize?: number; maxPageSize?: number },
): PaginationParams {
	const defaultPageSize = defaults?.defaultPageSize ?? 20;
	const maxPageSize = defaults?.maxPageSize ?? 100;

	let page = Number.parseInt(query.page ?? "1", 10);
	let pageSize = Number.parseInt(query.pageSize ?? String(defaultPageSize), 10);

	if (Number.isNaN(page) || page < 1) page = 1;
	if (Number.isNaN(pageSize) || pageSize < 1) pageSize = defaultPageSize;
	pageSize = Math.min(pageSize, maxPageSize);

	return { page, pageSize, skip: (page - 1) * pageSize };
}
