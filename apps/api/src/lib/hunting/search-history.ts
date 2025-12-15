/**
 * Search History Manager
 *
 * Tracks which items have been searched to avoid repeatedly searching
 * for the same content. Items become eligible for re-search after
 * the configured researchAfterDays period.
 */

import { Prisma, type PrismaClient } from "@prisma/client";

export interface SearchedItem {
	mediaType: "movie" | "series" | "season" | "episode";
	mediaId: number;
	seasonNumber?: number; // Use -1 for non-season items (movies, series, episodes)
	title: string;
}

export interface SearchHistoryManager {
	/**
	 * Check if an item was recently searched (within researchAfterDays)
	 */
	wasRecentlySearched(item: SearchedItem): boolean;

	/**
	 * Filter out items that were recently searched
	 */
	filterRecentlySearched<T extends { id: number }>(
		items: T[],
		getSearchedItem: (item: T) => SearchedItem,
	): T[];

	/**
	 * Record that items were searched
	 */
	recordSearches(items: SearchedItem[]): Promise<void>;

	/**
	 * Get count of items filtered due to recent search
	 */
	getFilteredCount(): number;
}

/**
 * Create a manager for tracking and filtering recently searched items for a specific hunt configuration.
 *
 * The manager uses a sliding window defined by `researchAfterDays` to consider entries "recently searched" and
 * exposes utilities to check, filter, record, and count filtered items. Season-less items use a sentinel season
 * number of `-1` when persisted or checked.
 *
 * @param researchAfterDays - Number of days to treat a previous search as "recent"; items searched within this window are considered recent
 * @returns A SearchHistoryManager scoped to the provided `configId` and `huntType` that can check/ filter recent items, record searches (updates or creates entries and tolerates unique-constraint race conditions), and report the number of items filtered due to recent searches
 */
export async function createSearchHistoryManager(
	prisma: PrismaClient,
	configId: string,
	huntType: "missing" | "upgrade",
	researchAfterDays: number,
): Promise<SearchHistoryManager> {
	// Calculate the cutoff date for "recently searched"
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - researchAfterDays);

	// Load recent search history for this config and hunt type
	const recentSearches = await prisma.huntSearchHistory.findMany({
		where: {
			configId,
			huntType,
			searchedAt: {
				gte: cutoffDate,
			},
		},
		select: {
			mediaType: true,
			mediaId: true,
			seasonNumber: true,
		},
	});

	// Create a Set for fast lookups
	// Key format: "mediaType:mediaId:seasonNumber" (seasonNumber is -1 for non-season items)
	const recentlySearchedSet = new Set(
		recentSearches.map((s) => `${s.mediaType}:${s.mediaId}:${s.seasonNumber}`),
	);

	let filteredCount = 0;

	return {
		wasRecentlySearched(item: SearchedItem): boolean {
			const key = `${item.mediaType}:${item.mediaId}:${item.seasonNumber ?? -1}`;
			return recentlySearchedSet.has(key);
		},

		filterRecentlySearched<T extends { id: number }>(
			items: T[],
			getSearchedItem: (item: T) => SearchedItem,
		): T[] {
			const filtered = items.filter((item) => {
				const searchedItem = getSearchedItem(item);
				const key = `${searchedItem.mediaType}:${searchedItem.mediaId}:${searchedItem.seasonNumber ?? -1}`;
				const wasSearched = recentlySearchedSet.has(key);
				if (wasSearched) {
					filteredCount++;
				}
				return !wasSearched;
			});
			return filtered;
		},

		async recordSearches(items: SearchedItem[]): Promise<void> {
			if (items.length === 0) return;

			// Record searches with race condition handling
			// If a concurrent insert happens, catch the unique constraint error and retry as update
			await Promise.all(
				items.map(async (item) => {
					const seasonNum = item.seasonNumber ?? -1; // Use -1 sentinel for non-season items
					const whereClause = {
						configId,
						huntType,
						mediaType: item.mediaType,
						mediaId: item.mediaId,
						seasonNumber: seasonNum,
					};

					try {
						// Try to find existing record first
						const existing = await prisma.huntSearchHistory.findFirst({
							where: whereClause,
						});

						if (existing) {
							await prisma.huntSearchHistory.update({
								where: { id: existing.id },
								data: {
									title: item.title,
									searchedAt: new Date(),
									searchCount: { increment: 1 },
								},
							});
						} else {
							await prisma.huntSearchHistory.create({
								data: {
									configId,
									huntType,
									mediaType: item.mediaType,
									mediaId: item.mediaId,
									seasonNumber: seasonNum,
									title: item.title,
									searchCount: 1,
								},
							});
						}
					} catch (error) {
						// Handle race condition: if create fails with unique constraint (P2002), retry as update
						if (
							error instanceof Prisma.PrismaClientKnownRequestError &&
							error.code === "P2002"
						) {
							const existing = await prisma.huntSearchHistory.findFirst({
								where: whereClause,
							});
							if (existing) {
								await prisma.huntSearchHistory.update({
									where: { id: existing.id },
									data: {
										title: item.title,
										searchedAt: new Date(),
										searchCount: { increment: 1 },
									},
								});
							}
						} else {
							// Re-throw non-unique-constraint errors
							throw error;
						}
					}
				}),
			);
		},

		getFilteredCount(): number {
			return filteredCount;
		},
	};
}

/**
 * Delete search history entries older than the retention window for all hunt configs belonging to a specific user.
 *
 * @param prisma - Prisma client used to perform the deletion
 * @param userId - ID of the user whose config-scoped history should be cleaned
 * @param retentionDays - Number of days to retain history (entries older than this are deleted); defaults to 90
 * @returns The number of search history records deleted
 */
export async function cleanupOldSearchHistory(
	prisma: PrismaClient,
	userId: string,
	retentionDays = 90,
): Promise<number> {
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

	const result = await prisma.huntSearchHistory.deleteMany({
		where: {
			searchedAt: {
				lt: cutoffDate,
			},
			config: {
				instance: {
					userId,
				},
			},
		},
	});

	return result.count;
}