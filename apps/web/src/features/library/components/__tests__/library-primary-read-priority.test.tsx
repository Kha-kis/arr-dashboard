import type { ProviderNativeInventoryResponse, ServiceInstanceSummary } from "@arr/shared";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";

const insightPaths = [
	"/api/library/insights/disk-waste",
	"/api/library/insights/watched-monitored",
	"/api/library/insights/requested-unwatched",
];
const plexProgressPath = "/api/plex/series-progress";
const jellyfinWatchPath = "/api/jellyfin/watch-enrichment";
const jellyfinProgressPath = "/api/jellyfin/series-progress";
const emptyProgress = { configured: true, progress: {} };
const bundledWatch = { items: {}, seriesProgress: emptyProgress };
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

function fixture({
	services = "provider",
	pairedWatchError = false,
	bundleJellyfinProgress = false,
	holdRead,
}: {
	services?: "provider" | "none" | "error";
	pairedWatchError?: boolean;
	bundleJellyfinProgress?: boolean;
	holdRead?: string;
} = {}) {
	const arr = Promise.withResolvers<Response>();
	const filteredArr = Promise.withResolvers<Response>();
	const native = Promise.withResolvers<Response>();
	const reload = Promise.withResolvers<Response>();
	const heldRead = Promise.withResolvers<Response>();
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
		if (path === holdRead) return heldRead.promise;
		if (path === jellyfinWatchPath) {
			if (pairedWatchError)
				return Response.json({ error: "Synthetic watch failure" }, { status: 503 });
			if (bundleJellyfinProgress) return Response.json(bundledWatch);
		}
		if (path.endsWith("/watch-enrichment")) return Response.json({ configured: false, items: {} });
		if (path.endsWith("/series-progress"))
			return Response.json({ configured: false, progress: {} });
		throw new Error(`Unexpected synthetic path: ${path}`);
	});
	const arrResponse = (empty = false, series = false) =>
		Response.json({
			items: empty
				? []
				: [
						{
							id: 1,
							instanceId: "synthetic-arr",
							instanceName: "Synthetic",
							service: series ? "sonarr" : "radarr",
							type: series ? "series" : "movie",
							remoteIds: series ? { tmdbId: 42 } : undefined,
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
	const element = () => (
		<QueryClientProvider client={client}>
			<SearchParamsContext.Provider value={new URLSearchParams()}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LibraryClient />
					</IncognitoProvider>
				</ColorThemeProvider>
			</SearchParamsContext.Provider>
		</QueryClientProvider>
	);
	return {
		arr,
		filteredArr,
		native,
		reload,
		heldRead,
		arrResponse,
		requests,
		insights: () => requests.filter((path) => insightPaths.includes(path)),
		render: () => {
			const view = render(element());
			return { ...view, rerenderLibrary: () => view.rerender(element()) };
		},
	};
}

describe("Library primary-read priority with real query hooks", () => {
	it.each([
		["/api/plex/watch-enrichment", () => Response.json({ items: {} })],
		[
			plexProgressPath,
			() => Response.json({ error: "Synthetic progress failure" }, { status: 503 }),
		],
		[jellyfinWatchPath, () => Response.json(bundledWatch)],
		[jellyfinProgressPath, () => Response.json(emptyProgress)],
	] as const)("waits for cold %s before Insights", async (path, result) => {
		const needsJellyfinFallback = path === jellyfinProgressPath;
		const f = fixture({
			holdRead: path,
			bundleJellyfinProgress: !needsJellyfinFallback,
			pairedWatchError: needsJellyfinFallback,
		});
		f.render();
		await act(async () => {
			f.arr.resolve(f.arrResponse(false, true));
			f.native.resolve(Response.json(nativeInventory));
		});
		await waitFor(() => {
			expect(f.requests).toContain(plexProgressPath);
			expect(f.requests).toContain(jellyfinWatchPath);
			expect(f.requests).toContain(path);
		});
		expect(f.insights()).toEqual([]);

		await act(async () => f.heldRead.resolve(result()));
		await waitFor(() => expect(f.insights().sort()).toEqual([...insightPaths].sort()));
		if (!needsJellyfinFallback) expect(f.requests).not.toContain(jellyfinProgressPath);
	});

	it("starts Insights while retained Plex progress refreshes", async () => {
		const f = fixture({ holdRead: plexProgressPath, bundleJellyfinProgress: true });
		const progressKey = plexKeys.seriesProgress("42");
		client.setQueryData(progressKey, emptyProgress, { updatedAt: Date.now() - 10 * 60_000 });
		f.render();
		await act(async () => {
			f.arr.resolve(f.arrResponse(false, true));
			f.native.resolve(Response.json(nativeInventory));
		});
		await waitFor(() => expect(f.insights().sort()).toEqual([...insightPaths].sort()));
		expect(f.requests).toContain(plexProgressPath);
		expect(client.getQueryState(progressKey)?.fetchStatus).toBe("fetching");
		await act(async () => f.heldRead.resolve(Response.json(emptyProgress)));
	});

	it.each(["success", "error"] as const)(
		"admits paired Jellyfin watch and Plex progress after native %s",
		async (result) => {
			const f = fixture({ pairedWatchError: result === "error" });
			f.render();
			await waitFor(() => expect(f.requests).toContain("/api/library/provider-inventory"));
			await act(async () => f.arr.resolve(f.arrResponse(false, true)));
			expect(await screen.findByText("Synthetic ARR row")).toBeVisible();
			await waitFor(() => expect(f.requests).toContain("/api/plex/watch-enrichment"));
			expect(f.requests).not.toContain("/api/jellyfin/watch-enrichment");
			expect(f.requests).not.toContain("/api/jellyfin/series-progress");
			expect(f.requests).not.toContain("/api/plex/series-progress");

			await act(async () =>
				f.native.resolve(
					result === "success"
						? Response.json(nativeInventory)
						: Response.json({ error: "Synthetic unavailable" }, { status: 503 }),
				),
			);
			await waitFor(() => {
				expect(f.requests).toContain("/api/jellyfin/watch-enrichment");
				expect(f.requests).toContain("/api/plex/series-progress");
			});
			if (result === "error") {
				await waitFor(() => expect(f.requests).toContain("/api/jellyfin/series-progress"));
				expect(f.requests.indexOf("/api/jellyfin/series-progress")).toBeGreaterThan(
					f.requests.indexOf("/api/jellyfin/watch-enrichment"),
				);
			}
		},
	);

	it.each(["success", "error"] as const)(
		"waits for a newly selected episode inventory before admitting watch reads on %s",
		async (result) => {
			const f = fixture({ bundleJellyfinProgress: true });
			f.render();
			await act(async () => f.native.resolve(Response.json(nativeInventory)));
			expect(await screen.findByText("Synthetic native row")).toBeVisible();

			fireEvent.change(screen.getByRole("combobox", { name: "Inventory domain" }), {
				target: { value: "episode" },
			});
			await waitFor(() =>
				expect(
					f.requests.filter((path) => path === "/api/library/provider-inventory"),
				).toHaveLength(2),
			);
			await act(async () => f.arr.resolve(f.arrResponse(false, true)));
			await waitFor(() => expect(f.requests).toContain("/api/plex/watch-enrichment"));
			expect(f.requests).not.toContain(jellyfinWatchPath);
			expect(f.requests).not.toContain(plexProgressPath);
			expect(f.requests).not.toContain(jellyfinProgressPath);

			await act(async () =>
				f.reload.resolve(
					result === "success"
						? Response.json(nativeInventory)
						: Response.json({ error: "Synthetic unavailable" }, { status: 503 }),
				),
			);
			await waitFor(() => {
				expect(f.requests).toContain(jellyfinWatchPath);
				expect(f.requests).toContain(plexProgressPath);
			});
		},
	);

	it("keeps a cold inventory selection ahead of watch reads when ARR data arrives in the same render", async () => {
		const f = fixture({ bundleJellyfinProgress: true });
		const view = f.render();
		await act(async () => f.native.resolve(Response.json(nativeInventory)));
		expect(await screen.findByText("Synthetic native row")).toBeVisible();

		const arrQueries = client.getQueryCache().findAll({
			queryKey: ["library"],
			predicate: ({ queryKey }) => queryKey.length === 2 && typeof queryKey[1] === "object",
		});
		expect(arrQueries).toHaveLength(1);
		const arrData = await f.arrResponse(false, true).json();
		notifyManager.setScheduler((callback) => callback());
		try {
			await act(async () => {
				flushSync(() => {
					client.setQueryData(arrQueries[0]!.queryKey, arrData);
					fireEvent.change(screen.getByRole("combobox", { name: "Inventory domain" }), {
						target: { value: "episode" },
					});
					view.rerenderLibrary();
				});
			});
		} finally {
			notifyManager.setScheduler((callback) => setTimeout(callback, 0));
		}
		await waitFor(() => {
			expect(f.requests.filter((path) => path === "/api/library/provider-inventory")).toHaveLength(
				2,
			);
			expect(f.requests).toContain("/api/plex/watch-enrichment");
		});
		expect(f.requests).not.toContain(jellyfinWatchPath);
		expect(f.requests).not.toContain(plexProgressPath);

		await act(async () => {
			f.reload.resolve(Response.json(nativeInventory));
			f.arr.resolve(f.arrResponse(false, true));
		});
		await waitFor(() => expect(f.requests).toContain(jellyfinWatchPath));
		expect(f.requests).toContain(plexProgressPath);
	});

	it("admits watch reads while retained inventory refreshes", async () => {
		const f = fixture({ bundleJellyfinProgress: true });
		f.render();
		await act(async () => f.native.resolve(Response.json(nativeInventory)));
		expect(await screen.findByText("Synthetic native row")).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
		await waitFor(() =>
			expect(f.requests.filter((path) => path === "/api/library/provider-inventory")).toHaveLength(
				2,
			),
		);
		await act(async () => f.arr.resolve(f.arrResponse(false, true)));
		await waitFor(() => {
			expect(f.requests).toContain(jellyfinWatchPath);
			expect(f.requests).toContain(plexProgressPath);
		});
		expect(screen.getByText("Synthetic native row")).toBeVisible();
		await act(async () => f.reload.resolve(Response.json(nativeInventory)));
	});

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
