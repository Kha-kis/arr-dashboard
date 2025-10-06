"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  DiscoverAddRequest,
  DiscoverSearchResult,
  DiscoverSearchType,
  RecommendationItem,
} from "@arr/shared";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
  useDiscoverAddMutation,
  useDiscoverSearchQuery,
  useInfiniteRecommendationsQuery,
} from "../../../hooks/api/useDiscover";
import { useLibraryQuery } from "../../../hooks/api/useLibrary";
import { filterExistingItems } from "../lib/discover-utils";
import { AddToLibraryDialog } from "./add-to-library-dialog";
import { MediaTypeToggle } from "./media-type-toggle";
import { SearchForm } from "./search-form";
import { SearchResults } from "./search-results";
import { TMDBCarousel } from "./tmdb-carousel";

/**
 * Main discover client component for searching and adding movies/series.
 * Orchestrates the discover flow including:
 * - Media type selection (movies vs series)
 * - Search functionality
 * - TMDB recommendations (trending, popular, top rated, upcoming)
 * - Adding titles to library instances
 *
 * @component
 */
export const DiscoverClient: React.FC = () => {
  const [searchType, setSearchType] = useState<DiscoverSearchType>("movie");
  const [searchInput, setSearchInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedResult, setSelectedResult] =
    useState<DiscoverSearchResult | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const { data: services = [] } = useServicesQuery();
  const { data: libraryData } = useLibraryQuery();

  const relevantInstances = useMemo(
    () =>
      services.filter(
        (service) =>
          service.enabled &&
          (searchType === "movie"
            ? service.service === "radarr"
            : service.service === "sonarr"),
      ),
    [services, searchType],
  );

  const searchQuery = useDiscoverSearchQuery({
    query: submittedQuery,
    type: searchType,
    enabled: submittedQuery.trim().length > 0,
  });

  const addMutation = useDiscoverAddMutation();

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timer = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed.length === 0) {
      return;
    }
    setSubmittedQuery(trimmed);
  };

  const handleSelectItem = (item: RecommendationItem) => {
    // Convert RecommendationItem to DiscoverSearchResult format
    const fakeResult: DiscoverSearchResult = {
      id: `tmdb-${item.tmdbId}`,
      title: item.title,
      type: searchType,
      year: item.releaseDate
        ? new Date(item.releaseDate).getFullYear()
        : undefined,
      overview: item.overview,
      remoteIds: {
        tmdbId: item.tmdbId,
      },
      images: {
        poster: item.posterUrl,
        fanart: item.backdropUrl,
      },
      ratings: item.rating
        ? {
            value: item.rating,
            votes: item.voteCount,
          }
        : undefined,
      // Create fake instance states - all available since we don't know which instances have it
      instanceStates: relevantInstances.map((instance) => ({
        instanceId: instance.id,
        instanceName: instance.label,
        service: instance.service as "sonarr" | "radarr",
        exists: false,
        monitored: false,
        hasFile: false,
      })),
    };
    setSelectedResult(fakeResult);
  };

  const handleAdd = async (requestPayload: DiscoverAddRequest) => {
    try {
      await addMutation.mutateAsync(requestPayload);
      if (selectedResult) {
        setFeedback({
          type: "success",
          message: `Added '${selectedResult.title ?? "Title"}' to your library.`,
        });
      }
      setSelectedResult(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add title";
      setFeedback({ type: "error", message });
    }
  };

  const searchResults = searchQuery.data?.results ?? [];
  const isLoading = searchQuery.isFetching || searchQuery.isLoading;
  const hasQuery = submittedQuery.trim().length > 0;
  const canSearch = relevantInstances.length > 0;

  // Query for TMDB recommendations with infinite scroll
  const trendingQuery = useInfiniteRecommendationsQuery(
    {
      type: "trending",
      mediaType: searchType === "movie" ? "movie" : "series",
    },
    !hasQuery && canSearch,
  );

  const popularQuery = useInfiniteRecommendationsQuery(
    {
      type: "popular",
      mediaType: searchType === "movie" ? "movie" : "series",
    },
    !hasQuery && canSearch,
  );

  const topRatedQuery = useInfiniteRecommendationsQuery(
    {
      type: "top_rated",
      mediaType: searchType === "movie" ? "movie" : "series",
    },
    !hasQuery && canSearch,
  );

  const upcomingQuery = useInfiniteRecommendationsQuery(
    {
      type: searchType === "movie" ? "upcoming" : "airing_today",
      mediaType: searchType === "movie" ? "movie" : "series",
    },
    !hasQuery && canSearch,
  );

  return (
    <div className="space-y-12">
      <header className="space-y-8">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.4em] text-white/40">
            Discover
          </p>
          <h1 className="text-3xl font-semibold text-white">
            Find new content for your *arr stack
          </h1>
          <p className="text-sm text-white/60">
            Search across your configured{" "}
            {searchType === "movie" ? "Radarr" : "Sonarr"} instances and add
            titles with smart defaults.
          </p>
        </div>

        {feedback && (
          <Alert variant={feedback.type === "success" ? "success" : "danger"}>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-6 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <MediaTypeToggle
            searchType={searchType}
            onTypeChange={setSearchType}
            instanceCount={relevantInstances.length}
          />

          <SearchForm
            searchInput={searchInput}
            onSearchInputChange={setSearchInput}
            onSubmit={handleSubmit}
            searchType={searchType}
            isLoading={isLoading}
            canSearch={canSearch}
          />
        </div>
      </header>

      {!hasQuery && (
        <TMDBCarousel
          title="Trending Now"
          description={`Popular ${searchType === "movie" ? "movies" : "series"} trending this week`}
          items={filterExistingItems(
            trendingQuery.data?.pages.flatMap((p) => p.items) || [],
            libraryData?.aggregated,
            searchType === "movie" ? "movie" : "series",
          )}
          onSelectItem={handleSelectItem}
          isLoading={trendingQuery.isLoading}
          isFetchingNextPage={trendingQuery.isFetchingNextPage}
          hasNextPage={trendingQuery.hasNextPage}
          onLoadMore={() => trendingQuery.fetchNextPage()}
        />
      )}

      {!hasQuery && (
        <TMDBCarousel
          title="Popular Releases"
          description={`Most popular ${searchType === "movie" ? "movies" : "series"} right now`}
          items={filterExistingItems(
            popularQuery.data?.pages.flatMap((p) => p.items) || [],
            libraryData?.aggregated,
            searchType === "movie" ? "movie" : "series",
          )}
          onSelectItem={handleSelectItem}
          isLoading={popularQuery.isLoading}
          isFetchingNextPage={popularQuery.isFetchingNextPage}
          hasNextPage={popularQuery.hasNextPage}
          onLoadMore={() => popularQuery.fetchNextPage()}
        />
      )}

      {!hasQuery && (
        <TMDBCarousel
          title="Top Rated"
          description={`Highest rated ${searchType === "movie" ? "movies" : "series"} of all time`}
          items={filterExistingItems(
            topRatedQuery.data?.pages.flatMap((p) => p.items) || [],
            libraryData?.aggregated,
            searchType === "movie" ? "movie" : "series",
          )}
          onSelectItem={handleSelectItem}
          isLoading={topRatedQuery.isLoading}
          isFetchingNextPage={topRatedQuery.isFetchingNextPage}
          hasNextPage={topRatedQuery.hasNextPage}
          onLoadMore={() => topRatedQuery.fetchNextPage()}
        />
      )}

      {!hasQuery && (
        <TMDBCarousel
          title={searchType === "movie" ? "Coming Soon" : "Airing Today"}
          description={
            searchType === "movie"
              ? "Upcoming movies to watch out for"
              : "TV shows airing today"
          }
          items={filterExistingItems(
            upcomingQuery.data?.pages.flatMap((p) => p.items) || [],
            libraryData?.aggregated,
            searchType === "movie" ? "movie" : "series",
          )}
          onSelectItem={handleSelectItem}
          isLoading={upcomingQuery.isLoading}
          isFetchingNextPage={upcomingQuery.isFetchingNextPage}
          hasNextPage={upcomingQuery.hasNextPage}
          onLoadMore={() => upcomingQuery.fetchNextPage()}
        />
      )}

      {hasQuery && (
        <SearchResults
          results={searchResults}
          searchType={searchType}
          relevantInstances={relevantInstances}
          isLoading={isLoading}
          onAddClick={setSelectedResult}
        />
      )}

      <AddToLibraryDialog
        open={Boolean(selectedResult)}
        result={selectedResult}
        type={searchType}
        instances={relevantInstances}
        submitting={addMutation.isPending}
        onClose={() => {
          if (!addMutation.isPending) {
            setSelectedResult(null);
          }
        }}
        onSubmit={handleAdd}
      />

      {searchQuery.isError && (
        <Alert variant="danger">
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>
            {(searchQuery.error as Error | undefined)?.message ??
              "An error occurred while searching."}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};
