/**
 * Behavior-focused tests for <ConsoleClient /> (Operator Console shell).
 *
 * Pins the user-visible shell contract:
 *   - header renders with the console identity
 *   - the attention feed is mounted and driven by the shared
 *     NeedsAttentionPanel (its own states are pinned in
 *     needs-attention-panel.test.tsx — not re-tested here)
 *   - NO tab bar renders while the console has a single tab (the
 *     Automation tab registers with the composer; a dead stub tab would
 *     be a misleading surface)
 *   - the header refresh action refetches the attention query
 */

import type { PulseResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// ---------------------------------------------------------------------------
// Mock the Pulse query hook. ConsoleClient (header freshness/refresh) and
// NeedsAttentionPanel (feed) both consume it from the same module.
// ---------------------------------------------------------------------------
const mockUsePulseQuery = vi.fn();

vi.mock("../../../../hooks/api/usePulse", () => ({
	usePulseQuery: (args?: { attentionOnly?: boolean }) => mockUsePulseQuery(args),
}));

// Stub useThemeGradient so we don't have to wire ColorThemeProvider
// (same idiom as pulse-client-hash-scroll.test.tsx).
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#6366f1", to: "#8b5cf6" } }),
}));

// Import after mocks so the component picks up the mocked hook.
import { ConsoleClient } from "../console-client";

function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

function makeResponse(): PulseResponse {
	return {
		items: [
			{
				id: "hunt-failures-radarr",
				severity: "warning",
				category: "operations",
				title: "Hunt failing on Radarr Main",
				detail: "2 consecutive failures",
				actionUrl: "/hunting",
				actionLabel: "Open Hunting",
				source: "hunting",
				timestamp: "2026-06-10T12:00:00.000Z",
			},
		],
		summary: { critical: 0, warning: 1, info: 0 },
		generatedAt: "2026-06-10T12:00:00.000Z",
	};
}

function mockQueryState(overrides: Record<string, unknown> = {}) {
	mockUsePulseQuery.mockReturnValue({
		data: makeResponse(),
		isLoading: false,
		isError: false,
		isFetching: false,
		dataUpdatedAt: Date.now(),
		refetch: vi.fn(),
		...overrides,
	});
}

beforeEach(() => {
	mockUsePulseQuery.mockReset();
	window.localStorage.clear();
});

describe("ConsoleClient shell", () => {
	it("renders the console header identity", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		expect(screen.getByText("Operator Console")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Console" })).toBeInTheDocument();
	});

	it("mounts the shared attention feed with live items", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		expect(screen.getByTestId("needs-attention-panel")).toBeInTheDocument();
		expect(screen.getByText("Hunt failing on Radarr Main")).toBeInTheDocument();
	});

	it("renders NO tab bar while the console has a single tab", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		// The only "Overview" affordance would come from a rendered tab bar —
		// the header itself never says Overview.
		expect(screen.queryByRole("button", { name: /overview/i })).not.toBeInTheDocument();
	});

	it("refetches the attention query from the header refresh action", () => {
		const refetch = vi.fn();
		mockQueryState({ refetch });
		render(<ConsoleClient />, { wrapper: createWrapper() });

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("requests the attention-only feed, not the full Pulse list", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		// Every consumer on this surface must ask for the curated rollup;
		// the full list lives on /pulse.
		for (const call of mockUsePulseQuery.mock.calls) {
			expect(call[0]).toEqual({ attentionOnly: true });
		}
	});
});
