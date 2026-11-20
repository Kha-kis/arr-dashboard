import type { QuiAttentionResponse, QuiSummaryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as api from "../../../../lib/api-client/qui";
import { quiKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiHomeClient } from "../qui-home-client";

vi.mock("../../../../lib/api-client/qui");
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const clients: QueryClient[] = [];
const coverage = {
	status: "current",
	currentInstances: 1,
	lastKnownInstances: 0,
	unavailableInstances: 0,
	incompleteInstances: 0,
	oldestFetchedAt: "2026-10-01T00:00:00Z",
} as const;
const summary: QuiSummaryResponse = {
	totalTorrents: 0,
	byState: { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 },
	avgRatio: 0,
	lowRatioCount: 0,
	dlSpeed: 0,
	upSpeed: 0,
	lastSyncAt: null,
	lastSyncOk: null,
	configuredInstances: 1,
	qbitInstances: [],
	inventoryCoverage: coverage,
	topologyCoverage: "current",
	throughputCoverage: "current",
};
const attention: QuiAttentionResponse = {
	items: [],
	totalCount: 0,
	inventoryCoverage: coverage,
	trackerCoverage: "current",
	fileCoverage: { status: "current", issueCount: 0, oldestBuiltAt: null },
};
const completed: api.QuiBackfillNowResult = {
	usersScanned: 1,
	rowsScanned: 5,
	rowsHashed: 2,
	rowsMissed: 3,
	errors: 0,
	durationMs: 1000,
};
function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	client.setQueryData(quiKeys.crossSeedAvailability(), { available: true });
	client.setQueryData(quiKeys.crossSeedDiscovery(), { items: [] });
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QuiHomeClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.fetchQuiSummary).mockResolvedValue(summary);
	vi.mocked(api.fetchQuiAttention).mockResolvedValue(attention);
	vi.mocked(api.runQuiBackfillNow).mockResolvedValue(completed);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("qUI correlation backfill UI with real query and mutation hooks", () => {
	it("shows a failed attempt without inventing a result and recovers only after another operator click", async () => {
		vi.mocked(api.runQuiBackfillNow).mockRejectedValueOnce(
			new Error("Synthetic unavailable response"),
		);
		const client = mount();
		fireEvent.click(await screen.findByRole("button", { name: "Run correlation now" }));
		await screen.findByText(/last correlation attempt failed/i);
		expect(screen.queryByText(/Last completed run:/)).not.toBeInTheDocument();
		expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
		await waitFor(() => expect(api.fetchQuiSummary).toHaveBeenCalledTimes(2));
		expect(client.getQueryState(quiKeys.crossSeedAvailability())?.isInvalidated).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Run correlation now" }));
		await screen.findByText(/Last completed run: hashed 2 of 5 scanned in 1.0s/);
		expect(screen.queryByText(/last correlation attempt failed/i)).not.toBeInTheDocument();
		expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(2);
		expect(client.getQueryState(quiKeys.crossSeedDiscovery())?.isInvalidated).toBe(true);
	});

	it("retains previous completed counts as last-known when the next attempt fails", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Run correlation now" }));
		await screen.findByText(/Last completed run: hashed 2 of 5 scanned in 1.0s/);
		vi.mocked(api.runQuiBackfillNow).mockRejectedValueOnce(new Error("Synthetic later failure"));
		fireEvent.click(screen.getByRole("button", { name: "Run correlation now" }));
		await screen.findByText(/last correlation attempt failed/i);
		expect(
			screen.getByText(/Last completed run \(last-known\): hashed 2 of 5 scanned in 1.0s/),
		).toBeInTheDocument();
		expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(2);
	});

	it("reports completed partial results with errors rather than an unqualified success", async () => {
		vi.mocked(api.runQuiBackfillNow).mockResolvedValueOnce({ ...completed, errors: 1 });
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Run correlation now" }));
		await screen.findByText(/correlation completed with 1 error/i);
		expect(toast.warning).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
		expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(1);
	});

	it("keeps the control disabled and withholds result counts while the request is pending", async () => {
		let resolve!: (value: api.QuiBackfillNowResult) => void;
		vi.mocked(api.runQuiBackfillNow).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Run correlation now" }));
		try {
			expect(await screen.findByRole("button", { name: /Correlating/ })).toBeDisabled();
			expect(screen.queryByText(/Last completed run:/)).not.toBeInTheDocument();
			expect(toast.success).not.toHaveBeenCalled();
		} finally {
			await act(async () => resolve(completed));
		}
		await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
	});

	it("does not start two sweeps for same-turn double activation", async () => {
		let resolve!: (value: api.QuiBackfillNowResult) => void;
		vi.mocked(api.runQuiBackfillNow).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		const button = await screen.findByRole("button", { name: "Run correlation now" });
		try {
			act(() => {
				button.click();
				button.click();
			});
			await waitFor(() => expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(1));
		} finally {
			await act(async () => resolve(completed));
		}
		expect(api.runQuiBackfillNow).toHaveBeenCalledTimes(1);
	});
});
