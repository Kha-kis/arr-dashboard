import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoTagRule, CleanupFieldOptionsResponse, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
			join(process.env.V4_EVIDENCE_ROOT, "auto-tag-rule-requests.json"),
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
	service("source-a", "Synthetic A", "radarr"),
	service("source-b", "Synthetic B", "radarr"),
];
const fieldOptions: CleanupFieldOptionsResponse = {
	videoCodecs: [],
	audioCodecs: [],
	resolutions: [],
	hdrTypes: [],
	releaseGroups: [],
	tautulliUsers: [],
	plexUsers: [],
	plexLibraries: [],
	plexCollections: [],
	plexLabels: [],
	jellyfinUsers: [],
	jellyfinLibraries: [],
	arrTags: [],
	hasPlex: false,
	hasTautulli: false,
	hasJellyfin: false,
};
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
let rules: AutoTagRule[];
let refused: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	rules = [];
	refused = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/api/auto-tag/rules") return json({ rules });
		if (method === "GET" && url === "/api/services") return json({ services });
		if (method === "GET" && url === "/api/library-cleanup/field-options") return json(fieldOptions);
		if (method === "GET" && url === "/api/auto-tag/webhook-config")
			return json({ secret: null, configured: false, freshlyGenerated: false });
		if (method === "GET" && url === "/api/auto-tag/webhook/install/status")
			return json({ instances: [] });
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic rule save refused" }, 503);
		if (method === "POST" && url === "/api/auto-tag/rules") {
			rules = [{ ...baseRule, ...(body as object) }];
			return json({ rule: rules[0] }, 201);
		}
		if (method === "PATCH" && url === "/api/auto-tag/rules/rule-b") {
			rules = [{ ...rules[0]!, ...(body as object) }];
			return json({ rule: rules[0] });
		}
		if (method === "DELETE" && url === "/api/auto-tag/rules/rule-b") {
			rules = [];
			return json(null, 204);
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
async function fill() {
	fireEvent.click(await screen.findByRole("button", { name: "New Rule" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), {
		target: { value: "Synthetic rule" },
	});
	fireEvent.change(screen.getByRole("textbox", { name: "Tag to apply" }), {
		target: { value: "family" },
	});
	fireEvent.change(screen.getByRole("textbox", { name: "Genres (comma-separated)" }), {
		target: { value: "Family, Adventure" },
	});
	fireEvent.click(await screen.findByRole("button", { name: "Synthetic B (radarr)" }));
}
const createBody = {
	name: "Synthetic rule",
	enabled: true,
	tagName: "family",
	ruleType: "genre",
	parameters: { operator: "includes_any", genres: ["Family", "Adventure"] },
	operator: null,
	conditions: null,
	instanceFilter: ["source-b"],
};
describe("A1 maintained Auto-Tag CRUD transport", () => {
	it("serializes chosen criterion and scope, reads created/edited rule, cancels deletion then deletes only B", async () => {
		show(<AutoTagClient />);
		await fill();
		gate = hold();
		const create = screen.getByRole("button", { name: "Create rule" });
		fireEvent.click(create);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(create).toBeDisabled());
		fireEvent.click(create);
		expect(writes()).toEqual([{ url: "/api/auto-tag/rules", method: "POST", body: createBody }]);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Synthetic rule");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		fireEvent.click(screen.getByTitle("Edit rule"));
		expect(screen.getByRole("textbox", { name: "Genres (comma-separated)" })).toHaveValue(
			"Family, Adventure",
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), {
			target: { value: "Synthetic edited" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Synthetic edited");
		await settled();
		expect(writes()[1]).toEqual({
			url: "/api/auto-tag/rules/rule-b",
			method: "PATCH",
			body: { ...createBody, name: "Synthetic edited" },
		});
		fireEvent.click(screen.getByTitle("Delete rule"));
		expect(writes()).toHaveLength(2);
		vi.mocked(confirm).mockReturnValue(true);
		fireEvent.click(screen.getByTitle("Delete rule"));
		await screen.findByText("No auto-tag rules yet");
		expect(writes()[2]).toEqual({
			url: "/api/auto-tag/rules/rule-b",
			method: "DELETE",
			body: null,
		});
		expect(
			requests.filter((r) => r.url === "/api/auto-tag/rules" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("retains refused create dialog, selected input and error until an explicit successful resubmission", async () => {
		refused = true;
		show(<AutoTagClient />);
		await fill();
		fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
		await screen.findByText("Synthetic rule save refused");
		await settled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("Synthetic rule");
		expect(screen.getByRole("textbox", { name: "Genres (comma-separated)" })).toHaveValue(
			"Family, Adventure",
		);
		expect(writes()).toEqual([{ url: "/api/auto-tag/rules", method: "POST", body: createBody }]);
		refused = false;
		fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
		await screen.findByText("Synthetic rule");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(writes()).toHaveLength(2);
	});
});
