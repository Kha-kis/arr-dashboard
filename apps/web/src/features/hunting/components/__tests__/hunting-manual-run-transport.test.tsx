import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
			join(process.env.V4_EVIDENCE_ROOT, "hunting-manual-requests.json"),
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

let responseMode: "success" | "cooldown" | "refused";
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	responseMode = "success";
	gate = null;
	respond = async ({ url, method }) => {
		if (method === "GET" && url === "/api/hunting/configs")
			return json({
				configs: [baseConfig],
				instances: [
					{ id: "source-a", label: "Synthetic A", service: "radarr" },
					{ id: "source-b", label: "Synthetic B", service: "radarr" },
				],
			});
		if (method === "GET" && url === "/api/hunting/status")
			return json({ schedulerRunning: true, instances: [], recentActivityCount: 0 });
		if (method === "GET" && url === "/api/hunting/filter-options/source-b")
			return json({ service: "radarr", tags: [], qualityProfiles: [], statuses: [] });
		if (method === "POST" && url === "/api/hunting/trigger/source-b") {
			if (gate) await gate.promise;
			if (responseMode === "cooldown") return json({ error: "Synthetic cooldown active" }, 429);
			if (responseMode === "refused") return json({ error: "Synthetic hunt refused" }, 503);
			return json({ queued: true, message: "Synthetic hunt queued" }, 202);
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
describe("H2 maintained Hunting manual transport", () => {
	it.each([
		{ label: "Run Missing Hunt", type: "missing" },
		{ label: "Run Upgrade Hunt", type: "upgrade" },
	] as const)(
		"selects B $type, blocks held duplicate and reports admission not completion",
		async ({ label, type }) => {
			show(<HuntingConfig />);
			const run = await screen.findByRole("button", { name: label });
			gate = hold();
			fireEvent.click(run);
			await waitFor(() => expect(writes()).toHaveLength(1));
			await waitFor(() => expect(run).toBeDisabled());
			fireEvent.click(run);
			expect(writes()).toEqual([
				{ url: "/api/hunting/trigger/source-b", method: "POST", body: { type } },
			]);
			await act(async () => {
				gate!.release();
			});
			await screen.findByText("Synthetic hunt queued");
			await settled();
			expect(screen.queryByText("Synthetic hunt completed")).not.toBeInTheDocument();
			expect(run).toBeEnabled();
			expect(writes()).toHaveLength(1);
		},
	);
	it.each(["cooldown", "refused"] as const)(
		"keeps %s actionable without replay and later explicit missing hunt can succeed",
		async (mode) => {
			responseMode = mode;
			show(<HuntingConfig />);
			fireEvent.click(await screen.findByRole("button", { name: "Run Missing Hunt" }));
			await screen.findByText(
				mode === "cooldown" ? "Synthetic cooldown active" : "Failed to trigger missing hunt",
			);
			await settled();
			expect(writes()).toEqual([
				{ url: "/api/hunting/trigger/source-b", method: "POST", body: { type: "missing" } },
			]);
			responseMode = "success";
			fireEvent.click(screen.getByRole("button", { name: "Run Missing Hunt" }));
			await screen.findByText("Synthetic hunt queued");
			await settled();
			expect(writes()).toEqual([
				{ url: "/api/hunting/trigger/source-b", method: "POST", body: { type: "missing" } },
				{ url: "/api/hunting/trigger/source-b", method: "POST", body: { type: "missing" } },
			]);
		},
	);
});
