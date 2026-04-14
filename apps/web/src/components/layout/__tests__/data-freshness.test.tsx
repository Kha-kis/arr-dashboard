import { describe, expect, it } from "vitest";

import { describeFreshness, formatRelativeTime } from "../data-freshness";

/* -----------------------------------------------------------------------------
   formatRelativeTime
   Coarse by design — these boundaries are what the UI shows operators, so
   pin them so UX wording doesn't drift silently across refactors.
   -------------------------------------------------------------------------- */

describe("formatRelativeTime", () => {
	const now = 1_700_000_000_000; // arbitrary fixed clock

	it("returns null when the timestamp is missing / zero / non-finite", () => {
		expect(formatRelativeTime(undefined, now)).toBeNull();
		expect(formatRelativeTime(0, now)).toBeNull();
		expect(formatRelativeTime(Number.NaN, now)).toBeNull();
	});

	it("collapses anything under 5s into 'just now' (avoids noisy 0s/1s updates)", () => {
		expect(formatRelativeTime(now - 500, now)).toBe("just now");
		expect(formatRelativeTime(now - 4_999, now)).toBe("just now");
	});

	it("uses seconds between 5s and 60s", () => {
		expect(formatRelativeTime(now - 5_000, now)).toBe("5s ago");
		expect(formatRelativeTime(now - 59_000, now)).toBe("59s ago");
	});

	it("rolls over to minutes, hours, then days", () => {
		expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
		expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59m ago");
		expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1h ago");
		expect(formatRelativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
		expect(formatRelativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
		expect(formatRelativeTime(now - 5 * 24 * 60 * 60_000, now)).toBe("5d ago");
	});

	it("clamps negative deltas (clock skew) to 'just now' instead of a future time", () => {
		expect(formatRelativeTime(now + 10_000, now)).toBe("just now");
	});
});

/* -----------------------------------------------------------------------------
   describeFreshness
   Precedence rules here define what an operator reads on the screen — pin
   every branch so UX can't flip accidentally.
   -------------------------------------------------------------------------- */

describe("describeFreshness", () => {
	const now = 1_700_000_000_000;

	it("reports 'loading' when the first fetch is in flight and we have no data yet", () => {
		const result = describeFreshness({ dataUpdatedAt: 0, isFetching: true, now });
		expect(result.state).toBe("loading");
		expect(result.label).toBe("Loading…");
		expect(result.relative).toBeNull();
	});

	it("reports 'idle' (and hides its label) when nothing has loaded and nothing is pending", () => {
		const result = describeFreshness({ dataUpdatedAt: 0, isFetching: false, now });
		expect(result.state).toBe("idle");
		expect(result.label).toBeNull();
	});

	it("reports 'fresh' within the polling window", () => {
		const result = describeFreshness({
			dataUpdatedAt: now - 10_000,
			isFetching: false,
			pollIntervalMs: 60_000,
			now,
		});
		expect(result.state).toBe("fresh");
		expect(result.label).toBe("Updated 10s ago");
	});

	it("reports 'refreshing' when a background refresh overlaps existing data", () => {
		const result = describeFreshness({
			dataUpdatedAt: now - 30_000,
			isFetching: true,
			pollIntervalMs: 60_000,
			now,
		});
		expect(result.state).toBe("refreshing");
		expect(result.label).toBe("Refreshing…");
		// Still surfaces the last good timestamp in the tooltip, not just "Refreshing…"
		expect(result.tooltip).toContain("30s ago");
	});

	it("reports 'stale' once data is older than 2× the poll interval", () => {
		const pollIntervalMs = 60_000;
		// 2m30s old, threshold is 2m (2x 60s)
		const result = describeFreshness({
			dataUpdatedAt: now - 150_000,
			isFetching: false,
			pollIntervalMs,
			now,
		});
		expect(result.state).toBe("stale");
		expect(result.label).toBe("Updated 2m ago · may be delayed");
	});

	it("does NOT mark data stale when the caller didn't supply a poll interval", () => {
		// Without pollIntervalMs we have nothing to compare against, so avoid
		// overclaiming a staleness signal we don't actually have.
		const result = describeFreshness({
			dataUpdatedAt: now - 10 * 60_000,
			isFetching: false,
			now,
		});
		expect(result.state).toBe("fresh");
	});

	it("error outranks refreshing — operators should see the warning while retrying", () => {
		const result = describeFreshness({
			dataUpdatedAt: now - 20_000,
			isFetching: true,
			isError: true,
			pollIntervalMs: 60_000,
			now,
		});
		expect(result.state).toBe("error");
		expect(result.label).toBe("Couldn't refresh · showing last result from 20s ago");
	});

	it("error state still renders a useful label when no prior fetch succeeded", () => {
		const result = describeFreshness({
			dataUpdatedAt: 0,
			isFetching: false,
			isError: true,
			now,
		});
		// With no prior success, an error is just "loading failed" territory —
		// we show the generic message without a fake timestamp.
		expect(result.state).toBe("error");
		expect(result.label).toBe("Couldn't refresh");
	});
});
