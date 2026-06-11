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

// Domain tiles' data sources (system jobs + services for gating).
const mockUseSystemJobs = vi.fn();
vi.mock("../../../../hooks/api/useSystem", () => ({
	useSystemJobs: () => mockUseSystemJobs(),
}));

const mockUseServicesQuery = vi.fn();
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => mockUseServicesQuery(),
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

function makeJob(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		label: id,
		description: "",
		concurrency: "singleton",
		state: "idle",
		lastStartedAt: "2026-06-11T12:00:00.000Z",
		lastFinishedAt: "2026-06-11T12:00:05.000Z",
		lastSuccessAt: "2026-06-11T12:00:05.000Z",
		lastFailureAt: null,
		lastDurationMs: 5000,
		lastError: null,
		consecutiveFailures: 0,
		totalRuns: 10,
		totalFailures: 0,
		disabled: false,
		disabledReason: null,
		...overrides,
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
	mockUseSystemJobs.mockReturnValue({
		data: {
			jobs: [makeJob("hunting"), makeJob("backup"), makeJob("qui-torrent-state-sync")],
			count: 3,
			capturedAt: "2026-06-11T12:00:10.000Z",
		},
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	});
	mockUseServicesQuery.mockReturnValue({
		data: [],
		isLoading: false,
		isError: false,
	});
}

beforeEach(() => {
	mockUsePulseQuery.mockReset();
	mockUseSystemJobs.mockReset();
	mockUseServicesQuery.mockReset();
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

	it("refreshes BOTH overview feeds from the header refresh action", () => {
		const refetch = vi.fn();
		mockQueryState({ refetch });
		const jobsRefetch = vi.fn();
		mockUseSystemJobs.mockReturnValue({
			data: { jobs: [makeJob("hunting")], count: 1, capturedAt: "2026-06-11T12:00:10.000Z" },
			isLoading: false,
			isError: false,
			error: null,
			refetch: jobsRefetch,
		});
		render(<ConsoleClient />, { wrapper: createWrapper() });

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(jobsRefetch).toHaveBeenCalledTimes(1);
	});

	it("renders domain tiles for core domains and OMITS service-gated ones", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		const grid = screen.getByTestId("domain-tile-grid");
		expect(grid).toBeInTheDocument();
		// hunting + backup jobs are registered → their tiles render.
		expect(screen.getByText("Hunting")).toBeInTheDocument();
		expect(screen.getByText("Backup")).toBeInTheDocument();
		// qui job is registered but NO qui service instance exists → no tile
		// (service-availability gating by omission, trust rule 1).
		expect(screen.queryByText("qui")).not.toBeInTheDocument();
	});

	it("degrades honestly when the SERVICES feed fails: core tiles render, omission disclosed", () => {
		// Reviewer-caught trust issue: blocking all tiles on a services
		// failure rendered a false "No domain schedulers registered" while
		// the jobs feed was demonstrably fine. Core domains need no service
		// data; only gated tiles are omitted, and the omission is disclosed.
		mockQueryState();
		mockUseServicesQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
		render(<ConsoleClient />, { wrapper: createWrapper() });

		expect(screen.getByText("Hunting")).toBeInTheDocument();
		expect(screen.getByText("Backup")).toBeInTheDocument();
		expect(screen.queryByText("No domain schedulers registered")).not.toBeInTheDocument();
		expect(screen.getByTestId("services-gating-degraded")).toBeInTheDocument();
	});

	it("shows honest last-run facts, never a predicted next-run time", () => {
		mockQueryState();
		render(<ConsoleClient />, { wrapper: createWrapper() });

		expect(screen.getAllByText(/Last activity /).length).toBeGreaterThan(0);
		expect(screen.queryByText(/next run/i)).not.toBeInTheDocument();
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
