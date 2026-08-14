import type { AnalyticsProviderSelection } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const mocks = vi.hoisted(() => ({
	selection: {
		selected: "tautulli" as const,
		source: "explicit" as const,
		status: "configured" as const,
		families: {
			tracearr: { configuredCount: 1, enabledCount: 1 },
			tautulli: { configuredCount: 1, enabledCount: 1 },
		},
	} as AnalyticsProviderSelection,
}));

vi.mock("../../../../hooks/api/useSystem", () => ({
	useAnalyticsProviderSelection: () => ({ data: mocks.selection, isLoading: false }),
	useUpdateAnalyticsProviderSelection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../tracearr-tab", () => ({ TracearrTab: () => <div data-testid="tracearr-analytics" /> }));
vi.mock("../tautulli-tab", () => ({ TautulliTab: () => <div data-testid="tautulli-analytics" /> }));

import { AnalyticsTab } from "../analytics-tab";

function renderTab() {
	return render(<AnalyticsTab />, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<ColorThemeProvider>{children}</ColorThemeProvider>
		),
	});
}

describe("AnalyticsTab", () => {
	beforeEach(() => {
		mocks.selection = {
			selected: "tautulli",
			source: "explicit",
			status: "configured",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 1, enabledCount: 1 },
			},
		};
	});

	it("mounts only the selected Tautulli analytics provider", () => {
		renderTab();
		expect(screen.getByTestId("tautulli-analytics")).toBeInTheDocument();
		expect(screen.queryByTestId("tracearr-analytics")).not.toBeInTheDocument();
	});

	it("does not fall back when the selected provider is unavailable", () => {
		mocks.selection = {
			selected: "tracearr",
			source: "explicit",
			status: "unconfigured",
			families: {
				tracearr: { configuredCount: 0, enabledCount: 0 },
				tautulli: { configuredCount: 1, enabledCount: 1 },
			},
		};
		renderTab();
		expect(screen.getByText(/Tracearr is selected but unavailable/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /configure selected provider/i })).toHaveAttribute(
			"href",
			"/settings/services#analytics-provider",
		);
		expect(screen.getByRole("button", { name: /switch to tautulli/i })).toBeInTheDocument();
		expect(screen.queryByTestId("tautulli-analytics")).not.toBeInTheDocument();
	});

	it("guides a new installation to configure its selected provider when neither family exists", () => {
		mocks.selection = {
			selected: "tracearr",
			source: "migration-default",
			status: "unconfigured",
			families: {
				tracearr: { configuredCount: 0, enabledCount: 0 },
				tautulli: { configuredCount: 0, enabledCount: 0 },
			},
		};
		renderTab();
		expect(
			screen.getByText("No historical analytics provider is configured yet."),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /configure selected provider/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /switch to tautulli/i })).not.toBeInTheDocument();
	});
});
