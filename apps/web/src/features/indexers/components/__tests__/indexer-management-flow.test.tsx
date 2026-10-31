import type { ProwlarrIndexer, ProwlarrIndexerDetails, ServicesResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { IndexersClient } from "../indexers-client";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: () => {} }),
	usePathname: () => "/indexers",
}));
const stamp = "2026-10-01T12:00:00Z";
const privateDetail = "synthetic-private-indexer-diagnostic";
const indexer = (instanceId: string): ProwlarrIndexer => ({
	id: 7,
	name: "Synthetic same indexer",
	instanceId,
	instanceName: instanceId,
	enable: true,
	protocol: "torrent",
	supportsRss: true,
	supportsSearch: true,
	supportsRedirect: false,
	appProfileId: 1,
	priority: 10,
	tags: [],
	capabilities: [],
});
const services: ServicesResponse = {
	services: ["north", "south"].map((id) => ({
		id,
		service: "prowlarr",
		label: id,
		baseUrl: `https://${id}.invalid`,
		externalUrl: null,
		enabled: true,
		isDefault: id === "north",
		hasApiKey: true,
		hasHttpAuth: false,
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
		createdAt: stamp,
		updatedAt: stamp,
		tags: [],
	})),
};
const detail = (instanceId: string): ProwlarrIndexerDetails => ({
	...indexer(instanceId),
	fields: [{ name: "host", label: "Host", type: "textbox", value: "old.synthetic.invalid" }],
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clients: QueryClient[] = [];
const violations: string[] = [];
function fixture(
	update: () => Response | Promise<Response> = () => json({ status: "outcome-unknown" }, 202),
) {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const saved = new Map([
		["north", detail("north")],
		["south", detail("south")],
	]);
	let updateReply = update;
	let testReply = () => json({ success: true });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET",
			url = new URL(path, "http://synthetic.invalid");
		calls.push({
			method,
			path: url.pathname,
			...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
		});
		if (method === "GET" && url.pathname === "/api/services") return json(services);
		if (method === "GET" && url.pathname === "/api/search/indexers") {
			const rows = [...saved.values()];
			return json({
				instances: rows.map((row) => ({
					instanceId: row.instanceId,
					instanceName: row.instanceName,
					success: true,
					data: [row],
				})),
				aggregated: rows,
				totalCount: 2,
				failedInstanceCount: 0,
			});
		}
		if (method === "GET" && /^\/api\/search\/indexers\/(north|south)\/7$/.test(url.pathname))
			return json({ indexer: saved.get(url.pathname.split("/")[4]!) });
		if (method === "PUT" && url.pathname === "/api/search/indexers/south/7") {
			expect(init.credentials).toBe("include");
			expect(new Headers(init.headers).get("content-type")).toBe("application/json");
			return updateReply();
		}
		if (method === "POST" && url.pathname === "/api/search/indexers/test") return testReply();
		violations.push(`${method} ${path}`);
		throw Error("Unexpected synthetic API operation");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false, gcTime: Infinity },
		},
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<IndexersClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		calls,
		saved,
		client,
		reply: (value: typeof update) => {
			updateReply = value;
		},
		test: (value: typeof testReply) => {
			testReply = value;
		},
	};
}
function southCard() {
	return screen.getByRole("heading", { name: "south" }).closest("article")!;
}
async function edit() {
	await screen.findByRole("heading", { name: "south" });
	fireEvent.click(
		within(southCard() as HTMLElement).getByRole("button", { name: /Synthetic same indexer/ }),
	);
	fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
	fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Host" }), {
		target: { value: "new.synthetic.invalid" },
	});
}
const writes = (view: ReturnType<typeof fixture>) =>
	view.calls.filter((call) => call.method !== "GET");
async function finished(view: ReturnType<typeof fixture>, count: number) {
	await waitFor(() => {
		expect(writes(view)).toHaveLength(count);
		expect(view.client.isMutating()).toBe(0);
		expect(view.client.isFetching()).toBe(0);
	});
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("maintained indexer management flow", () => {
	// Catches a lost instance coordinate, overposting a full client resource, or claiming success before readback.
	it("saves changed fields only on the chosen same-ID source and shows verified readback", async () => {
		const view = fixture(() => {
			const updated = {
				...detail("south"),
				priority: 30,
				fields: [{ name: "host", label: "Host", type: "textbox", value: "new.synthetic.invalid" }],
			};
			view.saved.set("south", updated);
			return json({ status: "verified", indexer: updated });
		});
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await finished(view, 1);
		expect(writes(view)).toEqual([
			{
				method: "PUT",
				path: "/api/search/indexers/south/7",
				body: {
					changes: { priority: 30, fields: [{ name: "host", value: "new.synthetic.invalid" }] },
				},
			},
		]);
		expect(await screen.findByText("Indexer changes saved and verified")).toBeInTheDocument();
		expect(screen.getByText("new.synthetic.invalid")).toBeInTheDocument();
		expect(view.saved.get("north")).toEqual(detail("north"));
	});
	it.each(["applied-unverified", "outcome-unknown"] as const)(
		"keeps %s honest and requires a separate explicit save after reading current state",
		async (status) => {
			const view = fixture(() => json({ status }, 202));
			await edit();
			fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
			await finished(view, 1);
			expect(screen.queryByText("Indexer changes saved and verified")).not.toBeInTheDocument();
			expect(
				screen.getByText(
					status === "outcome-unknown"
						? "Update outcome is unknown. Check Prowlarr before retrying."
						: "Update sent, but verification is unavailable. Check Prowlarr before retrying.",
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Refresh details"));
			await finished(view, 1);
			expect(writes(view)).toHaveLength(1);
			view.reply(() => {
				const updated = { ...detail("south"), priority: 30 };
				view.saved.set("south", updated);
				return json({ status: "verified", indexer: updated });
			});
			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
			fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
			await finished(view, 2);
			expect(await screen.findByText("Indexer changes saved and verified")).toBeInTheDocument();
		},
	);
	it("holds Save while pending and retains the form after a definite failed update", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(() => held);
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		try {
			await waitFor(() => expect(writes(view)).toHaveLength(1));
			expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
		} finally {
			await act(async () => release(json({ message: "Synthetic update refused" }, 409)));
		}
		await finished(view, 1);
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
		expect(screen.getByRole("textbox", { name: "Host" })).toHaveValue("new.synthetic.invalid");
		expect(screen.queryByText("Indexer changes saved and verified")).not.toBeInTheDocument();
	});
	// Existing indexer-test-outcomes tests cover the full result matrix. This adds
	// the missing management/readback isolation: Test never performs a config PUT.
	it("a separate fixture Test failure then explicit recovery never writes configuration", async () => {
		const view = fixture();
		view.test(() => json({ success: false, message: privateDetail }));
		await screen.findByRole("heading", { name: "south" });
		fireEvent.click(within(southCard() as HTMLElement).getByRole("button", { name: "Test" }));
		await finished(view, 1);
		expect(
			screen.getByText("Indexer test failed. Check Prowlarr before retrying."),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain(privateDetail);
		view.test(() => json({ success: true }));
		fireEvent.click(within(southCard() as HTMLElement).getByRole("button", { name: "Test" }));
		await finished(view, 2);
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		expect(writes(view)).toEqual([
			{
				method: "POST",
				path: "/api/search/indexers/test",
				body: { instanceId: "south", indexerId: 7 },
			},
			{
				method: "POST",
				path: "/api/search/indexers/test",
				body: { instanceId: "south", indexerId: 7 },
			},
		]);
	});
});
