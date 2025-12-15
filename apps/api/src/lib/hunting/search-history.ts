/**
 * Search History Manager
 *
 * Tracks which items have been searched to avoid repeatedly searching
 * for the same content. Items become eligible for re-search after
 * the configured researchAfterDays period.
 */

import type { PrismaClient } from "@prisma/client";

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
 * Create a search history manager for a specific hunt config
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
						// Handle race condition: if create fails with unique constraint, retry as update
						if (error instanceof Error && error.message.includes("Unique constraint")) {
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
 * Clean up old search history entries for a specific user
 * Called periodically to prevent the table from growing indefinitely
 * Scoped to user's configs to prevent cross-user data deletion
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
