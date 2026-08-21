import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	requireClient: vi.fn(),
	recordFailure: vi.fn(),
	getPublishedGenerationObservation: vi.fn(),
	loadUserGenerationObservations: vi.fn().mockResolvedValue([]),
	getPublishedEpisodeGenerationObservation: vi.fn(),
}));

vi.mock("../../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCache: mocks.refresh,
}));
vi.mock("../../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: mocks.requireClient,
}));
vi.mock("../../../lib/services/provider-cache-status.js", () => ({
	recordPlexCacheRefreshFailure: mocks.recordFailure,
}));

vi.mock("../../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-evidence-repository.js")>()),
	getPublishedGenerationObservation: mocks.getPublishedGenerationObservation,
	loadUserGenerationObservations: mocks.loadUserGenerationObservations,
	getPublishedEpisodeGenerationObservation: mocks.getPublishedEpisodeGenerationObservation,
}));

import { registerCacheRoutes } from "../cache-routes.js";

describe("POST /api/plex/cache/:instanceId/refresh publication authority", () => {
	let app: FastifyInstance;
	const instance = { id: "plex-1", service: "PLEX", connectionGeneration: 4 };

	beforeEach(async () => {
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
		mocks.getPublishedGenerationObservation.mockReset();
		mocks.loadUserGenerationObservations.mockReset().mockResolvedValue([]);
		mocks.getPublishedEpisodeGenerationObservation.mockReset();

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			plexCache: { count: vi.fn() },
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
		} as never);
		app.decorate("encryptor", { decrypt: vi.fn() } as never);
		await app.register(registerCacheRoutes, { prefix: "/api/plex" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("uses the pre-decryption refresh boundary without forwarding a caller client", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");

		expect(response.statusCode).toBe(200);
		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance,
			log: expect.anything(),
		});
		expect(mocks.requireClient).not.toHaveBeenCalled();
		expect(mocks.refresh.mock.calls[0]).not.toContainEqual({ server: "caller-controlled" });
	});

	it("returns an actionable sanitized response when preparation cannot publish", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["Plex refresh preparation failed before publication"],
		});

		const response = await createInjectAuthenticated(app)("POST", "/api/plex/cache/plex-1/refresh");

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			success: false,
			upserted: 0,
			errors: 1,
			error: "Plex refresh preparation failed before publication",
		});
		expect(JSON.stringify(response.json())).not.toContain("caller-controlled");
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
