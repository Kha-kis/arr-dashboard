import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	requireClient: vi.fn(),
	createSnapshot: vi.fn(),
	refresh: vi.fn(),
	recordFailure: vi.fn(),
}));

vi.mock("../../../lib/tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: routeMocks.requireClient,
}));
vi.mock("../../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	createOwnedTautulliPublicationSnapshot: routeMocks.createSnapshot,
	refreshTautulliCache: routeMocks.refresh,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	recordWatchProviderCacheRefreshFailure: routeMocks.recordFailure,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/tautulli/cache/:instanceId/refresh", () => {
	let app: FastifyInstance;
	const helperClient = { source: "caller-supplied-client" };
	const storedInstance = { id: "tautulli-1", service: "TAUTULLI" };
	const publicationInstance = { id: "tautulli-1", identityGeneration: 6 };

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.requireClient.mockResolvedValue({ client: helperClient, instance: storedInstance });
		routeMocks.createSnapshot.mockReturnValue(publicationInstance);
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

	it("publishes from the sealed owned snapshot without forwarding the helper client", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/tautulli/cache/tautulli-1/refresh",
		);

		expect(response.statusCode).toBe(200);
		expect(routeMocks.createSnapshot).toHaveBeenCalledWith(app.encryptor, storedInstance);
		expect(routeMocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ prisma: app.prisma, instance: publicationInstance }),
		);
		expect(routeMocks.refresh.mock.calls.flat()).not.toContain(helperClient);
		expect(routeMocks.recordFailure).not.toHaveBeenCalled();
	});
});
