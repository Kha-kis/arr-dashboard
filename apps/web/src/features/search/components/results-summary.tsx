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
		<div className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
			Showing <span className="font-semibold text-foreground">{displayedCount}</span> of{" "}
			<span className="font-semibold text-foreground">{totalCount}</span> results.
			{filtersActive && hiddenCount > 0 ? (
				<span className="ml-2 text-xs text-muted-foreground">{hiddenCount} hidden by filters.</span>
			) : null}
		</div>
	);
};
