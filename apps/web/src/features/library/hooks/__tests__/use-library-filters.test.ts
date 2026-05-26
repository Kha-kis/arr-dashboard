import { normalizedTorrentStateSchema } from "@arr/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TORRENT_STATE_FILTERS } from "../use-library-filters";

// Mock next/navigation so the hook can read URL params under jsdom. We hold the
// "current params" as a module-scoped object so warm-navigation tests can mutate
// the URL between renders by swapping `currentParams.entries` and re-rendering.
let currentParams = new Map<string, string>();
const mockGet = vi.fn<(key: string) => string | null>((key) => currentParams.get(key) ?? null);

// Each call to `useSearchParams` returns a fresh object identity so the
// useEffect's `[searchParams]` dependency triggers on re-render — this models
// Next.js App Router behavior where the hook returns a new ReadonlyURLSearchParams
// reference whenever the URL changes.
vi.mock("next/navigation", () => ({
	useSearchParams: () => ({ get: mockGet }),
}));

import { useLibraryFilters } from "../use-library-filters";

function setUrlParams(entries: Record<string, string>): void {
	currentParams = new Map(Object.entries(entries));
}

describe("useLibraryFilters — cold mount (deep-link seed)", () => {
	afterEach(() => {
		setUrlParams({});
		mockGet.mockClear();
	});

	it("defaults to all filters when no URL params are present", () => {
		setUrlParams({});

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("all");
		expect(result.current.serviceFilter).toBe("all");
	});

	it("seeds qualityFilter from ?quality=cutoff-unmet (Pulse deep link)", () => {
		setUrlParams({ quality: "cutoff-unmet" });

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("cutoff-unmet");
	});

	it("seeds qualityFilter from ?quality=cutoff-met", () => {
		setUrlParams({ quality: "cutoff-met" });

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("cutoff-met");
	});

	it("falls back to 'all' when ?quality= contains an unknown value", () => {
		setUrlParams({ quality: "garbage" });

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("all");
	});

	it("seeds serviceFilter from each supported service", () => {
		for (const service of ["sonarr", "radarr", "lidarr", "readarr"] as const) {
			setUrlParams({ service });
			const { result } = renderHook(() => useLibraryFilters());
			expect(result.current.serviceFilter).toBe(service);
		}
	});

	it("falls back to 'all' when ?service= contains an unknown value", () => {
		setUrlParams({ service: "plex" });

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.serviceFilter).toBe("all");
	});

	it("seeds quality and service together when both params are present", () => {
		setUrlParams({ quality: "cutoff-unmet", service: "radarr" });

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("cutoff-unmet");
		expect(result.current.serviceFilter).toBe("radarr");
	});
});

describe("useLibraryFilters — warm navigation (URL changes after mount)", () => {
	afterEach(() => {
		setUrlParams({});
		mockGet.mockClear();
	});

	it("syncs qualityFilter when ?quality= is added after mount", () => {
		setUrlParams({});
		const { result, rerender } = renderHook(() => useLibraryFilters());
		expect(result.current.qualityFilter).toBe("all");

		// Simulate Next.js client-side navigation to /library?quality=cutoff-unmet —
		// page does not remount but useSearchParams emits new values.
		act(() => {
			setUrlParams({ quality: "cutoff-unmet" });
			rerender();
		});

		expect(result.current.qualityFilter).toBe("cutoff-unmet");
	});

	it("syncs serviceFilter when ?service= is added after mount", () => {
		setUrlParams({});
		const { result, rerender } = renderHook(() => useLibraryFilters());
		expect(result.current.serviceFilter).toBe("all");

		act(() => {
			setUrlParams({ service: "sonarr" });
			rerender();
		});

		expect(result.current.serviceFilter).toBe("sonarr");
	});

	it("does not clobber a user-driven filter change when the URL is unchanged", () => {
		setUrlParams({ quality: "cutoff-unmet" });
		const { result, rerender } = renderHook(() => useLibraryFilters());
		expect(result.current.qualityFilter).toBe("cutoff-unmet");

		// User clicks "All quality" in the dropdown — URL stays the same.
		act(() => {
			result.current.setQualityFilter("all");
		});
		expect(result.current.qualityFilter).toBe("all");

		// A re-render happens for any other reason (e.g., parent state update).
		// URL still says ?quality=cutoff-unmet, but our effect should NOT
		// re-apply it because the param value is unchanged from what we last saw.
		act(() => {
			rerender();
		});

		expect(result.current.qualityFilter).toBe("all");
	});

	it("resets page to 1 when a new deep-link param arrives", () => {
		setUrlParams({});
		const { result, rerender } = renderHook(() => useLibraryFilters());
		act(() => {
			result.current.setPage(5);
		});
		expect(result.current.page).toBe(5);

		act(() => {
			setUrlParams({ quality: "cutoff-unmet" });
			rerender();
		});

		expect(result.current.qualityFilter).toBe("cutoff-unmet");
		expect(result.current.page).toBe(1);
	});
});

describe("useLibraryFilters — torrentState deep-link param (qui Quick Action target)", () => {
	// The qui home page's "Library — seeding" Quick Action and the Pulse
	// seeding-health card both link to `/library?torrentState=<bucket>`.
	// An earlier commit on this branch shipped that link but the filter
	// wasn't actually wired to read the URL param, so the deep link landed
	// on the unfiltered library. This block is the regression guard for
	// that class of bug.
	afterEach(() => {
		setUrlParams({});
		mockGet.mockClear();
	});

	it("defaults to 'all' when ?torrentState= is absent", () => {
		setUrlParams({});
		const { result } = renderHook(() => useLibraryFilters());
		expect(result.current.torrentStateFilter).toBe("all");
	});

	it("seeds torrentStateFilter from each supported bucket on cold mount", () => {
		const buckets = [
			"seeding",
			"downloading",
			"stalled_dl",
			"paused",
			"queued",
			"checking",
			"moving",
			"error",
			"unknown",
			"none",
		] as const;
		for (const bucket of buckets) {
			setUrlParams({ torrentState: bucket });
			const { result } = renderHook(() => useLibraryFilters());
			expect(result.current.torrentStateFilter).toBe(bucket);
		}
	});

	it("falls back to 'all' when ?torrentState= contains an unknown value", () => {
		// Defends against an untrusted URL widening the type union.
		setUrlParams({ torrentState: "garbage" });
		const { result } = renderHook(() => useLibraryFilters());
		expect(result.current.torrentStateFilter).toBe("all");
	});

	it("syncs torrentStateFilter when ?torrentState= is added after mount", () => {
		setUrlParams({});
		const { result, rerender } = renderHook(() => useLibraryFilters());
		expect(result.current.torrentStateFilter).toBe("all");

		act(() => {
			setUrlParams({ torrentState: "seeding" });
			rerender();
		});

		expect(result.current.torrentStateFilter).toBe("seeding");
	});

	it("resets page to 1 when torrentState deep-link arrives mid-session", () => {
		setUrlParams({});
		const { result, rerender } = renderHook(() => useLibraryFilters());
		act(() => {
			result.current.setPage(3);
		});
		expect(result.current.page).toBe(3);

		act(() => {
			setUrlParams({ torrentState: "error" });
			rerender();
		});

		expect(result.current.torrentStateFilter).toBe("error");
		expect(result.current.page).toBe(1);
	});

	it("does not clobber a user-driven torrentState change when URL is unchanged", () => {
		// Mirrors the quality+service tests: warm re-renders that don't
		// change the URL must not re-apply the URL param over the user's
		// dropdown choice.
		setUrlParams({ torrentState: "seeding" });
		const { result, rerender } = renderHook(() => useLibraryFilters());
		expect(result.current.torrentStateFilter).toBe("seeding");

		act(() => {
			result.current.setTorrentStateFilter("all");
		});
		expect(result.current.torrentStateFilter).toBe("all");

		act(() => {
			rerender();
		});
		expect(result.current.torrentStateFilter).toBe("all");
	});

	it("seeds quality, service, and torrentState together when all three params are present", () => {
		setUrlParams({
			quality: "cutoff-unmet",
			service: "radarr",
			torrentState: "stalled_dl",
		});

		const { result } = renderHook(() => useLibraryFilters());

		expect(result.current.qualityFilter).toBe("cutoff-unmet");
		expect(result.current.serviceFilter).toBe("radarr");
		expect(result.current.torrentStateFilter).toBe("stalled_dl");
	});
});

describe("TORRENT_STATE_FILTERS shape (mirror of normalizedTorrentStateSchema)", () => {
	// Pin the relationship between the UI filter list and the shared Zod
	// schema. The comment on TORRENT_STATE_FILTERS says it "mirrors
	// normalizedTorrentStateSchema in @arr/shared" — but nothing enforced
	// that. If qBit grows a new state and we add it to the schema, the UI
	// filter list would silently drop it; if we add a new UI bucket, the
	// schema wouldn't know. This block fails loudly the moment they drift.

	it("includes every normalized-state value from the shared schema", () => {
		const schemaValues = new Set(normalizedTorrentStateSchema.options);
		const filterValues = new Set(TORRENT_STATE_FILTERS.map((f) => f.value));
		for (const schemaValue of schemaValues) {
			expect(filterValues.has(schemaValue)).toBe(true);
		}
	});

	it("only extends the schema with 'all' and 'none' UI buckets", () => {
		// 'all' = the no-filter placeholder. 'none' = "not correlated with
		// qui" (rows where infoHash never matched). Any other deviation
		// from the shared schema is unintentional drift.
		const schemaValues = new Set<string>(normalizedTorrentStateSchema.options);
		const filterValues = new Set(TORRENT_STATE_FILTERS.map((f) => f.value));
		const uiOnly = [...filterValues].filter((v) => !schemaValues.has(v));
		expect(new Set(uiOnly)).toEqual(new Set(["all", "none"]));
	});

	it("preserves operator-priority ordering — 'all' first, problems before healthy", () => {
		// This isn't strictly correctness, but the ordering is intentional
		// (see the comment in use-library-filters.ts:36-39). A reviewer
		// re-alphabetizing the list would break the UX without changing
		// any other behavior — this test surfaces that.
		expect(TORRENT_STATE_FILTERS[0]?.value).toBe("all");
		const stalledIdx = TORRENT_STATE_FILTERS.findIndex((f) => f.value === "stalled_dl");
		const seedingIdx = TORRENT_STATE_FILTERS.findIndex((f) => f.value === "seeding");
		expect(stalledIdx).toBeGreaterThan(0);
		expect(stalledIdx).toBeLessThan(seedingIdx);
	});
});
