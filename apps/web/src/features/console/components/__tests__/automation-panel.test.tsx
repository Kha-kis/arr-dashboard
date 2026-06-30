import type { AutomationRulesResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

const mockUseAutomationRules = vi.fn();
vi.mock("../../../../hooks/api/useAutomation", () => ({
	useAutomationRules: () => mockUseAutomationRules(),
}));

import { AutomationPanel } from "../automation-panel";

function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

function response(rules: AutomationRulesResponse["rules"]): AutomationRulesResponse {
	return { rules };
}

beforeEach(() => {
	mockUseAutomationRules.mockReset();
	localStorage.removeItem(INCOGNITO_STORAGE_KEY);
});

describe("<AutomationPanel />", () => {
	it("shows a loading state while fetching", () => {
		mockUseAutomationRules.mockReturnValue({ isLoading: true });
		render(<AutomationPanel />, { wrapper: createWrapper() });
		expect(screen.queryByText(/No automation rules yet/i)).not.toBeInTheDocument();
	});

	it("shows an honest error state (not empty) on failure", () => {
		mockUseAutomationRules.mockReturnValue({
			isError: true,
			error: new Error("boom"),
		});
		render(<AutomationPanel />, { wrapper: createWrapper() });
		expect(screen.getByText(/Couldn't load automation rules/i)).toBeInTheDocument();
		expect(screen.queryByText(/No automation rules yet/i)).not.toBeInTheDocument();
	});

	it("shows the empty state only when the fetch succeeded with no rules", () => {
		mockUseAutomationRules.mockReturnValue({ data: response([]) });
		render(<AutomationPanel />, { wrapper: createWrapper() });
		expect(screen.getByText(/No automation rules yet/i)).toBeInTheDocument();
	});

	it("groups rules by domain and renders names + documents", () => {
		mockUseAutomationRules.mockReturnValue({
			data: response([
				{
					id: "c1",
					name: "Old movies",
					enabled: true,
					context: "library-cleanup",
					document: {
						version: 1,
						root: { kind: "age", params: { operator: "older_than", days: 30 } },
					},
					unavailableKinds: [],
					unparseable: false,
				},
				{
					id: "n1",
					name: "Hunt notifier",
					enabled: false,
					context: "notifications",
					document: {
						version: 1,
						root: {
							all: [
								{
									kind: "field_match",
									params: { field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
								},
							],
						},
					},
					unavailableKinds: [],
					unparseable: false,
				},
			]),
		});
		render(<AutomationPanel />, { wrapper: createWrapper() });

		expect(screen.getByText("Library Cleanup")).toBeInTheDocument();
		expect(screen.getByText("Notifications")).toBeInTheDocument();
		expect(screen.getByText("Old movies")).toBeInTheDocument();
		expect(screen.getByText("Hunt notifier")).toBeInTheDocument();
		expect(screen.getByText("Enabled")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
	});

	it("surfaces an unparseable rule with a warning instead of a document", () => {
		mockUseAutomationRules.mockReturnValue({
			data: response([
				{
					id: "bad",
					name: "Broken rule",
					enabled: true,
					context: "auto-tag",
					document: null,
					unavailableKinds: [],
					unparseable: true,
				},
			]),
		});
		render(<AutomationPanel />, { wrapper: createWrapper() });
		expect(screen.getByText("Broken rule")).toBeInTheDocument();
		expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
	});
});
