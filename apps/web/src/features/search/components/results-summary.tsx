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
		<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">
			Showing <span className="font-semibold text-fg">{displayedCount}</span> of{" "}
			<span className="font-semibold text-fg">{totalCount}</span> results.
			{filtersActive && hiddenCount > 0 ? (
				<span className="ml-2 text-xs text-fg-muted">{hiddenCount} hidden by filters.</span>
			) : null}
		</div>
	);
};
