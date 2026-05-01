import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
