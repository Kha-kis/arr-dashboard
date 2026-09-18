import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { fetchNowPlaying } from "../../../../lib/api-client/plex";
import { plexKeys } from "../../../../lib/query-keys";
import { DashboardClient } from "../dashboard-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#123456", to: "#654321", glow: "#123456" } }),
}));
vi.mock("../../../../hooks/api/useDashboard", () => ({ useDashboardStatisticsQuery: () => ({}) }));
vi.mock("../../hooks/useDashboardData", () => ({
	useDashboardData: () => ({
		currentUser: { username: "Synthetic owner" },
		services: [
			{ id: "plex-one", service: "plex", enabled: true, baseUrl: "http://synthetic.invalid" },
		],
		enabledServices: [{ id: "plex-one", service: "plex", enabled: true }],
		servicesRefetch: vi.fn(),
		groupedByService: {},
		queueAggregated: [],
		queueInstances: [],
		totalQueueItems: 0,
		queueRefetch: vi.fn(),
		instanceOptions: [],
		statusOptions: [],
		isLoading: false,
	}),
}));
vi.mock("../../hooks/useDashboardQueue", () => ({
	useDashboardQueue: () => ({ manualImportContext: { open: false } }),
}));
vi.mock("../needs-attention-panel", () => ({ NeedsAttentionPanel: () => null }));
vi.mock("../plex-server-info-widget", () => ({ PlexServerInfoWidget: () => null }));
vi.mock("../on-deck-widget", () => ({ OnDeckWidget: () => null }));
vi.mock("../recently-added-widget", () => ({ RecentlyAddedWidget: () => null }));
vi.mock("../seerr-requests-widget", () => ({ SeerrRequestsWidget: () => null }));
vi.mock("../watch-history-section", () => ({ WatchHistorySection: () => null }));
vi.mock("../queue-table", () => ({ QueueTable: () => null }));
vi.mock("../../../../lib/api-client/plex", () => ({ fetchNowPlaying: vi.fn() }));
vi.mock("../../../../lib/api-client/jellyfin", () => ({ fetchJellyfinNowPlaying: vi.fn() }));
vi.mock("../../../../lib/api-client/tautulli", () => ({ fetchTautulliActivity: vi.fn() }));

const complete = { status: "complete" as const, configuredSources: 1, availableSources: 1 };
const clients: QueryClient[] = [];
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>
				<DashboardClient />
			</IncognitoProvider>
		</QueryClientProvider>,
	);
	return client;
}
beforeEach(() => {
	vi.mocked(fetchNowPlaying).mockReset();
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe("Dashboard session visibility", () => {
	it("shows multiple-connection coverage without hiding Activity or asserting an exact count", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: { status: "complete", configuredSources: 2, availableSources: 2 },
		});
		mount();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/overlap/i));
		const activity = screen.getByRole("tab", { name: "Activity" });
		expect(within(activity).queryByText(/^\d+$/)).not.toBeInTheDocument();
		fireEvent.click(activity);
		expect(screen.getByRole("status")).toHaveTextContent(/overlap/i);
		expect(screen.queryByText(/No active streams right now/)).not.toBeInTheDocument();
	});
	it("keeps Activity reachable and shows the overview warning when the session count is unknown", async () => {
		vi.mocked(fetchNowPlaying).mockRejectedValue(new Error("Synthetic unavailable"));
		mount();
		await waitFor(() => expect(fetchNowPlaying).toHaveBeenCalled());
		const activity = screen.getByRole("tab", { name: "Activity" });
		expect(within(activity).queryByText(/^\d+$/)).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
		fireEvent.click(activity);
		expect(activity).toHaveAttribute("aria-selected", "true");
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
	});
	it("keeps a selected Activity tab reachable across failed refetch and recovery", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: complete,
		});
		const client = mount();
		const activity = await screen.findByRole("tab", { name: "Activity" });
		fireEvent.click(activity);
		await screen.findByText(/No active streams right now/);
		vi.mocked(fetchNowPlaying).mockRejectedValue(new Error("Synthetic unavailable"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: plexKeys.nowPlaying() });
		});
		expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/stale/i));
		expect(screen.queryByText(/No active streams right now/)).not.toBeInTheDocument();
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: complete,
		});
		await act(async () => {
			await client.invalidateQueries({ queryKey: plexKeys.nowPlaying() });
		});
		await screen.findByText(/No active streams right now/);
		expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
	});
});
