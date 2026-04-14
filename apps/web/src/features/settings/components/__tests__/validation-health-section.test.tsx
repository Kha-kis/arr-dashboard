import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { ValidationHealthResponse } from "../../../../lib/api-client/system";
import { ValidationHealthSection } from "../validation-health-section";

/*
 * Pins the DomainStatusBadge tooltip overrides on each validation row.
 *
 * Why this test exists:
 *   `DomainStatusBadge`'s default tooltips describe *network reachability*
 *   ("Reachable and last check succeeded"). That's the wrong frame for a
 *   validation row — at a validation row we already got the data back, so
 *   reachability is never in question. The per-row tooltip must describe
 *   *schema / payload validation* outcomes instead. Without this test, a
 *   future refactor could silently drop the `title` override and the
 *   operator would start reading reachability copy on validation surfaces.
 */

// Hooks that poll are mocked to constants — this test only cares about the
// presentation of the per-row badge, not query state.
vi.mock("../../../../hooks/api/useSystem", () => ({
	useValidationQuarantine: () => ({ data: undefined }),
	useClearQuarantine: () => ({ mutate: vi.fn(), isPending: false }),
}));

const baseStats = {
	total: 100,
	validated: 100,
	rejected: 0,
	warned: 0,
	byCategory: {},
};

function makeData(state: "healthy" | "degraded" | "failing"): ValidationHealthResponse["data"] {
	return {
		integrations: {
			sonarr: {
				lastRefreshAt: new Date(0).toISOString(),
				lastSuccessAt: new Date(0).toISOString(),
				lastFailureAt: null,
				consecutiveFailures: 0,
				state,
				categories: {
					series: baseStats,
				},
				totals: baseStats,
			},
		},
		overallTotals: baseStats,
		validationModes: { sonarr: "tolerant" },
		resetAt: null,
		fingerprints: {},
	};
}

const renderWithTheme = (ui: ReactElement) => render(<ColorThemeProvider>{ui}</ColorThemeProvider>);

const themeGradient = { from: "#6366f1", to: "#8b5cf6", glow: "rgba(99,102,241,0.3)" };

describe("ValidationHealthSection — per-row tooltip override", () => {
	/**
	 * Find the per-row DomainStatusBadge's `title` attribute. Scoping to the
	 * table avoids picking up the overall Status summary card that also renders
	 * a `"Healthy"` / `"Degraded"` string.
	 */
	function getRowBadgeTitle(rowLabel: string): string {
		const row = screen.getByRole("row", { name: new RegExp(rowLabel, "i") });
		const labelNode = row.querySelector("span, div, text");
		// Prefer the most specific: any descendant of the row with a title.
		const titled = row.querySelector("[title]") as HTMLElement | null;
		expect(titled, `expected a title-bearing element inside row "${rowLabel}"`).not.toBeNull();
		labelNode; // silence unused
		return titled!.getAttribute("title") ?? "";
	}

	it("uses validation-specific tooltip for healthy rows (not the reachability default)", () => {
		renderWithTheme(
			<ValidationHealthSection
				data={makeData("healthy")}
				themeGradient={themeGradient}
				onReset={vi.fn()}
				isResetting={false}
			/>,
		);
		const title = getRowBadgeTitle("sonarr");
		expect(title).toMatch(/conformed to the expected schema/i);
		expect(title).not.toMatch(/reachable/i);
	});

	it("uses validation-specific tooltip for degraded rows", () => {
		renderWithTheme(
			<ValidationHealthSection
				data={makeData("degraded")}
				themeGradient={themeGradient}
				onReset={vi.fn()}
				isResetting={false}
			/>,
		);
		const title = getRowBadgeTitle("sonarr");
		expect(title).toMatch(/failed validation/i);
		expect(title).not.toMatch(/reachable/i);
	});

	it("uses validation-specific tooltip for failing rows (not 'last check failed')", () => {
		renderWithTheme(
			<ValidationHealthSection
				data={makeData("failing")}
				themeGradient={themeGradient}
				onReset={vi.fn()}
				isResetting={false}
			/>,
		);
		const title = getRowBadgeTitle("sonarr");
		expect(title).toMatch(/significant share of payloads/i);
		expect(title).not.toMatch(/last check failed/i);
	});
});
