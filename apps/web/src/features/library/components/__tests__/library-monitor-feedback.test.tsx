import type { LibraryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";

const notice = "Monitoring update not confirmed";
const guidance = "Reload Library to check the current state before trying again.";
const privateError = "provider-error-sentinel https://private.invalid/instance-id";
const initial: LibraryItem = {
	id: 41,
	instanceId: "radarr-feedback-owned",
	instanceName: "private-instance-sentinel",
	service: "radarr",
	type: "movie",
	title: "private-media-title-sentinel",
	monitored: false,
};
type Failure = 409 | 503 | 401 | "rejected-fetch" | "lost-response";
let item: LibraryItem, client: QueryClient, reads: number;
let peer: LibraryItem | undefined;
let extraItems: LibraryItem[], pages: LibraryItem[][] | undefined;
let mutations: { path: string; body: unknown }[];
let held: {
	settled: boolean;
	resolve: (response: Response) => void;
	reject: (reason: Error) => void;
}[];
const release = (response: Response) => held.at(-1)!.resolve(response);
const reject = (reason: Error) => held.at(-1)!.reject(reason);
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
	localStorage.clear();
	toast.dismiss();
	item = structuredClone(initial);
	peer = undefined;
	extraItems = [];
	pages = undefined;
	reads = 0;
	mutations = [];
	held = [];
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	// Only fetch responses are synthetic. LibraryClient, card, query hooks, API wrapper,
	// providers and the production Toaster are real; no toast or mutation method is mocked.
	vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
		const url = new URL(input, "http://synthetic.invalid"),
			path = url.pathname;
		if (options?.method === "POST") {
			if (path !== "/api/library/monitor") throw Error(`Unexpected mutation: ${path}`);
			mutations.push({ path, body: JSON.parse(String(options.body)) });
			return new Promise<Response>((resolve, rejectResponse) => {
				const pending = {
					settled: false,
					resolve: (response: Response) => {
						pending.settled = true;
						resolve(response);
					},
					reject: (reason: Error) => {
						pending.settled = true;
						rejectResponse(reason);
					},
				};
				held.push(pending);
			});
		}
		if (path === "/api/services") {
			const entries = pages?.flat() ?? [item, ...(peer ? [peer] : []), ...extraItems];
			return json({
				services: [
					...new Map(
						entries.map((entry) => [
							entry.instanceId,
							{ id: entry.instanceId, service: entry.service, enabled: true },
						]),
					).values(),
				],
			});
		}
		if (path === "/api/library") {
			reads++;
			const page = Number(url.searchParams.get("page") ?? 1);
			const items = structuredClone(
				pages?.[page - 1] ?? [item, ...(peer ? [peer] : []), ...extraItems],
			);
			return json({
				items,
				pagination: {
					page,
					limit: 50,
					totalItems: pages ? pages.length * 50 : items.length,
					totalPages: pages?.length ?? 1,
				},
				syncStatus: { isCached: true, syncInProgress: false, totalCachedItems: items.length },
			});
		}
		if (path === "/api/library/sync/status") return json({ instances: [] });
		if (path === "/api/plex/identity") return json({ servers: [] });
		if (path === "/api/jellyfin/identity") return json([]);
		if (path === "/api/qui/tracker-icons") return json({ trackers: {} });
		if (path === "/api/qui/library-seeding-summary")
			return json({ status: "not-configured", summaries: {} });
		if (path.startsWith("/api/library/insights/")) return json({ data: { items: [] } });
		if (path.endsWith("/watch-enrichment")) return json({ configured: false, items: {} });
		if (path.endsWith("/series-progress")) return json({ configured: false, progress: {} });
		throw Error(`Unexpected fixture request: ${path}`);
	});
});
afterEach(async () => {
	await drainHeld();
	await waitFor(() => expect(client.isMutating()).toBe(0));
	toast.dismiss();
	cleanup();
	await client.cancelQueries();
	client.clear();
	vi.unstubAllGlobals();
});
async function drainHeld() {
	await act(async () => {
		for (const pending of held)
			if (!pending.settled) pending.resolve(new Response(null, { status: 204 }));
	});
	await waitFor(() => expect(client.isMutating()).toBe(0));
}
async function mount(incognito = false) {
	if (incognito) localStorage.setItem("arr-dashboard-incognito-mode", "true");
	render(
		<QueryClientProvider client={client}>
			<SearchParamsContext.Provider value={new URLSearchParams()}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LibraryClient />
						<Toaster duration={Infinity} />
					</IncognitoProvider>
				</ColorThemeProvider>
			</SearchParamsContext.Provider>
		</QueryClientProvider>,
	);
	return (await screen.findAllByRole("button", { name: /^Monitor$/ }))[0];
}
async function clickHeld() {
	const button = screen.getByRole("button", { name: /^Monitor$/ });
	fireEvent.click(button);
	await waitFor(() => expect(mutations).toHaveLength(1));
	expect(button).toBeDisabled();
	expect(screen.queryByText(notice)).not.toBeInTheDocument();
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(mutations[0]).toEqual({
		path: "/api/library/monitor",
		body: { instanceId: "radarr-feedback-owned", service: "radarr", itemId: 41, monitored: true },
	});
}
async function fail(kind: Failure) {
	await act(async () => {
		if (typeof kind === "number") release(json({ error: privateError }, kind));
		else reject(new Error(privateError));
	});
	await waitFor(() =>
		expect(client.getMutationCache().getAll().at(-1)?.state.status).toBe("error"),
	);
}
async function assertNotice() {
	expect(await screen.findByText(notice)).toBeVisible();
	expect(screen.getByText(guidance)).toBeVisible();
	const toaster = document.querySelector("[data-sonner-toaster]") as HTMLElement;
	expect(within(toaster).getByText(notice)).toBeVisible();
	expect(toaster.textContent).not.toMatch(
		/private-media-title-sentinel|private-instance-sentinel|provider-error-sentinel|private.invalid|radarr-feedback-owned/,
	);
	expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
}
describe("Library card monitoring failure feedback", () => {
	it.each(["A-first", "B-first"] as const)(
		"keeps A's error notice when overlapping B succeeds, settling %s",
		async (order) => {
			peer = { ...initial, id: 42, title: "private-peer-title-sentinel" };
			await mount();
			const before = reads;
			const buttons = screen.getAllByRole("button", { name: /^Monitor$/ });
			expect(buttons).toHaveLength(2);
			fireEvent.click(buttons[0]!);
			await waitFor(() => expect(held).toHaveLength(1));
			expect(buttons[0]).toBeDisabled();
			expect(buttons[1]).toBeEnabled();
			fireEvent.click(buttons[1]!);
			await waitFor(() => expect(held).toHaveLength(2));
			expect(buttons[1]).toBeDisabled();
			expect(screen.queryByText(notice)).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /^Unmonitor$/ })).not.toBeInTheDocument();
			expect(reads).toBe(before);
			for (const index of order === "A-first" ? [0, 1] : [1, 0]) {
				await act(async () => {
					if (index === 0) held[0]!.resolve(json({ error: privateError }, 503));
					else {
						peer = { ...peer!, monitored: true };
						held[1]!.resolve(new Response(null, { status: 204 }));
					}
				});
				await waitFor(() =>
					expect(client.getMutationCache().getAll()[index]!.state.status).toBe(
						index === 0 ? "error" : "success",
					),
				);
			}
			await assertNotice();
			expect(screen.getAllByText(notice)).toHaveLength(1);
			expect(await screen.findByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
			expect(screen.getByRole("button", { name: /^Monitor$/ })).toBeEnabled();
			expect(item.monitored).toBe(false);
			expect(reads).toBeGreaterThan(before);
			expect(mutations).toEqual(
				[41, 42].map((itemId) => ({
					path: "/api/library/monitor",
					body: { instanceId: initial.instanceId, service: "radarr", itemId, monitored: true },
				})),
			);
		},
	);
	it("handles both overlapping rejections with one notice per action and no replay", async () => {
		peer = { ...initial, id: 42, title: "private-peer-title-sentinel" };
		await mount();
		const before = reads;
		const buttons = screen.getAllByRole("button", { name: /^Monitor$/ });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[0]!);
		await waitFor(() => expect(held).toHaveLength(1));
		fireEvent.click(buttons[1]!);
		await waitFor(() => expect(held).toHaveLength(2));
		expect(screen.queryByText(notice)).not.toBeInTheDocument();
		await act(async () => {
			held[0]!.reject(new Error(privateError));
			held[1]!.reject(new Error(privateError));
		});
		await waitFor(() => expect(client.isMutating()).toBe(0));
		await waitFor(() => expect(screen.getAllByText(notice)).toHaveLength(2));
		expect(screen.getAllByText(guidance)).toHaveLength(2);
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
		expect(screen.queryByRole("button", { name: /^Unmonitor$/ })).not.toBeInTheDocument();
		expect(mutations).toEqual(
			[41, 42].map((itemId) => ({
				path: "/api/library/monitor",
				body: { instanceId: initial.instanceId, service: "radarr", itemId, monitored: true },
			})),
		);
		expect(reads).toBeGreaterThan(before);
		expect(item.monitored).toBe(false);
		expect(peer.monitored).toBe(false);
	});
	it.each([409, 503, 401, "rejected-fetch", "lost-response"] as const)(
		"shows generic actionable uncertainty after %s without replay or cache success",
		async (kind) => {
			await mount();
			const before = reads;
			await clickHeld();
			expect(reads).toBe(before);
			await fail(kind);
			await assertNotice();
			expect(screen.getByRole("button", { name: /^Monitor$/ })).toBeEnabled();
			expect(screen.queryByRole("button", { name: /^Unmonitor$/ })).not.toBeInTheDocument();
			expect(mutations).toHaveLength(1);
			expect(reads).toBeGreaterThan(before);
			expect(item.monitored).toBe(false);
		},
	);
	it("keeps private provider diagnostics out of the real notice in incognito mode", async () => {
		await mount(true);
		await clickHeld();
		await fail(503);
		await assertNotice();
		expect(screen.queryByText(initial.title)).not.toBeInTheDocument();
	});
	it("explicit rendered retry sends one additional request and recovers by successful invalidation/readback", async () => {
		await mount();
		await clickHeld();
		await fail(409);
		await assertNotice();
		const before = reads;
		fireEvent.click(screen.getByRole("button", { name: /^Monitor$/ }));
		await waitFor(() => expect(mutations).toHaveLength(2));
		expect(screen.getByRole("button", { name: /^Monitor$/ })).toBeDisabled();
		await act(async () => {
			item = { ...item, monitored: true };
			release(new Response(null, { status: 204 }));
		});
		expect(await screen.findByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		expect(reads).toBeGreaterThan(before);
		expect(mutations).toHaveLength(2);
		expect(mutations[1]).toEqual(mutations[0]);
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
	});
	it("successful monitoring keeps existing readback and produces no new failure or success toast", async () => {
		await mount();
		const before = reads;
		await clickHeld();
		await act(async () => {
			item = { ...item, monitored: true };
			release(new Response(null, { status: 204 }));
		});
		expect(await screen.findByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		expect(reads).toBeGreaterThan(before);
		expect(screen.queryByText(notice)).not.toBeInTheDocument();
		expect(document.querySelector("[data-sonner-toast]")).toBeNull();
		expect(mutations).toHaveLength(1);
	});
	it("rejects malformed200 without optimistic success and reconciles by settled GET", async () => {
		await mount();
		const before = reads;
		await clickHeld();
		await act(async () => {
			release(
				new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
			);
		});
		await waitFor(() =>
			expect(client.getMutationCache().getAll().at(-1)?.state.status).toBe("error"),
		);
		expect(reads).toBeGreaterThan(before);
		await assertNotice();
		expect(screen.getByRole("button", { name: /^Monitor$/ })).toBeEnabled();
		expect(mutations).toHaveLength(1);
	});
});

const monitorButtons = () => screen.getAllByRole("button", { name: /^(Monitor|Unmonitor)$/ });
// Narrow private React DOM prop seam: invoke the REAL card event closure twice
// before a render can disable the DOM button. No handler/hook/query/toast mocks.
function activation(button: HTMLElement): () => void {
	const key = Object.keys(button).find((name) => name.startsWith("__reactProps$"));
	if (!key) throw Error("Pinned React event-prop seam unavailable");
	return ((button as unknown as Record<string, unknown>)[key] as { onClick: () => void }).onClick;
}
async function start(index: number, count: number) {
	fireEvent.click(monitorButtons()[index]!);
	await waitFor(() => expect(held).toHaveLength(count));
}
async function settle(index: number, outcome: "success" | "error") {
	await act(async () => {
		if (outcome === "success") {
			if (index === 0) item = { ...item, monitored: true };
			else peer = { ...peer!, monitored: true };
		}
		held[index]!.resolve(
			outcome === "success"
				? new Response(null, { status: 204 })
				: json({ error: privateError }, 503),
		);
	});
	await waitFor(() =>
		expect(client.getMutationCache().getAll()[index]!.state.status).toBe(
			outcome === "success" ? "success" : "error",
		),
	);
}
function expectTargets(
	expected: { instanceId: string; service: LibraryItem["service"]; itemId: number | string }[],
) {
	expect(mutations).toEqual(
		expected.map((target) => ({
			path: "/api/library/monitor",
			body: { ...target, monitored: true },
		})),
	);
}
describe("Library card exact pending identity", () => {
	it.each([
		{ first: 0, outcome: "error" as const },
		{ first: 1, outcome: "success" as const },
		{ first: 0, outcome: "success" as const },
		{ first: 1, outcome: "error" as const },
	])("retains every running target when $first settles $outcome", async ({ first, outcome }) => {
		peer = { ...initial, id: 42, title: "private-peer-title-sentinel" };
		await mount();
		try {
			await start(0, 1);
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeEnabled();
			await start(1, 2);
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeDisabled();
			expect(screen.queryByText(notice)).not.toBeInTheDocument();
			expect(reads).toBe(1);
			await settle(first, outcome);
			await waitFor(() => expect(monitorButtons()[first]).toBeEnabled());
			expect(monitorButtons()[1 - first]).toBeDisabled();
			expect(mutations).toHaveLength(2);
			await settle(1 - first, outcome === "error" ? "success" : "error");
			await waitFor(() => monitorButtons().forEach((button) => expect(button).toBeEnabled()));
			await assertNotice();
			expect(screen.getAllByText(notice)).toHaveLength(1);
			expectTargets([
				{ instanceId: initial.instanceId, service: "radarr", itemId: 41 },
				{ instanceId: initial.instanceId, service: "radarr", itemId: 42 },
			]);
		} finally {
			await drainHeld();
		}
	});
	it("keeps same-service/id cards on distinct instances independent and preserves both errors", async () => {
		peer = {
			...initial,
			id: "41",
			instanceId: "radarr-other-instance",
			title: "private-peer-title-sentinel",
		};
		await mount();
		try {
			await start(0, 1);
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeEnabled();
			await start(1, 2);
			monitorButtons().forEach((button) => expect(button).toBeDisabled());
			await settle(1, "error");
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeEnabled();
			await settle(0, "error");
			await waitFor(() => expect(screen.getAllByText(notice)).toHaveLength(2));
			expectTargets([
				{ instanceId: initial.instanceId, service: "radarr", itemId: 41 },
				{ instanceId: "radarr-other-instance", service: "radarr", itemId: "41" },
			]);
		} finally {
			await drainHeld();
		}
	});
	it("guards same-tick same-target admission before React disables the real card", async () => {
		await mount();
		try {
			const activate = activation(monitorButtons()[0]!);
			await act(async () => {
				activate();
				activate();
			});
			await waitFor(() => expect(held).toHaveLength(1));
			expect(monitorButtons()[0]).toBeDisabled();
			expectTargets([{ instanceId: initial.instanceId, service: "radarr", itemId: 41 }]);
			await settle(0, "error");
			await assertNotice();
			expect(screen.getAllByText(notice)).toHaveLength(1);
		} finally {
			await drainHeld();
		}
	});
	it("retains normalized target admission across settled-read invalidation and fresh item objects", async () => {
		peer = { ...initial, id: 42, title: "private-peer-title-sentinel" };
		await mount();
		try {
			await start(0, 1);
			await start(1, 2);
			item = { ...item, id: "41" };
			peer = { ...peer, id: "42" };
			await act(async () => {
				await client.invalidateQueries({ queryKey: ["library"] });
			});
			expect(reads).toBeGreaterThan(1);
			monitorButtons().forEach((button) => expect(button).toBeDisabled());
			await act(async () => activation(monitorButtons()[0]!)());
			expect(mutations).toHaveLength(2);
			await settle(1, "success");
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeEnabled();
			await settle(0, "error");
			await assertNotice();
			expect(mutations).toHaveLength(2);
		} finally {
			await drainHeld();
		}
	});
	it("keeps a running target pending after paging away, starting another target and returning", async () => {
		peer = { ...initial, id: 42, title: "private-peer-title-sentinel" };
		pages = [[item], [peer]];
		await mount();
		try {
			await start(0, 1);
			fireEvent.click(screen.getAllByTitle("Next page")[0]!);
			await screen.findByText(peer.title);
			expect(monitorButtons()[0]).toBeEnabled();
			await start(0, 2);
			fireEvent.click(screen.getAllByTitle("Previous page")[0]!);
			await screen.findByText(item.title);
			expect(monitorButtons()[0]).toBeDisabled();
			await settle(1, "error");
			expect(monitorButtons()[0]).toBeDisabled();
			await settle(0, "error");
			await waitFor(() => expect(screen.getAllByText(notice)).toHaveLength(2));
			expect(mutations).toHaveLength(2);
		} finally {
			await drainHeld();
		}
	});
	it.each([
		{ service: "sonarr", type: "series" },
		{ service: "lidarr", type: "artist" },
		{ service: "readarr", type: "author" },
	] as const)(
		"honors the pending predicate in homogeneous $service cards",
		async ({ service, type }) => {
			item = { ...initial, service, type, instanceId: `${service}-owned` };
			peer = { ...item, id: 42, title: "private-peer-title-sentinel" };
			await mount();
			try {
				await start(0, 1);
				expect(monitorButtons()[1]).toBeEnabled();
				await start(1, 2);
				monitorButtons().forEach((button) => expect(button).toBeDisabled());
				await settle(1, "success");
				expect(monitorButtons()[0]).toBeDisabled();
				await settle(0, "error");
				await assertNotice();
				expectTargets([
					{ instanceId: `${service}-owned`, service, itemId: 41 },
					{ instanceId: `${service}-owned`, service, itemId: 42 },
				]);
			} finally {
				await drainHeld();
			}
		},
	);
	it("honors the pending predicate in the mixed four-service card branch", async () => {
		peer = {
			...initial,
			service: "sonarr",
			type: "series",
			instanceId: "sonarr-owned",
			title: "private-peer-title-sentinel",
		};
		extraItems = [
			{ ...initial, service: "lidarr", type: "artist", instanceId: "lidarr-owned" },
			{ ...initial, service: "readarr", type: "author", instanceId: "readarr-owned" },
		];
		await mount();
		try {
			await start(0, 1);
			await start(1, 2);
			expect(monitorButtons()).toHaveLength(4);
			expect(monitorButtons()[0]).toBeDisabled();
			expect(monitorButtons()[1]).toBeDisabled();
			expect(monitorButtons()[2]).toBeEnabled();
			expect(monitorButtons()[3]).toBeEnabled();
			await settle(0, "error");
			expect(monitorButtons()[1]).toBeDisabled();
			await settle(1, "success");
			await assertNotice();
			expectTargets([
				{ instanceId: initial.instanceId, service: "radarr", itemId: 41 },
				{ instanceId: "sonarr-owned", service: "sonarr", itemId: 41 },
			]);
		} finally {
			await drainHeld();
		}
	});
});
