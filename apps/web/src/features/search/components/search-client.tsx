"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SearchResult } from "@arr/shared";
import {
  useSearchIndexersQuery,
  useManualSearchMutation,
  useGrabSearchResultMutation,
} from "../../../hooks/api/useSearch";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
} from "../../../components/ui";
import { ApiError } from "../../../lib/api-client/base";
import { SearchResultsTable } from "./search-results-table";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { IndexerSelector } from "./indexer-selector";
import { SearchForm } from "./search-form";
import { FilterControls } from "./filter-controls";
import { SortControls } from "./sort-controls";
import { ResultsSummary } from "./results-summary";
import {
  buildFilters,
  parseNumberInput,
  getAgeHours,
  compareBySortKey,
  interpretGrabError,
  type SortKey,
  type ProtocolFilter,
} from "../lib/search-utils";

export const SearchClient = () => {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<
    "all" | "movie" | "tv" | "music" | "book"
  >("movie");
  const [selectedIndexers, setSelectedIndexers] = useState<
    Record<string, number[]>
  >({});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
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
        const enabled = instance.data
          .filter((indexer) => indexer.enable)
          .map((indexer) => indexer.id);
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
  }, [
    results,
    hideRejected,
    protocolFilter,
    minSeedersInput,
    maxAgeInput,
    sortKey,
    sortDirection,
  ]);

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
            message:
              total > 0
                ? `Found ${total} result${total === 1 ? "" : "s"}.`
                : "No results found for that query.",
          });
        },
        onError: (error) => {
          const message =
            error instanceof Error ? error.message : "Search failed";
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

  const deriveGrabErrorMessage = (error: unknown): string => {
    if (error instanceof ApiError) {
      const payload = error.payload;
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const primary =
          typeof record.message === "string" ? record.message.trim() : "";
        const secondary =
          typeof record.description === "string"
            ? record.description.trim()
            : "";

        const errors = record.errors as Record<string, unknown> | undefined;
        const fieldMessages: string[] = [];
        if (errors && typeof errors === "object") {
          for (const value of Object.values(errors)) {
            if (Array.isArray(value)) {
              for (const entry of value) {
                if (typeof entry === "string" && entry.trim().length > 0) {
                  fieldMessages.push(entry.trim());
                }
              }
            }
          }
        }

        const combined = [primary, secondary, ...fieldMessages].filter(
          (entry) => entry.length > 0,
        );
        if (combined.length > 0) {
          const friendly = interpretGrabError(combined.join(" "));
          return friendly ?? combined.join(" ");
        }
      } else if (typeof payload === "string" && payload.trim().length > 0) {
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

    return "Failed to send release to the download client.";
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
      setFeedback({
        type: "success",
        message: `Sent "${result.title}" to the download client.`,
      });
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
        setFeedback({
          type: "error",
          message:
            "No copyable magnet or download link is available for this release.",
        });
        return;
      }

      try {
        await navigator.clipboard.writeText(link);
        setFeedback({ type: "success", message: "Copied link to clipboard." });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Clipboard copy failed.";
        setFeedback({
          type: "error",
          message: `Unable to copy link: ${message}`,
        });
      }
    },
    [setFeedback],
  );

  const handleOpenInfo = useCallback(
    (result: SearchResult) => {
      const target =
        result.infoUrl ?? result.link ?? result.downloadUrl ?? result.magnetUrl;
      if (!target) {
        setFeedback({
          type: "error",
          message: "This release did not provide a public info link.",
        });
        return;
      }
      if (!safeOpenUrl(target)) {
        setFeedback({ type: "error", message: "Invalid or unsafe URL." });
      }
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
        <AlertDescription>
          Please verify your API connection and try again.
        </AlertDescription>
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
          <p className="text-sm font-medium uppercase text-white/60">
            Multi-indexer search
          </p>
          <h1 className="text-3xl font-semibold text-white">Manual Search</h1>
          <p className="mt-2 text-sm text-white/60">
            Query your configured Prowlarr instances and send releases directly
            to your download clients.
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
            <CardTitle className="text-xl">
              Prowlarr configuration required
            </CardTitle>
            <CardDescription>
              Add at least one Prowlarr instance in Settings to enable manual
              searches across your indexers.
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
            <CardHeader className="mb-0">
              <CardTitle>Search configuration</CardTitle>
              <CardDescription>
                Choose indexers and a search type, then run a manual query.
                Results refresh automatically on each search.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <SearchForm
                query={query}
                searchType={searchType}
                isSearching={searchMutation.isPending}
                onQueryChange={setQuery}
                onSearchTypeChange={setSearchType}
                onSubmit={handleSubmit}
              />

              {indexersQuery.data && (
                <IndexerSelector
                  indexersData={indexersQuery.data}
                  selectedIndexers={selectedIndexers}
                  onToggleIndexer={handleToggleIndexer}
                  onToggleAll={handleToggleAll}
                />
              )}

              <FilterControls
                protocolFilter={protocolFilter}
                minSeedersInput={minSeedersInput}
                maxAgeInput={maxAgeInput}
                hideRejected={hideRejected}
                onProtocolFilterChange={setProtocolFilter}
                onMinSeedersChange={setMinSeedersInput}
                onMaxAgeChange={setMaxAgeInput}
                onHideRejectedToggle={() => setHideRejected((value) => !value)}
                onReset={resetFilters}
              />

              <SortControls
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSortKeyChange={setSortKey}
                onSortDirectionChange={setSortDirection}
              />
            </CardContent>
          </Card>

          {(hasSearched || results.length > 0) && (
            <ResultsSummary
              displayedCount={processed.results.length}
              totalCount={results.length}
              hiddenCount={processed.hidden}
              filtersActive={filtersActive}
            />
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
