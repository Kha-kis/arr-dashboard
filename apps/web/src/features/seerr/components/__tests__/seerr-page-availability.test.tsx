import type {
	SeerrDiscoverResponse,
	SeerrPageResult,
	SeerrRequest,
	ServiceInstanceSummary,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { seerrKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DiscoverClient } from "../../../discover/components/discover-client";
import { RequestsClient } from "../requests-client";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const connection: ServiceInstanceSummary = {
	id: "owned-seerr",
	service: "seerr",
	label: "Synthetic owned Seerr",
	baseUrl: "https://seerr.invalid",
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
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	tags: [],
};
const requests: SeerrPageResult<SeerrRequest> = {
	pageInfo: { pages: 1, pageSize: 50, results: 1, page: 1 },
	results: [
		{
			id: 41,
			status: 1,
			type: "movie",
			is4k: false,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			media: {
				id: 51,
				tmdbId: 61,
				mediaType: "movie",
				status: 2,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				title: "Synthetic pending movie",
			},
			requestedBy: {
				id: 71,
				displayName: "Synthetic requester",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				permissions: 0,
				requestCount: 1,
				userType: 1,
			},
			seasons: [],
		},
	],
};
const discovery: SeerrDiscoverResponse = {
	page: 1,
	totalPages: 1,
	totalResults: 1,
	results: [{ id: 81, mediaType: "movie", title: "Synthetic discover movie", genreIds: [] }],
};
const counts = {
	total: 1,
	movie: 1,
	tv: 0,
	pending: 1,
	approved: 0,
	declined: 0,
	processing: 0,
	available: 0,
};
const status = {
	version: "1.0.0",
	commitTag: "synthetic",
	updateAvailable: false,
	commitsBehind: 0,
};
const privateDiagnostic = "private-provider-detail https://private.invalid synthetic-secret";
const unavailableMessage = "Unable to verify Seerr connections. Retry to check again.";
const cachedMessage =
	"Seerr connections could not be verified. Showing last-known connections; availability may have changed.";
let clients: QueryClient[] = [];
let serviceRead: () => Promise<Response>;
let reads: { url: string; method: string; body: unknown }[];
let unexpected: string[];

function response(data: unknown, statusCode = 200) {
	return new Response(JSON.stringify(data), {
		status: statusCode,
		headers: { "content-type": "application/json" },
	});
}

function deferConnectionRead() {
	let resolve!: (value: Response) => void;
	const pending = new Promise<Response>((done) => {
		resolve = done;
	});
	serviceRead = () => pending;
	return resolve;
}

beforeEach(() => {
	localStorage.clear();
	reads = [];
	unexpected = [];
	serviceRead = async () => response({ services: [] });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		reads.push({ url, method, body: init?.body });
		if (method !== "GET" || init?.body !== undefined) {
			unexpected.push(`${method} ${url}`);
			return response({ error: "Unexpected mutation" }, 500);
		}
		if (url === "/api/services") return serviceRead();
		if (url === "/api/seerr/requests/owned-seerr/count") return response(counts);
		if (url === "/api/seerr/status/owned-seerr") return response(status);
		if (url === "/api/seerr/requests/owned-seerr?filter=pending&sort=added&take=50") {
			return response(requests);
		}
		if (url === "/api/seerr/discover/owned-seerr/genres/movie") return response([]);
		if (
			[
				"/api/seerr/discover/owned-seerr/trending?page=1",
				"/api/seerr/discover/owned-seerr/movies?page=1",
				"/api/seerr/discover/owned-seerr/movies/upcoming?page=1",
			].includes(url)
		)
			return response(discovery);
		unexpected.push(`${method} ${url}`);
		return response({ error: "Unexpected synthetic request" }, 500);
	});
});

afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients = [];
	vi.unstubAllGlobals();
	expect(unexpected).toEqual([]);
});

function mount(
	Page: typeof RequestsClient | typeof DiscoverClient,
	cached?: ServiceInstanceSummary[],
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retryDelay: 0, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	if (cached) client.setQueryData(["services"], cached);
	if (cached?.length) {
		client.setQueryData(
			seerrKeys.requests(connection.id, {
				instanceId: connection.id,
				filter: "pending",
				sort: "added",
				take: 50,
			}),
			requests,
		);
		client.setQueryData(seerrKeys.requestCount(connection.id), counts);
		client.setQueryData(seerrKeys.status(connection.id), status);
		for (const key of [
			seerrKeys.discover.trending(connection.id),
			seerrKeys.discover.movies(connection.id),
			seerrKeys.discover.moviesUpcoming(connection.id),
		])
			client.setQueryData(key, { pages: [discovery], pageParams: [1] });
		client.setQueryData(seerrKeys.discover.genres(connection.id, "movie"), []);
	}
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Page />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { client, ...view };
}

function expectNoSetupOrDiagnostics() {
	expect(screen.queryByText("No Seerr Instances")).not.toBeInTheDocument();
	expect(screen.queryByText("Connect Seerr to Discover Content")).not.toBeInTheDocument();
	expect(screen.queryByText("Go to Settings")).not.toBeInTheDocument();
	expect(document.body.textContent).not.toContain(privateDiagnostic);
}

async function expectConnectionFailure(client: QueryClient) {
	await waitFor(() => expect(client.getQueryState(["services"])?.status).toBe("error"));
	expect(reads.filter(({ url }) => url === "/api/services")).toHaveLength(4);
}

describe.each([
	{
		name: "Requests",
		Page: RequestsClient,
		setup: "No Seerr Instances",
		content: "Synthetic pending movie",
	},
	{
		name: "Discover",
		Page: DiscoverClient,
		setup: "Connect Seerr to Discover Content",
		content: "Synthetic discover movie",
	},
])("$name connection availability", ({ Page, setup, content }) => {
	it("keeps the initial read loading instead of showing unavailable or setup", async () => {
		const resolve = deferConnectionRead();
		const { client, container } = mount(Page);
		await waitFor(() => expect(reads).toHaveLength(1));
		expect(client.getQueryState(["services"])?.fetchStatus).toBe("fetching");
		expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expectNoSetupOrDiagnostics();
		await act(async () => resolve(response({ services: [] })));
		expect(await screen.findByText(setup)).toBeInTheDocument();
	});

	it("shows generic unavailable and Retry after a failed uncached connection read", async () => {
		serviceRead = async () => response({ error: privateDiagnostic }, 503);
		const { client } = mount(Page);
		await expectConnectionFailure(client);
		expect(await screen.findByRole("alert")).toHaveTextContent(unavailableMessage);
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expectNoSetupOrDiagnostics();
	});

	it("does not treat cached empty connections as a confirmed empty result after failure", async () => {
		serviceRead = async () => response({ error: privateDiagnostic }, 503);
		const { client } = mount(Page, []);
		await expectConnectionFailure(client);
		expect(await screen.findByRole("alert")).toHaveTextContent(unavailableMessage);
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expectNoSetupOrDiagnostics();
	});

	it("recovers an uncached failure through a disabled pending GET-only Retry", async () => {
		serviceRead = async () => response({ error: privateDiagnostic }, 503);
		const { client } = mount(Page);
		await expectConnectionFailure(client);
		const retry = await screen.findByRole("button", { name: "Retry" });
		const resolve = deferConnectionRead();
		const previousReads = reads.length;
		fireEvent.click(retry);
		await waitFor(() => expect(reads).toHaveLength(previousReads + 1));
		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("alert")).toHaveTextContent(unavailableMessage);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(reads.slice(previousReads)).toEqual([
			{ url: "/api/services", method: "GET", body: undefined },
		]);
		expectNoSetupOrDiagnostics();
		await act(async () => resolve(response({ services: [connection] })));
		await waitFor(() => expect(screen.getAllByText(content).length).toBeGreaterThan(0));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
		expectNoSetupOrDiagnostics();
	});

	it.each([
		{ cache: "uncached", cached: undefined },
		{ cache: "cached empty", cached: [] as ServiceInstanceSummary[] },
	])("clears $cache failure after Retry confirms an empty configuration", async ({ cached }) => {
		serviceRead = async () => response({ error: privateDiagnostic }, 503);
		const { client } = mount(Page, cached);
		await expectConnectionFailure(client);
		const retry = await screen.findByRole("button", { name: "Retry" });
		const resolve = deferConnectionRead();
		fireEvent.click(retry);
		await waitFor(() => expect(reads).toHaveLength(5));
		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("alert")).toHaveTextContent(unavailableMessage);
		expectNoSetupOrDiagnostics();
		expect(reads[4]).toEqual({ url: "/api/services", method: "GET", body: undefined });
		await act(async () => resolve(response({ services: [] })));
		expect(await screen.findByText(setup)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
	});

	it("keeps populated cached content during a background read and warns after failure until GET-only recovery", async () => {
		const resolveFailure = deferConnectionRead();
		const { client } = mount(Page, [connection]);
		await waitFor(() => expect(reads).toHaveLength(1));
		const cachedElement = screen.getAllByText(content)[0]!;
		expect(cachedElement).toBeInTheDocument();
		expectNoSetupOrDiagnostics();
		serviceRead = async () => response({ error: privateDiagnostic }, 503);
		await act(async () => resolveFailure(response({ error: privateDiagnostic }, 503)));
		await expectConnectionFailure(client);
		expect(await screen.findByRole("alert")).toHaveTextContent(cachedMessage);
		expect(cachedElement).toBeInTheDocument();
		expectNoSetupOrDiagnostics();
		const resolveSuccess = deferConnectionRead();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(reads).toHaveLength(5));
		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("alert")).toHaveTextContent(cachedMessage);
		expect(cachedElement).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(reads).toHaveLength(5);
		expect(
			reads.every(
				({ url, method, body }) =>
					url === "/api/services" && method === "GET" && body === undefined,
			),
		).toBe(true);
		await act(async () => resolveSuccess(response({ services: [connection] })));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
		expect(cachedElement).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
		expectNoSetupOrDiagnostics();
	});

	it("shows setup only after success confirms no enabled Seerr connections", async () => {
		serviceRead = async () =>
			response({
				services: [
					{ ...connection, enabled: false },
					{ ...connection, id: "owned-sonarr", service: "sonarr" },
				],
			});
		mount(Page);
		expect(await screen.findByText(setup)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(reads).toEqual([{ url: "/api/services", method: "GET", body: undefined }]);
	});

	it("renders populated configured content after a successful nonempty read", async () => {
		serviceRead = async () => response({ services: [connection] });
		mount(Page);
		await waitFor(() => expect(screen.getAllByText(content).length).toBeGreaterThan(0));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expectNoSetupOrDiagnostics();
		expect(reads.every(({ method, body }) => method === "GET" && body === undefined)).toBe(true);
	});
});
