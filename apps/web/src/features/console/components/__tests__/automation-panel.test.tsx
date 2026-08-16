import type { AutomationRulesResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

const mockUseAutomationRules = vi.fn();
const mockUseCrossDomainRules = vi.fn();
vi.mock("../../../../hooks/api/useAutomation", () => ({
	useAutomationRules: () => mockUseAutomationRules(),
	useCrossDomainRules: () => mockUseCrossDomainRules(),
	useDryRunCrossDomainRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useDeployCrossDomainRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useDeactivateCrossDomainRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useDeleteCrossDomainRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
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
	mockUseCrossDomainRules.mockReset();
	mockUseCrossDomainRules.mockReturnValue({ data: { rules: [] } });
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
		expect(screen.getByRole("button", { name: /new notification rule/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit hunt notifier/i })).toBeInTheDocument();
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

	it("does not offer the flat editor for a recursive cleanup document", () => {
		mockUseAutomationRules.mockReturnValue({
			data: response([
				{
					id: "nested-cleanup",
					name: "Nested cleanup",
					enabled: true,
					context: "library-cleanup",
					document: {
						version: 1,
						root: {
							all: [
								{ kind: "age", params: { operator: "older_than", days: 30 } },
								{
									any: [{ kind: "year_range", params: { operator: "before", year: 2000 } }],
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

		expect(screen.getByText("Nested cleanup")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /edit nested cleanup/i })).not.toBeInTheDocument();
	});

	it("shows cross-domain draft lifecycle actions and requires a preview before deploy", () => {
		mockUseAutomationRules.mockReturnValue({
			data: response([
				{
					id: "x1",
					name: "Archive workflow",
					enabled: true,
					context: "cross-domain",
					document: { version: 1, root: { kind: "age", params: { days: 30 } } },
					unavailableKinds: [],
					unparseable: false,
				},
			]),
		});
		mockUseCrossDomainRules.mockReturnValue({
			data: {
				rules: [
					{
						id: "x1",
						name: "Archive workflow",
						active: true,
						hasDraftChanges: true,
						deploymentVersion: 2,
						actions: [{ type: "send_notification" }, { type: "exempt_cleanup" }],
					},
				],
			},
		});
		render(<AutomationPanel />, { wrapper: createWrapper() });

		expect(screen.getByText("Cross-Domain")).toBeInTheDocument();
		expect(screen.getByText("Draft changes")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /dry run/i })).toBeEnabled();
		expect(screen.getByRole("button", { name: /deploy/i })).toBeDisabled();
	});
});
