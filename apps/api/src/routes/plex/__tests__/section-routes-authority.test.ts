import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	loadUserSelectedEvidence: vi.fn(),
}));

vi.mock("../../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-evidence-repository.js")>()),
	loadUserSelectedEvidence: mocks.loadUserSelectedEvidence,
}));

import { registerSectionRoutes } from "../section-routes.js";

describe("GET /api/plex/sections authority", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {} as never);
		await app.register(registerSectionRoutes, { prefix: "/api/plex/sections" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("does not expose a silently truncated section list when one instance is unavailable", async () => {
		mocks.loadUserSelectedEvidence.mockResolvedValue([
			{
				available: true,
				instanceId: "plex-1",
				instanceName: "Primary",
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
				evidence: {
					publicationLevel: "authoritative",
					completeness: "complete",
					reasonCodes: [],
				},
			},
			{
				available: false,
				instanceId: "plex-2",
				evidence: {
					availability: "unavailable",
					authority: "unavailable",
					attemptState: "success",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["published_generation_stale"],
				},
			},
		]);

		const response = await createInjectAuthenticated(app)("GET", "/api/plex/sections");

		expect(response.statusCode).toBe(503);
		expect(response.json()).toMatchObject({
			error: "Plex cache evidence is unavailable",
			evidence: {
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["published_generation_stale"],
			},
		});
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("withholds current section values while reporting a failed latest attempt as degraded", async () => {
		mocks.loadUserSelectedEvidence.mockResolvedValue([
			{
				available: true,
				instanceId: "plex-1",
				instanceName: "Primary",
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
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
						itemCount: 1,
					},
				},
			},
		]);

		const response = await createInjectAuthenticated(app)("GET", "/api/plex/sections");

		expect(response.statusCode).toBe(503);
		expect(response.json()).toMatchObject({
			error: "Plex cache evidence is unavailable",
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		expect(response.json()).not.toHaveProperty("sections");
	});
});
