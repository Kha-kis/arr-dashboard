import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { PlexClient } from "../../plex/plex-client.js";
import { runNativeInventoryJobSlice } from "../native-inventory-job-runner.js";
import { runDueNativeInventoryWork } from "../native-inventory-job-orchestration.js";

vi.mock("../native-inventory-job-runner.js", () => ({
	runNativeInventoryJobSlice: vi.fn(async (_prisma, _id, adapter, options) => {
		const page = await adapter.readPage(
			adapter.domain === "paired"
				? {
						domain: "episode",
						sectionKey: "1",
						sectionUuid: "uuid-1",
						sectionType: "show",
						scopeKey: '["1","uuid-1","show"]',
					}
				: { libraryId: "library-1", collectionType: "tvshows", scopeKey: "library:library-1" },
			0,
			1,
			options.deadlineAt,
		);
		return { status: page.status === "unavailable" ? "yielded" : "published", pagesCommitted: 0 };
	}),
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each([
	["JELLYFIN", "library"],
	["JELLYFIN", "episode"],
	["EMBY", "library"],
	["EMBY", "episode"],
] as const)(
	"contains all %s %s identity/discovery/page reads outside the parent",
	async (service, workKey) => {
		const requests: string[] = [];
		const authentication: boolean[] = [];
		const server = createServer((request, response) => {
			const path = new URL(request.url!, "http://synthetic.invalid").pathname;
			requests.push(path);
			authentication.push(
				request.method === "GET" &&
					request.headers.authorization?.includes('Token="synthetic-key"') === true,
			);
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify(
					path === "/System/Info"
						? { Id: "synthetic-id", ServerName: "Synthetic", Version: "1" }
						: path === "/Library/MediaFolders"
							? {
									TotalRecordCount: 1,
									Items: [
										{
											Id: "1",
											Name: "Synthetic",
											Type: "CollectionFolder",
											CollectionType: "tvshows",
										},
									],
								}
							: { TotalRecordCount: 0, StartIndex: 0, Items: [] },
				),
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Fixture unavailable");
		const identity = vi
			.spyOn(JellyfinClient.prototype, "getServerInfo")
			.mockRejectedValue(new Error("Parent identity forbidden"));
		const discovery = vi
			.spyOn(JellyfinClient.prototype, "getNativeMediaFolders")
			.mockRejectedValue(new Error("Parent discovery forbidden"));
		const page = vi
			.spyOn(JellyfinClient.prototype, "readNativeInventoryPage")
			.mockRejectedValue(new Error("Parent page forbidden"));
		vi.mocked(runNativeInventoryJobSlice).mockImplementationOnce(
			async (_prisma, _id, adapter, options) => {
				expect(await options.verifyIdentity()).toBe("verified");
				const scopes = await adapter.discoverScopes(options.deadlineAt);
				expect(scopes.status).toBe("ready");
				if (scopes.status !== "ready") throw new Error("Fixture discovery failed");
				expect(await adapter.readPage(scopes.scopes[0]!, 0, 1, options.deadlineAt)).toEqual({
					status: "page",
					domain: workKey,
					scopeKey: "library:1",
					startIndex: 0,
					totalRecordCount: 0,
					rawNativeIds: [],
					comparisonKeys: [],
					rows: [],
				});
				return { status: "yielded", pagesCommitted: 0 };
			},
		);
		const instance = {
			id: "instance-1",
			userId: "owner",
			service,
			enabled: true,
			identityStatus: "VERIFIED",
			expectedIdentity: "synthetic-id",
			connectionGeneration: 1,
			identityGeneration: 1,
			baseUrl: `http://127.0.0.1:${address.port}`,
			encryptedApiKey: "synthetic",
			encryptionIv: "synthetic",
		};
		const app = {
			prisma: {
				providerNativeInventoryRun: {
					findMany: async () => [
						{
							id: "run-1",
							instanceId: instance.id,
							workKey,
							updatedAt: new Date(),
							connectionGeneration: 1,
							identityGeneration: 1,
							instance,
						},
					],
				},
			},
			encryptor: { decrypt: () => "synthetic-key" },
			log: { warn: vi.fn(), info: vi.fn() },
		};
		try {
			expect(
				await runDueNativeInventoryWork(app as never, {
					maxRuns: 1,
					maxConcurrent: 1,
					maxPagesPerRun: 1,
					pageSize: 1,
					maxDurationMs: 5_000,
					retryDelayMs: 0,
				}),
			).toMatchObject({ retryable: 1 });
			expect(identity).not.toHaveBeenCalled();
			expect(discovery).not.toHaveBeenCalled();
			expect(page).not.toHaveBeenCalled();
			expect(requests).toEqual(["/System/Info", "/Library/MediaFolders", "/Items"]);
			expect(authentication).toEqual([true, true, true]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);

it("contains every Plex identity, discovery and page GET in workers", async () => {
	const requests: { method?: string; path: string }[] = [];
	const server = createServer((request, response) => {
		const path = new URL(request.url!, "http://synthetic.invalid").pathname;
		requests.push({ method: request.method, path });
		response.setHeader("Content-Type", "application/json");
		const container =
			path === "/identity"
				? { machineIdentifier: "synthetic-id", version: "1" }
				: path === "/activities"
					? { size: 0, Activity: [] }
					: path === "/library/sections"
						? {
								size: 1,
								Directory: [
									{
										key: "1",
										uuid: "uuid-1",
										title: "Synthetic",
										type: "show",
										refreshing: false,
										scannedAt: 10,
										updatedAt: 10,
									},
								],
							}
						: {
								offset: 0,
								size: 1,
								totalSize: 1,
								Metadata: [{ ratingKey: "s1", type: "show", title: "Synthetic" }],
							};
		response.end(JSON.stringify({ MediaContainer: container }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Synthetic fixture unavailable");
	const discovery = vi.spyOn(PlexClient.prototype, "getLibrarySettlementSections");
	const activities = vi.spyOn(PlexClient.prototype, "getActivities");
	const identity = vi.spyOn(PlexClient.prototype, "getIdentity");
	const directPage = vi
		.spyOn(PlexClient.prototype, "readNativeInventoryPage")
		.mockRejectedValue(new Error("Parent page path must not run"));
	let observed: unknown;
	vi.mocked(runNativeInventoryJobSlice).mockImplementationOnce(
		async (_prisma, _id, adapter, options) => {
			expect(await options!.verifyIdentity!()).toBe("verified");
			const scopes = await adapter.discoverScopes(options!.deadlineAt!);
			expect(scopes.status).toBe("ready");
			if (scopes.status !== "ready") throw new Error("Synthetic discovery failed");
			observed = await adapter.readPage(scopes.scopes[0]!, 0, 1, options!.deadlineAt!);
			return { status: "yielded", pagesCommitted: 0 };
		},
	);
	const app = {
		prisma: {
			providerNativeInventoryRun: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "run-1",
						instanceId: "instance-1",
						workKey: "paired",
						updatedAt: new Date(),
						connectionGeneration: 1,
						identityGeneration: 1,
						instance: {
							id: "instance-1",
							userId: "user-1",
							service: "PLEX",
							enabled: true,
							identityStatus: "VERIFIED",
							expectedIdentity: "synthetic-id",
							connectionGeneration: 1,
							identityGeneration: 1,
							baseUrl: `http://127.0.0.1:${address.port}`,
							encryptedApiKey: "synthetic",
							encryptionIv: "synthetic",
						},
					},
				]),
			},
		},
		encryptor: { decrypt: vi.fn().mockReturnValue("synthetic-key") },
		log: { warn: vi.fn(), info: vi.fn() },
	};
	try {
		expect(
			await runDueNativeInventoryWork(app as never, {
				maxRuns: 1,
				maxConcurrent: 1,
				maxPagesPerRun: 1,
				pageSize: 1,
				maxDurationMs: 5_000,
				retryDelayMs: 0,
			}),
		).toMatchObject({ retryable: 1, completed: 0 });
		expect(observed).toMatchObject({
			status: "page",
			domain: "library",
			rows: [{ nativeId: "s1", mediaType: "series" }],
		});
		expect(discovery).not.toHaveBeenCalled();
		expect(activities).not.toHaveBeenCalled();
		expect(identity).not.toHaveBeenCalled();
		expect(directPage).not.toHaveBeenCalled();
		expect(requests).toHaveLength(4);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		expect(requests.map((request) => request.path).sort()).toEqual([
			"/activities",
			"/identity",
			"/library/sections",
			"/library/sections/1/all",
		]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("releases dispatched Plex work after physically containing an abort-insensitive response body", async () => {
	let body: ReadableStreamDefaultController<Uint8Array> | undefined;
	let enteredBody = false;
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						body = controller;
					},
					pull() {
						enteredBody = true;
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const app = {
		prisma: {
			providerNativeInventoryRun: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "run-1",
						instanceId: "instance-1",
						workKey: "paired",
						updatedAt: new Date(),
						connectionGeneration: 1,
						identityGeneration: 1,
						instance: {
							id: "instance-1",
							service: "PLEX",
							enabled: true,
							identityStatus: "VERIFIED",
							connectionGeneration: 1,
							identityGeneration: 1,
							baseUrl: "http://synthetic.invalid",
							encryptedApiKey: "synthetic",
							encryptionIv: "synthetic",
						},
					},
				]),
			},
		},
		encryptor: { decrypt: vi.fn().mockReturnValue("synthetic-key") },
		log: { warn: vi.fn(), info: vi.fn() },
	};
	let settled = false;
	const pending = runDueNativeInventoryWork(app as never, {
		maxRuns: 1,
		maxConcurrent: 1,
		maxPagesPerRun: 1,
		pageSize: 1,
		maxDurationMs: 50,
		retryDelayMs: 0,
	}).finally(() => {
		settled = true;
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(settled).toBe(true);
		expect(await pending).toMatchObject({ retryable: 1, completed: 0 });
	} finally {
		if (enteredBody) body?.close();
		await pending;
	}
});

it.each(["library", "episode"])(
	"physically contains the dispatched native %s page instead of awaiting the parent client",
	async (workKey) => {
		let release: (() => void) | undefined;
		const direct = vi.spyOn(JellyfinClient.prototype, "readNativeInventoryPage").mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ status: "unavailable", reason: "provider-unavailable" });
				}),
		);
		const app = {
			prisma: {
				providerNativeInventoryRun: {
					findMany: vi.fn().mockResolvedValue([
						{
							id: "run-1",
							instanceId: "instance-1",
							workKey,
							updatedAt: new Date(),
							connectionGeneration: 1,
							identityGeneration: 1,
							instance: {
								id: "instance-1",
								service: "JELLYFIN",
								enabled: true,
								identityStatus: "VERIFIED",
								connectionGeneration: 1,
								identityGeneration: 1,
								baseUrl: "http://synthetic.invalid",
								encryptedApiKey: "synthetic",
								encryptionIv: "synthetic",
							},
						},
					]),
				},
			},
			encryptor: { decrypt: vi.fn().mockReturnValue("synthetic-key") },
			log: { warn: vi.fn() },
		};
		let settled = false;
		const pending = runDueNativeInventoryWork(app as never, {
			maxRuns: 1,
			maxConcurrent: 1,
			maxPagesPerRun: 1,
			pageSize: 1,
			maxDurationMs: 50,
			retryDelayMs: 0,
		}).then((value) => {
			settled = true;
			return value;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(settled).toBe(true);
			expect(direct).not.toHaveBeenCalled();
			expect(await pending).toMatchObject({ retryable: 1, completed: 0 });
		} finally {
			release?.();
			await pending;
		}
	},
);
