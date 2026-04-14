/**
 * Behavior-focused tests for <NeedsAttentionPanel />.
 *
 * We mock `usePulseQuery` directly so each test drives a specific React
 * Query state (loading / error-no-data / empty / populated / truncated).
 * This keeps the surface under test to "given this hook state, what does
 * the operator see?" which is exactly what the trust requirements in the
 * PR 3 spec turn on.
 */

import type { PulseItem, PulseResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// ---------------------------------------------------------------------------
// Mock the Pulse query hook
// ---------------------------------------------------------------------------
const mockUsePulseQuery = vi.fn();

vi.mock("../../../../hooks/api/usePulse", () => ({
	usePulseQuery: (args?: { attentionOnly?: boolean }) => mockUsePulseQuery(args),
}));

// Import after mocks so the component picks up the mocked hook.
import { NeedsAttentionPanel } from "../needs-attention-panel";

// ---------------------------------------------------------------------------
// Wrapper: React Query + IncognitoProvider (required by useIncognitoMode)
// ---------------------------------------------------------------------------
function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

function makeItem(overrides: Partial<PulseItem> = {}): PulseItem {
	return {
		id: "item-1",
		severity: "warning",
		category: "health",
		title: "Example attention item",
		detail: "Something that needs a look",
		actionUrl: "/settings",
		actionLabel: "Resolve",
		source: "system",
		timestamp: "2026-04-14T12:00:00.000Z",
		...overrides,
	};
}

function makeResponse(items: PulseItem[]): PulseResponse {
	const summary = {
		critical: items.filter((i) => i.severity === "critical").length,
		warning: items.filter((i) => i.severity === "warning").length,
		info: items.filter((i) => i.severity === "info").length,
	};
	return { items, summary, generatedAt: "2026-04-14T12:00:00.000Z" };
}

beforeEach(() => {
	mockUsePulseQuery.mockReset();
});

describe("<NeedsAttentionPanel />", () => {
	it("renders a loading skeleton when the Pulse query is loading and has no data", () => {
		mockUsePulseQuery.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		});

		render(<NeedsAttentionPanel />, { wrapper: createWrapper() });

		expect(
			screen.getByTestId("needs-attention-panel-loading"),
		).toBeInTheDocument();
		// The loading state must NOT claim "all clear" or show any item rows.
		expect(screen.queryByText(/All systems operational/i)).not.toBeInTheDocument();
	});

	it("shows an honest error state (not 'all clear') when the query errors with no cached data", () => {
		mockUsePulseQuery.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});

		render(<NeedsAttentionPanel />, { wrapper: createWrapper() });

		expect(screen.getByTestId("needs-attention-panel-error")).toBeInTheDocument();
		expect(screen.getByText(/Couldn't load attention items/i)).toBeInTheDocument();
		// Critical trust requirement: a failed fetch must never render the
		// "all clear" empty state.
		expect(screen.queryByText(/All systems operational/i)).not.toBeInTheDocument();
	});

	it("shows the 'all clear' empty state ONLY when the fetch succeeded with zero items", () => {
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse([]),
			isLoading: false,
			isError: false,
		});

		render(<NeedsAttentionPanel />, { wrapper: createWrapper() });

		expect(screen.getByTestId("needs-attention-panel-empty")).toBeInTheDocument();
		expect(screen.getByText(/All systems operational/i)).toBeInTheDocument();
	});

	it("renders each attention item with title, detail, and action link to its actionUrl", () => {
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse([
				makeItem({
					id: "crit-1",
					severity: "critical",
					title: "Sonarr is unreachable",
					detail: "Timed out after 10s",
					actionUrl: "/settings/services?instance=sonarr-1",
					actionLabel: "Open service",
				}),
				makeItem({
					id: "warn-1",
					severity: "warning",
					title: "Queue cleaner failed",
					detail: "ECONNREFUSED on last run",
					actionUrl: "/queue-cleaner",
				}),
			]),
			isLoading: false,
			isError: false,
		});

		render(<NeedsAttentionPanel />, { wrapper: createWrapper() });

		expect(screen.getByTestId("needs-attention-panel")).toBeInTheDocument();

		// Both titles rendered.
		expect(screen.getByText("Sonarr is unreachable")).toBeInTheDocument();
		expect(screen.getByText("Queue cleaner failed")).toBeInTheDocument();

		// Details rendered.
		expect(screen.getByText("Timed out after 10s")).toBeInTheDocument();
		expect(screen.getByText("ECONNREFUSED on last run")).toBeInTheDocument();

		// Action links land on the exact actionUrl from the item, and respect
		// actionLabel when provided (else "Resolve" default).
		const openService = screen.getByRole("link", { name: /Open service/i });
		expect(openService).toHaveAttribute(
			"href",
			"/settings/services?instance=sonarr-1",
		);
		const resolve = screen.getByRole("link", { name: /Resolve/i });
		expect(resolve).toHaveAttribute("href", "/queue-cleaner");

		// Header shows a "View all in Pulse" link regardless.
		expect(
			screen.getByRole("link", { name: /View all in Pulse/i }),
		).toHaveAttribute("href", "/pulse");
	});

	it("caps rendered rows at 10 and shows a 'View all N items in Pulse' footer link when truncated", () => {
		const items: PulseItem[] = Array.from({ length: 13 }, (_, i) =>
			makeItem({
				id: `item-${i}`,
				title: `Attention item ${i}`,
				actionUrl: `/target/${i}`,
			}),
		);
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse(items),
			isLoading: false,
			isError: false,
		});

		render(<NeedsAttentionPanel />, { wrapper: createWrapper() });

		// First 10 rendered, 11th+ suppressed.
		expect(screen.getByText("Attention item 0")).toBeInTheDocument();
		expect(screen.getByText("Attention item 9")).toBeInTheDocument();
		expect(screen.queryByText("Attention item 10")).not.toBeInTheDocument();
		expect(screen.queryByText("Attention item 12")).not.toBeInTheDocument();

		// Truncation footer announces total and links to /pulse.
		const footer = screen.getByRole("link", {
			name: /View all 13 items in Pulse/i,
		});
		expect(footer).toHaveAttribute("href", "/pulse");
	});
});
