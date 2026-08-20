import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
	loadUserEvidence: vi.fn(),
}));

vi.mock("../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/plex/plex-evidence-repository.js")>()),
	loadUserEvidence: mocks.loadUserEvidence,
}));

import { registerInsightsRoutes } from "../library/insights-routes.js";

const unavailableEvidence = {
	availability: "last-known",
	authority: "unavailable",
	attemptState: "in_progress",
	publicationLevel: "unavailable",
	completeness: "unknown",
	reasonCodes: ["latest_attempt_in_progress"],
	publishedGeneration: {
		generationId: "generation-1",
		publicationLevel: "authoritative",
		publishedAt: "2026-08-20T12:00:00.000Z",
		itemCount: 1,
	},
} as const;

describe("library insight Plex authority contracts", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		mocks.loadUserEvidence.mockResolvedValue([
			{
				available: true,
				instanceId: "plex-1",
				rows: [],
				evidence: unavailableEvidence,
			},
		]);

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }: { where?: { service?: { in?: string[] } } }) =>
					where?.service?.in?.includes("SONARR")
						? [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }]
						: [],
				),
				findFirst: vi.fn(async () => ({
					id: "seerr-1",
					baseUrl: "http://seerr.invalid",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					service: "SEERR",
					label: "Seerr",
				})),
			},
			libraryCache: { findMany: vi.fn(async () => []) },
			jellyfinCache: { findMany: vi.fn(async () => []) },
		} as never);
		await app.register(registerInsightsRoutes, { prefix: "/api" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it.each([
		["disk-waste", "/api/library/insights/disk-waste", "totalWastedBytes"],
		["watched-monitored", "/api/library/insights/watched-monitored", "hasWatchData"],
		["requested-unwatched", "/api/library/insights/requested-unwatched", "hasWatchData"],
	] as const)(
		"withholds %s conclusions while a refresh is in progress",
		async (_name, url, field) => {
			const response = await createInjectAuthenticated(app)("GET", url);
			const body = response.json();

			expect(response.statusCode).toBe(503);
			expect(body).toEqual({
				error: "Plex cache evidence is unavailable",
				evidence: unavailableEvidence,
			});
			expect(body).not.toHaveProperty("data");
			expect(body).not.toHaveProperty(field);
			expect(JSON.stringify(body)).not.toContain("in_progress:");
		},
	);
});
