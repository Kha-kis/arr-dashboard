"use client";

interface ResultsSummaryProps {
  /**
   * Number of displayed results after filtering
   */
  displayedCount: number;
  /**
   * Total number of results before filtering
   */
  totalCount: number;
  /**
   * Number of results hidden by filters
   */
  hiddenCount: number;
  /**
   * Whether any filters are active
   */
  filtersActive: boolean;
}

/**
 * Results summary component displaying count information
 * Shows how many results are displayed vs total, and how many are hidden by filters
 *
 * @component
 */
export const ResultsSummary = ({
  displayedCount,
  totalCount,
  hiddenCount,
  filtersActive,
}: ResultsSummaryProps) => {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
      Showing <span className="font-semibold text-white">{displayedCount}</span>{" "}
      of <span className="font-semibold text-white">{totalCount}</span> results.
      {filtersActive && hiddenCount > 0 ? (
        <span className="ml-2 text-xs text-white/50">
          {hiddenCount} hidden by filters.
        </span>
      ) : null}
    </div>
  );
};
