/**
 * Pins the error-message surfacing added in #465.
 *
 * Before this PR the carousel rendered a flat "Failed to load <title>"
 * banner with no underlying detail, which made Seerr permission 403s
 * (and any other upstream failure) look identical to "no results yet."
 * Operators had to read server logs to figure out why a page was empty.
 *
 * These tests pin two invariants:
 *   1. When `isError` is true and `error.message` is provided, the
 *      message appears inline below the generic banner.
 *   2. When `isError` is true and `error` is null/undefined, the
 *      component still works (no crash) and falls back to the generic
 *      banner — backward-compatible with callers that haven't been
 *      updated to forward the error object.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DiscoverCarousel } from "../discover-carousel";

function wrapper({ children }: { children: ReactNode }) {
	return <ColorThemeProvider>{children}</ColorThemeProvider>;
}

describe("<DiscoverCarousel /> error surface (#465)", () => {
	it("renders the underlying error message inline when error is provided", () => {
		render(
			<DiscoverCarousel
				title="Trending Movies"
				items={[]}
				onSelectItem={() => {}}
				isError
				error={{
					message:
						"Seerr GET /api/v1/discover/trending?page=1 failed: 403 Forbidden — You do not have permission to access this endpoint",
				}}
			/>,
			{ wrapper },
		);
		expect(screen.getByText(/failed to load trending movies/i)).toBeInTheDocument();
		expect(screen.getByText(/403 forbidden/i)).toBeInTheDocument();
		expect(screen.getByText(/you do not have permission/i)).toBeInTheDocument();
	});

	it("falls back to the generic banner when no error is provided", () => {
		render(
			<DiscoverCarousel title="Popular TV Shows" items={[]} onSelectItem={() => {}} isError />,
			{ wrapper },
		);
		expect(screen.getByText(/failed to load popular tv shows/i)).toBeInTheDocument();
		// No "underlying" message paragraph should exist when error is omitted.
		expect(screen.queryByText(/permission/i)).not.toBeInTheDocument();
	});

	it("ignores empty / whitespace-only error messages (no blank detail paragraph)", () => {
		// React-query error objects can have empty `message` strings in some
		// transient states. Don't render an empty paragraph for them — it
		// looks like a layout bug.
		render(
			<DiscoverCarousel
				title="Coming Soon"
				items={[]}
				onSelectItem={() => {}}
				isError
				error={{ message: "   " }}
			/>,
			{ wrapper },
		);
		expect(screen.getByText(/failed to load coming soon/i)).toBeInTheDocument();
		// No second paragraph should render for whitespace messages.
		const container = screen.getByText(/failed to load/i).closest("div");
		expect(container?.querySelectorAll("p").length ?? 0).toBe(1);
	});
});
