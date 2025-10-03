"use client";

import { useEffect, useMemo, useState } from "react";
import type { DiscoverAddRequest, DiscoverSearchResult, DiscoverSearchType } from "@arr/shared";
import type { ServiceInstanceSummary } from "@arr/shared";
import { Film, Loader2, PlusCircle, Search, Tv, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useDiscoverAddMutation, useDiscoverSearchQuery } from "../../../hooks/api/useDiscover";
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
  const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);
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

const iconForType = (type: DiscoverSearchType) => (type === "movie" ? <Film className="h-4 w-4" /> : <Tv className="h-4 w-4" />);

export const DiscoverClient: React.FC = () => {
  const [searchType, setSearchType] = useState<DiscoverSearchType>("movie");
  const [searchInput, setSearchInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedResult, setSelectedResult] = useState<DiscoverSearchResult | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data: services = [] } = useServicesQuery();

  const relevantInstances = useMemo(
    () =>
      services.filter(
        (service) => service.enabled && (searchType === "movie" ? service.service === "radarr" : service.service === "sonarr"),
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

  const handleAdd = async (requestPayload: DiscoverAddRequest) => {
    try {
      await addMutation.mutateAsync(requestPayload);
      if (selectedResult) {
        setFeedback({ type: "success", message: `Added '${selectedResult.title ?? "Title"}' to your library.` });
      }
      setSelectedResult(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add title";
      setFeedback({ type: "error", message });
    }
  };

  const searchResults = searchQuery.data?.results ?? [];
  const isLoading = searchQuery.isFetching || searchQuery.isLoading;
  const hasQuery = submittedQuery.trim().length > 0;
  const canSearch = relevantInstances.length > 0;

  return (
    <div className="space-y-12">
      <header className="space-y-8">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.4em] text-white/40">Discover</p>
          <h1 className="text-3xl font-semibold text-white">Find new content for your *arr stack</h1>
          <p className="text-sm text-white/60">
            Search across your configured {searchType === "movie" ? "Radarr" : "Sonarr"} instances and add titles with
            smart defaults.
          </p>
        </div>

        {feedback ? (
          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-sm",
              feedback.type === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/40 bg-red-500/10 text-red-200",
            )}
          >
            {feedback.message}
          </div>
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
              {relevantInstances.length} {searchType === "movie" ? "Radarr" : "Sonarr"} instance
              {relevantInstances.length === 1 ? "" : "s"} connected
            </span>
          </div>

          <form className="flex w-full flex-col gap-4 md:flex-row" onSubmit={handleSubmit}>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <Input
                placeholder={`Search for ${searchType === "movie" ? "movies" : "series"} (title, keyword, remote id...)`}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="pl-10"
              />
            </div>
            <Button type="submit" className="flex items-center gap-2" disabled={!canSearch || searchInput.trim().length === 0}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </form>

          {!canSearch ? (
            <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
              Configure at least one {searchType === "movie" ? "Radarr" : "Sonarr"} instance in Settings to perform searches.
            </div>
          ) : null}
        </div>
      </header>

      <section className="space-y-6">
        {!hasQuery && !isLoading ? (
          <Card>
            <CardHeader>
              <CardTitle>Ready when you are</CardTitle>
              <CardDescription>
                Use the search bar above to look up titles. Results will merge data from every configured instance so you can
                add them with the right quality and folder.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {hasQuery && isLoading ? (
          <div className="flex items-center gap-3 text-white/60">
            <Loader2 className="h-5 w-5 animate-spin" />
            Fetching {searchType === "movie" ? "movies" : "series"}...
          </div>
        ) : null}

        {hasQuery && !isLoading && searchResults.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No results found</CardTitle>
              <CardDescription>Try a different title or adjust your search term.</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          {searchResults.map((result) => {
            const availableTargets = relevantInstances.filter((instance) => {
              const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);
              return !state?.exists;
            });
            const canAdd = availableTargets.length > 0;
            const runtimeLabel = formatRuntime(result.runtime);
            const genres = result.genres?.slice(0, 4) ?? [];
            const ratingValue = result.ratings?.value;

            return (
              <Card key={result.id} className="border-white/10 bg-white/5 p-5">
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
                          <h3 className="text-lg font-semibold text-white">{result.title}</h3>
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
                        <p className="line-clamp-3 text-sm text-white/70">{result.overview}</p>
                      ) : null}
                      {genres.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {genres.map((genre) => (
                            <span key={genre} className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60">
                              {genre}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {relevantInstances.map((instance) => renderInstanceBadge(instance, result))}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
                      {result.remoteIds?.tmdbId ? <span>TMDB #{result.remoteIds.tmdbId}</span> : null}
                      {result.remoteIds?.tvdbId ? <span>TVDB #{result.remoteIds.tvdbId}</span> : null}
                      {result.remoteIds?.imdbId ? <span>IMDB {result.remoteIds.imdbId}</span> : null}
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
        <div className="flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle className="h-4 w-4" />
          {(searchQuery.error as Error | undefined)?.message ?? "Search failed"}
        </div>
      ) : null}
    </div>
  );
};
