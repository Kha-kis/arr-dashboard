import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	requireClient: vi.fn(),
	createSnapshot: vi.fn(),
	refresh: vi.fn(),
	recordFailure: vi.fn(),
	loadPersistedGeneration: vi.fn(),
	count: vi.fn(),
	findStatus: vi.fn(),
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
vi.mock("../../../lib/tautulli/tautulli-evidence-repository.js", () => ({
	loadPersistedTautulliGeneration: routeMocks.loadPersistedGeneration,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("Tautulli cache routes", () => {
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
		routeMocks.count.mockResolvedValue(2);
		routeMocks.findStatus.mockResolvedValue(null);
		routeMocks.loadPersistedGeneration.mockResolvedValue({
			ok: false,
			reasonCode: "publication_integrity_mismatch",
		});
		app.decorate("prisma", {
			tautulliCache: { count: routeMocks.count },
			cacheRefreshStatus: { findUnique: routeMocks.findStatus },
		} as never);
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

	it("does not report a metadata-only generation as current when persisted roots fail", async () => {
		const root = { version: 1, count: 2, digest: "a".repeat(64) };
		const refreshedAt = new Date("2026-08-27T12:00:00.000Z");
		routeMocks.findStatus.mockResolvedValue({
			lastResult: "success",
			lastRefreshedAt: refreshedAt,
			lastAttemptAt: refreshedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			lastErrorMessage: null,
			generationId: "generation-1",
			generationMetadata: JSON.stringify({
				version: 1,
				provider: "tautulli",
				generationId: "generation-1",
				publicationLevel: "authoritative",
				completeness: { targetCatalog: root, observations: root, aggregate: root },
				connectionGeneration: 4,
				identityGeneration: 2,
				capabilities: ["exact-target-observations"],
				partialReasons: [],
			}),
			itemCount: 2,
			connectionGeneration: 4,
			identityGeneration: 2,
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/tautulli/cache/tautulli-1/status",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			publicationState: "unavailable",
			reasonCode: "publication_integrity_mismatch",
		});
		expect(routeMocks.loadPersistedGeneration).toHaveBeenCalled();
	});

	it("redacts legacy free-form errors from the status response", async () => {
		const sensitive = "rating_key=8675309 tmdb://12345 https://private";
		routeMocks.findStatus.mockResolvedValue({
			lastResult: "success",
			lastRefreshedAt: new Date("2026-08-27T12:00:00.000Z"),
			lastAttemptAt: new Date("2026-08-27T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: sensitive,
			lastErrorMessage: sensitive,
			generationId: null,
			generationMetadata: null,
			itemCount: 2,
			connectionGeneration: 4,
			identityGeneration: 2,
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/tautulli/cache/tautulli-1/status",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ attempt: { reasonCode: "legacy_error_redacted" } });
		expect(response.body).not.toMatch(/8675309|12345|private/);
	});
});
