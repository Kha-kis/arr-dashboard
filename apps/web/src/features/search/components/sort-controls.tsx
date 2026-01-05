"use client";

import { useState } from "react";
import { Button } from "../../../components/ui";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { OPTION_STYLE } from "../../settings/lib/settings-constants";
import { SORT_OPTIONS, type SortKey } from "../lib/search-utils";

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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [isFocused, setIsFocused] = useState(false);
	const [isHovered, setIsHovered] = useState(false);

	const selectStyle = isFocused
		? { borderColor: themeGradient.from, boxShadow: `0 0 0 1px ${themeGradient.from}` }
		: isHovered
			? { borderColor: `${themeGradient.from}cc` }
			: undefined;

	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<div>
				<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-fg-muted">
					Sort results by
				</label>
				<select
					value={sortKey}
					onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
					onFocus={() => setIsFocused(true)}
					onBlur={() => setIsFocused(false)}
					onMouseEnter={() => setIsHovered(true)}
					onMouseLeave={() => setIsHovered(false)}
					className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg transition-all duration-200 focus:outline-none"
					style={selectStyle}
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
