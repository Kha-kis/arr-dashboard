import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabelSyncRule, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LabelSyncClient } from "../label-sync-client";

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
			join(process.env.V4_EVIDENCE_ROOT, "label-sync-rule-requests.json"),
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
const service = (
	id: string,
	label: string,
	kind: ServiceInstanceSummary["service"],
): ServiceInstanceSummary => ({
	id,
	label,
	service: kind,
	baseUrl: "http://synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "verified",
		kind: "synthetic",
		fingerprint: "synthetic",
		verifiedAt: "2026-10-25T12:00:00Z",
		lastCheckedAt: "2026-10-25T12:00:00Z",
	},
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
	tags: [],
});

const services = [
	service("source-a", "Synthetic source A", "sonarr"),
	service("source-b", "Synthetic source B", "radarr"),
	service("dest-a", "Synthetic destination A", "plex"),
	service("dest-b", "Synthetic destination B", "plex"),
];
const baseRule: LabelSyncRule = {
	id: "label-b",
	userId: "owner",
	name: "Synthetic label rule",
	enabled: true,
	sourceService: "radarr",
	sourceInstanceId: "source-b",
	sourceTagName: "family",
	destService: "plex",
	destInstanceId: "dest-b",
	destTagName: "Family",
	destinationMutationCapability: { supported: true },
	recovery: {
		availability: "known",
		state: "clear",
		heldCount: 0,
		reconciledCount: 0,
		lastCheckAt: null,
	},
	lastRunAt: null,
	lastRunStatus: null,
	lastRunMessage: null,
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
};
let rules: LabelSyncRule[];
let saveRefused: boolean;
let runRefused: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	rules = [];
	saveRefused = false;
	runRefused = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/api/services") return json({ services });
		if (method === "GET" && url === "/api/label-sync/rules") return json({ rules });
		if (gate) await gate.promise;
		if (method === "POST" && url === "/api/label-sync/rules/label-b/run") {
			if (runRefused) return json({ error: "Synthetic mapping changed" }, 409);
			rules = [
				{
					...rules[0]!,
					lastRunAt: "2026-10-25T12:30:00Z",
					lastRunStatus: "partial",
					lastRunMessage: "Synthetic returned partial outcome",
					recovery: {
						availability: "known",
						state: "restored-held",
						heldCount: 2,
						reconciledCount: 0,
						lastCheckAt: null,
					},
				},
			];
			return json({ rule: rules[0] });
		}
		if (saveRefused) return json({ error: "Synthetic label save refused" }, 503);
		if (method === "POST" && url === "/api/label-sync/rules") {
			rules = [{ ...baseRule, ...(body as object) }];
			return json({ rule: rules[0] }, 201);
		}
		if (method === "PATCH" && url === "/api/label-sync/rules/label-b") {
			rules = [{ ...rules[0]!, ...(body as object) }];
			return json({ rule: rules[0] });
		}
		if (method === "DELETE" && url === "/api/label-sync/rules/label-b") {
			rules = [];
			return json(null, 204);
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
const payload = {
	name: "Synthetic label rule",
	enabled: true,
	sourceService: "radarr",
	sourceInstanceId: "source-b",
	sourceTagName: "family",
	destService: "plex",
	destInstanceId: "dest-b",
	destTagName: "Family",
};
describe("L1 maintained Label Sync lifecycle transport", () => {
	it("retains refused source/destination draft, creates and edits exact mapping with readback, cancels then confirms delete", async () => {
		show(<LabelSyncClient />);
		fireEvent.click(await screen.findByRole("button", { name: "New Rule" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), {
			target: { value: "Synthetic label rule" },
		});
		await screen.findByRole("option", { name: "Synthetic destination B" });
		fireEvent.change(screen.getByRole("combobox", { name: "Source service" }), {
			target: { value: "radarr" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "Source instance" }), {
			target: { value: "source-b" },
		});
		fireEvent.change(screen.getByRole("textbox", { name: "Source tag name" }), {
			target: { value: "family" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "Destination instance" }), {
			target: { value: "dest-b" },
		});
		fireEvent.change(screen.getByRole("textbox", { name: "Destination tag/label" }), {
			target: { value: "Family" },
		});
		gate = hold();
		saveRefused = true;
		const create = screen.getByRole("button", { name: "Create rule" });
		fireEvent.click(create);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(create).toBeDisabled());
		fireEvent.click(create);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Synthetic label save refused");
		await settled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Source instance" })).toHaveValue("source-b");
		expect(screen.getByRole("combobox", { name: "Destination instance" })).toHaveValue("dest-b");
		expect(screen.getByRole("textbox", { name: "Destination tag/label" })).toHaveValue("Family");
		expect(writes()).toEqual([{ url: "/api/label-sync/rules", method: "POST", body: payload }]);
		saveRefused = false;
		fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
		await screen.findByText("Synthetic label rule");
		await settled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
		expect(screen.getByRole("combobox", { name: "Source instance" })).toHaveValue("source-b");
		expect(screen.getByRole("combobox", { name: "Destination instance" })).toHaveValue("dest-b");
		fireEvent.change(screen.getByRole("textbox", { name: "Destination tag/label" }), {
			target: { value: "Family edited" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Family edited");
		await settled();
		expect(writes()[2]).toEqual({
			url: "/api/label-sync/rules/label-b",
			method: "PATCH",
			body: { ...payload, destTagName: "Family edited" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
		expect(writes()).toHaveLength(3);
		vi.mocked(confirm).mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
		await screen.findByText("No label-sync rules yet");
		expect(writes()[3]).toEqual({
			url: "/api/label-sync/rules/label-b",
			method: "DELETE",
			body: null,
		});
		expect(
			requests.filter((r) => r.url === "/api/label-sync/rules" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("reads back the current rule after execution could not be recorded and does not resend", async () => {
		rules = [structuredClone(baseRule)];
		const originalRespond = respond;
		const runUrl = "/api/label-sync/rules/label-b/run";
		respond = async (request) => {
			if (request.method === "POST" && request.url === runUrl) {
				rules = [{ ...rules[0]!, name: "Synthetic revised mapping" }];
				return json(
					{
						error: "Synthetic execution finished but could not be saved",
						code: "label_sync_rule_changed",
						execution: { status: "partial", totals: { attempted: 2, succeeded: 1 } },
					},
					409,
				);
			}
			return originalRespond(request);
		};
		show(<LabelSyncClient />);
		fireEvent.click(await screen.findByRole("button", { name: "Run rule now" }));
		await settled();
		expect(alerts).toEqual([
			"Label Sync execution finished, but its result could not be saved because the rule changed or was deleted. Review the current rule and destination before running again.",
		]);
		await screen.findByText("Synthetic revised mapping");
		const attempt = requests.findIndex(({ url, method }) => url === runUrl && method === "POST");
		expect(attempt).toBeGreaterThanOrEqual(0);
		expect(requests.slice(attempt)).toEqual([
			{ url: runUrl, method: "POST", body: {} },
			{ url: "/api/label-sync/rules", method: "GET", body: null },
		]);
	});

	it("reports refused Run without hidden retry then explicit run returns honest partial and held recovery readback", async () => {
		rules = [structuredClone(baseRule)];
		runRefused = true;
		show(<LabelSyncClient />);
		fireEvent.click(await screen.findByRole("button", { name: "Run rule now" }));
		await settled();
		expect(alerts).toEqual(["Run failed: Synthetic mapping changed"]);
		expect(writes()).toEqual([
			{ url: "/api/label-sync/rules/label-b/run", method: "POST", body: {} },
		]);
		runRefused = false;
		fireEvent.click(screen.getByRole("button", { name: "Run rule now" }));
		await settled();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/2.*held/i));
		expect(screen.getByText("Last run: partial")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit rule" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Delete rule" })).toBeDisabled();
		expect(alerts[1]).toContain("Run outcome: PARTIAL");
		expect(alerts[1]).toContain("Synthetic returned partial outcome");
		expect(alerts[1]).toContain("no automatic resend");
		expect(writes()).toEqual([
			{ url: "/api/label-sync/rules/label-b/run", method: "POST", body: {} },
			{ url: "/api/label-sync/rules/label-b/run", method: "POST", body: {} },
		]);
		expect(
			requests.filter((r) => r.url === "/api/label-sync/rules" && r.method === "GET").length,
		).toBeGreaterThan(1);
	});
});
