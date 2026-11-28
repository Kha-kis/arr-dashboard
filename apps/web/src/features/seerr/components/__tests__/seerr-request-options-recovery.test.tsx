import type { SeerrRequest, SeerrServerWithDetails } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
// The actual protected-route graph is compiled in the web project too. Load
// its API declarations before the direct Fastify import so module augmentation
// uses one context type; these erased imports execute no infrastructure/jobs.
import type {} from "../../../../../../api/src/types/fastify";
import type {} from "../../../../../../api/src/bootstrap/infrastructure";
import type {} from "../../../../../../api/src/bootstrap/schedulers";
import type {} from "../../../../../../api/src/lib/backup/backup-mutation-gate";
import type {} from "../../../../../../api/node_modules/@fastify/rate-limit";
import Fastify, {
	type FastifyRequest,
} from "../../../../../../api/node_modules/fastify/fastify.js";
import { registerProtectedRoutes } from "../../../../../../api/src/bootstrap/protected-routes";
import type {
	ArrClientFactory,
	ClientInstanceData,
} from "../../../../../../api/src/lib/arr/client-factory";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxSavePath, getLinuxServerName, getLinuxUsername } from "../../../../lib/incognito";
import { seerrKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DiscoverRequestDialog } from "../../../discover/components/discover-request-dialog";
import { ApproveWithOptionsDialog } from "../approve-with-options-dialog";

vi.mock("../../../../../../api/src/routes/route-manifest", async () => ({
	PROTECTED_ROUTE_GROUPS: [
		{
			prefix: "/api/seerr",
			register: (await import("../../../../../../api/src/routes/seerr/index")).registerSeerrRoutes,
		},
	],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const instance = {
	id: "owned",
	userId: "owner",
	service: "SEERR" as const,
	enabled: true,
	baseUrl: "http://synthetic.invalid",
	encryptedApiKey: "synthetic-unused",
	encryptionIv: "synthetic-unused",
};
const user = {
	id: 5,
	displayName: "Synthetic user",
	createdAt: "synthetic",
	updatedAt: "synthetic",
	permissions: 1,
	requestCount: 0,
	userType: 1,
};
const server = (id: number, is4k = false) => ({
	id,
	name: `Synthetic server ${id}`,
	is4k,
	isDefault: id === 1,
	activeProfileId: id + 10,
	activeDirectory: `/synthetic/${id}`,
	activeTags: [],
});
const details = (id: number, is4k = false): SeerrServerWithDetails => ({
	server: server(id, is4k),
	profiles: [
		{ id: id + 10, name: `Synthetic profile ${id}` },
		{ id: id + 20, name: `Alternate profile ${id}` },
	],
	rootFolders: [
		{ id: id + 100, path: `/synthetic/${id}` },
		{ id: id + 200, path: `/alternate/${id}` },
	],
	tags: [{ id: id + 30, label: `Synthetic tag ${id}` }],
	languageProfiles: null,
});
const requestFixture = (extra: Partial<SeerrRequest> = {}): SeerrRequest => ({
	id: 42,
	status: 1,
	type: "movie",
	is4k: false,
	media: { id: 8, tmdbId: 7, status: 1, createdAt: "synthetic", updatedAt: "synthetic" },
	createdAt: "synthetic",
	updatedAt: "synthetic",
	requestedBy: user,
	...extra,
});
const tv = {
	id: 7,
	name: "Synthetic series",
	genres: [],
	credits: { cast: [], crew: [] },
	keywords: [],
	seasons: [{ id: 1, seasonNumber: 1, name: "Synthetic season 1", episodeCount: 3 }],
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
type TransportOptions = NonNullable<Parameters<ArrClientFactory["rawRequest"]>[2]>;
type DialogKind = "discover" | "approve";
let app: ReturnType<typeof Fastify>;
let queryClient: QueryClient;
let configured: ReturnType<typeof server>[];
let detailResponses: Map<number, () => Response>;
let listResponse: (() => Response | Promise<Response>) | undefined;
let responseMetadata: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined;
let providerCalls: { id: string; path: string; options: TransportOptions }[];
let apiCalls: { method: string; path: string; body?: unknown }[];
let request: SeerrRequest;
let onClose: Mock<(open?: boolean) => void>;
let renderErrors: unknown[];
const mutations = () => providerCalls.filter((call) => call.options.method !== "GET");
const key = (type: "movie" | "tv" = "movie") => seerrKeys.discover.requestOptions("owned", type);

beforeEach(async () => {
	localStorage.clear();
	configured = [server(1), server(2)];
	detailResponses = new Map();
	listResponse = undefined;
	responseMetadata = undefined;
	providerCalls = [];
	apiCalls = [];
	request = requestFixture();
	onClose = vi.fn<(open?: boolean) => void>();
	renderErrors = [];
	app = Fastify({ logger: false });
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
				where.id === instance.id && where.userId === instance.userId ? instance : null,
		},
		seerrActionLog: { create: async () => ({}) },
	});
	app.decorate("arrClientFactory", {
		rawRequest: async (row: ClientInstanceData, path: string, options: TransportOptions) => {
			providerCalls.push({ id: row.id, path, options });
			if (options.method === "GET") {
				if (/^\/api\/v1\/service\/(radarr|sonarr)$/.test(path))
					return listResponse?.() ?? json(configured);
				if (/^\/api\/v1\/service\/(radarr|sonarr)\/\d+$/.test(path)) {
					const id = Number(path.split("/").at(-1));
					return (
						detailResponses.get(id)?.() ??
						json(details(id, configured.find((s) => s.id === id)?.is4k))
					);
				}
				if (path === "/api/v1/user?take=50&skip=0&sort=displayname")
					return json({
						pageInfo: { pages: 1, pageSize: 50, results: 1, page: 1 },
						results: [user],
					});
				if (path === "/api/v1/tv/7") return json(tv);
				if (path === "/api/v1/status")
					return json({
						version: "synthetic",
						commitTag: "synthetic",
						updateAvailable: false,
						commitsBehind: 0,
					});
				if (path === "/api/v1/request/42") return json(request);
			}
			if (options.method === "POST" && path === "/api/v1/request") {
				const body = options.body as { mediaId: number; mediaType: "movie" | "tv"; is4k?: boolean };
				return json({
					id: 23,
					status: 1,
					type: body.mediaType,
					media: { ...request.media, tmdbId: body.mediaId },
					createdAt: "synthetic",
					is4k: body.is4k ?? false,
				});
			}
			if (options.method === "PUT" && path === "/api/v1/request/42") return json(request);
			if (options.method === "POST" && path === "/api/v1/request/42/approve")
				return json({ ...request, status: 2 });
			throw Error("Unexpected synthetic provider request");
		},
	});
	app.decorateRequest("currentUser", null);
	app.addHook("onRequest", async (r: FastifyRequest) => {
		r.currentUser = { id: "owner" } as NonNullable<typeof r.currentUser>;
	});
	registerProtectedRoutes(app);
	await app.ready();
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
			const url = new URL(String(input), "http://fixture.invalid");
			const method = options?.method ?? "GET";
			const allowed =
				url.origin === "http://fixture.invalid" &&
				((method === "GET" &&
					[
						"/api/seerr/discover/owned/request-options",
						"/api/seerr/users/owned",
						"/api/seerr/discover/owned/tv/7",
					].includes(url.pathname)) ||
					(method === "POST" &&
						["/api/seerr/discover/owned/request", "/api/seerr/requests/owned/42/approve"].includes(
							url.pathname,
						)));
			if (!allowed) throw Error("Live/unexpected frontend network forbidden");
			apiCalls.push({
				method,
				path: url.pathname,
				...(options?.body ? { body: JSON.parse(String(options.body)) } : {}),
			});
			const response = await app.inject({
				method: method as "GET" | "POST",
				url: url.pathname + url.search,
				...(options?.body
					? { payload: String(options.body), headers: { "content-type": "application/json" } }
					: {}),
			});
			// A rolling deployment/cache may carry an older or incoherent successful contract.
			const body =
				responseMetadata && response.statusCode === 200 && url.pathname.endsWith("request-options")
					? JSON.stringify(responseMetadata(response.json()))
					: response.body;
			return new Response(body, {
				status: response.statusCode,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(async () => {
	cleanup();
	queryClient.clear();
	await app.close();
	vi.unstubAllGlobals();
});

// Catch a component render exception as an observable failure without an
// unhandled React error ending the rest of the real-dialog regression suite.
class DialogRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? (
			<div role="alert">Synthetic dialog render failed</div>
		) : (
			this.props.children
		);
	}
}

function mount(kind: DialogKind, type: "movie" | "tv" = "movie") {
	return render(
		<DialogRenderBoundary>
			<QueryClientProvider client={queryClient}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{kind === "discover" ? (
							<DiscoverRequestDialog
								item={{
									id: 7,
									mediaType: type,
									title: "Synthetic movie",
									name: "Synthetic series",
								}}
								instanceId="owned"
								onClose={onClose}
							/>
						) : (
							<ApproveWithOptionsDialog
								request={request}
								instanceId="owned"
								open
								onOpenChange={onClose}
							/>
						)}
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>
		</DialogRenderBoundary>,
		{
			onCaughtError: (error) => {
				renderErrors.push(error);
			},
		},
	);
}
const submit = (kind: DialogKind) =>
	screen.getByRole("button", { name: kind === "discover" ? "Submit Request" : "Approve" });
async function loaded(type: "movie" | "tv" = "movie") {
	await waitFor(() => expect(queryClient.getQueryState(key(type))?.fetchStatus).toBe("idle"));
	await waitFor(() => expect(queryClient.getQueryState(key(type))?.status).not.toBe("pending"));
	await act(async () => {
		await Promise.resolve();
	});
}
async function refresh(type: "movie" | "tv" = "movie") {
	await act(async () => {
		await queryClient.refetchQueries({ queryKey: key(type), exact: true });
	});
}
function choose(name: string, value: string) {
	const select = screen
		.getAllByRole("combobox")
		.find((el) => within(el).queryByRole("option", { name }));
	if (!select) throw Error(`Expected selector with ${name}`);
	fireEvent.change(select, { target: { value } });
	return select;
}
async function partial(kind: DialogKind, target?: number) {
	detailResponses.set(1, () => json({ message: "Synthetic private error" }, 403));
	if (target !== undefined) request = requestFixture({ serverId: target });
	mount(kind);
	await loaded();
}

describe.each<DialogKind>(["discover", "approve"])(
	"%s request-options recovery with real hooks and registered routes",
	(kind) => {
		// A malformed dashboard envelope must render recovery, not crash or
		// infer complete coverage from only the rows which happen to parse.
		it.each([
			["non-array servers", "synthetic-invalid-array", false],
			["null row", [null], false],
			["missing-server row", [{ profiles: [], rootFolders: [], tags: [] }], false],
			["mixed valid and invalid rows", [details(2), null], true],
		])(
			"recovers %s without a render exception or mutation",
			async (_label, rawServers, keepsPositive) => {
				responseMetadata = (body) => ({
					...body,
					servers: rawServers,
					coverage: "complete",
					configuredServerCount: 1,
					unavailableServerCount: 0,
				});
				mount(kind);
				await loaded();
				expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
				expect(renderErrors).toEqual([]);
				expect(submit(kind)).toBeDisabled();
				if (keepsPositive) {
					expect(screen.getByRole("alert")).toHaveTextContent(/last.known/i);
					choose("Synthetic server 2", "2");
					expect(screen.getByRole("option", { name: /^Synthetic profile 2/ })).toBeInTheDocument();
					expect(submit(kind)).toBeDisabled();
				}
				fireEvent.click(submit(kind));
				expect(mutations()).toHaveLength(0);
				responseMetadata = undefined;
				const before = apiCalls.length;
				fireEvent.click(screen.getByRole("button", { name: "Retry" }));
				await loaded();
				await waitFor(() => expect(submit(kind)).toBeEnabled());
				expect(apiCalls.slice(before)).toEqual([
					{ method: "GET", path: "/api/seerr/discover/owned/request-options" },
				]);
				expect(mutations()).toHaveLength(0);
				expect(renderErrors).toEqual([]);
			},
		);
		it("prohibits submission while initial options are loading", async () => {
			let finish: ((response: Response) => void) | undefined;
			listResponse = () =>
				new Promise((resolve) => {
					finish = resolve;
				});
			mount(kind);
			await waitFor(() => expect(finish).toBeDefined());
			expect(submit(kind)).toBeDisabled();
			fireEvent.click(submit(kind));
			expect(mutations()).toHaveLength(0);
			await act(async () => {
				finish!(json(configured));
			});
			await loaded();
			await waitFor(() => expect(submit(kind)).toBeEnabled());
		});
		// A successful-empty detail failure must never become permission to submit defaults.
		it("blocks unavailable options, gives generic warning and GET-only retry", async () => {
			configured = [server(1)];
			detailResponses.set(1, () => json({ message: "Synthetic private error" }, 403));
			mount(kind);
			await loaded();
			expect(submit(kind)).toBeDisabled();
			expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
			expect(screen.queryByText(/Synthetic private error/)).not.toBeInTheDocument();
			const before = apiCalls.length;
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await loaded();
			expect(apiCalls.slice(before)).toEqual([
				{ method: "GET", path: "/api/seerr/discover/owned/request-options" },
			]);
			fireEvent.click(submit(kind));
			expect(mutations()).toHaveLength(0);
		});
		it("retains cached choices as last-known after list failure and prohibits mutation", async () => {
			mount(kind);
			await loaded();
			choose("Synthetic server 2", "2");
			listResponse = () => json({}, 403);
			await refresh();
			expect(await screen.findByRole("alert")).toHaveTextContent(/last.known/i);
			expect(screen.getByRole("option", { name: "Synthetic server 2" })).toBeInTheDocument();
			expect(submit(kind)).toBeDisabled();
			fireEvent.click(submit(kind));
			expect(mutations()).toHaveLength(0);
		});
		it.each(["missing", "incoherent"])(
			"blocks %s coverage metadata even with positive cached choices",
			async (mode) => {
				responseMetadata = (body) =>
					mode === "missing"
						? { servers: body.servers }
						: {
								...body,
								coverage: "complete",
								configuredServerCount: 0,
								unavailableServerCount: 0,
							};
				mount(kind);
				await loaded();
				expect(submit(kind)).toBeDisabled();
				expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
			},
		);
		it("requires explicit selection of the only verified partial server, then binds its defaults", async () => {
			await partial(kind);
			expect(submit(kind)).toBeDisabled();
			expect(screen.getByRole("alert")).toHaveTextContent(/some.*unavailable/i);
			choose("Synthetic server 2", "2");
			expect(submit(kind)).toBeEnabled();
			fireEvent.click(submit(kind));
			await waitFor(() => expect(onClose).toHaveBeenCalled());
			if (kind === "discover")
				expect(mutations()).toEqual([
					expect.objectContaining({
						id: "owned",
						path: "/api/v1/request",
						options: expect.objectContaining({
							method: "POST",
							body: {
								mediaId: 7,
								mediaType: "movie",
								serverId: 2,
								profileId: 12,
								rootFolder: "/synthetic/2",
							},
						}),
					}),
				]);
			else
				expect(
					mutations().map((call) => ({
						path: call.path,
						method: call.options.method,
						body: call.options.body,
					})),
				).toEqual([
					{
						path: "/api/v1/request/42",
						method: "PUT",
						body: { mediaType: "movie", serverId: 2, profileId: 12, rootFolder: "/synthetic/2" },
					},
					{ path: "/api/v1/request/42/approve", method: "POST", body: undefined },
				]);
		});
		it("preserves manual server/profile/root through partial-to-complete recovery", async () => {
			await partial(kind);
			choose("Synthetic server 2", "2");
			choose("Alternate profile 2", "22");
			choose("/alternate/2", "/alternate/2");
			detailResponses.clear();
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await loaded();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(screen.getByRole("option", { name: "Synthetic server 2" })).toHaveProperty(
				"selected",
				true,
			);
			expect(screen.getByRole("option", { name: "Alternate profile 2" })).toHaveProperty(
				"selected",
				true,
			);
			expect(screen.getByRole("option", { name: "/alternate/2" })).toHaveProperty("selected", true);
			expect(mutations()).toHaveLength(0);
		});
		it.each(["profile", "root"])(
			"pins the displayed server when manually editing its %s before an overlapping default switch",
			async (field) => {
				configured = [server(1)];
				mount(kind);
				await loaded();
				if (field === "profile") choose("Alternate profile 1", "21");
				else choose("/alternate/1", "/alternate/1");
				const overlap = details(1);
				configured = [server(2)];
				detailResponses.set(2, () =>
					json({
						...overlap,
						server: { ...server(2), activeProfileId: 11, activeDirectory: "/synthetic/1" },
					}),
				);
				await refresh();
				await waitFor(() =>
					expect(
						queryClient.getQueryData<{ servers: SeerrServerWithDetails[] }>(key())?.servers[0]
							?.server.id,
					).toBe(2),
				);
				await waitFor(() => expect(submit(kind)).toBeDisabled());
				fireEvent.click(submit(kind));
				expect(mutations()).toHaveLength(0);
			},
		);
		it("never falls back when a selected server disappears, including a verified empty refresh", async () => {
			mount(kind);
			await loaded();
			choose("Synthetic server 2", "2");
			configured = [server(1)];
			await refresh();
			await waitFor(() => expect(submit(kind)).toBeDisabled());
			configured = [];
			await refresh();
			await waitFor(() => expect(submit(kind)).toBeDisabled());
			fireEvent.click(submit(kind));
			expect(mutations()).toHaveLength(0);
		});
		it.each(["profile", "root"])(
			"blocks removed selected %s rather than substituting defaults",
			async (removed) => {
				mount(kind);
				await loaded();
				choose("Synthetic server 2", "2");
				choose("Alternate profile 2", "22");
				choose("/alternate/2", "/alternate/2");
				const next = details(2);
				if (removed === "profile") next.profiles = [next.profiles[0]!];
				else next.rootFolders = [next.rootFolders[0]!];
				detailResponses.set(2, () => json(next));
				await refresh();
				await waitFor(() => expect(submit(kind)).toBeDisabled());
				fireEvent.click(submit(kind));
				expect(mutations()).toHaveLength(0);
			},
		);
		it("disables retry and submission throughout an active refetch", async () => {
			await partial(kind);
			choose("Synthetic server 2", "2");
			let finish: ((response: Response) => void) | undefined;
			listResponse = () =>
				new Promise((resolve) => {
					finish = resolve;
				});
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await waitFor(() => expect(submit(kind)).toBeDisabled());
			expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
			fireEvent.click(submit(kind));
			expect(mutations()).toHaveLength(0);
			await act(async () => {
				finish!(json(configured));
			});
			await loaded();
			expect(submit(kind)).toBeEnabled();
		});
		it("recovers unavailable to confirmed-empty without mutation on retry", async () => {
			configured = [server(1)];
			detailResponses.set(1, () => json({}, 403));
			mount(kind);
			await loaded();
			configured = [];
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await loaded();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(mutations()).toHaveLength(0);
			if (kind === "discover") expect(submit(kind)).toBeEnabled();
			else {
				expect(submit(kind)).toBeDisabled();
				expect(screen.getByText(/No servers configured/)).toBeInTheDocument();
			}
		});
		it("recovers unavailable to complete verified defaults without an automatic write", async () => {
			configured = [server(1)];
			detailResponses.set(1, () => json({}, 403));
			mount(kind);
			await loaded();
			detailResponses.clear();
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await loaded();
			await waitFor(() => expect(submit(kind)).toBeEnabled());
			expect(mutations()).toHaveLength(0);
		});
		it("preserves healthy default routing without custom overrides", async () => {
			mount(kind);
			await loaded();
			fireEvent.click(submit(kind));
			await waitFor(() => expect(onClose).toHaveBeenCalled());
			if (kind === "discover")
				expect(mutations()[0]?.options.body).toEqual({ mediaId: 7, mediaType: "movie" });
			else {
				expect(mutations()).toHaveLength(1);
				expect(mutations()[0]?.path).toBe("/api/v1/request/42/approve");
			}
		});
		it("masks newly offered partial server/root labels in incognito", async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			await partial(kind);
			const label = `${getLinuxServerName("Synthetic server 2")} 1`;
			await screen.findByRole("option", { name: label });
			choose(label, "2");
			expect(screen.queryByRole("option", { name: "Synthetic server 2" })).not.toBeInTheDocument();
			expect(
				screen.getAllByRole("option", { name: new RegExp(getLinuxSavePath("/synthetic/2")) })
					.length,
			).toBeGreaterThan(0);
			expect(screen.queryByRole("option", { name: "/synthetic/2" })).not.toBeInTheDocument();
			if (kind === "discover")
				expect(
					screen.getByRole("button", { name: getLinuxUsername("Synthetic tag 2") }),
				).toBeInTheDocument();
		});
	},
);

describe("existing approval intent", () => {
	it("keeps valid inherited tags and healthy no-override approval unchanged", async () => {
		request = requestFixture({ serverId: 1, tags: [31] });
		mount("approve");
		await loaded();
		expect(submit("approve")).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Clear unavailable tags" }),
		).not.toBeInTheDocument();
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations().map((call) => ({ path: call.path, body: call.options.body }))).toEqual([
			{ path: "/api/v1/request/42/approve", body: undefined },
		]);
		expect(request.tags).toEqual([31]);
	});
	it.each(["complete", "partial"])(
		"explicitly clears only unavailable inherited tags before a %s verified reroute",
		async (coverage) => {
			request = requestFixture({ serverId: 1, tags: [31, 32] });
			if (coverage === "partial") detailResponses.set(1, () => json({}, 403));
			else
				detailResponses.set(1, () =>
					json({
						...details(1),
						tags: [
							{ id: 31, label: "Old tag" },
							{ id: 32, label: "Retained tag" },
						],
					}),
				);
			mount("approve");
			await loaded();
			choose("Synthetic server 2", "2");
			expect(submit("approve")).toBeDisabled();
			const before = apiCalls.length;
			fireEvent.click(screen.getByRole("button", { name: "Clear unavailable tags" }));
			expect(submit("approve")).toBeEnabled();
			expect(apiCalls.slice(before)).toEqual([]);
			expect(mutations()).toHaveLength(0);
			fireEvent.click(submit("approve"));
			await waitFor(() => expect(onClose).toHaveBeenCalled());
			expect(
				mutations().map((call) => ({
					path: call.path,
					method: call.options.method,
					body: call.options.body,
				})),
			).toEqual([
				{
					path: "/api/v1/request/42",
					method: "PUT",
					body: {
						mediaType: "movie",
						serverId: 2,
						profileId: 12,
						rootFolder: "/synthetic/2",
						tags: [32],
					},
				},
				{ path: "/api/v1/request/42/approve", method: "POST", body: undefined },
			]);
			expect(request.tags).toEqual([31, 32]);
		},
	);
	it("sends explicit empty tags only after clearing a removed inherited tag and approving", async () => {
		request = requestFixture({ serverId: 1, tags: [31] });
		mount("approve");
		await loaded();
		detailResponses.set(1, () => json({ ...details(1), tags: [] }));
		await refresh();
		await waitFor(() => expect(submit("approve")).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Clear unavailable tags" }));
		expect(submit("approve")).toBeEnabled();
		expect(mutations()).toHaveLength(0);
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({ mediaType: "movie", serverId: 1, tags: [] });
		expect(mutations()[1]?.path).toBe("/api/v1/request/42/approve");
		expect(request.tags).toEqual([31]);
	});
	it("pins tag-removal intent through a refetch and overlapping default switch", async () => {
		configured = [server(1)];
		request = requestFixture({ tags: [31] });
		detailResponses.set(1, () => json({ ...details(1), tags: [] }));
		mount("approve");
		await loaded();
		fireEvent.click(screen.getByRole("button", { name: "Clear unavailable tags" }));
		configured = [
			{ ...server(2), isDefault: true },
			{ ...server(1), isDefault: false },
		];
		detailResponses.set(1, () => json({ ...details(1), server: configured[1], tags: [] }));
		detailResponses.set(2, () =>
			json({
				...details(2),
				server: configured[0],
				tags: [{ id: 31, label: "Different server tag" }],
			}),
		);
		await refresh();
		await waitFor(() =>
			expect(screen.getByRole("option", { name: "Synthetic server 1" })).toHaveProperty(
				"selected",
				true,
			),
		);
		expect(submit("approve")).toBeEnabled();
		expect(mutations()).toHaveLength(0);
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaType: "movie",
			serverId: 1,
			profileId: 11,
			rootFolder: "/synthetic/1",
			tags: [],
		});
	});
	it("blocks local tag clearing during refetch and cached query failure", async () => {
		request = requestFixture({ serverId: 1, tags: [31] });
		detailResponses.set(1, () => json({ ...details(1), tags: [] }));
		mount("approve");
		await loaded();
		let finish: ((response: Response) => void) | undefined;
		listResponse = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Clear unavailable tags" })).toBeDisabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Clear unavailable tags" }));
		await act(async () => {
			finish!(json(configured));
		});
		await loaded();
		expect(submit("approve")).toBeDisabled();
		listResponse = () => json({}, 403);
		await refresh();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Clear unavailable tags" })).toBeDisabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Clear unavailable tags" }));
		expect(submit("approve")).toBeDisabled();
		expect(mutations()).toHaveLength(0);
	});
	it.each([1, 0])(
		"does not fall back from missing explicit request target %s",
		async (serverId) => {
			await partial("approve", serverId);
			expect(submit("approve")).toBeDisabled();
			choose("Synthetic server 2", "2");
			expect(submit("approve")).toBeEnabled();
		},
	);
	it("allows the exact verified request target in partial coverage and binds full defaults", async () => {
		await partial("approve", 2);
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaType: "movie",
			serverId: 2,
			profileId: 12,
			rootFolder: "/synthetic/2",
		});
	});
	it("preserves TV/4K intent and existing seasons in partial approval", async () => {
		configured = [server(1), server(3, true), server(4, true)];
		detailResponses.set(4, () => json({}, 403));
		request = requestFixture({
			type: "tv",
			is4k: true,
			serverId: 3,
			seasons: [{ id: 1, seasonNumber: 1, status: 1 }],
		});
		mount("approve", "tv");
		await loaded("tv");
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaType: "tv",
			serverId: 3,
			profileId: 13,
			rootFolder: "/synthetic/3",
			seasons: [1],
		});
	});
	it("cannot use a regular server for a missing requested 4K target", async () => {
		request = requestFixture({ is4k: true, serverId: 3 });
		mount("approve");
		await loaded();
		expect(submit("approve")).toBeDisabled();
		expect(mutations()).toHaveLength(0);
	});
	it("binds an explicitly selected verified zero server in partial approval", async () => {
		configured = [server(0), server(1)];
		detailResponses.set(1, () => json({}, 403));
		request = requestFixture({ serverId: 0 });
		mount("approve");
		await loaded();
		fireEvent.click(submit("approve"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaType: "movie",
			serverId: 0,
			profileId: 10,
			rootFolder: "/synthetic/0",
		});
	});
});

describe("Discover explicit options", () => {
	it("pins the displayed server when manually choosing a tag before overlapping targets refresh", async () => {
		configured = [server(1)];
		mount("discover");
		await loaded();
		fireEvent.click(screen.getByRole("button", { name: "Synthetic tag 1" }));
		const overlap = details(1);
		configured = [server(2)];
		detailResponses.set(2, () =>
			json({
				...overlap,
				server: { ...server(2), activeProfileId: 11, activeDirectory: "/synthetic/1" },
			}),
		);
		await refresh();
		await waitFor(() => expect(submit("discover")).toBeDisabled());
		expect(mutations()).toHaveLength(0);
	});
	it("submits confirmed-empty complete options through the existing default route", async () => {
		configured = [];
		mount("discover");
		await loaded();
		fireEvent.click(submit("discover"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({ mediaId: 7, mediaType: "movie" });
	});
	it("blocks removed tags until explicitly recovering the server choice", async () => {
		mount("discover");
		await loaded();
		choose("Synthetic server 2", "2");
		fireEvent.click(screen.getByRole("button", { name: "Synthetic tag 2" }));
		detailResponses.set(2, () => json({ ...details(2), tags: [] }));
		await refresh();
		await waitFor(() => expect(submit("discover")).toBeDisabled());
		choose("Synthetic server 1", "1");
		expect(submit("discover")).toBeEnabled();
		expect(mutations()).toHaveLength(0);
	});
	it("requires validated defaults rather than submitting a partial server with missing profile/root membership", async () => {
		detailResponses.set(1, () => json({}, 403));
		detailResponses.set(2, () => json({ ...details(2), profiles: [], rootFolders: [] }));
		mount("discover");
		await loaded();
		choose("Synthetic server 2", "2");
		expect(submit("discover")).toBeDisabled();
	});
	it("keeps intended TV/4K mode when the target disappears and requires explicit recovery", async () => {
		configured = [server(1), server(3, true), server(4, true)];
		mount("discover", "tv");
		await loaded("tv");
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic season 1/ }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Request in 4K" }));
		choose("Synthetic server 3", "3");
		detailResponses.set(3, () => json({}, 403));
		detailResponses.set(4, () => json({}, 403));
		await refresh("tv");
		expect(screen.getByRole("checkbox", { name: "Request in 4K" })).toBeChecked();
		await waitFor(() => expect(submit("discover")).toBeDisabled());
		detailResponses.delete(4);
		await refresh("tv");
		await screen.findByRole("option", { name: "Synthetic server 4" });
		choose("Synthetic server 4", "4");
		fireEvent.click(submit("discover"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaId: 7,
			mediaType: "tv",
			is4k: true,
			seasons: [1],
			serverId: 4,
			profileId: 14,
			rootFolder: "/synthetic/4",
		});
	});
	it("submits verified zero server explicitly instead of treating it as absence", async () => {
		configured = [server(0), server(1)];
		detailResponses.set(1, () => json({}, 403));
		mount("discover");
		await loaded();
		choose("Synthetic server 0", "0");
		fireEvent.click(submit("discover"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(mutations()[0]?.options.body).toEqual({
			mediaId: 7,
			mediaType: "movie",
			serverId: 0,
			profileId: 10,
			rootFolder: "/synthetic/0",
		});
	});
});
