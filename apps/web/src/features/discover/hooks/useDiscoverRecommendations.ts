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
	const { data: libraryData, isLoading: libraryIsLoading } = useLibraryQuery();
	const mediaType = searchType === "movie" ? "movie" : "series";

	// Wait for library data before filtering to prevent items from appearing then disappearing
	const libraryReady = !libraryIsLoading && libraryData !== undefined;

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
	// Only filter when library data is ready to prevent items from appearing then disappearing
	const trendingItems = useMemo(() => {
		if (!libraryReady) return []; // Wait for library data
		const allItems = trendingQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [trendingQuery.data, libraryData, mediaType, libraryReady]);

	const popularItems = useMemo(() => {
		if (!libraryReady) return []; // Wait for library data
		const allItems = popularQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [popularQuery.data, libraryData, mediaType, libraryReady]);

	const topRatedItems = useMemo(() => {
		if (!libraryReady) return []; // Wait for library data
		const allItems = topRatedQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [topRatedQuery.data, libraryData, mediaType, libraryReady]);

	const upcomingItems = useMemo(() => {
		if (!libraryReady) return []; // Wait for library data
		const allItems = upcomingQuery.data?.pages.flatMap((p) => p.items) || [];
		const uniqueItems = deduplicateItems(allItems);
		return filterExistingItems(uniqueItems, libraryData?.aggregated, mediaType);
	}, [upcomingQuery.data, libraryData, mediaType, libraryReady]);

	// Auto-load more pages for trending if filtered results are too few
	const {
		hasNextPage: trendingHasNextPage,
		isFetchingNextPage: trendingIsFetchingNextPage,
		isLoading: trendingIsLoading,
		fetchNextPage: fetchNextTrending,
	} = trendingQuery;
	useEffect(() => {
		if (
			libraryReady && // Only auto-load after library data is ready
			trendingItems.length < MIN_VISIBLE_ITEMS &&
			trendingHasNextPage &&
			!trendingIsFetchingNextPage &&
			!trendingIsLoading
		) {
			fetchNextTrending();
		}
	}, [
		libraryReady,
		trendingItems.length,
		trendingHasNextPage,
		trendingIsFetchingNextPage,
		trendingIsLoading,
		fetchNextTrending,
	]);

	// Auto-load more pages for popular if filtered results are too few
	const {
		hasNextPage: popularHasNextPage,
		isFetchingNextPage: popularIsFetchingNextPage,
		isLoading: popularIsLoading,
		fetchNextPage: fetchNextPopular,
	} = popularQuery;
	useEffect(() => {
		if (
			libraryReady && // Only auto-load after library data is ready
			popularItems.length < MIN_VISIBLE_ITEMS &&
			popularHasNextPage &&
			!popularIsFetchingNextPage &&
			!popularIsLoading
		) {
			fetchNextPopular();
		}
	}, [
		libraryReady,
		popularItems.length,
		popularHasNextPage,
		popularIsFetchingNextPage,
		popularIsLoading,
		fetchNextPopular,
	]);

	// Auto-load more pages for top rated if filtered results are too few
	const {
		hasNextPage: topRatedHasNextPage,
		isFetchingNextPage: topRatedIsFetchingNextPage,
		isLoading: topRatedIsLoading,
		fetchNextPage: fetchNextTopRated,
	} = topRatedQuery;
	useEffect(() => {
		if (
			libraryReady && // Only auto-load after library data is ready
			topRatedItems.length < MIN_VISIBLE_ITEMS &&
			topRatedHasNextPage &&
			!topRatedIsFetchingNextPage &&
			!topRatedIsLoading
		) {
			fetchNextTopRated();
		}
	}, [
		libraryReady,
		topRatedItems.length,
		topRatedHasNextPage,
		topRatedIsFetchingNextPage,
		topRatedIsLoading,
		fetchNextTopRated,
	]);

	// Auto-load more pages for upcoming if filtered results are too few
	const {
		hasNextPage: upcomingHasNextPage,
		isFetchingNextPage: upcomingIsFetchingNextPage,
		isLoading: upcomingIsLoading,
		fetchNextPage: fetchNextUpcoming,
	} = upcomingQuery;
	useEffect(() => {
		if (
			libraryReady && // Only auto-load after library data is ready
			upcomingItems.length < MIN_VISIBLE_ITEMS &&
			upcomingHasNextPage &&
			!upcomingIsFetchingNextPage &&
			!upcomingIsLoading
		) {
			fetchNextUpcoming();
		}
	}, [
		libraryReady,
		upcomingItems.length,
		upcomingHasNextPage,
		upcomingIsFetchingNextPage,
		upcomingIsLoading,
		fetchNextUpcoming,
	]);

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
		// Library loading state - carousels should show loading until library is ready
		libraryReady,
		libraryIsLoading,
	};
}
