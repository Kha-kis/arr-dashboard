"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoverAddRequest,
  DiscoverSearchResult,
  DiscoverSearchType,
  RecommendationItem,
} from "@arr/shared";
import type { ServiceInstanceSummary } from "@arr/shared";
import {
  Film,
  Loader2,
  PlusCircle,
  Search,
  Tv,
  CheckCircle2,
  AlertCircle,
  Inbox,
  Star,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Alert,
  AlertTitle,
  AlertDescription,
  EmptyState,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
  useDiscoverAddMutation,
  useDiscoverSearchQuery,
  useInfiniteRecommendationsQuery,
} from "../../../hooks/api/useDiscover";
import { useLibraryQuery } from "../../../hooks/api/useLibrary";
import { AddToLibraryDialog } from "./add-to-library-dialog";

const formatRuntime = (runtime?: number) => {
  if (!runtime || runtime <= 0) {
    return null;
  }
  if (runtime >= 60) {
    const hours = Math.floor(runtime / 60);
    const minutes = runtime % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${runtime}m`;
};

const renderInstanceBadge = (
  instance: ServiceInstanceSummary,
  result: DiscoverSearchResult,
) => {
  const state = result.instanceStates.find(
    (entry) => entry.instanceId === instance.id,
  );
  if (!state) {
    return (
      <span
        key={instance.id}
        className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60"
      >
        {instance.label}
        <span className="text-white/40">offline</span>
      </span>
    );
  }

  if (state.exists) {
    return (
      <span
        key={instance.id}
        className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200"
      >
        {instance.label}
        <CheckCircle2 className="h-3 w-3" />
      </span>
    );
  }

  return (
    <span
      key={instance.id}
      className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-200"
    >
      {instance.label}
      <span className="text-white/70">available</span>
    </span>
  );
};

const iconForType = (type: DiscoverSearchType) =>
  type === "movie" ? <Film className="h-4 w-4" /> : <Tv className="h-4 w-4" />;

const TMDBCarousel: React.FC<{
  title: string;
  description?: string;
  items: RecommendationItem[];
  onSelectItem: (item: RecommendationItem) => void;
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  onLoadMore?: () => void;
}> = ({
  title,
  description,
  items,
  onSelectItem,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScrollButtons = () => {
    if (!scrollContainerRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
  };

  const scroll = (direction: "left" | "right") => {
    if (!scrollContainerRef.current) return;
    const scrollAmount = scrollContainerRef.current.clientWidth * 0.8;
    scrollContainerRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const handleScroll = () => {
    checkScrollButtons();

    // Check if we're near the end and should load more
    if (!scrollContainerRef.current || !hasNextPage || isFetchingNextPage)
      return;

    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
    const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;

    // Load more when scrolled 80% to the right
    if (scrollPercentage > 0.8 && onLoadMore) {
      onLoadMore();
    }
  };

  useEffect(() => {
    checkScrollButtons();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll);
      window.addEventListener("resize", checkScrollButtons);
      return () => {
        container.removeEventListener("scroll", handleScroll);
        window.removeEventListener("resize", checkScrollButtons);
      };
    }
  }, [items, hasNextPage, isFetchingNextPage]);

  if (isLoading) {
    return (
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          {description && (
            <p className="text-sm text-fg-muted">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 text-fg-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading recommendations...
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="group/carousel relative">
        {canScrollLeft && (
          <button
            onClick={() => scroll("left")}
            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/80 p-2 text-white shadow-lg transition-all hover:bg-black/90 hover:scale-110"
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {canScrollRight && (
          <button
            onClick={() => scroll("right")}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/80 p-2 text-white shadow-lg transition-all hover:bg-black/90 hover:scale-110"
            aria-label="Scroll right"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
        <div
          ref={scrollContainerRef}
          className="flex gap-4 overflow-x-auto pb-4 scrollbar-none"
        >
          {items.map((item) => (
            <div
              key={item.id}
              className="group relative w-[160px] flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border/50 bg-bg-subtle transition-all hover:scale-105 hover:border-border"
              onClick={() => onSelectItem(item)}
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900">
                {item.posterUrl ? (
                  <img
                    src={item.posterUrl}
                    alt={item.title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-white/40">
                    No poster
                  </div>
                )}
                {typeof item.rating === "number" && item.rating > 0 && (
                  <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200 backdrop-blur-sm">
                    <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                    {item.rating.toFixed(1)}
                  </div>
                )}
              </div>
              <div className="p-2">
                <p className="truncate text-sm font-medium text-fg">
                  {item.title}
                </p>
                {item.releaseDate && (
                  <p className="text-xs text-fg-muted">
                    {new Date(item.releaseDate).getFullYear()}
                  </p>
                )}
              </div>
            </div>
          ))}
          {isFetchingNextPage && (
            <div className="flex w-[160px] flex-shrink-0 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-fg-muted" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

const RecommendationCarousel: React.FC<{
  title: string;
  description?: string;
  results: DiscoverSearchResult[];
  relevantInstances: ServiceInstanceSummary[];
  onSelectResult: (result: DiscoverSearchResult) => void;
  isLoading?: boolean;
}> = ({
  title,
  description,
  results,
  relevantInstances,
  onSelectResult,
  isLoading,
}) => {
  // Filter out items that already exist in ANY instance
  const availableResults = results.filter((result) => {
    const existsInAnyInstance = result.instanceStates.some(
      (state) => state.exists,
    );
    return !existsInAnyInstance;
  });

  if (isLoading) {
    return (
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          {description && (
            <p className="text-sm text-fg-muted">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 text-fg-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading recommendations...
        </div>
      </section>
    );
  }

  if (availableResults.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="relative -mx-6 px-6">
        <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border/50">
          {availableResults.slice(0, 10).map((result) => {
            const availableTargets = relevantInstances.filter((instance) => {
              const state = result.instanceStates.find(
                (entry) => entry.instanceId === instance.id,
              );
              return !state?.exists;
            });
            const canAdd = availableTargets.length > 0;
            const ratingValue = result.ratings?.value;

            return (
              <div
                key={result.id}
                className="group relative w-[160px] flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border/50 bg-bg-subtle transition-all hover:scale-105 hover:border-border"
                onClick={() => onSelectResult(result)}
              >
                <div className="relative aspect-[2/3] w-full overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900">
                  {result.images?.poster ? (
                    <img
                      src={result.images.poster}
                      alt={result.title ?? "Poster"}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-white/40">
                      No poster
                    </div>
                  )}
                  {typeof ratingValue === "number" && (
                    <div className="absolute right-2 top-2 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200 backdrop-blur-sm">
                      {ratingValue.toFixed(1)}
                    </div>
                  )}
                  {!canAdd && (
                    <div className="absolute left-2 top-2 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-200 backdrop-blur-sm">
                      <CheckCircle2 className="inline h-3 w-3" />
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-medium text-fg">
                    {result.title}
                  </p>
                  <p className="text-xs text-fg-muted">{result.year}</p>
                  {result.genres && result.genres.length > 0 && (
                    <p className="mt-1 truncate text-xs text-fg-muted">
                      {result.genres.slice(0, 2).join(", ")}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

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

  // Filter out recommendations that are already in the library
  const filterExistingItems = (items: RecommendationItem[]) => {
    if (!libraryData?.aggregated) return items;

    const libraryTitles = new Set(
      libraryData.aggregated
        .filter(
          (item) =>
            (searchType === "movie" && item.type === "movie") ||
            (searchType === "series" && item.type === "series"),
        )
        .map((item) => item.title.toLowerCase()),
    );

    return items.filter((item) => !libraryTitles.has(item.title.toLowerCase()));
  };

  // Get recently added items from library
  const recentlyAdded = useMemo(() => {
    if (!libraryData?.aggregated) {
      return [];
    }

    const matchingItems = libraryData.aggregated.filter(
      (item) =>
        (searchType === "movie" && item.type === "movie") ||
        (searchType === "series" && item.type === "series"),
    );

    return matchingItems
      .filter((item) => item.added)
      .sort(
        (a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime(),
      )
      .slice(0, 5);
  }, [libraryData, searchType]);

  // Get highly rated items from library
  const topRated = useMemo(() => {
    if (!libraryData?.aggregated) {
      return [];
    }

    const matchingItems = libraryData.aggregated.filter(
      (item) =>
        (searchType === "movie" && item.type === "movie") ||
        (searchType === "series" && item.type === "series"),
    );

    return matchingItems
      .filter((item) => item.statistics?.runtime && item.statistics.runtime > 0)
      .sort((a, b) => {
        const ratingA = a.statistics?.runtime || 0;
        const ratingB = b.statistics?.runtime || 0;
        return ratingB - ratingA;
      })
      .slice(0, 5);
  }, [libraryData, searchType]);

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

        {feedback ? (
          <Alert variant={feedback.type === "success" ? "success" : "danger"}>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-6 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-full bg-white/10 p-1">
              {(["movie", "series"] as DiscoverSearchType[]).map((type) => (
                <Button
                  key={type}
                  variant={searchType === type ? "primary" : "secondary"}
                  className="flex items-center gap-2 px-4 py-2 text-sm"
                  onClick={() => setSearchType(type)}
                  type="button"
                >
                  {iconForType(type)}
                  <span>{type === "movie" ? "Movies" : "Series"}</span>
                </Button>
              ))}
            </div>
            <span className="text-sm text-white/50">
              {relevantInstances.length}{" "}
              {searchType === "movie" ? "Radarr" : "Sonarr"} instance
              {relevantInstances.length === 1 ? "" : "s"} connected
            </span>
          </div>

          <form
            className="flex w-full flex-col gap-4 md:flex-row"
            onSubmit={handleSubmit}
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <Input
                placeholder={`Search for ${searchType === "movie" ? "movies" : "series"} (title, keyword, remote id...)`}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="pl-10"
              />
            </div>
            <Button
              type="submit"
              className="flex items-center gap-2"
              disabled={!canSearch || searchInput.trim().length === 0}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Search
            </Button>
          </form>

          {!canSearch ? (
            <Alert variant="warning">
              <AlertDescription>
                Configure at least one{" "}
                {searchType === "movie" ? "Radarr" : "Sonarr"} instance in
                Settings to perform searches.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </header>

      {!hasQuery && (
        <TMDBCarousel
          title="Trending Now"
          description={`Popular ${searchType === "movie" ? "movies" : "series"} trending this week`}
          items={filterExistingItems(
            trendingQuery.data?.pages.flatMap((p) => p.items) || [],
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
          )}
          onSelectItem={handleSelectItem}
          isLoading={upcomingQuery.isLoading}
          isFetchingNextPage={upcomingQuery.isFetchingNextPage}
          hasNextPage={upcomingQuery.hasNextPage}
          onLoadMore={() => upcomingQuery.fetchNextPage()}
        />
      )}

      {hasQuery && (
        <section className="space-y-6">
          {isLoading ? (
            <div className="flex items-center gap-3 text-fg-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
              Fetching {searchType === "movie" ? "movies" : "series"}...
            </div>
          ) : null}

          {!isLoading && searchResults.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No results found"
              description="Try a different title or adjust your search term."
            />
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            {searchResults.map((result) => {
              const availableTargets = relevantInstances.filter((instance) => {
                const state = result.instanceStates.find(
                  (entry) => entry.instanceId === instance.id,
                );
                return !state?.exists;
              });
              const canAdd = availableTargets.length > 0;
              const runtimeLabel = formatRuntime(result.runtime);
              const genres = result.genres?.slice(0, 4) ?? [];
              const ratingValue = result.ratings?.value;

              return (
                <Card
                  key={result.id}
                  className="border-white/10 bg-white/5 p-5"
                >
                  <CardContent className="space-y-4">
                    <div className="flex gap-4">
                      <div className="relative h-36 w-24 overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-slate-700 to-slate-900">
                        {result.images?.poster ? (
                          <img
                            src={result.images.poster}
                            alt={result.title ?? "Poster"}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-sm text-white/40">
                            {searchType === "movie" ? "Poster" : "Key art"}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h3 className="text-lg font-semibold text-white">
                              {result.title}
                            </h3>
                            <p className="text-sm text-white/50">
                              {result.year ? String(result.year) + " - " : ""}
                              {result.status ?? "Unknown status"}
                              {runtimeLabel ? " - " + runtimeLabel : ""}
                            </p>
                          </div>
                          {typeof ratingValue === "number" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs text-yellow-200">
                              Rating {ratingValue.toFixed(1)}
                            </span>
                          ) : null}
                        </div>
                        {result.overview ? (
                          <p className="line-clamp-3 text-sm text-white/70">
                            {result.overview}
                          </p>
                        ) : null}
                        {genres.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {genres.map((genre) => (
                              <span
                                key={genre}
                                className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60"
                              >
                                {genre}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {relevantInstances.map((instance) =>
                        renderInstanceBadge(instance, result),
                      )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
                        {result.remoteIds?.tmdbId ? (
                          <span>TMDB #{result.remoteIds.tmdbId}</span>
                        ) : null}
                        {result.remoteIds?.tvdbId ? (
                          <span>TVDB #{result.remoteIds.tvdbId}</span>
                        ) : null}
                        {result.remoteIds?.imdbId ? (
                          <span>IMDB {result.remoteIds.imdbId}</span>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        className="flex items-center gap-2"
                        variant={canAdd ? "primary" : "secondary"}
                        disabled={!canAdd}
                        onClick={() => setSelectedResult(result)}
                      >
                        <PlusCircle className="h-4 w-4" />
                        {canAdd ? "Add to library" : "Already added"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
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

      {searchQuery.isError ? (
        <Alert variant="danger">
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>
            {(searchQuery.error as Error | undefined)?.message ??
              "An error occurred while searching."}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
