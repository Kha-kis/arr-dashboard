import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	findInstance: vi.fn(),
	refreshWithAttempt: vi.fn(),
	claim: vi.fn(),
	start: vi.fn(),
	readObservation: vi.fn(),
}));

vi.mock("../../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCacheWithAttempt: routeMocks.refreshWithAttempt,
}));
vi.mock("../../../lib/provider-observation/background-cache-refresh.js", () => ({
	startProviderCacheRefreshInBackground: routeMocks.start,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: routeMocks.claim,
}));
vi.mock("../../../lib/tautulli/tautulli-cache-authority.js", () => ({
	findOwnedEnabledTautulliInstance: routeMocks.findInstance,
}));
vi.mock("../../../lib/tautulli/tautulli-observation-repository.js", () => ({
	readOwnedTautulliObservation: routeMocks.readObservation,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/tautulli/cache/:instanceId/refresh", () => {
	let app: FastifyInstance;
	const storedInstance = { id: "tautulli-1", service: "TAUTULLI" };

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.findInstance.mockResolvedValue(storedInstance);
		routeMocks.readObservation.mockResolvedValue({
			instanceId: "tautulli-1",
			metadata: null,
			rows: [],
			providerStatus: {
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "idle",
				reasonCodes: ["no-publication"],
			},
		});
		routeMocks.refreshWithAttempt.mockResolvedValue({
			kind: "positive-observation",
			complete: false,
			upserted: 5,
			errors: 0,
			errorMessages: [],
		});
		routeMocks.claim.mockResolvedValue({
			status: "acquired",
			attempt: {
				attemptedAt: new Date("2026-09-05T00:00:00.000Z"),
				resultMarker: "in_progress:123e4567-e89b-42d3-a456-426614174000",
			},
		});
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
		app.decorate("prisma", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerCacheRoutes, { prefix: "/api/tautulli" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns exact durable acceptance and passes the claim to the adapter", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/tautulli/cache/tautulli-1/refresh",
		);

		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "tautulli" });
		expect(routeMocks.claim).toHaveBeenCalledWith(
			app.prisma,
			"tautulli",
			expect.objectContaining({ id: storedInstance.id }),
		);
		expect(routeMocks.refreshWithAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance: storedInstance,
			}),
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
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
			"/api/tautulli/cache/tautulli-1/refresh",
		);
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "tautulli" });
		expect(routeMocks.refreshWithAttempt).not.toHaveBeenCalled();
	});

	it("returns while a deferred producer is unsettled, then settles it explicitly", async () => {
		let resolveProducer!: () => void;
		routeMocks.refreshWithAttempt.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveProducer = resolve;
			}),
		);
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/tautulli/cache/tautulli-1/refresh",
		);
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "tautulli" });
		expect(routeMocks.refreshWithAttempt).toHaveBeenCalledTimes(1);
		resolveProducer();
		await Promise.resolve();
	});

	it("rejects a missing instance before claim or background admission", async () => {
		routeMocks.findInstance.mockResolvedValueOnce(null);
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/tautulli/cache/missing/refresh",
		);
		expect(response.statusCode).toBe(404);
		expect(routeMocks.claim).not.toHaveBeenCalled();
		expect(routeMocks.start).not.toHaveBeenCalled();
	});

	it("returns exactly provider status plus observed row count", async () => {
		routeMocks.readObservation.mockResolvedValueOnce({
			instanceId: "tautulli-1",
			metadata: null,
			rows: [{ id: "row-1" }],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				observedAt: "2026-09-05T00:00:00.000Z",
				ageSeconds: 300,
				latestAttempt: "successful",
				reasonCodes: ["positive-only"],
				domains: [
					{
						domain: "watch-count",
						availability: "current",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
						observedAt: "2026-09-05T00:00:00.000Z",
						reasonCodes: ["positive-only"],
					},
				],
			},
		});
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/tautulli/cache/tautulli-1/status",
		);

		expect(response.statusCode).toBe(200);
		expect(routeMocks.readObservation).toHaveBeenCalledWith(app.prisma, {
			userId: "user-1",
			instanceId: "tautulli-1",
		});
		expect(response.json()).toEqual({
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				observedAt: "2026-09-05T00:00:00.000Z",
				ageSeconds: 300,
				latestAttempt: "successful",
				reasonCodes: ["positive-only"],
				domains: [
					{
						domain: "watch-count",
						availability: "current",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
						observedAt: "2026-09-05T00:00:00.000Z",
						reasonCodes: ["positive-only"],
					},
				],
			},
			itemCount: 1,
		});
	});

	it.each([
		["partial", "positive-only", 2],
		["last-known", "positive-only", 1],
		["unavailable", "unknown", 0],
	] as const)(
		"preserves %s observation status and bounded count",
		async (availability, evidence, itemCount) => {
			routeMocks.readObservation.mockResolvedValueOnce({
				instanceId: "tautulli-1",
				metadata: null,
				rows: Array.from({ length: itemCount }, (_, index) => ({ id: `row-${index}` })),
				providerStatus: {
					availability,
					evidence,
					observedAt: availability === "unavailable" ? null : "2026-08-28T11:00:00.000Z",
					ageSeconds: availability === "unavailable" ? null : 300,
					latestAttempt: availability === "last-known" ? "failed" : "successful",
					reasonCodes: availability === "unavailable" ? ["no-publication"] : ["positive-only"],
				},
			});

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/tautulli/cache/tautulli-1/status",
			);

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				providerStatus: expect.objectContaining({ availability, evidence }),
				itemCount,
			});
		},
	);

	it("preserves the existing not-found path when the observation is not owned", async () => {
		routeMocks.readObservation.mockResolvedValueOnce(null);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/tautulli/cache/foreign/status",
		);

		expect(response.statusCode).toBe(404);
	});
});
