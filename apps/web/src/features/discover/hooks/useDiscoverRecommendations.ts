import { useEffect, useMemo } from "react";
import type { DiscoverSearchType, RecommendationItem } from "@arr/shared";
import { useInfiniteRecommendationsQuery } from "../../../hooks/api/useDiscover";
import { useLibraryQuery } from "../../../hooks/api/useLibrary";
import { deduplicateItems, filterExistingItems } from "../lib/discover-utils";

/**
 * Minimum number of visible items required before auto-loading next page.
 * This ensures carousels always have sufficient content after filtering.
 */
const MIN_VISIBLE_ITEMS = 10;

/**
 * Hook for managing TMDB recommendation carousels with auto-pagination.
 * Handles fetching, deduplication, library filtering, and automatic page loading
 * to maintain minimum visible items threshold.
 *
 * @param searchType - Current media type ("movie" or "series")
 * @param enabled - Whether to fetch recommendations (disabled during search)
 * @returns Object containing carousel configurations for all recommendation types
 *
 * @example
 * const { trending, popular, topRated, upcoming } = useDiscoverRecommendations("movie", true);
 */
export function useDiscoverRecommendations(
	searchType: DiscoverSearchType,
	enabled: boolean,
) {
	const { data: libraryData } = useLibraryQuery();
	const mediaType = searchType === "movie" ? "movie" : "series";

	// Parallel queries for all recommendation types
	const trendingQuery = useInfiniteRecommendationsQuery(
		{
			type: "trending",
			mediaType,
		},
		enabled,
	);

	const popularQuery = useInfiniteRecommendationsQuery(
		{
			type: "popular",
			mediaType,
		},
		enabled,
	);

	const topRatedQuery = useInfiniteRecommendationsQuery(
		{
			type: "top_rated",
			mediaType,
		},
		enabled,
	);

	const upcomingQuery = useInfiniteRecommendationsQuery(
		{
			type: searchType === "movie" ? "upcoming" : "airing_today",
			mediaType,
		},
		enabled,
	);

	// Process and filter items for each carousel
	const trendingItems = useMemo(() => {
		const allItems = trendingQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [trendingQuery.data, libraryData, mediaType]);

	const popularItems = useMemo(() => {
		const allItems = popularQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [popularQuery.data, libraryData, mediaType]);

	const topRatedItems = useMemo(() => {
		const allItems = topRatedQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [topRatedQuery.data, libraryData, mediaType]);

	const upcomingItems = useMemo(() => {
		const allItems = upcomingQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [upcomingQuery.data, libraryData, mediaType]);

	// Auto-load more pages for trending if filtered results are too few
	useEffect(() => {
		if (
			trendingItems.length < MIN_VISIBLE_ITEMS &&
			trendingQuery.hasNextPage &&
			!trendingQuery.isFetchingNextPage &&
			!trendingQuery.isLoading
		) {
			trendingQuery.fetchNextPage();
		}
	}, [trendingItems.length, trendingQuery]);

	// Auto-load more pages for popular if filtered results are too few
	useEffect(() => {
		if (
			popularItems.length < MIN_VISIBLE_ITEMS &&
			popularQuery.hasNextPage &&
			!popularQuery.isFetchingNextPage &&
			!popularQuery.isLoading
		) {
			popularQuery.fetchNextPage();
		}
	}, [popularItems.length, popularQuery]);

	// Auto-load more pages for top rated if filtered results are too few
	useEffect(() => {
		if (
			topRatedItems.length < MIN_VISIBLE_ITEMS &&
			topRatedQuery.hasNextPage &&
			!topRatedQuery.isFetchingNextPage &&
			!topRatedQuery.isLoading
		) {
			topRatedQuery.fetchNextPage();
		}
	}, [topRatedItems.length, topRatedQuery]);

	// Auto-load more pages for upcoming if filtered results are too few
	useEffect(() => {
		if (
			upcomingItems.length < MIN_VISIBLE_ITEMS &&
			upcomingQuery.hasNextPage &&
			!upcomingQuery.isFetchingNextPage &&
			!upcomingQuery.isLoading
		) {
			upcomingQuery.fetchNextPage();
		}
	}, [upcomingItems.length, upcomingQuery]);

	return {
		trending: {
			query: trendingQuery,
			items: trendingItems,
		},
		popular: {
			query: popularQuery,
			items: popularItems,
		},
		topRated: {
			query: topRatedQuery,
			items: topRatedItems,
		},
		upcoming: {
			query: upcomingQuery,
			items: upcomingItems,
		},
	};
}
