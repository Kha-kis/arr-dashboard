import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	createSnapshot: vi.fn((_encryptor: unknown, instance: unknown) => ({ sealed: instance })),
	refresh: vi.fn(),
	requireClient: vi.fn(),
	recordFailure: vi.fn(),
}));

vi.mock("../../../lib/plex/plex-cache-refresher.js", () => ({
	createOwnedPlexPublicationSnapshot: mocks.createSnapshot,
	refreshPlexCache: mocks.refresh,
}));
vi.mock("../../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: mocks.requireClient,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	recordPlexCacheRefreshFailure: mocks.recordFailure,
	recordProviderCacheRefreshFailure: mocks.recordFailure,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/plex/cache/:instanceId/refresh publication authority", () => {
	let app: FastifyInstance;
	const instance = { id: "plex-1", service: "PLEX", connectionGeneration: 4 };

	beforeEach(async () => {
		mocks.createSnapshot.mockClear();
		mocks.refresh.mockReset().mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 1,
			errors: 0,
			errorMessages: [],
		});
		mocks.requireClient.mockReset().mockResolvedValue({
			client: { server: "caller-controlled" },
			instance,
		});
		mocks.recordFailure.mockReset();

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", { plexCache: { count: vi.fn() } } as never);
		app.decorate("encryptor", { decrypt: vi.fn() } as never);
		await app.register(registerCacheRoutes, { prefix: "/api/plex" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("passes only the owned snapshot to the sealed refresher", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");

		expect(response.statusCode).toBe(200);
		expect(mocks.createSnapshot).toHaveBeenCalledWith(app.encryptor, instance);
		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: app.prisma,
			instance: { sealed: instance },
			log: expect.anything(),
		});
		expect(mocks.refresh.mock.calls[0]).not.toContainEqual({ server: "caller-controlled" });
	});

	it("records an incomplete attempt only through its full publication snapshot", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["identity unavailable"],
		});

		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");

		expect(response.statusCode).toBe(200);
		expect(mocks.recordFailure).toHaveBeenCalledWith(
			app.prisma,
			"plex",
			"identity unavailable",
			{ sealed: instance },
			expect.anything(),
		);
	});
});
