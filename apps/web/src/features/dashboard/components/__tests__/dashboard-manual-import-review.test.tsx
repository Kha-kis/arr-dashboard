import { webcrypto } from "node:crypto";
import type { QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DashboardClient } from "../dashboard-client";

const selected = ["first", "second"].map((downloadId) => ({
	instanceId: "instance",
	instanceName: "Synthetic",
	service: "radarr",
	downloadId,
	id: downloadId,
})) as QueueItem[];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../hooks/api/useDashboard", () => ({ useDashboardStatisticsQuery: () => ({}) }));
vi.mock("../../hooks/useDashboardData", () => ({
	useDashboardData: () => ({
		currentUser: { id: "owner", username: "Synthetic" },
		services: [],
		enabledServices: [],
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
vi.mock("../needs-attention-panel", () => ({ NeedsAttentionPanel: () => null }));
vi.mock("../on-deck-widget", () => ({ OnDeckWidget: () => null }));
vi.mock("../recently-added-widget", () => ({ RecentlyAddedWidget: () => null }));
vi.mock("../seerr-requests-widget", () => ({ SeerrRequestsWidget: () => null }));
vi.mock("../watch-history-section", () => ({ WatchHistorySection: () => null }));
// Exercise the maintained Dashboard callback with the same multi-selection contract as QueueTable.
vi.mock("../queue-table", () => ({
	QueueTable: ({ onManualImport }: { onManualImport: (items: QueueItem[]) => void }) => (
		<button type="button" onClick={() => onManualImport(selected)}>
			Review selected downloads
		</button>
	),
}));
afterEach(() => vi.unstubAllGlobals());
describe("Dashboard multi-selection Manual Import caller", () => {
	it("passes every selected download to the real review instead of taking the first", async () => {
		sessionStorage.clear();
		vi.stubGlobal("crypto", webcrypto);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ candidates: [], total: 0 }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic" });
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<DashboardClient />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Active Queue" }));
		fireEvent.click(screen.getByRole("button", { name: "Review selected downloads" }));
		expect(await screen.findByText("Download 1 of 2")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next download" }));
		expect(await screen.findByText("Download 2 of 2")).toBeInTheDocument();
	});
});
