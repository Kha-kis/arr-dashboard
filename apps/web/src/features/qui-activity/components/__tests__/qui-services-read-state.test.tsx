import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as quiApi from "../../../../lib/api-client/qui";
import * as servicesApi from "../../../../lib/api-client/services";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiActivityClient } from "../qui-activity-client";

const service: ServiceInstanceSummary = {
	id: "qui-1",
	service: "qui",
	label: "Example qUI",
	baseUrl: "http://qui.example",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-09-28T00:00:00.000Z",
	updatedAt: "2026-09-28T00:00:00.000Z",
	tags: [],
};
let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
	});
	vi.spyOn(servicesApi, "fetchServices").mockResolvedValue([service]);
	vi.spyOn(quiApi, "fetchQuiActivityFeed").mockResolvedValue({ events: [], nextCursor: null });
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function mount() {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>
					<QuiActivityClient />
				</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}
describe("qUI configuration read evidence", () => {
	it("reports a cold configuration failure without mounting activity, then retries the service read", async () => {
		vi.mocked(servicesApi.fetchServices).mockRejectedValue(new Error("unavailable"));
		mount();
		await screen.findByRole("alert");
		expect(screen.queryByText("No qui instance configured")).not.toBeInTheDocument();
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(quiApi.fetchQuiActivityFeed).not.toHaveBeenCalled();
		vi.mocked(servicesApi.fetchServices).mockResolvedValue([service]);
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await screen.findByRole("tablist");
		await screen.findByText("No qui activity yet");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(servicesApi.fetchServices).toHaveBeenCalledTimes(5); // existing hook: 1 + 3 retries, then manual GET
		expect(quiApi.fetchQuiActivityFeed).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("waits for configuration before mounting activity or claiming absence", async () => {
		let resolve!: (services: ServiceInstanceSummary[]) => void;
		vi.mocked(servicesApi.fetchServices).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		expect(screen.queryByText("No qui instance configured")).not.toBeInTheDocument();
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(quiApi.fetchQuiActivityFeed).not.toHaveBeenCalled();
		await act(async () => resolve([]));
		await screen.findByText("No qui instance configured");
		expect(quiApi.fetchQuiActivityFeed).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"marks retained configuration on refresh failure (empty=%s)",
		async (empty) => {
			vi.mocked(servicesApi.fetchServices).mockResolvedValue(empty ? [] : [service]);
			mount();
			if (empty) await screen.findByText("No qui instance configured");
			else await screen.findByText("No qui activity yet");
			vi.mocked(servicesApi.fetchServices).mockRejectedValue(new Error("refresh unavailable"));
			await act(async () => {
				await client.refetchQueries({ queryKey: ["services"] });
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(/last-known/i);
			if (empty) {
				expect(screen.queryByText("No qui instance configured")).not.toBeInTheDocument();
				expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
				expect(quiApi.fetchQuiActivityFeed).not.toHaveBeenCalled();
			} else expect(screen.getByRole("tablist")).toBeInTheDocument();
			vi.mocked(servicesApi.fetchServices).mockResolvedValue(empty ? [] : [service]);
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
