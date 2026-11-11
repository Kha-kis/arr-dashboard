import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { HuntLog } from "../../lib/hunting-types";
import { HuntingClient } from "../hunting-client";

type Request = { url: string; method: string; body: unknown };
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let requests: Request[];
let alerts: string[];
let clients: QueryClient[];
let gates: Array<{ promise: Promise<void>; release: () => void }>;
let active: Set<Promise<Response>>;
let respond: (request: Request) => Promise<Response>;
const receipts: unknown[] = [];
const writes = () => requests.filter((request) => request.method !== "GET");
function hold() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const gate = { promise, release };
	gates.push(gate);
	return gate;
}
beforeEach(() => {
	localStorage.clear();
	requests = [];
	alerts = [];
	clients = [];
	gates = [];
	active = new Set();
	respond = async (request) => {
		throw new Error(`Unexpected synthetic request ${request.method} ${request.url}`);
	};
	vi.stubGlobal(
		"alert",
		vi.fn((message: unknown) => {
			alerts.push(String(message));
		}),
	);
	vi.stubGlobal(
		"confirm",
		vi.fn(() => false),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = respond(request);
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
async function settled() {
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
}
afterEach(async () => {
	try {
		gates.forEach((gate) => {
			gate.release();
		});
		await act(async () => {
			await Promise.allSettled([...active]);
		});
		await settled();
		receipts.push({
			test: expect.getState().currentTestName,
			requests,
			alerts,
			heldWorkJoined: active.size === 0,
		});
	} finally {
		toast.dismiss();
		cleanup();
		clients.forEach((client) => {
			client.clear();
		});
		vi.unstubAllGlobals();
	}
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "hunting-activity-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{ui}
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}

const log = (index: number): HuntLog => ({
	id: `log-${index}`,
	instanceId: "source-b",
	instanceName: `Synthetic source ${index}`,
	service: "radarr",
	huntType: "missing",
	itemsSearched: 2,
	itemsGrabbed: 1,
	searchedItems: [`Synthetic searched ${index}`],
	grabbedItems: [
		{
			title: `Synthetic release ${index}`,
			quality: "1080p",
			indexer: "Synthetic indexer",
			size: 1073741824,
		},
	],
	status: "partial",
	message: "Synthetic partial history",
	durationMs: 1250,
	startedAt: "2026-10-25T12:00:00Z",
	completedAt: "2026-10-25T12:00:01Z",
});
let mode: "populated" | "failed" | "empty";
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	mode = "populated";
	gate = null;
	respond = async ({ url, method }) => {
		if (method === "GET" && url === "/api/hunting/status")
			return json({ schedulerRunning: true, instances: [], recentActivityCount: 21 });
		if (method === "GET" && url.startsWith("/api/hunting/logs?")) {
			if (gate) await gate.promise;
			if (mode === "failed") return json({ error: "Synthetic history unavailable" }, 503);
			if (mode === "empty") return json({ logs: [], totalCount: 0 });
			const page = new URL(url, "http://synthetic.invalid").searchParams.get("page");
			return json({
				logs: page === "2" ? [log(21)] : Array.from({ length: 20 }, (_, i) => log(i + 1)),
				totalCount: 21,
			});
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
describe("Hunting status recovery", () => {
	it.each(["initial", "background"] as const)(
		"retries a failed %s status read without enabling hunt actions",
		async (failure) => {
			const statusUrl = "/api/hunting/status";
			const statusRequests = () => requests.filter(({ url }) => url === statusUrl);
			const success = { schedulerRunning: true, instances: [], recentActivityCount: 0 };
			let failed = failure === "initial";
			let pending: ReturnType<typeof hold> | undefined;
			respond = async ({ url, method }) => {
				if (url !== statusUrl || method !== "GET") throw new Error("Unexpected request");
				await pending?.promise;
				return failed ? json({ error: "Synthetic unavailable" }, 503) : json(success);
			};
			show(<HuntingClient />);
			if (failure === "background") {
				const refresh = await screen.findByRole("button", { name: "Refresh" });
				failed = true;
				fireEvent.click(refresh);
			}

			await screen.findByText(/hunting status/i);
			const retry = screen.getByRole("button", { name: "Retry" });
			expect(screen.queryByRole("button", { name: "Configuration" })).toBeNull();
			pending = hold();
			const beforeRetry = statusRequests().length;
			fireEvent.click(retry);
			await waitFor(() => expect(retry).toBeDisabled());
			expect(screen.getByText(/hunting status/i)).toBeInTheDocument();
			fireEvent.click(retry);
			expect(statusRequests()).toHaveLength(beforeRetry + 1);
			await act(async () => {
				pending!.release();
			});
			await waitFor(() => expect(retry).toBeEnabled());

			failed = false;
			fireEvent.click(retry);
			await screen.findByRole("button", { name: "Configuration" });
			expect(statusRequests()).toHaveLength(beforeRetry + 2);
			expect(writes()).toEqual([]);
		},
	);
});

describe("H3 maintained Hunting history transport", () => {
	it("reads populated details, serializes page and filters, resets page and keeps header Refresh read-only", async () => {
		show(<HuntingClient />);
		fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
		fireEvent.click((await screen.findByText("Synthetic source 1")).closest("button")!);
		expect(screen.getByText("Synthetic release 1")).toBeInTheDocument();
		expect(screen.getByText("Synthetic searched 1")).toBeInTheDocument();
		const history = () => requests.filter((r) => r.url.startsWith("/api/hunting/logs?"));
		expect(history()[0]).toEqual({
			url: "/api/hunting/logs?page=1&pageSize=20",
			method: "GET",
			body: null,
		});
		fireEvent.click(screen.getAllByTitle("Next page")[0]!);
		await screen.findByText("Synthetic source 21");
		expect(history().at(-1)?.url).toBe("/api/hunting/logs?page=2&pageSize=20");
		fireEvent.change(screen.getByRole("combobox", { name: "Type" }), {
			target: { value: "missing" },
		});
		await screen.findByText("Synthetic source 1");
		expect(history().at(-1)?.url).toBe("/api/hunting/logs?type=missing&page=1&pageSize=20");
		fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
			target: { value: "partial" },
		});
		await waitFor(() =>
			expect(history().at(-1)?.url).toBe(
				"/api/hunting/logs?type=missing&status=partial&page=1&pageSize=20",
			),
		);
		const before = history().length;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(requests.filter((r) => r.url === "/api/hunting/status").length).toBeGreaterThan(1),
		);
		expect(history()).toHaveLength(before);
		expect(writes()).toEqual([]);
	});
	it("distinguishes failed history from empty and recovers by actual tab re-entry without replay", async () => {
		mode = "failed";
		show(<HuntingClient />);
		gate = hold();
		fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
		await waitFor(() =>
			expect(requests.some((r) => r.url.startsWith("/api/hunting/logs?"))).toBe(true),
		);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Failed to load activity");
		expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
		mode = "populated";
		fireEvent.click(screen.getByRole("button", { name: "Overview" }));
		fireEvent.click(screen.getByRole("button", { name: "Activity" }));
		await screen.findByText("Synthetic source 1");
		expect(writes()).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Overview" }));
		mode = "empty";
		fireEvent.click(screen.getByRole("button", { name: "Activity" }));
		await screen.findByText("No activity yet");
		expect(screen.queryByText("Failed to load activity")).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});
});
