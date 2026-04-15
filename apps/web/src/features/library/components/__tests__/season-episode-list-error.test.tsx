/**
 * Microcopy regression guard for the SeasonEpisodeList error state.
 *
 * The old copy said "Failed to load episodes. The Sonarr instance may
 * be unreachable." That speculative diagnosis competed with Pulse's
 * canonical reachability signal and could mislead operators when the
 * real cause was a transient 500 or a stale series id. See the
 * post-feature audit that motivated this fix.
 *
 * This test pins the neutral phrasing so a future edit doesn't
 * regress to diagnostic language.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Mock the episodes hook to simulate an error state.
vi.mock("../../../../hooks/api/useLibrary", () => ({
	useEpisodesQuery: () => ({ data: undefined, isLoading: false, isError: true }),
	useLibraryEpisodeSearchMutation: () => ({ mutateAsync: vi.fn() }),
	useLibraryEpisodeMonitorMutation: () => ({ mutateAsync: vi.fn() }),
}));

import { SeasonEpisodeList } from "../season-episode-list";

function wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("<SeasonEpisodeList /> error state microcopy", () => {
	it("renders the neutral error message pointing at Pulse as the live source", () => {
		render(
			<SeasonEpisodeList instanceId="inst-1" seriesId={1} seasonNumber={1} />,
			{ wrapper },
		);
		expect(
			screen.getByText(/Failed to load episodes\. Try again, or check Pulse/i),
		).toBeInTheDocument();
	});

	it("does NOT render the old speculative 'may be unreachable' copy", () => {
		render(
			<SeasonEpisodeList instanceId="inst-1" seriesId={1} seasonNumber={1} />,
			{ wrapper },
		);
		// The component has no way to diagnose the actual cause of a fetch
		// failure — guessing "may be unreachable" competes with Pulse's
		// canonical reachability signal. Never bring it back.
		expect(screen.queryByText(/may be unreachable/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Sonarr instance/i)).not.toBeInTheDocument();
	});
});
