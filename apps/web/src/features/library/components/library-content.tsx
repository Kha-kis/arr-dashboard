"use client";

import type { LibraryItem, ServiceInstanceSummary } from "@arr/shared";
import { Library as LibraryIcon, Loader2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  EmptyState,
} from "../../../components/ui";

/**
 * Props for LibraryCard component (passthrough)
 */
interface LibraryCardProps {
  item: LibraryItem;
  onToggleMonitor: (item: LibraryItem) => void;
  pending: boolean;
  externalLink?: string | null;
  onViewSeasons?: (item: LibraryItem) => void;
  onSearchMovie?: (item: LibraryItem) => void;
  movieSearchPending?: boolean;
  onSearchSeries?: (item: LibraryItem) => void;
  seriesSearchPending?: boolean;
  onExpandDetails?: (item: LibraryItem) => void;
}

/**
 * Props for the LibraryContent component
 */
interface LibraryContentProps {
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  isError: boolean;
  /** Error object */
  error?: Error | null;
  /** Grouped library items */
  grouped: {
    movies: LibraryItem[];
    series: LibraryItem[];
  };
  /** Handler for toggling monitoring */
  onToggleMonitor: (item: LibraryItem) => void;
  /** Pending key for monitor mutation */
  pendingKey: string | null;
  /** Whether monitor mutation is pending */
  isMonitorPending: boolean;
  /** Service lookup for building external links */
  serviceLookup: Record<string, ServiceInstanceSummary>;
  /** Handler for viewing seasons */
  onViewSeasons: (item: LibraryItem) => void;
  /** Handler for searching a movie */
  onSearchMovie: (item: LibraryItem) => void;
  /** Pending movie search key */
  pendingMovieSearch: string | null;
  /** Handler for searching a series */
  onSearchSeries: (item: LibraryItem) => void;
  /** Pending series search key */
  pendingSeriesSearch: string | null;
  /** Handler for expanding details */
  onExpandDetails: (item: LibraryItem) => void;
  /** Function to build external link */
  buildLibraryExternalLink: (
    item: LibraryItem,
    instance?: ServiceInstanceSummary,
  ) => string | null;
  /** LibraryCard component to render */
  LibraryCard: React.ComponentType<LibraryCardProps>;
}

/**
 * Content area for the library page
 *
 * Displays the library items with appropriate states:
 * - Loading state with spinner
 * - Empty state when no items match filters
 * - Movies section (if movies exist)
 * - Series section (if series exist)
 * - Error alert if loading fails
 */
export const LibraryContent: React.FC<LibraryContentProps> = ({
  isLoading,
  isError,
  error,
  grouped,
  onToggleMonitor,
  pendingKey,
  isMonitorPending,
  serviceLookup,
  onViewSeasons,
  onSearchMovie,
  pendingMovieSearch,
  onSearchSeries,
  pendingSeriesSearch,
  onExpandDetails,
  buildLibraryExternalLink,
  LibraryCard,
}) => {
  const totalItems = grouped.movies.length + grouped.series.length;

  return (
    <>
      {isLoading ? (
        <div className="flex items-center gap-3 text-white/60">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading library from
          your instances...
        </div>
      ) : null}

      {!isLoading && totalItems === 0 ? (
        <EmptyState
          icon={LibraryIcon}
          title="No items found"
          description="Adjust your filters or add content from the Discover tab to populate your library."
        />
      ) : null}

      {grouped.movies.length > 0 ? (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">Movies</h2>
            <span className="text-sm text-white/50">
              {grouped.movies.length} items
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {grouped.movies.map((item) => (
              <LibraryCard
                key={`${item.instanceId}:${item.id}`}
                item={item}
                onToggleMonitor={onToggleMonitor}
                pending={
                  pendingKey === `${item.service}:${item.id}` &&
                  isMonitorPending
                }
                externalLink={buildLibraryExternalLink(
                  item,
                  serviceLookup[item.instanceId],
                )}
                onSearchMovie={onSearchMovie}
                movieSearchPending={
                  pendingMovieSearch === `${item.instanceId}:${item.id}`
                }
                onExpandDetails={onExpandDetails}
              />
            ))}
          </div>
        </section>
      ) : null}

      {grouped.series.length > 0 ? (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">Series</h2>
            <span className="text-sm text-white/50">
              {grouped.series.length} items
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {grouped.series.map((item) => (
              <LibraryCard
                key={`${item.instanceId}:${item.id}`}
                item={item}
                onToggleMonitor={onToggleMonitor}
                pending={
                  pendingKey === `${item.service}:${item.id}` &&
                  isMonitorPending
                }
                externalLink={buildLibraryExternalLink(
                  item,
                  serviceLookup[item.instanceId],
                )}
                onViewSeasons={onViewSeasons}
                onSearchSeries={onSearchSeries}
                seriesSearchPending={
                  pendingSeriesSearch === `${item.instanceId}:${item.id}`
                }
                onExpandDetails={onExpandDetails}
              />
            ))}
          </div>
        </section>
      ) : null}

      {isError ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load library</AlertTitle>
          <AlertDescription>
            {error?.message ??
              "An error occurred while loading your library."}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
};
