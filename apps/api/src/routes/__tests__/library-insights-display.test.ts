import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({ plex: vi.fn(), jellyfin: vi.fn(), requests: vi.fn() }));
vi.mock("../../lib/plex/plex-authority-service.js", async (original) => ({
	...(await original<typeof import("../../lib/plex/plex-authority-service.js")>()),
	PlexAuthorityService: class {
		readUserSelectedDisplay = mocks.plex;
		scanUserPolicy = mocks.plex;
	},
}));
vi.mock("../../lib/jellyfin/jellyfin-display-evidence.js", async (original) => ({
	...(await original<typeof import("../../lib/jellyfin/jellyfin-display-evidence.js")>()),
	readOwnedJellyfinLibraryDisplaySources: mocks.jellyfin,
}));
vi.mock("../../lib/seerr/seerr-client.js", () => ({
	SeerrClient: class {
		getRequests = mocks.requests;
	},
}));
import { registerInsightsRoutes } from "../library/insights-routes.js";

function status(complete: boolean, current = true) {
	return {
		availability: current ? "current" : "last-known",
		evidence: complete ? "complete" : "positive-only",
		observedAt: "2026-09-15T00:00:00.000Z",
		ageSeconds: 0,
		latestAttempt: "successful",
		reasonCodes: [],
		domains: [
			{
				domain: "watch-count",
				availability: current ? "current" : "last-known",
				evidence: complete ? "complete" : "positive-only",
				valueSemantics: complete ? "exact" : "lower-bound",
				reasonCodes: [],
			},
		],
	};
}
const row = (watchCount: unknown) => ({
	tmdbId: 42,
	mediaType: "movie",
	watchCount,
	lastWatchedAt: null,
	watchedByUsers: "[]",
});
const source = (rows: unknown[], complete = false, current = true) => ({
	available: true,
	instanceId: "plex-1",
	rows,
	providerStatus: status(complete, current),
	evidence: {
		availability: current ? "current" : "last-known",
		authority: complete ? "authoritative" : "unavailable",
		attemptState: "idle",
		publicationLevel: complete ? "authoritative" : "positive-only",
		completeness: complete ? "complete" : "partial",
		reasonCodes: [],
	},
});
const candidate = (id = 42, data: unknown = { remoteIds: { tmdbId: id } }) => ({
	instanceId: "arr-1",
	arrItemId: id,
	itemType: "movie",
	title: "Candidate",
	year: 2024,
	sizeOnDisk: 2147483648n,
	arrAddedAt: new Date("2026-01-01"),
	monitored: true,
	qualityProfileName: "HD",
	hasFile: true,
	data: JSON.stringify(data),
});

describe("watch insight display without whole-endpoint evidence failures", () => {
	let app: FastifyInstance;
	let candidates: ReturnType<typeof candidate>[];
	let jellyfinInstances: Array<{ id: string; label: string; service: string }>;
	beforeEach(async () => {
		vi.resetAllMocks();
		candidates = [candidate()];
		jellyfinInstances = [];
		mocks.plex.mockResolvedValue([source([])]);
		mocks.jellyfin.mockResolvedValue({ sources: [], providerStatus: undefined });
		mocks.requests.mockResolvedValue({
			results: [
				{
					media: { tmdbId: 42 },
					type: "movie",
					requestedBy: { displayName: "Requester" },
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(
					async ({ where }: { where: { userId: string; service: { in: string[] } } }) => {
						expect(where.userId).toBe("user-1");
						return where.service.in.includes("SONARR")
							? [{ id: "arr-1", label: "ARR", service: "RADARR" }]
							: jellyfinInstances;
					},
				),
				findFirst: vi.fn(async () => ({ id: "seerr-1", service: "SEERR" })),
			},
			libraryCache: { findMany: vi.fn(async () => candidates) },
		} as never);
		await app.register(registerInsightsRoutes, { prefix: "/api" });
		await app.ready();
	});
	afterEach(async () => {
		await app.close();
	});
	const get = (app: FastifyInstance, route: string) =>
		createInjectAuthenticated(app)("GET", `/api/library/insights/${route}`);
	it.each(["disk-waste", "requested-unwatched"])(
		"keeps %s candidate facts when watch evidence is partial",
		async (route) => {
			const response = await get(app, route);
			expect(response.statusCode).toBe(200);
			expect(response.json().data).toMatchObject({
				items: [],
				unknownItems: [{ arrItemId: 42, watchState: "unknown" }],
				watchStatus: "partial",
			});
			if (route === "disk-waste") expect(response.json().data.totalWastedBytes).toBeNull();
			else
				expect(response.json().data).toMatchObject({
					hasSeerrData: true,
					requestStatus: "complete",
				});
			expect(app.prisma.libraryCache.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ instance: { userId: "user-1" } }),
				}),
			);
		},
	);
	it.each(["disk-waste", "requested-unwatched"])(
		"requires explicit current exact zeros for %s",
		async (route) => {
			mocks.plex.mockResolvedValue([source([row(0)], true)]);
			const response = await get(app, route);
			expect(response.statusCode).toBe(200);
			expect(response.json().data).toMatchObject({
				items: [{ arrItemId: 42, watchState: "unwatched" }],
				unknownItems: [],
				watchStatus: "complete",
			});
		},
	);
	it.each(["disk-waste", "requested-unwatched"])(
		"excludes known watched items even with another missing provider for %s",
		async (route) => {
			mocks.plex.mockResolvedValue([
				source([row(3)]),
				{ ...source([], false), instanceId: "plex-2", available: false },
			]);
			const response = await get(app, route);
			expect(response.statusCode).toBe(200);
			expect(response.json().data).toMatchObject({
				items: [],
				unknownItems: [],
				watchStatus: "partial",
			});
		},
	);
	it.each([undefined, -1, NaN, 0.5, "0"])(
		"does not convert an invalid count %s to unwatched",
		async (count) => {
			mocks.plex.mockResolvedValue([source([row(count)], true)]);
			const response = await get(app, "disk-waste");
			expect(response.statusCode).toBe(200);
			expect(response.json().data).toMatchObject({
				items: [],
				unknownItems: [{ watchState: "unknown" }],
			});
		},
	);
	it("retains unmapped ARR files as unknown and exposes the candidate bound", async () => {
		candidates = [candidate(1, {}), candidate(2), candidate(3), candidate(4)];
		mocks.plex.mockResolvedValue([source([row(0)], true)]);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/disk-waste?limit=1",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			items: [],
			unknownItems: [{ arrItemId: 1, watchState: "unknown" }],
			limited: true,
			totalWastedBytes: null,
		});
	});
	it("requires a zero from every configured Jellyfin/Emby source", async () => {
		mocks.plex.mockResolvedValue([]);
		jellyfinInstances = [
			{ id: "jf-1", label: "JF", service: "JELLYFIN" },
			{ id: "jf-2", label: "Alias", service: "EMBY" },
		];
		mocks.jellyfin.mockResolvedValue({
			sources: [
				{ instanceId: "jf-1", rows: [row(0)] },
				{ instanceId: "jf-2", rows: [] },
			],
			providerStatus: {
				availability: "current",
				sources: jellyfinInstances.map((i) => ({
					instanceId: i.id,
					cacheType: "jellyfin",
					service: "jellyfin",
					status: status(true),
				})),
			},
		});
		const response = await get(app, "disk-waste");
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			items: [],
			unknownItems: [{ watchState: "unknown" }],
			watchStatus: "partial",
		});
	});
	it("does not use a last-known zero as current unwatched evidence", async () => {
		mocks.plex.mockResolvedValue([source([row(0)], true, false)]);
		const response = await get(app, "disk-waste");
		expect(response.statusCode).toBe(200);
		expect(response.json().data.items).toEqual([]);
		expect(response.json().data.unknownItems).toHaveLength(1);
	});
	it("distinguishes unavailable requests from no configured request service", async () => {
		mocks.requests.mockRejectedValue(new Error("private provider payload"));
		const response = await get(app, "requested-unwatched");
		expect(response.statusCode).toBe(200);
		expect(response.json().data.requestStatus).toBe("unavailable");
		expect(response.body).not.toContain("private provider payload");
	});
	it("keeps known Seerr requests after a later page fails and marks request coverage partial", async () => {
		mocks.requests
			.mockResolvedValueOnce({
				results: Array.from({ length: 50 }, () => ({
					media: { tmdbId: 42 },
					type: "movie",
					requestedBy: { displayName: "Requester" },
					createdAt: "2026-01-01T00:00:00.000Z",
				})),
			})
			.mockRejectedValueOnce(new Error("unavailable"));
		const response = await get(app, "requested-unwatched");
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			hasSeerrData: true,
			requestStatus: "partial",
			limited: true,
			items: [],
			unknownItems: [{ arrItemId: 42, watchState: "unknown" }],
		});
	});
	it("keeps configured but unavailable watch evidence distinct from no provider", async () => {
		mocks.plex.mockResolvedValue([
			{
				...source([]),
				available: false,
				providerStatus: { availability: "unavailable", evidence: "unknown", reasonCodes: [] },
			},
		]);
		const unavailable = await get(app, "disk-waste");
		expect(unavailable.json().data).toMatchObject({
			watchStatus: "unavailable",
			items: [],
			unknownItems: [{ watchState: "unknown" }],
			totalWastedBytes: null,
		});
		mocks.plex.mockResolvedValue([]);
		const absent = await get(app, "disk-waste");
		expect(absent.json().data).toMatchObject({
			watchStatus: "not-configured",
			items: [],
			unknownItems: [{ watchState: "unknown" }],
			totalWastedBytes: null,
		});
	});
	it("does not turn a database failure into an empty successful insight", async () => {
		vi.mocked(app.prisma.libraryCache.findMany).mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		const response = await get(app, "disk-waste");
		expect(response.statusCode).toBe(500);
		expect(response.json()).not.toHaveProperty("success", true);
	});
});
