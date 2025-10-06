"use client";

import { useState } from "react";
import type { LibraryItem } from "@arr/shared";
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { Button } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { LibraryBadge } from "./library-badge";
import { SeasonEpisodeList } from "./season-episode-list";

/**
 * Props for the SeasonBreakdownModal component
 */
interface SeasonBreakdownModalProps {
  /** The library item (must be a series) to display season details for */
  item: LibraryItem;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback to toggle monitoring for a season */
  onToggleSeason: (seasonNumber: number, nextMonitored: boolean) => void;
  /** Callback to search for a season */
  onSearchSeason: (seasonNumber: number) => void;
  /** The key representing which action is currently pending */
  pendingActionKey: string | null;
}

/**
 * SeasonBreakdownModal displays detailed information about all seasons of a series.
 *
 * For each season, it shows:
 * - Season number and title
 * - Episode progress (downloaded/total)
 * - Missing episode count
 * - Monitoring status
 * - Progress bar
 *
 * Users can expand individual seasons to see episode-level details and perform actions:
 * - Monitor/unmonitor seasons
 * - Search for missing episodes
 * - View detailed episode list with individual controls
 */
export const SeasonBreakdownModal = ({
  item,
  onClose,
  onToggleSeason,
  onSearchSeason,
  pendingActionKey,
}: SeasonBreakdownModalProps) => {
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(
    new Set(),
  );

  if (item.type !== "series" || !item.seasons?.length) {
    return null;
  }

  const toggleSeasonExpanded = (seasonNumber: number) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) {
        next.delete(seasonNumber);
      } else {
        next.add(seasonNumber);
      }
      return next;
    });
  };

  const totalMissing = item.seasons.reduce(
    (total, season) =>
      total +
      (season.missingEpisodeCount ??
        Math.max(
          (season.episodeCount ?? 0) - (season.episodeFileCount ?? 0),
          0,
        )),
    0,
  );

  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-border bg-bg-subtle/98 backdrop-blur-xl p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-fg">{item.title}</h2>
            <p className="text-sm text-fg-muted">
              {item.instanceName}
              {totalMissing > 0
                ? ` - ${totalMissing} missing episode${totalMissing === 1 ? "" : "s"}`
                : " - All monitored episodes available"}
            </p>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="mt-6 max-h-[440px] space-y-3 overflow-y-auto pr-2">
          {item.seasons.map((season) => {
            const total = season.episodeCount ?? 0;
            const downloaded = season.episodeFileCount ?? 0;
            const missing =
              season.monitored === false
                ? 0
                : (season.missingEpisodeCount ??
                  Math.max(total - downloaded, 0));
            const isSpecial = season.seasonNumber === 0;
            const label = isSpecial
              ? "Specials"
              : `Season ${season.seasonNumber}`;
            const seasonKey = `${item.instanceId}:${item.id}:${season.seasonNumber}`;
            const monitorKey = `monitor:${seasonKey}`;
            const searchKey = `search:${seasonKey}`;
            const seasonMonitorPending = pendingActionKey === monitorKey;
            const seasonSearchPending = pendingActionKey === searchKey;

            const isExpanded = expandedSeasons.has(season.seasonNumber);
            const percentComplete =
              total > 0 ? Math.round((downloaded / total) * 100) : 0;

            return (
              <div
                key={season.seasonNumber}
                className="rounded-xl border border-border bg-bg-muted/30"
              >
                <div className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      onClick={() => toggleSeasonExpanded(season.seasonNumber)}
                      className="flex items-center gap-2 text-left hover:text-fg transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 flex-shrink-0" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-fg">{label}</p>
                        {season.title && season.title !== label ? (
                          <p className="text-xs text-fg-muted">
                            {season.title}
                          </p>
                        ) : null}
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <LibraryBadge tone={missing > 0 ? "yellow" : "green"}>
                        {downloaded}/{total || "?"} episodes
                      </LibraryBadge>
                      {missing > 0 ? (
                        <LibraryBadge tone="red">
                          {missing} missing
                        </LibraryBadge>
                      ) : null}
                      {season.monitored === false ? (
                        <LibraryBadge tone="blue">Unmonitored</LibraryBadge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="flex items-center gap-2"
                        disabled={seasonMonitorPending}
                        onClick={() =>
                          onToggleSeason(
                            season.seasonNumber,
                            !(season.monitored ?? false),
                          )
                        }
                      >
                        {seasonMonitorPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : season.monitored === false ? (
                          <span>Monitor</span>
                        ) : (
                          <span>Unmonitor</span>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="flex items-center gap-2"
                        disabled={seasonSearchPending}
                        onClick={() => onSearchSeason(season.seasonNumber)}
                      >
                        {seasonSearchPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Search className="h-3.5 w-3.5" />
                        )}
                        <span>Search</span>
                      </Button>
                    </div>
                  </div>

                  {/* Progress bar */}
                  {total > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-fg-subtle">Progress</span>
                        <span className="font-medium text-fg">
                          {percentComplete}%
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-bg-muted overflow-hidden">
                        <div
                          className={cn(
                            "h-full transition-all duration-300 rounded-full",
                            missing > 0 ? "bg-warning" : "bg-success",
                          )}
                          style={{ width: `${percentComplete}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-border px-4 py-3 bg-bg/20 space-y-3">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-fg-subtle">Total Episodes:</span>
                        <span className="ml-2 font-medium text-fg">
                          {total}
                        </span>
                      </div>
                      <div>
                        <span className="text-fg-subtle">Downloaded:</span>
                        <span className="ml-2 font-medium text-success">
                          {downloaded}
                        </span>
                      </div>
                      {missing > 0 && (
                        <div>
                          <span className="text-fg-subtle">Missing:</span>
                          <span className="ml-2 font-medium text-danger">
                            {missing}
                          </span>
                        </div>
                      )}
                      <div>
                        <span className="text-fg-subtle">Status:</span>
                        <span className="ml-2 font-medium text-fg">
                          {season.monitored === false
                            ? "Unmonitored"
                            : "Monitored"}
                        </span>
                      </div>
                    </div>

                    <div className="border-t border-border/50 pt-3">
                      <h4 className="text-xs font-medium uppercase tracking-wider text-fg-subtle mb-2">
                        Episodes
                      </h4>
                      <SeasonEpisodeList
                        instanceId={item.instanceId}
                        seriesId={item.id}
                        seasonNumber={season.seasonNumber}
                      />
                    </div>

                    {missing > 0 && season.monitored !== false && (
                      <div className="p-3 rounded-lg bg-warning/10 border border-warning/30">
                        <p className="text-xs text-warning">
                          {missing} episode{missing === 1 ? "" : "s"} missing.
                          Click "Search" to look for{" "}
                          {missing === 1 ? "it" : "them"}.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
