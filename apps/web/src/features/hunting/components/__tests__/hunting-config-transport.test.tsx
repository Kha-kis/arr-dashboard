import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { HuntConfigWithInstance } from "../../lib/hunting-types";
import { HuntingConfig } from "../hunting-config";

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
			join(process.env.V4_EVIDENCE_ROOT, "hunting-config-requests.json"),
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

const baseConfig: HuntConfigWithInstance = {
	id: "config-b",
	instanceId: "source-b",
	instanceName: "Synthetic B",
	service: "radarr",
	huntMissingEnabled: true,
	huntUpgradesEnabled: true,
	missingBatchSize: 5,
	missingIntervalMins: 60,
	upgradeBatchSize: 3,
	upgradeIntervalMins: 120,
	hourlyApiCap: 100,
	queueThreshold: 10,
	filterLogic: "AND",
	monitoredOnly: true,
	includeTags: null,
	excludeTags: null,
	includeQualityProfiles: null,
	excludeQualityProfiles: null,
	includeStatuses: null,
	yearMin: null,
	yearMax: null,
	ageThresholdDays: null,
	preferSeasonPacks: false,
	upgradeSearchAll: false,
	researchAfterDays: 7,
	lastMissingHunt: null,
	lastUpgradeHunt: null,
	apiCallsThisHour: 0,
	apiCallsResetAt: null,
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
};
let configs: HuntConfigWithInstance[];
let refused: boolean;
let running: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	configs = [];
	refused = false;
	running = true;
	gate = null;
	respond = async (request) => {
		const { url, method } = request;
		if (method === "GET" && url === "/api/hunting/status")
			return json({ schedulerRunning: running, instances: [], recentActivityCount: 0 });
		if (method === "GET" && url === "/api/hunting/configs")
			return json({
				configs,
				instances: [
					{ id: "source-a", label: "Synthetic A", service: "radarr" },
					{ id: "source-b", label: "Synthetic B", service: "radarr" },
				],
			});
		if (method === "GET" && url === "/api/hunting/filter-options/source-b")
			return json({ service: "radarr", tags: [], qualityProfiles: [], statuses: [] });
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic mutation refused" }, 503);
		if (method === "POST" && url === "/api/hunting/configs") {
			configs = [structuredClone(baseConfig)];
			return json(configs[0], 201);
		}
		if (method === "PATCH" && url === "/api/hunting/configs/source-b") {
			configs = [{ ...configs[0]!, ...(request.body as object) }];
			return json(configs[0]);
		}
		if (method === "POST" && url === "/api/hunting/scheduler/toggle") {
			running = !running;
			return json({ running });
		}
		if (method === "DELETE" && url === "/api/hunting/history/source-b")
			return json({ message: "Synthetic history reset", deleted: 4, huntType: "all" });
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
describe("H1 maintained Hunting config transport", () => {
	it("enables only selected B, retains refused draft, explicitly saves complete settings and reads them back", async () => {
		const view = show(<HuntingConfig />);
		const configure = (await screen.findAllByRole("button", { name: "Configure" }))[1]!;
		gate = hold();
		fireEvent.click(configure);
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(configure).toBeDisabled();
		fireEvent.click(configure);
		expect(writes()).toEqual([
			{ url: "/api/hunting/configs", method: "POST", body: { instanceId: "source-b" } },
		]);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByRole("button", { name: "Save Changes" });
		const batch = screen.getAllByRole("spinbutton")[0]!;
		fireEvent.change(batch, { target: { value: "7" } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText("Synthetic mutation refused");
		await settled();
		expect(batch).toHaveValue(7);
		expect(writes()).toHaveLength(2);
		refused = false;
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText("Settings saved");
		await settled();
		expect(writes()[2]).toEqual({
			url: "/api/hunting/configs/source-b",
			method: "PATCH",
			body: {
				huntMissingEnabled: true,
				huntUpgradesEnabled: true,
				missingBatchSize: 7,
				missingIntervalMins: 60,
				upgradeBatchSize: 3,
				upgradeIntervalMins: 120,
				hourlyApiCap: 100,
				queueThreshold: 10,
				researchAfterDays: 7,
				filterLogic: "AND",
				monitoredOnly: true,
				includeTags: null,
				excludeTags: null,
				includeQualityProfiles: null,
				excludeQualityProfiles: null,
				includeStatuses: null,
				yearMin: null,
				yearMax: null,
				ageThresholdDays: null,
				preferSeasonPacks: false,
				upgradeSearchAll: false,
			},
		});
		view.unmount();
		show(<HuntingConfig />);
		await screen.findByRole("button", { name: "Save Changes" });
		expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(7);
		expect(
			requests.filter((r) => r.method === "GET" && r.url === "/api/hunting/configs").length,
		).toBeGreaterThan(2);
	});
	it("toggles with current status GET and resets only B history after confirmation, not cancellation", async () => {
		configs = [structuredClone(baseConfig)];
		show(<HuntingConfig />);
		fireEvent.click(await screen.findByRole("button", { name: "Stop Automation" }));
		await screen.findByText("Automation stopped");
		await screen.findByRole("button", { name: "Start Automation" });
		expect(writes()).toEqual([{ url: "/api/hunting/scheduler/toggle", method: "POST", body: {} }]);
		fireEvent.click(screen.getByRole("button", { name: "Reset History" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
		expect(writes()).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Reset History" }));
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Reset History" }),
		);
		await screen.findByText("Search history cleared");
		await settled();
		expect(writes()[1]).toEqual({
			url: "/api/hunting/history/source-b",
			method: "DELETE",
			body: null,
		});
		expect(
			requests.filter((r) => r.url === "/api/hunting/configs" && r.method === "GET").length,
		).toBeGreaterThan(1);
	});
});
