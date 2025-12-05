"use client";

import { Button } from "../../../components/ui";
import { SORT_OPTIONS, type SortKey } from "../lib/search-utils";
import { OPTION_STYLE } from "../../settings/lib/settings-constants";

interface SortControlsProps {
	/**
	 * Current sort key
	 */
	sortKey: SortKey;
	/**
	 * Current sort direction
	 */
	sortDirection: "asc" | "desc";
	/**
	 * Handler for sort key changes
	 */
	onSortKeyChange: (value: SortKey) => void;
	/**
	 * Handler for sort direction changes
	 */
	onSortDirectionChange: (value: "asc" | "desc") => void;
}

/**
 * Sort controls component for search results
 * Provides sorting by various criteria and direction control
 *
 * @component
 */
export const SortControls = ({
	sortKey,
	sortDirection,
	onSortKeyChange,
	onSortDirectionChange,
}: SortControlsProps) => {
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<div>
				<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-fg-muted">
					Sort results by
				</label>
				<select
					value={sortKey}
					onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
					className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
				>
					{SORT_OPTIONS.map((option) => (
						<option key={option.value} value={option.value} style={OPTION_STYLE}>
							{option.label}
						</option>
					))}
				</select>
			</div>

			<div className="flex flex-col justify-end gap-2">
				<label className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
					Sort direction
				</label>
				<div className="flex gap-2">
					<Button
						type="button"
						variant={sortDirection === "desc" ? "primary" : "ghost"}
						className="flex-1"
						onClick={() => onSortDirectionChange("desc")}
						aria-pressed={sortDirection === "desc"}
					>
						Desc
					</Button>
					<Button
						type="button"
						variant={sortDirection === "asc" ? "primary" : "ghost"}
						className="flex-1"
						onClick={() => onSortDirectionChange("asc")}
						aria-pressed={sortDirection === "asc"}
					>
						Asc
					</Button>
				</div>
			</div>
		</div>
	);
};
