import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	health: vi.fn(),
	refreshWithAttempt: vi.fn(),
	singleflightWithAttempt: vi.fn(),
	claim: vi.fn(),
	start: vi.fn(),
	recovery: { admit: vi.fn(), arm: vi.fn() },
}));

vi.mock("../../../lib/jellyfin/jellyfin-cache-health.js", () => ({
	readOwnedJellyfinCacheHealthSources: routeMocks.health,
}));
vi.mock("../../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	refreshOwnedJellyfinCacheWithAttempt: routeMocks.refreshWithAttempt,
}));
vi.mock("../../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlightWithAttempt: routeMocks.singleflightWithAttempt,
}));
vi.mock("../../../lib/provider-observation/background-cache-refresh.js", () => ({
	startProviderCacheRefreshInBackground: routeMocks.start,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: routeMocks.claim,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("GET /api/jellyfin/cache/health", () => {
	let app: FastifyInstance;
	const instances = [
		{
			id: "jellyfin-1",
			label: "Jellyfin",
			service: "JELLYFIN",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		},
		{
			id: "emby-1",
			label: "Emby",
			service: "EMBY",
			createdAt: new Date("2026-01-02T00:00:00.000Z"),
		},
	];
	const healthItem = {
		instanceId: "jellyfin-1",
		instanceName: "Jellyfin",
		cacheType: "jellyfin",
		lastRefreshedAt: "2026-09-03T10:00:00.000Z",
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 17,
		isStale: false,
	};

	beforeEach(async () => {
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue(instances),
			},
		} as never);
		routeMocks.health.mockResolvedValue([{ item: healthItem, fallbackObservedAt: null }]);
		await app.register(registerCacheRoutes, { prefix: "/api/jellyfin" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("discovers enabled owned sources and projects only public health items", async () => {
		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/cache/health");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			items: [healthItem],
		});
		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
			},
			select: { id: true, label: true, service: true, createdAt: true },
		});
		expect(routeMocks.health).toHaveBeenCalledTimes(1);
		expect(routeMocks.health).toHaveBeenCalledWith({
			prisma: app.prisma,
			userId: "user-1",
			instances,
		});
	});

	it("returns an empty response when no owned source is configured", async () => {
		const findMany = app.prisma.serviceInstance.findMany as unknown as ReturnType<typeof vi.fn>;
		findMany.mockResolvedValueOnce([]);
		routeMocks.health.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/cache/health");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ items: [] });
		expect(routeMocks.health).toHaveBeenLastCalledWith({
			prisma: app.prisma,
			userId: "user-1",
			instances: [],
		});
	});
});

describe("POST /api/jellyfin/cache/:instanceId/refresh", () => {
	let app: FastifyInstance;
	const storedInstance = {
		id: "jellyfin-1",
		userId: "user-1",
		service: "JELLYFIN",
		enabled: true,
		baseUrl: "https://jellyfin.example.invalid",
		encryptedApiKey: "encrypted-key",
		encryptionIv: "key-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "jellyfin-server-1",
		identityStatus: "VERIFIED",
		connectionGeneration: 7,
		identityGeneration: 4,
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.refreshWithAttempt.mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 3,
			errors: 0,
		});
		routeMocks.claim.mockResolvedValue({
			status: "acquired",
			attempt: {
				attemptedAt: new Date("2026-09-05T00:00:00.000Z"),
				resultMarker: "in_progress:123e4567-e89b-42d3-a456-426614174000",
			},
		});
		routeMocks.singleflightWithAttempt.mockImplementation(
			async (
				_authority: unknown,
				_cacheType: unknown,
				_attempt: unknown,
				refresh: () => Promise<unknown>,
			) => await refresh(),
		);
		routeMocks.start.mockImplementation(
			async (options: {
				claim: () => Promise<unknown>;
				produce: (attempt: unknown) => Promise<unknown>;
			}) => {
				const claim = await options.claim();
				const backgroundTask = Promise.resolve().then(() => {
					if (
						typeof claim === "object" &&
						claim !== null &&
						"status" in claim &&
						claim.status === "acquired" &&
						"attempt" in claim
					) {
						return options.produce((claim as { attempt: unknown }).attempt);
					}
				});
				return { accepted: true, backgroundTask };
			},
		);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(storedInstance),
			},
		} as never);
		app.decorate("encryptor", {} as never);
		app.decorate("libraryRefreshRecovery", routeMocks.recovery as never);
		registerTestErrorHandler(app);
		await app.register(registerCacheRoutes, { prefix: "/api/jellyfin" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns exact durable acceptance and passes the claim through singleflight", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/jellyfin-1/refresh",
		);

		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "jellyfin" });
		expect(app.prisma.serviceInstance.findFirst).toHaveBeenCalledWith({
			where: { id: "jellyfin-1", userId: "user-1", enabled: true },
		});
		expect(routeMocks.singleflightWithAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				id: storedInstance.id,
				userId: storedInstance.userId,
				service: storedInstance.service,
				baseUrl: storedInstance.baseUrl,
				encryptedApiKey: storedInstance.encryptedApiKey,
				expectedIdentity: storedInstance.expectedIdentity,
			}),
			"jellyfin",
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
			expect.any(Function),
		);
		expect(routeMocks.refreshWithAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance: storedInstance,
			}),
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
		expect(routeMocks.singleflightWithAttempt.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
		expect(routeMocks.singleflightWithAttempt.mock.calls[0]?.[0]).not.toHaveProperty(
			"httpAuthHeaders",
		);
		expect(routeMocks.start.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				recovery: expect.objectContaining({
					provider: "jellyfin",
					userId: "user-1",
					instanceId: storedInstance.id,
					handoff: routeMocks.recovery,
				}),
			}),
		);
	});

	it("returns before a deferred producer settles", async () => {
		let resolveProducer!: () => void;
		routeMocks.refreshWithAttempt.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveProducer = resolve;
			}),
		);
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/jellyfin-1/refresh",
		);
		expect(response.statusCode).toBe(202);
		expect(routeMocks.refreshWithAttempt).toHaveBeenCalledTimes(1);
		resolveProducer();
	});

	it("does not dispatch a producer for an already-running claim", async () => {
		routeMocks.claim.mockResolvedValueOnce({
			status: "already-running",
			attempt: {
				attemptedAt: new Date(),
				resultMarker: "in_progress:123e4567-e89b-42d3-a456-426614174000",
			},
		});
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/jellyfin-1/refresh",
		);
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "jellyfin" });
		expect(routeMocks.refreshWithAttempt).not.toHaveBeenCalled();
	});

	it("returns 404 for a missing or unowned enabled instance", async () => {
		const findFirst = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		findFirst.mockResolvedValueOnce(null);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/missing/refresh",
		);

		expect(response.statusCode).toBe(404);
		expect(response.json().error).toBe("InstanceNotFoundError");
		expect(routeMocks.refreshWithAttempt).not.toHaveBeenCalled();
		expect(routeMocks.claim).not.toHaveBeenCalled();
		expect(routeMocks.start).not.toHaveBeenCalled();
	});

	it("rejects an owned enabled instance of the wrong service", async () => {
		const findFirst = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		findFirst.mockResolvedValueOnce({ ...storedInstance, service: "PLEX" });

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/jellyfin/cache/jellyfin-1/refresh",
		);

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toBe("AppValidationError");
		expect(routeMocks.refreshWithAttempt).not.toHaveBeenCalled();
		expect(routeMocks.claim).not.toHaveBeenCalled();
		expect(routeMocks.start).not.toHaveBeenCalled();
	});
});
