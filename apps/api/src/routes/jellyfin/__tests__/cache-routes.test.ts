import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	requireClient: vi.fn(),
	createSnapshot: vi.fn(),
	refresh: vi.fn(),
	singleflight: vi.fn(),
}));

vi.mock("../../../lib/jellyfin/jellyfin-helpers.js", () => ({
	requireJellyfinClient: routeMocks.requireClient,
}));
vi.mock("../../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	createOwnedJellyfinPublicationSnapshot: routeMocks.createSnapshot,
	refreshJellyfinCache: routeMocks.refresh,
}));
vi.mock("../../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: routeMocks.singleflight,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("GET /api/jellyfin/cache/health", () => {
	let app: FastifyInstance;
	const successfulAt = new Date("2025-08-03T12:00:00.000Z");
	const failedAt = new Date("2025-08-03T12:05:00.000Z");
	const statuses = [
		{
			id: "status-jellyfin",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			lastRefreshedAt: successfulAt,
			lastResult: "success",
			lastErrorMessage: "Jellyfin item scan was incomplete",
			itemCount: 17,
			generationId: "jellyfin-generation-1",
			generationMetadata: '{"sections":["TV"]}',
			lastAttemptAt: failedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "Jellyfin item scan was incomplete",
		},
		{
			id: "status-emby",
			instanceId: "emby-1",
			cacheType: "jellyfin_episode",
			lastRefreshedAt: successfulAt,
			lastResult: "success",
			lastErrorMessage: "Emby episode scan failed",
			itemCount: 23,
			generationId: "emby-generation-1",
			generationMetadata: '{"sections":["Shows"]}',
			lastAttemptAt: failedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "Emby episode scan failed",
		},
	];

	beforeEach(async () => {
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{ id: "jellyfin-1", label: "Jellyfin" },
					{ id: "emby-1", label: "Emby" },
				]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue(statuses),
			},
		} as never);
		await app.register(registerCacheRoutes, { prefix: "/api/jellyfin" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("reports preserved Jellyfin and Emby generations as degraded after newer failed attempts", async () => {
		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/cache/health");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			items: [
				{
					instanceId: "jellyfin-1",
					instanceName: "Jellyfin",
					cacheType: "jellyfin",
					lastRefreshedAt: successfulAt.toISOString(),
					lastResult: "partial",
					lastErrorMessage: "Jellyfin item scan was incomplete",
					itemCount: 17,
					isStale: true,
				},
				{
					instanceId: "emby-1",
					instanceName: "Emby",
					cacheType: "jellyfin_episode",
					lastRefreshedAt: successfulAt.toISOString(),
					lastResult: "partial",
					lastErrorMessage: "Emby episode scan failed",
					itemCount: 23,
					isStale: true,
				},
			],
		});
		expect(statuses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					generationId: "jellyfin-generation-1",
					generationMetadata: '{"sections":["TV"]}',
				}),
				expect.objectContaining({
					generationId: "emby-generation-1",
					generationMetadata: '{"sections":["Shows"]}',
				}),
			]),
		);
	});
});

describe("POST /api/jellyfin/cache/:instanceId/refresh", () => {
	let app: FastifyInstance;
	const helperClient = { source: "caller-supplied-client" };
	const storedInstance = { id: "jellyfin-1", service: "JELLYFIN" };
	const publicationInstance = { id: "jellyfin-1", identityGeneration: 4 };

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.requireClient.mockResolvedValue({ client: helperClient, instance: storedInstance });
		routeMocks.createSnapshot.mockReturnValue(publicationInstance);
		routeMocks.refresh.mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 3,
			errors: 0,
		});
		routeMocks.singleflight.mockImplementation(
			async (_authority: unknown, refresh: () => Promise<unknown>) => await refresh(),
		);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerCacheRoutes, { prefix: "/api/jellyfin" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("passes only the sealed owned snapshot to singleflight and publication", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/jellyfin-1/refresh",
		);

		expect(response.statusCode).toBe(200);
		expect(routeMocks.createSnapshot).toHaveBeenCalledWith(app.encryptor, storedInstance);
		expect(routeMocks.singleflight).toHaveBeenCalledWith(
			publicationInstance,
			expect.any(Function),
			expect.objectContaining({ prisma: app.prisma }),
		);
		expect(routeMocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ prisma: app.prisma, instance: publicationInstance }),
		);
		expect(routeMocks.refresh.mock.calls.flat()).not.toContain(helperClient);
	});
});
