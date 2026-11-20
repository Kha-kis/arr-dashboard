import type { QuiActionLogEntry } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as api from "../../../../lib/api-client/qui";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiActivityClient } from "../qui-activity-client";

vi.mock("../../../../lib/api-client/qui");
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [{ service: "qui", enabled: true }], isLoading: false }),
}));
const clients: QueryClient[] = [];
let verified = false;
function logEntry(): QuiActionLogEntry {
	return {
		id: "held-action-1",
		serviceInstanceId: "qui-1",
		serviceInstanceLabel: "Synthetic qUI",
		qbitInstanceId: 7,
		torrentHash: "a".repeat(40),
		action: "pause",
		status: verified ? "operator_verified_not_applied" : "uncertain",
		error: null,
		payload: null,
		requestedAt: "2026-01-01T00:00:00Z",
		completedAt: null,
	};
}
async function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QuiActivityClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "My Actions" }));
	await screen.findByText(/Outcome not confirmed/);
	return client;
}
beforeEach(() => {
	vi.resetAllMocks();
	verified = false;
	vi.spyOn(window, "confirm").mockReturnValue(true);
	vi.mocked(api.fetchQuiActivityFeed).mockResolvedValue({ events: [], nextCursor: null });
	vi.mocked(api.fetchQuiActionLog).mockImplementation(async () => ({
		entries: [logEntry()],
		nextCursor: null,
	}));
	vi.mocked(api.postQuiActionReconciliation).mockImplementation(async () => {
		verified = true;
		return { status: "operator_verified_not_applied" };
	});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("qUI held-action UI recovery with real query and mutation hooks", () => {
	it("cancels operator verification without dispatch or release", async () => {
		vi.mocked(window.confirm).mockReturnValueOnce(false);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Verified not applied" }));
		expect(api.postQuiActionReconciliation).not.toHaveBeenCalled();
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
	});

	it("retains a failed held outcome, refreshes explicitly, and recovers without replaying the torrent action", async () => {
		vi.mocked(api.postQuiActionReconciliation).mockRejectedValueOnce(
			new Error("Synthetic resolution unavailable"),
		);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Verified not applied" }));
		await screen.findByText(/Could not resolve this action/);
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		expect(api.postQuiActionReconciliation).toHaveBeenCalledTimes(1);
		expect(api.postQuiActionReconciliation).toHaveBeenCalledWith({
			actionLogId: "held-action-1",
			decision: "not_applied",
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(api.fetchQuiActionLog).toHaveBeenCalledTimes(2));
		expect(api.postQuiActionReconciliation).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Verified not applied" }));
		await screen.findByText(/Operator-verified outcome; qUI did not confirm the original request/);
		expect(screen.queryByText(/Outcome not confirmed/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Could not resolve this action/)).not.toBeInTheDocument();
		expect(api.postQuiActionReconciliation).toHaveBeenCalledTimes(2);
		expect(api.fetchQuiActionLog).toHaveBeenCalledTimes(3);
		expect(api.postQuiTorrentAction).not.toHaveBeenCalled();
		expect(api.postQuiBulkAction).not.toHaveBeenCalled();
	});

	it("does not publish a resolution before acknowledgement and the refreshed action log", async () => {
		let resolve!: (value: { status: "operator_verified_not_applied" }) => void;
		vi.mocked(api.postQuiActionReconciliation).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Verified not applied" }));
		try {
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Verified not applied" })).toBeDisabled(),
			);
			expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
			expect(screen.queryByText(/Operator-verified outcome;/)).not.toBeInTheDocument();
			expect(api.fetchQuiActionLog).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => {
				verified = true;
				resolve({ status: "operator_verified_not_applied" });
			});
		}
		await screen.findByText(/Operator-verified outcome; qUI did not confirm the original request/);
		expect(api.postQuiActionReconciliation).toHaveBeenCalledTimes(1);
	});
});
