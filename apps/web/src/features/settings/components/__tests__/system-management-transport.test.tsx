import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type {
	QuarantineResponse,
	SecurityPostureResponse,
	SystemSettings,
	ValidationHealthResponse,
} from "../../../../lib/api-client/system";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SystemTab } from "../system-tab";

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
			join(process.env.V4_EVIDENCE_ROOT, "system-management-requests.json"),
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

let settings: SystemSettings;
let health: ValidationHealthResponse;
let quarantine: QuarantineResponse;
let refused: boolean;
let saved: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	settings = {
		apiPort: 3001,
		webPort: 3000,
		listenAddress: "0.0.0.0",
		appName: "Synthetic dashboard",
		externalUrl: null,
		trustProxy: false,
		secureCookies: null,
		effectiveApiPort: 3001,
		effectiveWebPort: 3000,
		effectiveListenAddress: "0.0.0.0",
		effectiveTrustProxy: false,
		effectiveSecureCookies: false,
		requiresRestart: true,
		updatedAt: "2026-10-25T12:00:00Z",
	};
	health = {
		success: true,
		data: {
			integrations: {
				radarr: {
					lastRefreshAt: "2026-10-25T12:00:00Z",
					lastSuccessAt: "2026-10-25T12:00:00Z",
					lastFailureAt: "2026-10-25T12:00:00Z",
					consecutiveFailures: 1,
					state: "degraded",
					categories: { movies: { total: 3, validated: 2, rejected: 1 } },
					totals: { total: 3, validated: 2, rejected: 1 },
				},
			},
			overallTotals: { total: 3, validated: 2, rejected: 1 },
			validationModes: { radarr: "strict" },
			resetAt: null,
			fingerprints: {},
		},
	};
	quarantine = {
		success: true,
		data: {
			items: {
				radarr: [
					{
						raw: { synthetic: true },
						errors: ["Synthetic invalid upstream row"],
						integration: "radarr",
						category: "movies",
						timestamp: "2026-10-25T12:00:00Z",
					},
				],
			},
			totalCount: 1,
		},
	};
	refused = false;
	saved = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/api/system/settings")
			return json({ success: true, data: settings });
		if (method === "GET" && url === "/api/system/info")
			return json({
				success: true,
				data: {
					version: "synthetic",
					database: { type: "sqlite", host: null },
					runtime: { nodeVersion: "synthetic", platform: "synthetic", uptime: 125 },
				},
			});
		if (method === "GET" && url === "/api/system/logs")
			return json({ success: true, data: { directory: "synthetic", files: [] } });
		if (method === "GET" && url === "/api/system/validation-health") return json(health);
		if (method === "GET" && url === "/api/system/validation-quarantine") return json(quarantine);
		if (method === "GET" && url === "/api/system/security-posture") {
			const posture: SecurityPostureResponse = {
				success: true,
				data: {
					overall: "healthy",
					checks: [
						{
							id: "synthetic",
							label: "Synthetic posture",
							detail: saved ? "Synthetic posture refreshed" : "Synthetic posture initial",
							severity: "healthy",
						},
					],
					effective: {
						nodeEnv: "test",
						trustProxy: false,
						secureCookies: false,
						sessionTtlHours: 24,
						sessionCookieName: "synthetic_session",
						passwordPolicy: "strict",
						appUrl: "http://synthetic.invalid",
					},
					auth: {
						passwordEnabled: true,
						passwordUserCount: 1,
						oidcEnabled: false,
						oidcProviderEnabled: false,
						passkeyCount: 0,
					},
					capturedAt: "2026-10-25T12:00:00Z",
				},
			};
			return json(posture);
		}
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic system action refused" }, 503);
		if (method === "PUT" && url === "/api/system/settings") {
			settings = { ...settings, ...(body as object) };
			saved = true;
			return json({ success: true, data: settings, message: "Synthetic settings saved" });
		}
		if (method === "POST" && url === "/api/system/restart")
			return json({ success: true, message: "Synthetic restart requested" }, 202);
		if (method === "DELETE" && url === "/api/system/validation-health") {
			health = {
				success: true,
				data: {
					integrations: {},
					overallTotals: { total: 0, validated: 0, rejected: 0 },
					validationModes: { radarr: "strict" },
					resetAt: "2026-10-25T12:30:00Z",
					fingerprints: {},
				},
			};
			return json(health);
		}
		if (method === "DELETE" && url === "/api/system/validation-quarantine") {
			quarantine = { success: true, data: { items: {}, totalCount: 0 } };
			return json({ success: true });
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
describe("S6 maintained System transport", () => {
	it("validates before PUT, preserves refused draft, reads settings/posture and emits restart POST only after confirmation", async () => {
		const view = show(<SystemTab />);
		const api = await screen.findByRole("spinbutton", { name: "API Port" });
		await screen.findByText("Synthetic posture initial");
		fireEvent.change(api, { target: { value: "0" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText("API Port must be between 1 and 65535");
		expect(writes()).toEqual([]);
		fireEvent.change(api, { target: { value: "3201" } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText("Synthetic system action refused");
		await settled();
		expect(api).toHaveValue(3201);
		refused = false;
		gate = hold();
		const save = screen.getByRole("button", { name: "Save Changes" });
		fireEvent.click(save);
		await waitFor(() => expect(writes()).toHaveLength(2));
		await waitFor(() => expect(save).toBeDisabled());
		fireEvent.click(save);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Synthetic settings saved");
		await screen.findByText("Synthetic posture refreshed");
		await settled();
		expect(writes()[1]).toEqual({
			url: "/api/system/settings",
			method: "PUT",
			body: {
				apiPort: 3201,
				webPort: 3000,
				listenAddress: "0.0.0.0",
				externalUrl: null,
				trustProxy: false,
				secureCookies: null,
			},
		});
		expect(
			requests.filter((r) => r.url === "/api/system/settings" && r.method === "GET").length,
		).toBeGreaterThan(1);
		view.unmount();
		show(<SystemTab />);
		await waitFor(() =>
			expect(screen.getByRole("spinbutton", { name: "API Port" })).toHaveValue(3201),
		);
		fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
		expect(writes()).toHaveLength(2);
		vi.mocked(confirm).mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
		await screen.findByText("Synthetic restart requested");
		await settled();
		expect(writes()[2]).toEqual({ url: "/api/system/restart", method: "POST", body: {} });
	});
	it("keeps failed health/quarantine clears actionable and explicit retries perform DELETE then current GET readback", async () => {
		show(<SystemTab />);
		const reset = await screen.findByRole("button", { name: "Reset Stats" });
		refused = true;
		fireEvent.click(reset);
		await screen.findByText("Synthetic system action refused");
		await settled();
		expect(reset).toBeEnabled();
		expect(writes()).toHaveLength(1);
		refused = false;
		fireEvent.click(reset);
		await screen.findByText("Validation health stats reset");
		await settled();
		await waitFor(() => expect(reset).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: /Quarantine/ }));
		const clear = screen.getByRole("button", { name: "Clear All" });
		refused = true;
		fireEvent.click(clear);
		await screen.findByText("Failed to clear quarantine: Synthetic system action refused");
		await settled();
		expect(
			screen.queryByText("No quarantined items — all validated data passed successfully."),
		).not.toBeInTheDocument();
		refused = false;
		fireEvent.click(clear);
		await screen.findByText("Quarantine cleared");
		await screen.findByText("No quarantined items — all validated data passed successfully.");
		await settled();
		expect(writes()).toEqual([
			{ url: "/api/system/validation-health", method: "DELETE", body: null },
			{ url: "/api/system/validation-health", method: "DELETE", body: null },
			{ url: "/api/system/validation-quarantine", method: "DELETE", body: null },
			{ url: "/api/system/validation-quarantine", method: "DELETE", body: null },
		]);
		expect(
			requests.filter((r) => r.url === "/api/system/validation-health" && r.method === "GET")
				.length,
		).toBeGreaterThan(1);
		expect(
			requests.filter((r) => r.url === "/api/system/validation-quarantine" && r.method === "GET")
				.length,
		).toBeGreaterThan(1);
	});
});
