"use client";

import type { DiscoverSearchResult, ServiceInstanceSummary } from "@arr/shared";
import { Loader2, CheckCircle2 } from "lucide-react";

/**
 * Props for the RecommendationCarousel component
 */
interface RecommendationCarouselProps {
  /** Title of the carousel section */
  title: string;
  /** Optional description text */
  description?: string;
  /** Array of search results to display */
  results: DiscoverSearchResult[];
  /** Available service instances */
  relevantInstances: ServiceInstanceSummary[];
  /** Callback when a result is selected */
  onSelectResult: (result: DiscoverSearchResult) => void;
  /** Whether the data is loading */
  isLoading?: boolean;
}

/**
 * Horizontal scrolling carousel for displaying recommendations from search results.
 * Filters out items that already exist in any instance.
 * Shows poster, rating, title, year, and genres.
 *
 * @component
 * @example
 * <RecommendationCarousel
 *   title="Recommended for You"
 *   description="Based on your library"
 *   results={recommendations}
 *   relevantInstances={instances}
 *   onSelectResult={handleSelect}
 *   isLoading={false}
 * />
 */
export const RecommendationCarousel: React.FC<RecommendationCarouselProps> = ({
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
