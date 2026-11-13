import "@testing-library/jest-dom/vitest";
import type { QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys, QUEUE_QUERY_KEY } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DashboardClient } from "../dashboard-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../hooks/api/useDashboard", async (original) => ({
	...(await original<typeof import("../../../../hooks/api/useDashboard")>()),
	useDashboardStatisticsQuery: () => ({}),
}));
vi.mock("../needs-attention-panel", () => ({ NeedsAttentionPanel: () => null }));
vi.mock("../on-deck-widget", () => ({ OnDeckWidget: () => null }));
vi.mock("../recently-added-widget", () => ({ RecentlyAddedWidget: () => null }));
vi.mock("../seerr-requests-widget", () => ({ SeerrRequestsWidget: () => null }));
vi.mock("../watch-history-section", () => ({ WatchHistorySection: () => null }));

const item: QueueItem = {
	id: 31,
	instanceId: "north",
	instanceName: "Synthetic",
	service: "sonarr",
	title: "Synthetic retained row",
	actions: { canRemove: true, canRetry: true },
};
function queue(evidence: unknown[], rows: QueueItem[] = []) {
	return {
		instances: evidence.map((success, index) => ({
			instanceId: index ? "south" : "north",
			instanceName: "Synthetic",
			service: "sonarr",
			data: index ? [] : rows,
			...(success === undefined ? {} : { success }),
		})),
		aggregated: rows,
		totalCount: rows.length,
	};
}
const clients: QueryClient[] = [];
let response: unknown;
let failed = false;
let serviceFailed = false;
let queueReadHeld: Promise<void> | undefined;
let requests: Array<{ url: string; method: string }>;
function mount(cached?: ReturnType<typeof queue>, cachedServices?: unknown[]) {
	requests = [];
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: Infinity, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic" });
	if (cached !== undefined) client.setQueryData(QUEUE_QUERY_KEY, cached);
	if (cachedServices !== undefined) client.setQueryData(["services"], cachedServices);
	vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
		requests.push({ url, method: options?.method ?? "GET" });
		if (url === "/api/services")
			return serviceFailed ? Response.json({}, { status: 503 }) : Response.json({ services: [] });
		if (url === "/api/dashboard/queue") {
			await queueReadHeld;
			if (failed) throw new Error("Synthetic private transport failure");
			return Response.json(response);
		}
		throw new Error(`Unexpected read ${url}`);
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<DashboardClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}
async function openQueue() {
	fireEvent.click(await screen.findByRole("tab", { name: "Active Queue" }));
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
	failed = false;
	serviceFailed = false;
});

describe("Dashboard actual data hook and queue query read availability", () => {
	it.each([
		{ evidence: [false, false], rows: [], category: /queue unavailable/i },
		{ evidence: [true, false], rows: [item], category: /partial queue reads/i },
		{ evidence: [true, false], rows: [], category: /partial queue reads/i },
		{ evidence: [true, true], rows: [], category: /queue reads available/i },
		{ evidence: [], rows: [], category: /queue reads available/i },
		{ evidence: [undefined], rows: [item], category: /queue coverage unknown/i },
		{ evidence: ["true"], rows: [], category: /queue coverage unknown/i },
	])("shows truthful returned coverage %#", async ({ evidence, rows, category }) => {
		response = queue(evidence, rows);
		mount();
		await openQueue();
		expect(await screen.findByLabelText("Queue read status")).toHaveTextContent(category);
		if (rows.length) expect(screen.getByText(item.title!)).toBeInTheDocument();
		else expect(screen.getByText("No queue items returned.")).toBeInTheDocument();
		expect(
			screen.queryByText(/Queue is empty across all instances|Monitoring \d+ instance/i),
		).not.toBeInTheDocument();
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		if (evidence.some((success) => success === false)) {
			response = queue([true], [item]);
			fireEvent.click(screen.getByRole("button", { name: "Retry queue read" }));
			await waitFor(() =>
				expect(screen.getByLabelText("Queue read status")).toHaveTextContent(
					/queue reads available/i,
				),
			);
			expect(screen.getByText(item.title!)).toBeInTheDocument();
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		}
	});
	it("keeps cold transport failure distinct from zero and retries only the GET", async () => {
		failed = true;
		response = queue([true], [item]);
		mount();
		await openQueue();
		expect(await screen.findByLabelText("Queue read status")).toHaveTextContent(
			/queue unavailable/i,
		);
		expect(screen.queryByText(/Showing 0 of 0|Items across all queues/)).not.toBeInTheDocument();
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry queue read" }));
		expect(await screen.findByText(item.title!)).toBeInTheDocument();
		expect(screen.getByLabelText("Queue read status")).toHaveTextContent(/queue reads available/i);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		expect(requests.filter((request) => request.url === "/api/dashboard/queue")).toHaveLength(2);
	});
	it.each([{ rows: [] }, { rows: [item] }])(
		"retains populated and empty last-known observations %#",
		async ({ rows }) => {
			response = queue([true], rows);
			const client = mount();
			await openQueue();
			await screen.findByLabelText("Queue read status");
			failed = true;
			await act(async () => {
				await client.refetchQueries({ queryKey: QUEUE_QUERY_KEY });
			});
			expect(await screen.findByLabelText("Queue read status")).toHaveTextContent(
				/last-known queue/i,
			);
			if (rows.length) expect(screen.getByText(item.title!)).toBeInTheDocument();
			expect(
				screen.queryByText(/Queue is empty across all instances|Monitoring \d+ instance/i),
			).not.toBeInTheDocument();
			failed = false;
			fireEvent.click(screen.getByRole("button", { name: "Retry queue read" }));
			await waitFor(() =>
				expect(screen.getByLabelText("Queue read status")).toHaveTextContent(
					/queue reads available/i,
				),
			);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		},
	);
	it("shows loading without a current zero while a cold queue GET is held", async () => {
		let release!: () => void;
		queueReadHeld = new Promise<void>((resolve) => {
			release = resolve;
		});
		response = queue([true]);
		const client = mount();
		try {
			await openQueue();
			expect(screen.getByLabelText("Queue read status")).toHaveTextContent(/loading queue/i);
			expect(screen.getByText("Fetching queue items...")).toBeInTheDocument();
			expect(
				screen.queryByText(/Showing 0 of 0|Items across all queues|No queue items returned/),
			).not.toBeInTheDocument();
		} finally {
			await act(async () => {
				release();
				await queueReadHeld;
			});
			queueReadHeld = undefined;
		}
		await waitFor(() => expect(client.getQueryState(QUEUE_QUERY_KEY)?.status).toBe("success"));
	});
	it.each([
		undefined,
		[
			{
				id: "known",
				label: "Synthetic",
				service: "sonarr",
				enabled: true,
				baseUrl: "http://synthetic.invalid",
				tags: [],
				isDefault: false,
				createdAt: "2026-10-29T00:00:00Z",
				updatedAt: "2026-10-29T00:00:00Z",
			},
		],
	])(
		"does not turn failed service reads into first-configuration guidance %#",
		async (cachedServices) => {
			serviceFailed = true;
			response = queue([true]);
			const client = mount(undefined, cachedServices);
			await waitFor(() => expect(client.getQueryState(["services"])?.status).toBe("error"));
			expect(await screen.findByLabelText("Service configuration status")).toHaveTextContent(
				/configuration unavailable|last-known configuration/i,
			);
			fireEvent.click(screen.getByRole("button", { name: /Configured Instances/i }));
			expect(
				screen.queryByText(/No instances configured|to begin monitoring|0 active instances/i),
			).not.toBeInTheDocument();
			if (cachedServices)
				expect(screen.getByText("Synthetic", { exact: true })).toBeInTheDocument();
			serviceFailed = false;
			fireEvent.click(screen.getByRole("button", { name: "Retry service read" }));
			await waitFor(() =>
				expect(screen.queryByLabelText("Service configuration status")).not.toBeInTheDocument(),
			);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		},
	);
});
