import type { ProviderNativeInventoryResponse, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";

const insightPaths = [
	"/api/library/insights/disk-waste",
	"/api/library/insights/watched-monitored",
	"/api/library/insights/requested-unwatched",
];
const service: ServiceInstanceSummary = {
	id: "synthetic-plex",
	service: "plex",
	label: "Synthetic",
	enabled: true,
	baseUrl: "https://synthetic.invalid",
	externalUrl: null,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "verified",
		kind: "server",
		fingerprint: "synthetic",
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-11-05T00:00:00.000Z",
	updatedAt: "2026-11-05T00:00:00.000Z",
	tags: [],
};
const nativeInventory: ProviderNativeInventoryResponse = {
	status: "available",
	generationId: "synthetic-generation",
	observedAt: "2026-11-05T12:00:00.000Z",
	itemCount: 1,
	scopeCount: 1,
	lastAttemptAt: "2026-11-05T12:00:00.000Z",
	lastAttemptResult: "success",
	lastAttemptReason: null,
	freshness: "current",
	complete: true,
	rows: [
		{
			nativeId: "synthetic-native",
			mediaType: "movie",
			libraryIds: ["synthetic-library"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic native row",
			externalIds: { tmdb: [42] },
		},
	],
	nextNativeId: null,
};

let client: QueryClient;
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	window.history.replaceState({}, "", "/");
});

function fixture({ services = "provider" }: { services?: "provider" | "none" | "error" } = {}) {
	const arr = Promise.withResolvers<Response>();
	const filteredArr = Promise.withResolvers<Response>();
	const native = Promise.withResolvers<Response>();
	const reload = Promise.withResolvers<Response>();
	const requests: string[] = [];
	let nativeRequests = 0;
	let arrRequests = 0;
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
	window.history.replaceState({}, "", "/library");
	vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
		const path = new URL(input, "http://synthetic.invalid").pathname;
		requests.push(path);
		if (path === "/api/qui/library-seeding-summary" && options?.method === "POST") {
			return Response.json({ status: "not-configured", summaries: {} });
		}
		if (options?.method && options.method !== "GET") throw new Error("Unexpected mutation");
		if (path === "/api/services") {
			if (services === "error") return Response.json({ error: "Unavailable" }, { status: 503 });
			return Response.json({ services: services === "provider" ? [service] : [] });
		}
		if (path === "/api/library") {
			arrRequests += 1;
			return arrRequests === 1 ? arr.promise : filteredArr.promise;
		}
		if (path === "/api/library/provider-inventory") {
			nativeRequests += 1;
			return nativeRequests === 1 ? native.promise : reload.promise;
		}
		if (path === "/api/library/sync/status") return Response.json({ instances: [] });
		if (path === "/api/plex/identity") return Response.json({ servers: [] });
		if (path === "/api/jellyfin/identity") return Response.json([]);
		if (path === "/api/plex/sections") return Response.json({ sections: [], configured: true });
		if (path === "/api/qui/tracker-icons") return Response.json({ trackers: {} });
		if (insightPaths.includes(path)) return Response.json({ data: { items: [] } });
		if (path.endsWith("/watch-enrichment")) return Response.json({ configured: false, items: {} });
		if (path.endsWith("/series-progress"))
			return Response.json({ configured: false, progress: {} });
		throw new Error(`Unexpected synthetic path: ${path}`);
	});
	const arrResponse = (empty = false) =>
		Response.json({
			items: empty
				? []
				: [
						{
							id: 1,
							instanceId: "synthetic-arr",
							instanceName: "Synthetic",
							service: "radarr",
							type: "movie",
							title: "Synthetic ARR row",
							monitored: false,
						},
					],
			pagination: { page: 1, limit: 50, totalItems: empty ? 0 : 1, totalPages: 1 },
			syncStatus: {
				isCached: true,
				lastSync: null,
				syncInProgress: false,
				totalCachedItems: empty ? 0 : 1,
			},
		});
	return {
		arr,
		filteredArr,
		native,
		reload,
		arrResponse,
		requests,
		insights: () => requests.filter((path) => insightPaths.includes(path)),
		render: () =>
			render(
				<QueryClientProvider client={client}>
					<SearchParamsContext.Provider value={new URLSearchParams()}>
						<ColorThemeProvider>
							<IncognitoProvider>
								<LibraryClient />
							</IncognitoProvider>
						</ColorThemeProvider>
					</SearchParamsContext.Provider>
				</QueryClientProvider>,
			),
	};
}

describe("Library primary-read priority with real query hooks", () => {
	it.each(["arr", "native"] as const)(
		"admits insights only after both primary reads settle (%s first)",
		async (first) => {
			const f = fixture();
			f.render();
			await waitFor(() => expect(f.requests).toContain("/api/library/provider-inventory"));
			expect(f.insights()).toEqual([]);
			await act(async () => {
				if (first === "arr") f.arr.resolve(f.arrResponse());
				else f.native.resolve(Response.json(nativeInventory));
			});
			if (first === "arr") expect(await screen.findByText("Synthetic ARR row")).toBeVisible();
			else expect(await screen.findByText("Synthetic native row")).toBeVisible();
			expect(f.insights()).toEqual([]);
			await act(async () => {
				if (first === "arr") f.native.resolve(Response.json(nativeInventory));
				else f.arr.resolve(f.arrResponse());
			});
			await waitFor(() => expect(f.insights().sort()).toEqual([...insightPaths].sort()));
			expect(screen.getByText("Synthetic ARR row")).toBeVisible();
			expect(screen.getByText("Synthetic native row")).toBeVisible();

			fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
			await waitFor(() =>
				expect(f.requests.filter((p) => p === "/api/library/provider-inventory")).toHaveLength(2),
			);
			expect(f.insights()).toHaveLength(3);
			expect(screen.getByText("Synthetic native row")).toBeVisible();
			await act(async () => f.reload.resolve(Response.json(nativeInventory)));

			fireEvent.change(screen.getByRole("combobox", { name: "Sort By" }), {
				target: { value: "year" },
			});
			await waitFor(() =>
				expect(f.requests.filter((path) => path === "/api/library")).toHaveLength(2),
			);
			// A later primary query must not disable already admitted insight reads.
			await act(async () => {
				await client.invalidateQueries({ queryKey: ["library", "insights"] });
			});
			await waitFor(() => expect(f.insights()).toHaveLength(6));
			await act(async () => f.filteredArr.resolve(f.arrResponse()));
		},
	);

	it.each(["unavailable", "error"])(
		"still admits insights after an empty ARR result and native %s",
		async (result) => {
			const f = fixture();
			f.render();
			await waitFor(() => expect(f.requests).toContain("/api/library/provider-inventory"));
			expect(f.insights()).toEqual([]);
			await act(async () => {
				f.arr.resolve(f.arrResponse(true));
				f.native.resolve(
					result === "error"
						? Response.json({ error: "Synthetic unavailable" }, { status: 503 })
						: Response.json({ status: "unavailable", reason: "no-publication" }),
				);
			});
			await waitFor(() => expect(f.insights()).toHaveLength(3));
		},
	);

	it("does not strand insights after a terminal ARR error", async () => {
		const f = fixture();
		f.render();
		await waitFor(() => expect(f.requests).toContain("/api/library/provider-inventory"));
		expect(f.insights()).toEqual([]);
		await act(async () => {
			f.arr.resolve(Response.json({ error: "Synthetic unavailable" }, { status: 503 }));
			f.native.resolve(Response.json(nativeInventory));
		});
		await waitFor(() => expect(f.insights()).toHaveLength(3));
		expect(screen.getByText("Synthetic native row")).toBeVisible();
	});

	it.each(["none", "error"] as const)(
		"waits for ARR, not nonexistent inventory, when services are %s",
		async (services) => {
			const f = fixture({ services });
			f.render();
			await waitFor(() =>
				expect(client.getQueryState(["services"])?.status).toBe(
					services === "error" ? "error" : "success",
				),
			);
			expect(f.insights()).toEqual([]);
			await act(async () => f.arr.resolve(f.arrResponse(true)));
			await waitFor(() => expect(f.insights()).toHaveLength(3));
			expect(f.requests).not.toContain("/api/library/provider-inventory");
		},
	);
});
