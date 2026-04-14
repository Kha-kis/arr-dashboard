import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — we exercise the surface, not the network, so we stub the hooks that
// AsyncStateView reads from and any context providers the component pulls in.
// ---------------------------------------------------------------------------

const mockUseNotificationLogs = vi.fn();

vi.mock("../../../../hooks/api/useNotifications", () => ({
	useNotificationLogs: (...args: unknown[]) => mockUseNotificationLogs(...args),
}));

vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [false, vi.fn()],
	getLinuxIsoName: (s: string) => s,
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

import { NotificationLogTable } from "../notification-log-table";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NotificationLogTable — AsyncStateView wiring", () => {
	beforeEach(() => {
		mockUseNotificationLogs.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders the error card with retry when the logs query fails", () => {
		const refetch = vi.fn();
		mockUseNotificationLogs.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error("notification api offline"),
			refetch,
		});

		render(<NotificationLogTable />, { wrapper });

		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(screen.getByText(/couldn't load notification logs/i)).toBeInTheDocument();
		expect(screen.getByText(/notification api offline/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("shows a 'Clear filters' affordance when empty AND a filter is active", () => {
		mockUseNotificationLogs.mockReturnValue({
			data: { logs: [], total: 0, limit: 15 },
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		});

		render(<NotificationLogTable />, { wrapper });

		// Apply a status filter so `hasFilters` becomes true.
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));

		expect(screen.getByText(/no matching logs/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
	});

	it("shows the generic empty copy when there are no logs and no filter", () => {
		mockUseNotificationLogs.mockReturnValue({
			data: { logs: [], total: 0, limit: 15 },
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		});

		render(<NotificationLogTable />, { wrapper });

		expect(screen.getByText(/no notification logs yet/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
	});
});
