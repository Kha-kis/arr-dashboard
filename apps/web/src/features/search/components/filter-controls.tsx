"use client";

import { Button, Input } from "../../../components/ui";
import {
  PROTOCOL_FILTERS,
  type ProtocolFilter,
} from "../lib/search-utils";

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
  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Result filters</h3>
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
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
            Protocol
          </label>
          <select
            value={protocolFilter}
            onChange={(event) =>
              onProtocolFilterChange(event.target.value as ProtocolFilter)
            }
            className="w-full rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            style={{ color: "#f8fafc" }}
          >
            {PROTOCOL_FILTERS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                className="bg-slate-900 text-white"
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
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
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
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
          <label className="text-xs font-semibold uppercase tracking-wide text-white/60">
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
