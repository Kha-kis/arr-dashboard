import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	refreshWithAttempt: vi.fn(),
	claim: vi.fn(),
	start: vi.fn(),
	requireClient: vi.fn(),
	recordFailure: vi.fn(),
	getPublishedGenerationObservation: vi.fn(),
	loadUserGenerationObservations: vi.fn().mockResolvedValue([]),
	getPublishedEpisodeGenerationObservation: vi.fn(),
	recovery: { admit: vi.fn(), arm: vi.fn() },
}));

vi.mock("../../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCacheWithAttempt: mocks.refreshWithAttempt,
}));
vi.mock("../../../lib/provider-observation/background-cache-refresh.js", () => ({
	startProviderCacheRefreshInBackground: mocks.start,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: mocks.claim,
}));
vi.mock("../../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: mocks.requireClient,
}));
vi.mock("../../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-evidence-repository.js")>()),
	getPublishedGenerationObservation: mocks.getPublishedGenerationObservation,
	loadUserGenerationObservations: mocks.loadUserGenerationObservations,
	getPublishedEpisodeGenerationObservation: mocks.getPublishedEpisodeGenerationObservation,
}));

vi.mock("../../../lib/plex/plex-authority-service.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/plex/plex-authority-service.js")>();
	return {
		...actual,
		PlexAuthorityService: class {
			async readInstance() {
				return await mocks.getPublishedGenerationObservation();
			}
		},
	};
});

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/plex/cache/:instanceId/refresh publication authority", () => {
	let app: FastifyInstance;
	const instance = { id: "plex-1", service: "PLEX", connectionGeneration: 4 };

	beforeEach(async () => {
		mocks.refreshWithAttempt.mockReset().mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 1,
			errors: 0,
			errorMessages: [],
		});
		mocks.claim.mockReset().mockResolvedValue({
			status: "acquired",
			attempt: {
				attemptedAt: new Date("2026-09-05T00:00:00.000Z"),
				resultMarker: "in_progress:123e4567-e89b-42d3-a456-426614174000",
			},
		});
		mocks.start
			.mockReset()
			.mockImplementation(
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
		mocks.requireClient.mockReset().mockResolvedValue({
			client: { server: "caller-controlled" },
			instance,
		});
		mocks.recordFailure.mockReset();
		mocks.getPublishedGenerationObservation.mockReset();
		mocks.loadUserGenerationObservations.mockReset().mockResolvedValue([]);
		mocks.getPublishedEpisodeGenerationObservation.mockReset();

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			plexCache: { count: vi.fn() },
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([{ id: instance.id, label: "Plex" }]),
			},
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
			providerObservationRun: { findMany: vi.fn().mockResolvedValue([]) },
		} as never);
		app.decorate("encryptor", { decrypt: vi.fn() } as never);
		app.decorate("libraryRefreshRecovery", mocks.recovery as never);
		await app.register(registerCacheRoutes, { prefix: "/api/plex" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("fences health status and progress reads by the authenticated owner", async () => {
		const response = await createInjectAuthenticated(app)("GET", "/api/plex/cache/health");
		expect(response.statusCode).toBe(200);
		for (const query of [
			app.prisma.cacheRefreshStatus.findMany,
			app.prisma.providerObservationRun.findMany,
		]) {
			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						instanceId: { in: [instance.id] },
						instance: { userId: "user-1" },
					}),
				}),
			);
		}
	});

	it("returns exact durable acceptance and passes the claim to the adapter", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");

		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "plex" });
		expect(mocks.claim).toHaveBeenCalledWith(
			app.prisma,
			"plex",
			expect.objectContaining({ id: instance.id }),
		);
		expect(mocks.refreshWithAttempt).toHaveBeenCalledWith(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance,
				log: expect.anything(),
			},
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
		expect(mocks.requireClient).not.toHaveBeenCalled();
		expect(mocks.refreshWithAttempt.mock.calls[0]).not.toContainEqual({
			server: "caller-controlled",
		});
		expect(mocks.start.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				recovery: expect.objectContaining({
					provider: "plex",
					userId: "user-1",
					instanceId: instance.id,
					handoff: mocks.recovery,
				}),
			}),
		);
	});

	it("returns before a deferred producer settles", async () => {
		let resolveProducer!: () => void;
		mocks.refreshWithAttempt.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveProducer = resolve;
			}),
		);
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");
		expect(response.statusCode).toBe(202);
		expect(mocks.refreshWithAttempt).toHaveBeenCalledTimes(1);
		resolveProducer();
	});

	it("does not accept an already-running claim as a new producer", async () => {
		mocks.claim.mockResolvedValueOnce({
			status: "already-running",
			attempt: {
				attemptedAt: new Date(),
				resultMarker: "in_progress:123e4567-e89b-42d3-a456-426614174000",
			},
		});
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ status: "accepted", cacheType: "plex" });
		expect(mocks.refreshWithAttempt).not.toHaveBeenCalled();
	});

	it("rejects a missing instance before claim or background admission", async () => {
		const findFirst = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		findFirst.mockResolvedValueOnce(null);
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/plex/cache/missing/refresh",
		);
		expect(response.statusCode).toBe(404);
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("rejects a wrong-service instance before claim or background admission", async () => {
		const findFirst = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		findFirst.mockResolvedValueOnce({ ...instance, service: "JELLYFIN" });
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");
		expect(response.statusCode).toBe(400);
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it.each([0, 42])(
		"withholds exact status values after a failed latest attempt (prior count %i)",
		async (itemCount) => {
			mocks.getPublishedGenerationObservation.mockResolvedValue({
				available: true,
				itemCount,
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState: "error",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["latest_attempt_failed"],
					publishedGeneration: {
						generationId: "generation-1",
						publicationLevel: "authoritative",
						publishedAt: "2026-08-20T12:00:00.000Z",
						itemCount,
					},
				},
			});

			const response = await createInjectAuthenticated(app)("GET", "/api/plex/cache/plex-1/status");

			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({
				error: "Plex cache evidence is unavailable",
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState: "error",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["latest_attempt_failed"],
					publishedGeneration: {
						generationId: "generation-1",
						publicationLevel: "authoritative",
						publishedAt: "2026-08-20T12:00:00.000Z",
						itemCount,
					},
				},
			});
		},
	);
});
