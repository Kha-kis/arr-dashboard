import type {
	CurrentUser,
	ProwlarrIndexer,
	SearchIndexersResponse,
	ServicesResponse,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../../../../components/auth/auth-gate";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
	subscribeProtectedUnauthorized,
} from "../../../../lib/auth-session-signal";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { IndexersClient } from "../indexers-client";

const routerPush = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: routerPush }));
vi.mock("next/navigation", () => ({
	usePathname: () => "/indexers",
	useRouter: () => router,
}));

const privateDetail = "synthetic-private-indexer-provider-diagnostic";
const currentUser: CurrentUser = {
	id: "synthetic-user",
	username: "synthetic-admin",
	mustChangePassword: false,
	createdAt: "2026-10-01T12:00:00Z",
	hasTmdbApiKey: false,
	hasPassword: true,
};
const indexers: ProwlarrIndexer[] = [
	{
		id: 7,
		name: "Selected Alpha",
		enable: true,
		protocol: "torrent",
		supportsRss: true,
		supportsSearch: true,
		supportsRedirect: false,
		appProfileId: 1,
		priority: 10,
		tags: [1],
		capabilities: ["search", "tv-search"],
		instanceId: "synthetic-north",
		instanceName: "Synthetic North",
		instanceUrl: "https://north.example.invalid",
		health: {
			successRate: 1,
			averageResponseTime: 100,
			grabs: 2,
			fails: 0,
			lastCheck: "2026-10-06T12:00:00Z",
			lastFailure: "2026-10-01T12:00:00Z",
		},
	},
	{
		id: 8,
		name: "Selected Beta",
		enable: true,
		protocol: "torrent",
		supportsRss: true,
		supportsSearch: true,
		supportsRedirect: false,
		appProfileId: 1,
		priority: 20,
		tags: [1],
		capabilities: ["search", "tv-search"],
		instanceId: "synthetic-north",
		instanceName: "Synthetic North",
		instanceUrl: "https://north.example.invalid",
		health: {
			successRate: 0.5,
			averageResponseTime: 200,
			grabs: 1,
			fails: 1,
			lastCheck: "2026-10-06T12:00:00Z",
			lastFailure: "2026-10-06T11:00:00Z",
		},
	},
	{
		id: 9,
		name: "Selected Disabled",
		enable: false,
		protocol: "torrent",
		supportsRss: true,
		supportsSearch: true,
		supportsRedirect: false,
		appProfileId: 1,
		priority: 30,
		tags: [1],
		capabilities: ["search"],
		instanceId: "synthetic-north",
		instanceName: "Synthetic North",
		instanceUrl: "https://north.example.invalid",
		health: {
			successRate: 0,
			averageResponseTime: 300,
			grabs: 0,
			fails: 1,
			lastCheck: "2026-10-06T12:00:00Z",
			lastFailure: "2026-10-06T11:00:00Z",
		},
	},
	{
		id: 10,
		name: "Other Usenet",
		enable: true,
		protocol: "usenet",
		supportsRss: false,
		supportsSearch: true,
		supportsRedirect: false,
		appProfileId: 1,
		priority: 40,
		tags: [2],
		capabilities: ["search"],
		instanceId: "synthetic-north",
		instanceName: "Synthetic North",
		instanceUrl: "https://north.example.invalid",
		health: {
			successRate: 1,
			averageResponseTime: 400,
			grabs: 1,
			fails: 0,
			lastCheck: "2026-10-06T12:00:00Z",
			lastFailure: "2026-10-01T12:00:00Z",
		},
	},
	{
		id: 7,
		name: "Selected Alpha",
		enable: true,
		protocol: "torrent",
		supportsRss: true,
		supportsSearch: true,
		supportsRedirect: false,
		appProfileId: 1,
		priority: 10,
		tags: [1],
		capabilities: ["search", "tv-search"],
		instanceId: "synthetic-south",
		instanceName: "Synthetic South",
		instanceUrl: "https://south.example.invalid",
		health: {
			successRate: 1,
			averageResponseTime: 100,
			grabs: 1,
			fails: 0,
			lastCheck: "2026-10-06T12:00:00Z",
			lastFailure: "2026-10-01T12:00:00Z",
		},
	},
];
const list: SearchIndexersResponse = {
	instances: [
		{
			instanceId: "synthetic-north",
			instanceName: "Synthetic North",
			success: true,
			data: indexers.slice(0, 4),
		},
		{
			instanceId: "synthetic-south",
			instanceName: "Synthetic South",
			success: true,
			data: indexers.slice(4),
		},
	],
	aggregated: indexers,
	totalCount: 5,
	failedInstanceCount: 0,
};
const services: ServicesResponse = {
	services: [
		{
			id: "synthetic-north",
			service: "prowlarr",
			label: "Synthetic North",
			baseUrl: "https://north.example.invalid",
			externalUrl: null,
			enabled: true,
			isDefault: true,
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
			createdAt: "2026-10-01T12:00:00Z",
			updatedAt: "2026-10-06T12:00:00Z",
			tags: [],
		},
		{
			id: "synthetic-south",
			service: "prowlarr",
			label: "Synthetic South",
			baseUrl: "https://south.example.invalid",
			externalUrl: null,
			enabled: true,
			isDefault: false,
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
			createdAt: "2026-10-01T12:00:00Z",
			updatedAt: "2026-10-06T12:00:00Z",
			tags: [],
		},
	],
};

type Target = { instanceId: string; indexerId: number };
const clients: QueryClient[] = [];
const violations: string[] = [];
const renderErrors: string[] = [];
const subscriptions: (() => void)[] = [];

class IndexerTestBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(error: Error) {
		renderErrors.push(error.message);
	}
	override render() {
		return this.state.failed ? (
			<p role="alert">Synthetic indexer renderer boundary.</p>
		) : (
			this.props.children
		);
	}
}
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function fixture(
	reply: (target: Target) => Response | Promise<Response>,
	authRecheck?: () => Response | Promise<Response>,
	strictMode = false,
) {
	const posts: Target[] = [];
	const reads: string[] = [];
	const authReads: string[] = [];
	const signalRevisions: number[] = [];
	let allowance = 0;
	let currentReply = reply;
	if (authRecheck) {
		subscriptions.push(
			subscribeProtectedUnauthorized(() => {
				const revision = getPendingUnauthorizedRevision();
				if (revision !== 0) signalRevisions.push(revision);
			}),
		);
	}
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		if (
			authRecheck &&
			method === "GET" &&
			init.body === undefined &&
			(path === "/auth/setup-required" || path === "/auth/me")
		) {
			expect(init.credentials).toBe("include");
			authReads.push(path);
			if (path === "/auth/setup-required") return json({ required: false });
			return authReads.filter((read) => read === "/auth/me").length === 1
				? json({ user: currentUser })
				: authRecheck();
		}
		if (method === "GET" && init.body === undefined && path === "/api/services") {
			reads.push(path);
			return json(services);
		}
		if (method === "GET" && init.body === undefined && path === "/api/search/indexers") {
			reads.push(path);
			return json(list);
		}
		if (method === "POST" && path === "/api/search/indexers/test" && allowance > 0) {
			allowance--;
			const target: Target = JSON.parse(String(init.body));
			if (
				Object.keys(target).sort().join(",") === "indexerId,instanceId" &&
				indexers.some(
					(indexer) => indexer.instanceId === target.instanceId && indexer.id === target.indexerId,
				)
			) {
				expect(init.credentials).toBe("include");
				expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
				posts.push(target);
				return currentReply(target);
			}
		}
		violations.push(`${method} ${path}`);
		throw new Error("Out-of-scope synthetic request");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity },
			mutations: { gcTime: Infinity },
		},
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<IndexerTestBoundary>
						{authRecheck ? (
							<AuthGate>
								<IndexersClient />
							</AuthGate>
						) : (
							<IndexersClient />
						)}
					</IndexerTestBoundary>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
		strictMode ? { wrapper: StrictMode } : undefined,
	);
	return {
		client,
		posts,
		reads,
		authReads,
		signalRevisions,
		click(button: HTMLElement, count = 1) {
			allowance += count;
			fireEvent.click(button);
		},
		replaceReply(next: typeof reply) {
			currentReply = next;
		},
	};
}
type Fixture = ReturnType<typeof fixture>;
async function ready(view: Fixture) {
	await screen.findByRole("heading", { name: "Synthetic South" });
	await waitFor(() => expect(view.client.getQueryState(["services"])?.fetchStatus).toBe("idle"));
	expect(view.reads.sort()).toEqual(["/api/search/indexers", "/api/services"]);
	expect(view.posts).toEqual([]);
	if (view.authReads.length > 0) {
		await waitFor(() =>
			expect(view.client.getQueryData(authKeys.currentUser)).toEqual(currentUser),
		);
		expect(view.authReads).toEqual(["/auth/setup-required", "/auth/me"]);
	}
}
function testButton(instance = "Synthetic South", name = "Selected Alpha") {
	const card = screen.getByRole("heading", { name: instance }).closest("article");
	if (!card) throw new Error("Synthetic instance card missing");
	const row = within(card).getByText(name).closest('[role="button"]');
	if (!(row instanceof HTMLElement)) throw new Error("Synthetic indexer row missing");
	return within(row).getByRole("button", { name: "Test" });
}
async function finished(view: Fixture, count = 1) {
	await waitFor(() => {
		expect(view.posts).toHaveLength(count);
		expect(view.client.isMutating()).toBe(0);
		expect(screen.getByRole("button", { name: "Test All" })).toBeEnabled();
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function expectNoPrivateEvidence(view: Fixture) {
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
	for (const mutation of view.client.getMutationCache().getAll()) {
		expect.soft(JSON.stringify(mutation.state.data) ?? "").not.toContain(privateDetail);
		const error = mutation.state.error;
		if (error instanceof Error) {
			expect.soft(error.message).not.toContain(privateDetail);
			expect.soft(error.cause).toBeUndefined();
			expect.soft(error).not.toHaveProperty("payload");
			expect.soft(error).not.toHaveProperty("response");
			expect.soft(JSON.stringify(error)).not.toContain(privateDetail);
		}
	}
}
function expectNegativeFeedback() {
	expect.soft(screen.queryByText(/indexer test passed/i)).not.toBeInTheDocument();
	expect
		.soft(
			screen.queryByText(
				/test (?:failed|failure)|(?:could not|couldn't|unable to) (?:confirm|verify|test)/i,
			),
		)
		.toBeInTheDocument();
}
afterEach(() => {
	cleanup();
	if (vi.isFakeTimers()) {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
	for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	routerPush.mockReset();
	localStorage.clear();
	expect(renderErrors.splice(0)).toEqual([]);
	expect(violations.splice(0)).toEqual([]);
});

describe("Indexer feedback lifetime", () => {
	it.each([
		["successful response", { success: true }, 200],
		["negative response", { success: false }, 200],
		["failed response", { message: privateDetail }, 500],
	] as const)(
		"does not create a feedback timer for a late %s after unmount",
		async (_name, body, status) => {
			let finishReply!: (response: Response) => void;
			const reply = new Promise<Response>((resolve) => {
				finishReply = resolve;
			});
			const view = fixture(() => reply);
			await ready(view);
			view.click(testButton());
			await waitFor(() => expect(view.posts).toHaveLength(1));
			expect(view.client.isMutating()).toBe(1);
			cleanup();
			vi.useFakeTimers();
			await act(async () => {
				finishReply(json(body, status));
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(view.client.isMutating()).toBe(0);
			expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
			expect(vi.getTimerCount()).toBe(0);
			expect(screen.queryByRole("button", { name: "Test All" })).not.toBeInTheDocument();
		},
	);

	it("keeps mounted success feedback visible for five seconds after StrictMode effect remount", async () => {
		const view = fixture(() => json({ success: true }), undefined, true);
		await ready(view);
		vi.useFakeTimers();
		await act(async () => {
			view.click(testButton());
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		await act(async () => vi.advanceTimersByTimeAsync(4999));
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(screen.queryByText("Indexer test passed")).not.toBeInTheDocument();
		expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
	});
});

describe("Indexer Test HTTP 401 through the real AuthGate", () => {
	function unauthorized() {
		const response = json({ message: privateDetail, details: { provider: privateDetail } }, 401);
		const readBody = vi.spyOn(response, "json");
		return { response, readBody };
	}
	async function rejectedTest(view: Fixture) {
		await waitFor(() => {
			expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
			expect(view.client.isMutating()).toBe(0);
		});
		const mutations = view.client.getMutationCache().getAll();
		expect(mutations).toHaveLength(1);
		expect(mutations[0]?.state.status).toBe("error");
		expect(mutations[0]?.state.data).toBeUndefined();
		expect(mutations[0]?.state.error?.message).toBe(
			"Unable to confirm indexer test. Check Prowlarr before retrying.",
		);
		expect(view.signalRevisions).toHaveLength(1);
		expect(view.signalRevisions[0]).toBeGreaterThan(0);
		expectNoPrivateEvidence(view);
	}
	function expectProtectedControlsHidden() {
		expect(screen.queryByRole("heading", { name: "Synthetic South" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Test All" })).not.toBeInTheDocument();
		expect(screen.queryAllByRole("button", { name: "Test" })).toHaveLength(0);
	}

	it("hides controls during one session recheck and redirects only on confirmed sign-out, without replay", async () => {
		let finishRecheck!: (response: Response) => void;
		const recheck = new Promise<Response>((resolve) => {
			finishRecheck = resolve;
		});
		const failure = unauthorized();
		const view = fixture(
			() => failure.response,
			() => recheck,
		);
		await ready(view);
		view.click(testButton());
		await waitFor(() => expect(view.authReads).toHaveLength(3));
		await rejectedTest(view);
		expectProtectedControlsHidden();
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
		expect(routerPush).not.toHaveBeenCalled();
		expect(failure.readBody).not.toHaveBeenCalled();
		await act(async () => finishRecheck(new Response(null, { status: 401 })));
		await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login?redirectTo=%2Findexers"));
		expect(routerPush).toHaveBeenCalledTimes(1);
		expect(view.client.getQueryData(authKeys.currentUser)).toBeNull();
		expect(view.client.getQueryData(["services"])).toBeUndefined();
		expect(view.client.getQueryData(["search", "indexers"])).toBeUndefined();
		expect(view.authReads).toEqual(["/auth/setup-required", "/auth/me", "/auth/me"]);
		expect(getPendingUnauthorizedRevision()).toBe(0);
		expectProtectedControlsHidden();
		await rejectedTest(view);
		expect(view.reads.sort()).toEqual(["/api/search/indexers", "/api/services"]);
		expect(failure.readBody).not.toHaveBeenCalled();
		expect(failure.response.bodyUsed).toBe(false);
	});

	it.each(["still-valid session", "unavailable auth recheck"] as const)(
		"keeps a %s hidden until explicit page recovery, and requires a separate Test click",
		async (mode) => {
			let finishRetry!: (response: Response) => void;
			const retry = new Promise<Response>((resolve) => {
				finishRetry = resolve;
			});
			let rechecks = 0;
			const failure = unauthorized();
			const view = fixture(
				() => failure.response,
				() => {
					rechecks++;
					if (rechecks !== 1) return retry;
					if (mode === "unavailable auth recheck") throw new Error(privateDetail);
					return json({ user: currentUser });
				},
			);
			await ready(view);
			view.click(testButton());
			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent(
				"This page could not be loaded safely. Your data is hidden until you retry.",
			);
			await rejectedTest(view);
			expectProtectedControlsHidden();
			expect(routerPush).not.toHaveBeenCalled();
			expect(view.authReads).toEqual(["/auth/setup-required", "/auth/me", "/auth/me"]);
			expect(getPendingUnauthorizedRevision()).toBe(0);
			expect(failure.readBody).not.toHaveBeenCalled();

			fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
			await waitFor(() => expect(view.authReads).toHaveLength(4));
			expectProtectedControlsHidden();
			expect(view.reads.sort()).toEqual(["/api/search/indexers", "/api/services"]);
			await rejectedTest(view);
			await act(async () => finishRetry(json({ user: currentUser })));
			await screen.findByRole("heading", { name: "Synthetic South" });
			await waitFor(() =>
				expect(view.reads.sort()).toEqual([
					"/api/search/indexers",
					"/api/search/indexers",
					"/api/services",
					"/api/services",
				]),
			);
			expect(view.authReads).toEqual(["/auth/setup-required", "/auth/me", "/auth/me", "/auth/me"]);
			expect(view.client.getQueryData(authKeys.currentUser)).toEqual(currentUser);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(routerPush).not.toHaveBeenCalled();
			await rejectedTest(view);
			expect(screen.queryByText("Indexer test passed")).not.toBeInTheDocument();

			view.replaceReply(() => json({ success: true }));
			view.click(testButton());
			await finished(view, 2);
			expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
			expect(view.posts).toEqual([
				{ instanceId: "synthetic-south", indexerId: 7 },
				{ instanceId: "synthetic-south", indexerId: 7 },
			]);
			expect(view.client.getMutationCache().getAll()).toHaveLength(2);
			expectNoPrivateEvidence(view);
			expect(failure.readBody).not.toHaveBeenCalled();
			expect(failure.response.bodyUsed).toBe(false);
		},
	);
});

describe("Indexer Test response outcomes through real mounted client and transport", () => {
	// Catches treating HTTP fulfillment as provider success, independently of message presence.
	it.each([
		["absent message", { success: false }],
		["private provider message", { success: false, message: privateDetail }],
	] as const)(
		"does not report HTTP 200 success:false as an individual pass (%s)",
		async (_name, body) => {
			const view = fixture(() => json(body));
			await ready(view);
			view.click(testButton());
			await finished(view);
			expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
			expectNegativeFeedback();
			expect
				.soft(view.client.getMutationCache().getAll()[0]?.state.data)
				.toHaveProperty("success", false);
			expectNoPrivateEvidence(view);
		},
	);
	it.each([
		["absent message", { success: true }],
		["present string message", { success: true, message: "Indexer test passed" }],
	] as const)("control: explicit success:true remains a pass (%s)", async (_name, body) => {
		const view = fixture(() => json(body));
		await ready(view);
		view.click(testButton());
		await finished(view);
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
	});
	// Same-title/same-ID targets in two instances catch a lost instance coordinate.
	it("control: Test All uses only currently filtered enabled targets and full instance:indexer coordinates", async () => {
		const view = fixture(() => json({ success: true }));
		await ready(view);
		fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
		fireEvent.change(screen.getByRole("combobox", { name: "Protocol" }), {
			target: { value: "torrent" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "Instance" }), {
			target: { value: "synthetic-north" },
		});
		view.click(screen.getByRole("button", { name: "Test All" }), 2);
		await finished(view, 2);
		expect(screen.getByText("All 2 indexers passed")).toBeInTheDocument();
		expect(view.posts).toEqual([
			{ instanceId: "synthetic-north", indexerId: 7 },
			{ instanceId: "synthetic-north", indexerId: 8 },
		]);
	});
	it("counts only explicit success:true in mixed Test All outcomes", async () => {
		const view = fixture((target) => {
			if (target.instanceId === "synthetic-south") throw new Error(privateDetail);
			return json(
				target.indexerId === 7 ? { success: true } : { success: false, message: privateDetail },
			);
		});
		await ready(view);
		fireEvent.change(screen.getByPlaceholderText("Search indexers..."), {
			target: { value: "Selected" },
		});
		view.click(screen.getByRole("button", { name: "Test All" }), 3);
		await finished(view, 3);
		expect(view.posts).toEqual([
			{ instanceId: "synthetic-north", indexerId: 7 },
			{ instanceId: "synthetic-south", indexerId: 7 },
			{ instanceId: "synthetic-north", indexerId: 8 },
		]);
		expect
			.soft(
				screen.queryByText(/1 passed, 2 (?:failed|not passed|test failures) out of 3 indexers/i),
			)
			.toBeInTheDocument();
		expect.soft(screen.queryByText("2 passed, 1 failed out of 3 indexers")).not.toBeInTheDocument();
		expectNoPrivateEvidence(view);
	});
	// Catches admitting nonboolean envelopes into fulfilled mutation state before the UI consumes them.
	it.each([
		["null", null],
		["missing success", { message: privateDetail }],
		["string success", { success: "false", message: privateDetail }],
	] as const)(
		"rejects malformed HTTP 200 %s without pass or private evidence",
		async (_name, body) => {
			const view = fixture(() => json(body));
			await ready(view);
			view.click(testButton());
			await finished(view);
			expectNegativeFeedback();
			const state = view.client.getMutationCache().getAll()[0]?.state;
			expect.soft(state?.status).toBe("error");
			expect.soft(state?.data).toBeUndefined();
			expectNoPrivateEvidence(view);
		},
	);
	it.each([
		[
			"HTTP diagnostic",
			() => json({ message: privateDetail, details: { provider: privateDetail } }, 500),
		],
		[
			"network diagnostic",
			() => {
				throw new Error(privateDetail);
			},
		],
		[
			"unreadable JSON",
			() => new Response(`{${privateDetail}`, { headers: { "Content-Type": "application/json" } }),
		],
	] as const)(
		"keeps %s private in individual feedback and mutation cache",
		async (_name, reply) => {
			const view = fixture(reply);
			await ready(view);
			view.click(testButton());
			await finished(view);
			expectNegativeFeedback();
			expect.soft(view.client.getMutationCache().getAll()[0]?.state.status).toBe("error");
			expectNoPrivateEvidence(view);
		},
	);
	it("discards diagnostic message and extra fields from a valid positive outcome even after incognito changes", async () => {
		const view = fixture(() =>
			json({ success: true, message: privateDetail, provider: { diagnostic: privateDetail } }),
		);
		await ready(view);
		view.click(testButton());
		await finished(view);
		expect.soft(screen.queryByText("Indexer test passed")).toBeInTheDocument();
		expectNoPrivateEvidence(view);
		act(() => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expectNoPrivateEvidence(view);
	});
	it("control: a later explicit Test click recovers a rejected request without automatic mutation replay", async () => {
		const view = fixture(() => json({ message: "Indexer test failed" }, 500));
		await ready(view);
		view.click(testButton());
		await finished(view);
		expect(
			screen.getByText(
				/test (?:failed|failure)|(?:could not|couldn't|unable to) (?:confirm|verify|test)/i,
			),
		).toBeInTheDocument();
		expect(view.posts).toEqual([{ instanceId: "synthetic-south", indexerId: 7 }]);
		view.replaceReply(() => json({ success: true }));
		view.click(testButton());
		await finished(view, 2);
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		expect(
			screen.queryByText(
				/test (?:failed|failure)|(?:could not|couldn't|unable to) (?:confirm|verify|test)/i,
			),
		).not.toBeInTheDocument();
		expect(view.posts).toEqual([
			{ instanceId: "synthetic-south", indexerId: 7 },
			{ instanceId: "synthetic-south", indexerId: 7 },
		]);
	});
	it("a later explicit Test can recover success:false after its negative outcome is shown", async () => {
		const view = fixture(() => json({ success: false }));
		await ready(view);
		view.click(testButton());
		await finished(view);
		// Guard: later recovery is not exercised until the current false-success defect is repaired.
		expect(screen.queryByText("Indexer test passed")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				/test (?:failed|failure)|(?:could not|couldn't|unable to) (?:confirm|verify|test)/i,
			),
		).toBeInTheDocument();
		view.replaceReply(() => json({ success: true }));
		view.click(testButton());
		await finished(view, 2);
		expect(screen.getByText("Indexer test passed")).toBeInTheDocument();
		expect(view.posts).toEqual([
			{ instanceId: "synthetic-south", indexerId: 7 },
			{ instanceId: "synthetic-south", indexerId: 7 },
		]);
	});
});
