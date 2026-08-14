import type { AnalyticsProviderSelection } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const mocks = vi.hoisted(() => ({
	selection: {
		selected: "tracearr" as const,
		source: "migration-default" as const,
		status: "configured" as const,
		families: {
			tracearr: { configuredCount: 1, enabledCount: 1 },
			tautulli: { configuredCount: 1, enabledCount: 1 },
		},
	} as AnalyticsProviderSelection,
	update: vi.fn(),
}));

vi.mock("../../../../hooks/api/useSystem", () => ({
	useAnalyticsProviderSelection: () => ({ data: mocks.selection, isLoading: false }),
	useUpdateAnalyticsProviderSelection: () => ({ mutate: mocks.update, isPending: false }),
}));

import { AnalyticsProviderSection } from "../analytics-provider-section";

function renderSection() {
	return render(<AnalyticsProviderSection />, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<ColorThemeProvider>{children}</ColorThemeProvider>
		),
	});
}

describe("AnalyticsProviderSection", () => {
	beforeEach(() => {
		mocks.update.mockReset();
		mocks.selection = {
			selected: "tracearr",
			source: "migration-default",
			status: "configured",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 1, enabledCount: 1 },
			},
		};
	});

	it("labels Tracearr as recommended and preserves the migration default", () => {
		renderSection();

		const selector = screen.getByRole("radiogroup", { name: /historical analytics provider/i });
		expect(selector).toHaveAttribute("id", "analytics-provider");
		expect(screen.getByRole("radio", { name: /tracearr recommended/i })).toBeChecked();
		expect(screen.getByRole("radio", { name: /tautulli alternative/i })).toBeInTheDocument();
	});

	it("requires an explicit keyboard-confirmed switch for a configured provider", () => {
		renderSection();
		const tracearr = screen.getByRole("radio", { name: /tracearr recommended/i });

		tracearr.focus();
		fireEvent.keyDown(tracearr, { key: "ArrowRight" });

		expect(screen.getByRole("dialog")).toHaveTextContent(/historical analytics will change/i);
		expect(screen.getByRole("dialog")).toHaveTextContent(
			/native media-server live sessions do not/i,
		);
		expect(mocks.update).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /switch to tautulli/i }));
		expect(mocks.update).toHaveBeenCalledWith({ provider: "tautulli" });
	});

	it("does not claim an automatic fallback when the selected provider is unavailable", () => {
		mocks.selection = {
			selected: "tautulli",
			source: "explicit",
			status: "disabled",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 1, enabledCount: 0 },
			},
		};
		renderSection();

		expect(screen.getByText(/Tautulli is selected but unavailable/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /configure selected provider/i })).toHaveAttribute(
			"href",
			"#services",
		);
		expect(screen.getByRole("button", { name: /switch to tracearr/i })).toBeInTheDocument();
		expect(screen.queryByText(/automatically switched/i)).not.toBeInTheDocument();
	});
});
