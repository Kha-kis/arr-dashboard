"use client";

import { useState } from "react";
import { Button, Input } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PROTOCOL_FILTERS, type ProtocolFilter } from "../lib/search-utils";

interface FilterControlsProps {
	/**
	 * Current protocol filter
	 */
	protocolFilter: ProtocolFilter;
	/**
	 * Minimum seeders input value
	 */
	minSeedersInput: string;
	/**
	 * Maximum age input value
	 */
	maxAgeInput: string;
	/**
	 * Whether rejected releases are hidden
	 */
	hideRejected: boolean;
	/**
	 * Handler for protocol filter changes
	 */
	onProtocolFilterChange: (value: ProtocolFilter) => void;
	/**
	 * Handler for minimum seeders changes
	 */
	onMinSeedersChange: (value: string) => void;
	/**
	 * Handler for maximum age changes
	 */
	onMaxAgeChange: (value: string) => void;
	/**
	 * Handler for hide rejected toggle
	 */
	onHideRejectedToggle: () => void;
	/**
	 * Handler for resetting all filters
	 */
	onReset: () => void;
}

/**
 * Filter controls component for search results
 * Provides filtering by protocol, seeders, age, and rejection status
 *
 * @component
 */
export const FilterControls = ({
	protocolFilter,
	minSeedersInput,
	maxAgeInput,
	hideRejected,
	onProtocolFilterChange,
	onMinSeedersChange,
	onMaxAgeChange,
	onHideRejectedToggle,
	onReset,
}: FilterControlsProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [isFocused, setIsFocused] = useState(false);
	const [isHovered, setIsHovered] = useState(false);

	const selectStyle = isFocused
		? { borderColor: themeGradient.from, boxShadow: `0 0 0 1px ${themeGradient.from}` }
		: isHovered
			? { borderColor: `${themeGradient.from}cc` }
			: undefined;

	return (
		<div className="space-y-4 rounded-xl border border-border bg-card p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-semibold text-foreground">Result filters</h3>
				<Button
					type="button"
					variant="ghost"
					className="text-xs uppercase tracking-wide"
					onClick={onReset}
				>
					Reset
				</Button>
			</div>

			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<div>
					<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Protocol
					</label>
					<select
						value={protocolFilter}
						onChange={(event) => onProtocolFilterChange(event.target.value as ProtocolFilter)}
						onFocus={() => setIsFocused(true)}
						onBlur={() => setIsFocused(false)}
						onMouseEnter={() => setIsHovered(true)}
						onMouseLeave={() => setIsHovered(false)}
						className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-none"
						style={selectStyle}
					>
						{PROTOCOL_FILTERS.map((option) => (
							<option key={option.value} value={option.value} className="bg-background text-foreground">
								{option.label}
							</option>
						))}
					</select>
				</div>

				<div>
					<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Minimum seeders
					</label>
					<Input
						type="number"
						min={0}
						value={minSeedersInput}
						onChange={(event) => onMinSeedersChange(event.target.value)}
						placeholder="0"
					/>
				</div>

				<div>
					<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Maximum age (hours)
					</label>
					<Input
						type="number"
						min={0}
						value={maxAgeInput}
						onChange={(event) => onMaxAgeChange(event.target.value)}
						placeholder="72"
					/>
				</div>

				<div className="flex flex-col justify-end gap-2">
					<label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Visibility
					</label>
					<Button
						type="button"
						variant={hideRejected ? "primary" : "ghost"}
						className="justify-start"
						onClick={onHideRejectedToggle}
						aria-pressed={hideRejected}
					>
						{hideRejected ? "Hidden rejected releases" : "Hide rejected releases"}
					</Button>
				</div>
			</div>
		</div>
	);
};
