import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Focused wiring tests for NotificationRulesTab.
 *
 * What we lock in:
 *  - error branch renders the *real* error message, not the generic fallback
 *  - retry button calls the hook's `refetch`
 *  - the empty-state CTA shows when rules are empty AND the form is closed
 *
 * We intentionally do NOT exercise the form itself — that's a large surface
 * and out of scope for this trust-hardening PR.
 */

const mockUseNotificationRules = vi.fn();
const mockUseNotificationChannels = vi.fn();
const mockCreate = { mutate: vi.fn(), isPending: false };
const mockUpdate = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };

vi.mock("../../../../hooks/api/useNotifications", () => ({
	useNotificationRules: () => mockUseNotificationRules(),
	useNotificationChannels: () => mockUseNotificationChannels(),
	useCreateRule: () => mockCreate,
	useUpdateRule: () => mockUpdate,
	useDeleteRule: () => mockDelete,
}));

vi.mock("@/hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#7c3aed",
			to: "#a855f7",
			glow: "rgba(124,58,237,0.4)",
			fromLight: "rgba(124,58,237,0.15)",
		},
	}),
}));

import { NotificationRulesTab } from "../notification-rules-tab";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NotificationRulesTab — AsyncStateView wiring", () => {
	beforeEach(() => {
		mockUseNotificationRules.mockReset();
		mockUseNotificationChannels.mockReturnValue({ data: [] });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders the real error message instead of the generic fallback when the rules query fails", () => {
		const refetch = vi.fn();
		mockUseNotificationRules.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error("rules api offline"),
			refetch,
		});

		render(<NotificationRulesTab />, { wrapper });

		expect(screen.getByText("Couldn't load notification rules")).toBeInTheDocument();
		// The real error message is shown, proving `error` is threaded through.
		expect(screen.getByText("rules api offline")).toBeInTheDocument();
		expect(screen.queryByText(/something went wrong while loading/i)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("shows the empty-state CTA when rules are empty and the form is closed", () => {
		mockUseNotificationRules.mockReturnValue({
			data: [],
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		});

		render(<NotificationRulesTab />, { wrapper });

		expect(screen.getByText("No notification rules configured yet")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /add your first rule/i })).toBeInTheDocument();
	});

	it("suppresses the empty-state CTA once the inline form is open, so it doesn't sit under a half-filled form", () => {
		mockUseNotificationRules.mockReturnValue({
			data: [],
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		});

		render(<NotificationRulesTab />, { wrapper });

		// Open the form by clicking the CTA.
		fireEvent.click(screen.getByRole("button", { name: /add your first rule/i }));

		// Empty-state heading is gone; the form header is visible.
		expect(screen.queryByText("No notification rules configured yet")).not.toBeInTheDocument();
		expect(screen.getByText("New Rule")).toBeInTheDocument();
	});
});
