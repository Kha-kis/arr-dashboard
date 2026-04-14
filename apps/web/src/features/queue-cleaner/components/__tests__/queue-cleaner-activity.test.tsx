import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — we exercise the migration (AsyncStateView wiring + filter-aware
// empty copy) without touching the network or the real theme/incognito
// providers.
// ---------------------------------------------------------------------------

const mockUseQueueCleanerLogs = vi.fn();

vi.mock("../../hooks/useQueueCleanerLogs", () => ({
	useQueueCleanerLogs: (...args: unknown[]) => mockUseQueueCleanerLogs(...args),
}));

vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [false, vi.fn()],
	getLinuxIsoName: (s: string) => s,
	getLinuxInstanceName: (s: string) => s,
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

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#7c3aed",
			to: "#a855f7",
			glow: "rgba(124,58,237,0.4)",
			fromLight: "rgba(124,58,237,0.15)",
		},
	}),
}));

import { QueueCleanerActivity } from "../queue-cleaner-activity";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function emptyState(overrides: Record<string, unknown> = {}) {
	return {
		logs: [],
		totalCount: 0,
		isLoading: false,
		error: null,
		refetch: vi.fn(),
		hasRunningCleans: false,
		...overrides,
	};
}

describe("QueueCleanerActivity — AsyncStateView wiring", () => {
	beforeEach(() => {
		mockUseQueueCleanerLogs.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders the generic 'No activity yet' empty state when no filter is active", () => {
		mockUseQueueCleanerLogs.mockReturnValue(emptyState());

		render(<QueueCleanerActivity />, { wrapper });

		expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
		expect(screen.getByText(/queue cleaner activity will appear here/i)).toBeInTheDocument();
	});

	it("renders filter-specific empty copy when a status filter yields no rows", () => {
		mockUseQueueCleanerLogs.mockReturnValue(emptyState());

		render(<QueueCleanerActivity />, { wrapper });

		// Choose a non-default status from the FilterSelect combobox.
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "error" } });

		expect(screen.getByText(/no matching activity/i)).toBeInTheDocument();
		expect(screen.getByText(/no runs match the current status filter/i)).toBeInTheDocument();
	});

	it("surfaces the error card with retry when the logs hook reports an error", () => {
		const refetch = vi.fn();
		mockUseQueueCleanerLogs.mockReturnValue(
			emptyState({
				error: new Error("queue cleaner offline"),
				refetch,
			}),
		);

		render(<QueueCleanerActivity />, { wrapper });

		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(screen.getByText(/couldn't load activity log/i)).toBeInTheDocument();
		expect(screen.getByText(/queue cleaner offline/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});
});
