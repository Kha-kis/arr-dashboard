import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoTagPreviewResponse, AutoTagRule } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AutoTagClient } from "../auto-tag-client";

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
			join(process.env.V4_EVIDENCE_ROOT, "auto-tag-execution-requests.json"),
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
const baseRule: AutoTagRule = {
	id: "rule-b",
	userId: "owner",
	name: "Synthetic rule",
	enabled: true,
	ruleType: "genre",
	parameters: { operator: "includes_any", genres: ["Family", "Adventure"] },
	operator: null,
	conditions: null,
	serviceFilter: null,
	instanceFilter: ["source-b"],
	excludeTags: null,
	excludeTitles: null,
	plexLibraryFilter: null,
	tagName: "family",
	lastRunAt: null,
	lastRunStatus: null,
	lastRunMessage: null,
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
};

const preview: AutoTagPreviewResponse = {
	itemsScanned: 2,
	itemsMatched: 1,
	itemsUnknown: 1,
	truncated: false,
	items: [
		{
			instanceId: "source-b",
			arrItemId: 101,
			itemType: "movie",
			title: "Synthetic positive",
			state: "true",
			reason: "Synthetic positive criterion",
		},
		{
			instanceId: "source-b",
			arrItemId: 102,
			itemType: "movie",
			title: "Synthetic unresolved",
			state: "unknown",
			reason: "Synthetic evidence unavailable; not a negative match",
		},
	],
};
let rules: AutoTagRule[];
let previewFailed: boolean;
let conflict: boolean;
let resultStatus: "partial" | "failed" | "success";
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	rules = [
		{ ...baseRule, id: "rule-a", name: "Synthetic other", instanceFilter: ["source-a"] },
		{ ...baseRule, name: "Synthetic chosen" },
	];
	previewFailed = false;
	conflict = false;
	resultStatus = "partial";
	gate = null;
	respond = async ({ url, method }) => {
		if (method === "GET" && url === "/api/auto-tag/rules") return json({ rules });
		if (method === "GET" && url === "/api/auto-tag/webhook-config")
			return json({ secret: null, configured: false, freshlyGenerated: false });
		if (method === "GET" && url === "/api/auto-tag/webhook/install/status")
			return json({ instances: [] });
		if (method === "GET" && url === "/api/auto-tag/rules/rule-b/preview")
			return json(
				previewFailed ? { error: "Synthetic preview unavailable" } : preview,
				previewFailed ? 503 : 200,
			);
		if (method === "POST" && url === "/api/auto-tag/rules/rule-b/run") {
			if (gate) await gate.promise;
			if (conflict) return json({ error: "Synthetic rule changed; reload before running" }, 409);
			rules = [
				rules[0]!,
				{
					...rules[1]!,
					lastRunAt: "2026-10-25T12:30:00Z",
					lastRunStatus: resultStatus,
					lastRunMessage: "Synthetic run outcome; unresolved items retained",
				},
			];
			return json({ rule: rules[1] });
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
function chosen() {
	return within(screen.getByText("Synthetic chosen").closest("tr")!);
}
describe("A2 maintained Auto-Tag preview and run transport", () => {
	it("uses GET-only preview, shows unknown separately and never sends preview coordinates as command authority", async () => {
		show(<AutoTagClient />);
		await screen.findByText("Synthetic chosen");
		fireEvent.click(chosen().getByTitle("Preview rule"));
		await screen.findByText("Synthetic unresolved");
		expect(within(screen.getByRole("dialog")).getAllByText("Unknown")).toHaveLength(2);
		expect(
			screen.getByText("Synthetic evidence unavailable; not a negative match"),
		).toBeInTheDocument();
		expect(
			requests.some((r) => r.url === "/api/auto-tag/rules/rule-b/preview" && r.method === "GET"),
		).toBe(true);
		fireEvent.click(
			within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]!,
		);
		expect(writes()).toEqual([]);
	});
	it("reports failed preview and actual explicit reopen recovers through GET without a Run", async () => {
		previewFailed = true;
		show(<AutoTagClient />);
		await screen.findByText("Synthetic chosen");
		fireEvent.click(chosen().getByTitle("Preview rule"));
		expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic preview unavailable");
		fireEvent.click(
			within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]!,
		);
		previewFailed = false;
		fireEvent.click(chosen().getByTitle("Preview rule"));
		await screen.findByText("Synthetic unresolved");
		expect(writes()).toEqual([]);
		expect(requests.filter((r) => r.url === "/api/auto-tag/rules/rule-b/preview")).toHaveLength(2);
	});
	it.each(["partial", "failed"] as const)(
		"holds chosen run once and exposes returned %s with actual last-run GET",
		async (status) => {
			resultStatus = status;
			show(<AutoTagClient />);
			await screen.findByText("Synthetic chosen");
			gate = hold();
			const run = chosen().getByTitle("Run rule now");
			fireEvent.click(run);
			await waitFor(() => expect(writes()).toHaveLength(1));
			expect(run).toBeDisabled();
			fireEvent.click(run);
			expect(writes()).toEqual([
				{ url: "/api/auto-tag/rules/rule-b/run", method: "POST", body: {} },
			]);
			await act(async () => {
				gate!.release();
			});
			await settled();
			await screen.findByText("Synthetic run outcome; unresolved items retained");
			expect(chosen().getByText(status)).toBeInTheDocument();
			expect(alerts).toEqual([
				`${status.toUpperCase()}\n\nSynthetic run outcome; unresolved items retained`,
			]);
			expect(
				requests.filter((r) => r.url === "/api/auto-tag/rules" && r.method === "GET").length,
			).toBeGreaterThan(1);
			expect(writes()).toHaveLength(1);
		},
	);
	it("reports 409 without automatic resend and later explicit run succeeds with fresh last-run readback", async () => {
		conflict = true;
		show(<AutoTagClient />);
		await screen.findByText("Synthetic chosen");
		fireEvent.click(chosen().getByTitle("Run rule now"));
		await settled();
		expect(alerts).toEqual(["Run failed: Synthetic rule changed; reload before running"]);
		expect(writes()).toHaveLength(1);
		conflict = false;
		resultStatus = "success";
		fireEvent.click(chosen().getByTitle("Run rule now"));
		await settled();
		await screen.findByText("Synthetic run outcome; unresolved items retained");
		expect(chosen().getByText("success")).toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: "/api/auto-tag/rules/rule-b/run", method: "POST", body: {} },
			{ url: "/api/auto-tag/rules/rule-b/run", method: "POST", body: {} },
		]);
	});
});
