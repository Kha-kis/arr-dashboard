import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	findInstance: vi.fn(),
	refresh: vi.fn(),
	readAuthority: vi.fn(),
}));

vi.mock("../../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: routeMocks.refresh,
}));
vi.mock("../../../lib/tautulli/tautulli-cache-authority.js", () => ({
	findOwnedEnabledTautulliInstance: routeMocks.findInstance,
	readOwnedTautulliCacheAuthority: routeMocks.readAuthority,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/tautulli/cache/:instanceId/refresh", () => {
	let app: FastifyInstance;
	const storedInstance = { id: "tautulli-1", service: "TAUTULLI" };

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.findInstance.mockResolvedValue(storedInstance);
		routeMocks.readAuthority.mockResolvedValue({
			available: true,
			state: "healthy_complete",
			reasonCodes: [],
			cachedItems: 5,
			lastRefreshedAt: new Date("2026-08-28T11:00:00.000Z"),
		});
		routeMocks.refresh.mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 5,
			errors: 0,
			errorMessages: [],
		});
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerCacheRoutes, { prefix: "/api/tautulli" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("owns the attempt before the refresher decrypts the stored instance", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/tautulli/cache/tautulli-1/refresh",
		);

		expect(response.statusCode).toBe(200);
		expect(routeMocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance: storedInstance,
			}),
		);
	});

	it("returns the bounded shared currentness projection", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/tautulli/cache/tautulli-1/status",
		);

		expect(response.statusCode).toBe(200);
		expect(routeMocks.readAuthority).toHaveBeenCalledWith(app.prisma, {
			userId: "user-1",
			instanceId: "tautulli-1",
		});
		expect(response.json()).toEqual({
			instanceId: "tautulli-1",
			available: true,
			state: "healthy_complete",
			reasonCodes: [],
			cachedItems: 5,
			hasCacheData: true,
			lastRefreshedAt: "2026-08-28T11:00:00.000Z",
		});
	});
});
