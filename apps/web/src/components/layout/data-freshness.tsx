"use client";

import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/* =============================================================================
   DATA FRESHNESS
   Shared vocabulary for "how fresh is this panel's data?" across polling
   surfaces.

   Why this exists:
   - Several panels poll (System Pulse, Queue Cleaner, Validation Health) but
     don't tell the operator *when* they last fetched successfully. When a
     background refresh fails or a tab goes idle, the UI looks confident even
     though the numbers are stale.
   - A shared primitive keeps the wording ("Updated 12s ago", "Refreshing…",
     "may be delayed") consistent and tied to real signals from React Query
     (`dataUpdatedAt`, `isFetching`, `isError`), not guesses.

   Precedence order inside describeFreshness:
     never-loaded → error → refreshing (with prior data) → stale → fresh
   ============================================================================= */

export type FreshnessState =
	/** No data has ever loaded and the first request is in flight. */
	| "loading"
	/** No data has ever loaded and nothing is in flight (e.g. mutation-only hook). */
	| "idle"
	/** Data was previously loaded and a background refresh is currently in flight. */
	| "refreshing"
	/** Data is within its expected refresh window. */
	| "fresh"
	/** Data is older than `2 × pollIntervalMs` — the poll hasn't landed when it should have. */
	| "stale"
	/** Most recent refresh failed. Last successful timestamp (if any) is still shown. */
	| "error";

export interface DescribeFreshnessInput {
	/** Timestamp (ms since epoch) of the last successful fetch. `undefined` / `0` = never. */
	dataUpdatedAt?: number;
	/** Whether the underlying query is currently fetching. */
	isFetching?: boolean;
	/** Whether the most recent fetch failed. */
	isError?: boolean;
	/** Expected polling cadence in ms. Staleness threshold = `2 × pollIntervalMs`. */
	pollIntervalMs?: number;
	/** Test seam — override "now". Defaults to `Date.now()`. */
	now?: number;
}

export interface FreshnessDescriptor {
	state: FreshnessState;
	/** Short user-facing label, e.g. "Updated 12s ago". `null` when there is nothing to say. */
	label: string | null;
	/** Longer description suitable for a `title` attribute. */
	tooltip: string;
	/** Relative time string for the last successful fetch, e.g. "12s ago". `null` if never. */
	relative: string | null;
}

/**
 * Format a timestamp as a coarse relative-time string.
 *
 * Intentionally coarse — we only surface staleness, not millisecond precision:
 * - < 5s      → "just now"
 * - < 60s     → "Ns ago"
 * - < 60m     → "Nm ago"
 * - < 24h     → "Nh ago"
 * - otherwise → "Nd ago"
 *
 * Returns `null` when `fromMs` is missing / non-positive, so callers can skip
 * rendering instead of showing a meaningless "0s ago".
 */
export function formatRelativeTime(fromMs: number | undefined, now = Date.now()): string | null {
	if (!fromMs || fromMs <= 0 || !Number.isFinite(fromMs)) return null;
	const diffMs = Math.max(0, now - fromMs);
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Classify a React Query-like panel's freshness so callers can render a
 * consistent label. Pure function — no DOM, no hooks.
 */
export function describeFreshness(input: DescribeFreshnessInput): FreshnessDescriptor {
	const now = input.now ?? Date.now();
	const hasData = Boolean(input.dataUpdatedAt && input.dataUpdatedAt > 0);
	const relative = formatRelativeTime(input.dataUpdatedAt, now);

	// Never loaded anything yet.
	if (!hasData) {
		// A first-fetch error with no prior data: still surface it so the header
		// doesn't look "idle" while the panel below renders its own error state.
		if (input.isError) {
			return {
				state: "error",
				label: "Couldn't refresh",
				tooltip:
					"The first fetch for this panel failed. There is no previous data to fall back to.",
				relative: null,
			};
		}
		if (input.isFetching) {
			return {
				state: "loading",
				label: "Loading…",
				tooltip: "Fetching the initial data for this panel.",
				relative: null,
			};
		}
		return {
			state: "idle",
			label: null,
			tooltip: "No data has been loaded yet.",
			relative: null,
		};
	}

	// We have data — an error outranks "refreshing" so operators see the warning.
	if (input.isError) {
		return {
			state: "error",
			label: relative
				? `Couldn't refresh · showing last result from ${relative}`
				: "Couldn't refresh",
			tooltip:
				"The most recent refresh failed. The values below are from the last successful fetch and may be out of date.",
			relative,
		};
	}

	// A background refresh is in flight on top of existing data.
	if (input.isFetching) {
		return {
			state: "refreshing",
			label: "Refreshing…",
			tooltip: relative ? `Fetching fresh data. Last update ${relative}.` : "Fetching fresh data.",
			relative,
		};
	}

	// Staleness: data older than 2× the expected poll interval means the poll
	// isn't landing when it should. We can't *know* something is broken, but we
	// can tell the operator the numbers are older than expected.
	const staleAfterMs = input.pollIntervalMs ? input.pollIntervalMs * 2 : undefined;
	const age = now - (input.dataUpdatedAt as number);
	if (staleAfterMs !== undefined && age > staleAfterMs) {
		return {
			state: "stale",
			label: relative ? `Updated ${relative} · may be delayed` : "May be delayed",
			tooltip: `Data is older than the expected refresh cadence. This can happen if the tab was in the background or a refresh failed silently.`,
			relative,
		};
	}

	return {
		state: "fresh",
		label: relative ? `Updated ${relative}` : "Up to date",
		tooltip: `Last successful refresh ${relative ?? "just now"}.`,
		relative,
	};
}

/* =============================================================================
   <DataFreshness />
   Small inline indicator. Renders an icon + short label, sized to sit in a
   page header or beside an action bar without taking visual weight.

   Pass the raw query signals — the component does the classification so every
   surface gets identical wording for identical states.
   ============================================================================= */

interface DataFreshnessProps
	extends Omit<HTMLAttributes<HTMLSpanElement>, "title">,
		DescribeFreshnessInput {
	/** Optional className applied to the wrapping span. */
	className?: string;
	/** Suppress rendering when there's nothing useful to say (state === "idle"). */
	hideWhenIdle?: boolean;
}

const STATE_CLASSES: Record<FreshnessState, string> = {
	loading: "text-muted-foreground",
	idle: "text-muted-foreground",
	refreshing: "text-muted-foreground",
	fresh: "text-muted-foreground",
	stale: "text-amber-400",
	error: "text-red-400",
};

/**
 * Render a compact freshness indicator from React Query-style inputs.
 *
 * Example:
 *   const q = useSomeQuery();
 *   <DataFreshness
 *     dataUpdatedAt={q.dataUpdatedAt}
 *     isFetching={q.isFetching}
 *     isError={q.isError}
 *     pollIntervalMs={POLLING_STANDARD}
 *   />
 */
export function DataFreshness({
	dataUpdatedAt,
	isFetching,
	isError,
	pollIntervalMs,
	now,
	className,
	hideWhenIdle = true,
	...rest
}: DataFreshnessProps) {
	const descriptor = describeFreshness({
		dataUpdatedAt,
		isFetching,
		isError,
		pollIntervalMs,
		now,
	});

	if (descriptor.label === null) {
		return hideWhenIdle ? null : <span className={className} aria-hidden="true" />;
	}

	const Icon =
		descriptor.state === "refreshing" || descriptor.state === "loading"
			? RefreshCw
			: descriptor.state === "stale" || descriptor.state === "error"
				? AlertTriangle
				: Clock;

	const spin = descriptor.state === "refreshing" || descriptor.state === "loading";

	return (
		<span
			{...rest}
			className={cn(
				"inline-flex items-center gap-1.5 text-xs font-medium",
				STATE_CLASSES[descriptor.state],
				className,
			)}
			title={descriptor.tooltip}
			// `polite` — the label updates on every refresh tick; assertive would be noisy.
			aria-live="polite"
			data-freshness-state={descriptor.state}
		>
			<Icon className={cn("h-3 w-3", spin && "animate-spin")} aria-hidden="true" />
			<span>{descriptor.label}</span>
		</span>
	);
}
