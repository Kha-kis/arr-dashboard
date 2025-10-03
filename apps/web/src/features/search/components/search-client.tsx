"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SearchResult } from "@arr/shared";
import {
  useSearchIndexersQuery,
  useManualSearchMutation,
  useGrabSearchResultMutation,
} from "../../../hooks/api/useSearch";
import { Input, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Alert, AlertTitle, AlertDescription, EmptyState, Skeleton } from "../../../components/ui";
import { ApiError } from "../../../lib/api-client/base";
import { SearchResultsTable } from "./search-results-table";

const SEARCH_TYPES: Array<{ value: "all" | "movie" | "tv" | "music" | "book"; label: string }> = [
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
  { value: "music", label: "Music" },
  { value: "book", label: "Books" },
  { value: "all", label: "All" },
];

const PROTOCOL_FILTERS: Array<{ value: "all" | "torrent" | "usenet"; label: string }> = [
  { value: "all", label: "All protocols" },
  { value: "torrent", label: "Torrent only" },
  { value: "usenet", label: "Usenet only" },
];

const SORT_OPTIONS: Array<{ value: "seeders" | "publishDate" | "age" | "size" | "title"; label: string }> = [
  { value: "seeders", label: "Seeders" },
  { value: "publishDate", label: "Publish date" },
  { value: "age", label: "Age" },
  { value: "size", label: "Size" },
  { value: "title", label: "Title" },
];

type SortKey = (typeof SORT_OPTIONS)[number]["value"];
type ProtocolFilter = (typeof PROTOCOL_FILTERS)[number]["value"];

const buildFilters = (selected: Record<string, number[]>): Array<{ instanceId: string; indexerIds: number[] }> => {
  return Object.entries(selected)
    .map(([instanceId, ids]) => ({ instanceId, indexerIds: ids.filter((id) => typeof id === "number" && id > 0) }))
    .filter((entry) => entry.indexerIds.length > 0);
};

const parseNumberInput = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const getPublishTimestamp = (value?: string): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const getAgeHours = (result: SearchResult): number | null => {
  if (typeof result.ageHours === "number" && Number.isFinite(result.ageHours)) {
    return result.ageHours;
  }
  if (typeof result.age === "number" && Number.isFinite(result.age)) {
    return result.age;
  }
  if (typeof result.ageDays === "number" && Number.isFinite(result.ageDays)) {
    return result.ageDays * 24;
  }
  const timestamp = getPublishTimestamp(result.publishDate);
  if (timestamp) {
    const diffMs = Date.now() - timestamp;
    if (diffMs > 0) {
      return diffMs / (1000 * 60 * 60);
    }
  }
  return null;
};

const compareNumbers = (a: number, b: number) => {
  if (a === b) {
    return 0;
  }
  return a > b ? 1 : -1;
};

const compareBySortKey = (sortKey: SortKey, a: SearchResult, b: SearchResult): number => {
  switch (sortKey) {
    case "seeders":
      return compareNumbers(a.seeders ?? 0, b.seeders ?? 0);
    case "size":
      return compareNumbers(a.size ?? 0, b.size ?? 0);
    case "publishDate": {
      const timeA = getPublishTimestamp(a.publishDate);
      const timeB = getPublishTimestamp(b.publishDate);
      if (timeA === null && timeB === null) {
        return 0;
      }
      if (timeA === null) {
        return 1;
      }
      if (timeB === null) {
        return -1;
      }
      return compareNumbers(timeA, timeB);
    }
    case "age": {
      const ageA = getAgeHours(a);
      const ageB = getAgeHours(b);
      if (ageA === null && ageB === null) {
        return 0;
      }
      if (ageA === null) {
        return 1;
      }
      if (ageB === null) {
        return -1;
      }
      return compareNumbers(ageA, ageB);
    }
    case "title":
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    default:
      return 0;
  }
};

export const SearchClient = () => {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<"all" | "movie" | "tv" | "music" | "book">("movie");
  const [selectedIndexers, setSelectedIndexers] = useState<Record<string, number[]>>({});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [grabbingKey, setGrabbingKey] = useState<string | null>(null);
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
  const [minSeedersInput, setMinSeedersInput] = useState("");
  const [maxAgeInput, setMaxAgeInput] = useState("");
  const [hideRejected, setHideRejected] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("seeders");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [hasSearched, setHasSearched] = useState(false);

  const indexersQuery = useSearchIndexersQuery();
  const searchMutation = useManualSearchMutation();
  const grabMutation = useGrabSearchResultMutation();

  useEffect(() => {
    if (!indexersQuery.data || indexersQuery.data.instances.length === 0) {
      setSelectedIndexers({});
      return;
    }

    setSelectedIndexers((current) => {
      if (Object.keys(current).length > 0) {
        return current;
      }

      const initial: Record<string, number[]> = {};
      for (const instance of indexersQuery.data.instances) {
        const enabled = instance.data.filter((indexer) => indexer.enable).map((indexer) => indexer.id);
        initial[instance.instanceId] = enabled;
      }
      return initial;
    });
  }, [indexersQuery.data]);

  const processed = useMemo(() => {
    const minSeeders = parseNumberInput(minSeedersInput);
    const maxAgeHours = parseNumberInput(maxAgeInput);

    const filtered = results.filter((result) => {
      if (hideRejected && result.rejected) {
        return false;
      }
      if (protocolFilter !== "all" && result.protocol !== protocolFilter) {
        return false;
      }
      if (minSeeders !== null && (result.seeders ?? 0) < minSeeders) {
        return false;
      }
      if (maxAgeHours !== null) {
        const age = getAgeHours(result);
        if (age === null || age > maxAgeHours) {
          return false;
        }
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      const comparison = compareBySortKey(sortKey, a, b);
      if (comparison !== 0) {
        return sortDirection === "asc" ? comparison : -comparison;
      }

      const seedFallback = compareBySortKey("seeders", a, b);
      if (seedFallback !== 0) {
        return sortDirection === "asc" ? seedFallback : -seedFallback;
      }

      const publishFallback = compareBySortKey("publishDate", a, b);
      return sortDirection === "asc" ? publishFallback : -publishFallback;
    });

    return {
      results: sorted,
      hidden: results.length - filtered.length,
      minSeeders,
      maxAgeHours,
    };
  }, [results, hideRejected, protocolFilter, minSeedersInput, maxAgeInput, sortKey, sortDirection]);

  const filtersActive =
    hideRejected ||
    protocolFilter !== "all" ||
    processed.minSeeders !== null ||
    processed.maxAgeHours !== null;

  const handleToggleIndexer = (instanceId: string, indexerId: number) => {
    setSelectedIndexers((current) => {
      const existing = new Set(current[instanceId] ?? []);
      if (existing.has(indexerId)) {
        existing.delete(indexerId);
      } else {
        existing.add(indexerId);
      }
      const next = { ...current, [instanceId]: Array.from(existing) };
      setValidationError(null);
      return next;
    });
  };

  const handleToggleAll = (instanceId: string, ids: number[]) => {
    setSelectedIndexers((current) => {
      const existing = new Set(current[instanceId] ?? []);
      const everySelected = ids.every((id) => existing.has(id));
      const nextIds = everySelected ? [] : ids;
      const next = { ...current, [instanceId]: nextIds };
      setValidationError(null);
      return next;
    });
  };

  const handleSearch = () => {
    if (!query.trim()) {
      setValidationError("Enter a search query first.");
      setFeedback(null);
      return;
    }

    const filters = buildFilters(selectedIndexers);
    if (filters.length === 0) {
      setValidationError("Select at least one indexer to search against.");
      setFeedback(null);
      return;
    }

    setValidationError(null);
    setFeedback(null);

    searchMutation.mutate(
      {
        query: query.trim(),
        type: searchType,
        filters,
      },
      {
        onSuccess: (data) => {
          setHasSearched(true);
          setResults(data.aggregated);
          const total = data.totalCount;
          setFeedback({
            type: "success",
            message: total > 0 ? `Found ${total} result${total === 1 ? "" : "s"}.` : "No results found for that query.",
          });
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : "Search failed";
          setFeedback({ type: "error", message });
        },
      },
    );
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!searchMutation.isPending) {
      handleSearch();
    }
  };

  
const interpretGrabError = (message: string): string | null => {
  const normalized = message.toLowerCase();
  if (normalized.includes('download client') && normalized.includes("isn't configured")) {
    return 'Configure a torrent download client in Prowlarr before grabbing releases.';
  }
  if (normalized.includes('download client') && normalized.includes('configure')) {
    return 'Configure a torrent download client in Prowlarr before grabbing releases.';
  }
  if (normalized.includes('validation errors') && normalized.includes('json value could not be converted')) {
    return 'Prowlarr rejected the grab payload. Try the search again or review the indexer configuration.';
  }
  return null;
};

const deriveGrabErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    const payload = error.payload;
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const primary = typeof record.message === 'string' ? record.message.trim() : '';
      const secondary = typeof record.description === 'string' ? record.description.trim() : '';

      const errors = record.errors as Record<string, unknown> | undefined;
      const fieldMessages: string[] = [];
      if (errors && typeof errors === 'object') {
        for (const value of Object.values(errors)) {
          if (Array.isArray(value)) {
            for (const entry of value) {
              if (typeof entry === 'string' && entry.trim().length > 0) {
                fieldMessages.push(entry.trim());
              }
            }
          }
        }
      }

      const combined = [primary, secondary, ...fieldMessages].filter((entry) => entry.length > 0);
      if (combined.length > 0) {
        const friendly = interpretGrabError(combined.join(' '));
        return friendly ?? combined.join(' ');
      }
    } else if (typeof payload === 'string' && payload.trim().length > 0) {
      const friendly = interpretGrabError(payload);
      return friendly ?? payload.trim();
    }

    if (error.message) {
      const friendly = interpretGrabError(error.message);
      return friendly ?? error.message;
    }
  }

  if (error instanceof Error && error.message) {
    const friendly = interpretGrabError(error.message);
    return friendly ?? error.message;
  }

  return 'Failed to send release to the download client.';
};

const handleGrab = async (result: SearchResult) => {
    const rowKey = `${result.instanceId}:${result.indexerId}:${result.id}`;
    setGrabbingKey(rowKey);
    setFeedback(null);
    try {
      await grabMutation.mutateAsync({
        instanceId: result.instanceId,
        result,
      });
      setFeedback({ type: "success", message: `Sent "${result.title}" to the download client.` });
    } catch (error) {
      const message = deriveGrabErrorMessage(error);
      setFeedback({ type: "error", message });
    } finally {
      setGrabbingKey(null);
    }
  };

  const handleCopyMagnet = useCallback(
    async (result: SearchResult) => {
      const link = result.magnetUrl ?? result.downloadUrl ?? result.link;
      if (!link) {
        setFeedback({ type: "error", message: "No copyable magnet or download link is available for this release." });
        return;
      }

      try {
        await navigator.clipboard.writeText(link);
        setFeedback({ type: "success", message: "Copied link to clipboard." });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Clipboard copy failed.";
        setFeedback({ type: "error", message: `Unable to copy link: ${message}` });
      }
    },
    [setFeedback],
  );

  const handleOpenInfo = useCallback(
    (result: SearchResult) => {
      const target = result.infoUrl ?? result.link ?? result.downloadUrl ?? result.magnetUrl;
      if (!target) {
        setFeedback({ type: "error", message: "This release did not provide a public info link." });
        return;
      }
      window.open(target, "_blank", "noopener,noreferrer");
    },
    [setFeedback],
  );

  const resetFilters = useCallback(() => {
    setProtocolFilter("all");
    setMinSeedersInput("");
    setMaxAgeInput("");
    setHideRejected(false);
    setSortKey("seeders");
    setSortDirection("desc");
  }, []);

  if (indexersQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (indexersQuery.error) {
    return (
      <Alert variant="danger">
        <AlertTitle>Unable to load indexers</AlertTitle>
        <AlertDescription>Please verify your API connection and try again.</AlertDescription>
      </Alert>
    );
  }

  const noIndexers = !indexersQuery.data || indexersQuery.data.totalCount === 0;
  const emptyMessage = !hasSearched
    ? "Submit a manual search to see results across your indexers."
    : results.length === 0
    ? "No results returned from your indexers for that query."
    : filtersActive
    ? "No results match the current filters. Adjust them to see more releases."
    : "No results to display.";

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase text-white/60">Multi-indexer search</p>
          <h1 className="text-3xl font-semibold text-white">Manual Search</h1>
          <p className="mt-2 text-sm text-white/60">
            Query your configured Prowlarr instances and send releases directly to your download clients.
          </p>
        </div>
      </header>

      {feedback && (
        <Alert variant={feedback.type === "success" ? "success" : "danger"}>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      {validationError && (
        <Alert variant="warning">
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {noIndexers ? (
        <Card className="border-dashed border-white/20 bg-white/5">
          <CardHeader>
            <CardTitle className="text-xl">Prowlarr configuration required</CardTitle>
            <CardDescription>
              Add at least one Prowlarr instance in Settings to enable manual searches across your indexers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/settings">Open Settings</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <form onSubmit={handleSubmit} className="space-y-6">
              <CardHeader className="mb-0">
                <CardTitle>Search configuration</CardTitle>
                <CardDescription>
                  Choose indexers and a search type, then run a manual query. Results refresh automatically on each search.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-col gap-4 md:flex-row">
                  <div className="flex-1">
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                      Query
                    </label>
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search for movies, series, music, or books"
                    />
                  </div>
                  <div className="md:w-64">
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                      Type
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {SEARCH_TYPES.map((type) => (
                        <Button
                          key={type.value}
                          type="button"
                          variant={searchType === type.value ? "primary" : "ghost"}
                          className="flex-1"
                          onClick={() => setSearchType(type.value)}
                        >
                          {type.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {indexersQuery.data?.instances.map((instance) => {
                    const ids = selectedIndexers[instance.instanceId] ?? [];
                    const allIds = instance.data.map((indexer) => indexer.id);
                    const everySelected = allIds.length > 0 && allIds.every((id) => ids.includes(id));
                    return (
                      <div key={instance.instanceId} className="rounded-xl border border-white/10 bg-white/5 p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-white">{instance.instanceName}</p>
                            <p className="text-xs text-white/50">
                              {ids.length} of {instance.data.length} indexers selected
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => handleToggleAll(instance.instanceId, allIds)}
                          >
                            {everySelected ? "Clear" : "Select all"}
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {instance.data.map((indexer) => {
                            const isSelected = ids.includes(indexer.id);
                            return (
                              <button
                                key={indexer.id}
                                type="button"
                                onClick={() => handleToggleIndexer(instance.instanceId, indexer.id)}
                                className={`rounded-full border px-3 py-1 text-xs transition ${
                                  isSelected
                                    ? "border-sky-400 bg-sky-500/20 text-white"
                                    : "border-white/20 bg-transparent text-white/70 hover:border-white/40"
                                }`}
                              >
                                {indexer.name}
                              </button>
                            );
                          })}
                          {instance.data.length === 0 && (
                            <span className="text-xs text-white/50">No indexers configured on this instance.</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-4 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-white">Result filters</h3>
                    <Button type="button" variant="ghost" className="text-xs uppercase tracking-wide" onClick={resetFilters}>
                      Reset
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                        Protocol
                      </label>
                      <select
                        value={protocolFilter}
                        onChange={(event) => setProtocolFilter(event.target.value as ProtocolFilter)}
                        className="w-full rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                        style={{ color: "#f8fafc" }}
                      >
                        {PROTOCOL_FILTERS.map((option) => (
                          <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                        Minimum seeders
                      </label>
                      <Input
                        type="number"
                        min={0}
                        value={minSeedersInput}
                        onChange={(event) => setMinSeedersInput(event.target.value)}
                        placeholder="0"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                        Maximum age (hours)
                      </label>
                      <Input
                        type="number"
                        min={0}
                        value={maxAgeInput}
                        onChange={(event) => setMaxAgeInput(event.target.value)}
                        placeholder="72"
                      />
                    </div>

                    <div className="flex flex-col justify-end gap-2">
                      <label className="text-xs font-semibold uppercase tracking-wide text-white/60">Visibility</label>
                      <Button
                        type="button"
                        variant={hideRejected ? "primary" : "ghost"}
                        className="justify-start"
                        onClick={() => setHideRejected((value) => !value)}
                        aria-pressed={hideRejected}
                      >
                        {hideRejected ? "Hidden rejected releases" : "Hide rejected releases"}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
                        Sort results by
                      </label>
                      <select
                        value={sortKey}
                        onChange={(event) => setSortKey(event.target.value as SortKey)}
                        className="w-full rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                        style={{ color: "#f8fafc" }}
                      >
                        {SORT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col justify-end gap-2">
                      <label className="text-xs font-semibold uppercase tracking-wide text-white/60">Sort direction</label>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant={sortDirection === "desc" ? "primary" : "ghost"}
                          className="flex-1"
                          onClick={() => setSortDirection("desc")}
                          aria-pressed={sortDirection === "desc"}
                        >
                          Desc
                        </Button>
                        <Button
                          type="button"
                          variant={sortDirection === "asc" ? "primary" : "ghost"}
                          className="flex-1"
                          onClick={() => setSortDirection("asc")}
                          aria-pressed={sortDirection === "asc"}
                        >
                          Asc
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button type="submit" disabled={searchMutation.isPending}>
                    {searchMutation.isPending ? "Searching..." : "Search"}
                  </Button>
                </div>
              </CardContent>
            </form>
          </Card>

          {(hasSearched || results.length > 0) && (
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
              Showing <span className="font-semibold text-white">{processed.results.length}</span> of
              {" "}
              <span className="font-semibold text-white">{results.length}</span> results.
              {filtersActive && processed.hidden > 0 ? (
                <span className="ml-2 text-xs text-white/50">
                  {processed.hidden} hidden by filters.
                </span>
              ) : null}
            </div>
          )}

          <SearchResultsTable
            results={processed.results}
            loading={searchMutation.isPending}
            onGrab={handleGrab}
            grabbingKey={grabbingKey}
            onCopyMagnet={handleCopyMagnet}
            onOpenInfo={handleOpenInfo}
            emptyMessage={emptyMessage}
          />
        </>
      )}
    </section>
  );
};


