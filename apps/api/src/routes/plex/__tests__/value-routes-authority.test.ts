import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	loadInstanceEvidence: vi.fn(),
	loadInstanceEpisodeEvidence: vi.fn(),
	loadInstanceSelectedEpisodeEvidence: vi.fn(),
	loadUserEvidence: vi.fn(),
	loadUserSelectedEvidence: vi.fn(),
}));

vi.mock("../../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-evidence-repository.js")>()),
	loadInstanceEvidence: mocks.loadInstanceEvidence,
	loadInstanceEpisodeEvidence: mocks.loadInstanceEpisodeEvidence,
	loadInstanceSelectedEpisodeEvidence: mocks.loadInstanceSelectedEpisodeEvidence,
	loadUserEvidence: mocks.loadUserEvidence,
	loadUserSelectedEvidence: mocks.loadUserSelectedEvidence,
}));

import { registerCollectionRoutes } from "../collection-routes.js";
import { registerCollectionStatsRoutes } from "../collection-stats-routes.js";
import { registerEpisodeRoutes } from "../episode-routes.js";
import { registerOnDeckRoutes } from "../on-deck-routes.js";
import { registerRecentlyAddedRoutes } from "../recently-added-routes.js";
import { registerSeriesProgressRoutes } from "../series-progress-routes.js";
import { registerUserEpisodeCompletionRoutes } from "../user-episode-completion-routes.js";
import { registerWatchEnrichmentRoutes } from "../watch-enrichment-routes.js";

const authoritativeEvidence = {
	availability: "current",
	authority: "authoritative",
	attemptState: "success",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: [],
} as const;

const unavailableEvidence = {
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
} as const;

const currentSelected = {
	available: true,
	instanceId: "plex-1",
	instanceName: "Primary",
	rows: [],
	sections: [],
	evidence: authoritativeEvidence,
};

const currentEpisodes = {
	available: true,
	instanceId: "plex-1",
	rows: [],
	evidence: authoritativeEvidence,
};

const unavailable = {
	available: true,
	instanceId: "plex-1",
	instanceName: "Primary",
	rows: [],
	sections: [],
	evidence: unavailableEvidence,
};

describe("Plex value route evidence contracts", () => {
	let app: FastifyInstance;
	let plexInstances: Array<{ id: string }>;

	beforeEach(async () => {
		plexInstances = [{ id: "plex-1" }];
		mocks.loadInstanceEvidence.mockResolvedValue(unavailable);
		mocks.loadInstanceEpisodeEvidence.mockResolvedValue(unavailable);
		mocks.loadInstanceSelectedEpisodeEvidence.mockResolvedValue(unavailable);
		mocks.loadUserEvidence.mockResolvedValue([unavailable]);
		mocks.loadUserSelectedEvidence.mockResolvedValue([unavailable]);

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }: { where?: { service?: string } }) =>
					where?.service === "PLEX" ? plexInstances : [],
				),
			},
			tautulliCache: { findMany: vi.fn(async () => []) },
		} as never);
		await app.register(registerOnDeckRoutes, { prefix: "/api/plex/on-deck" });
		await app.register(registerRecentlyAddedRoutes, { prefix: "/api/plex/recently-added" });
		await app.register(registerCollectionRoutes, { prefix: "/api/plex" });
		await app.register(registerCollectionStatsRoutes, { prefix: "/api/plex/collection-stats" });
		await app.register(registerSeriesProgressRoutes, { prefix: "/api/plex/series-progress" });
		await app.register(registerEpisodeRoutes, { prefix: "/api/plex/episodes" });
		await app.register(registerUserEpisodeCompletionRoutes, {
			prefix: "/api/plex/user-episode-completion",
		});
		await app.register(registerWatchEnrichmentRoutes, { prefix: "/api/plex/watch-enrichment" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it.each([
		["on-deck", "/api/plex/on-deck", "items"],
		["recently added", "/api/plex/recently-added", "items"],
		["collections", "/api/plex/plex-1/collections", "collections"],
		["labels", "/api/plex/plex-1/labels", "labels"],
		["collection statistics", "/api/plex/collection-stats", "collections"],
		["series progress", "/api/plex/series-progress?tmdbIds=1", "progress"],
		["episode status", "/api/plex/episodes?instanceId=plex-1&showTmdbId=1", "episodes"],
		["episode completion", "/api/plex/user-episode-completion?tmdbIds=1", "shows"],
		["watch enrichment", "/api/plex/watch-enrichment?tmdbIds=1&types=movie", "items"],
	] as const)("withholds %s values when the latest attempt failed", async (_name, url, field) => {
		const response = await createInjectAuthenticated(app)("GET", url);
		const body = response.json();

		expect(response.statusCode).toBe(503);
		expect(body).toEqual({
			error: "Plex cache evidence is unavailable",
			evidence: unavailableEvidence,
		});
		expect(body).not.toHaveProperty(field);
		expect(JSON.stringify(body)).not.toContain("in_progress:");
	});

	it.each([
		["on-deck", "/api/plex/on-deck", { items: [], evidence: authoritativeEvidence }],
		["recently added", "/api/plex/recently-added", { items: [], evidence: authoritativeEvidence }],
		[
			"collections",
			"/api/plex/plex-1/collections",
			{ collections: [], labels: [], evidence: authoritativeEvidence },
		],
		[
			"labels",
			"/api/plex/plex-1/labels",
			{ collections: [], labels: [], evidence: authoritativeEvidence },
		],
		[
			"collection statistics",
			"/api/plex/collection-stats",
			{ collections: [], labels: [], evidence: authoritativeEvidence },
		],
		[
			"series progress",
			"/api/plex/series-progress?tmdbIds=1",
			{ progress: {}, evidence: authoritativeEvidence },
		],
		[
			"episode status",
			"/api/plex/episodes?instanceId=plex-1&showTmdbId=1",
			{ showTmdbId: 1, episodes: [], evidence: authoritativeEvidence },
		],
		[
			"episode completion",
			"/api/plex/user-episode-completion?tmdbIds=1",
			{ shows: [], evidence: authoritativeEvidence },
		],
		[
			"watch enrichment",
			"/api/plex/watch-enrichment?tmdbIds=1&types=movie",
			{ items: {}, evidence: authoritativeEvidence },
		],
	] as const)("preserves the authoritative-success shape for %s", async (_name, url, expected) => {
		mocks.loadInstanceEvidence.mockResolvedValue(currentSelected);
		mocks.loadInstanceEpisodeEvidence.mockResolvedValue(currentEpisodes);
		mocks.loadInstanceSelectedEpisodeEvidence.mockResolvedValue(currentEpisodes);
		mocks.loadUserEvidence.mockResolvedValue([currentSelected]);
		mocks.loadUserSelectedEvidence.mockResolvedValue([currentSelected]);

		const response = await createInjectAuthenticated(app)("GET", url);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(expected);
	});

	it.each([
		["series progress", "/api/plex/series-progress?tmdbIds=1,2,1"],
		["episode status", "/api/plex/episodes?instanceId=plex-1&showTmdbId=1"],
		["episode completion", "/api/plex/user-episode-completion?tmdbIds=1,2,1"],
	] as const)(
		"uses selected episode evidence for %s while preserving its response",
		async (_name, url) => {
			mocks.loadInstanceEpisodeEvidence.mockResolvedValue(currentEpisodes);
			mocks.loadInstanceSelectedEpisodeEvidence.mockResolvedValue(currentEpisodes);

			const response = await createInjectAuthenticated(app)("GET", url);

			expect(response.statusCode).toBe(200);
			expect(mocks.loadInstanceSelectedEpisodeEvidence).toHaveBeenCalled();
			expect(mocks.loadInstanceEpisodeEvidence).not.toHaveBeenCalled();
		},
	);

	it("aggregates selected episode progress from each enabled Plex instance", async () => {
		plexInstances = [{ id: "plex-1" }, { id: "plex-2" }];
		mocks.loadInstanceSelectedEpisodeEvidence.mockImplementation(
			async (_prisma: unknown, input: { instanceId: string }) =>
				input.instanceId === "plex-1"
					? {
							...currentEpisodes,
							rows: [{ showTmdbId: 1, watched: true }],
						}
					: {
							...currentEpisodes,
							instanceId: "plex-2",
							rows: [
								{ showTmdbId: 1, watched: false },
								{ showTmdbId: 2, watched: true },
							],
						},
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/series-progress?tmdbIds=2,1,2",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			progress: {
				1: { total: 2, watched: 1, percent: 50 },
				2: { total: 1, watched: 1, percent: 100 },
			},
			evidence: authoritativeEvidence,
		});
		expect(mocks.loadInstanceSelectedEpisodeEvidence).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			{ userId: "user-1", instanceId: "plex-1", showTmdbIds: [2, 1] },
		);
		expect(mocks.loadInstanceSelectedEpisodeEvidence).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			{ userId: "user-1", instanceId: "plex-2", showTmdbIds: [2, 1] },
		);
	});

	it("aggregates selected episode completion from each enabled Plex instance", async () => {
		plexInstances = [{ id: "plex-1" }, { id: "plex-2" }];
		mocks.loadInstanceSelectedEpisodeEvidence.mockImplementation(
			async (_prisma: unknown, input: { instanceId: string }) =>
				input.instanceId === "plex-1"
					? {
							...currentEpisodes,
							rows: [{ showTmdbId: 1, watched: true, watchedByUsers: '["alice"]' }],
						}
					: {
							...currentEpisodes,
							instanceId: "plex-2",
							rows: [{ showTmdbId: 2, watched: true, watchedByUsers: '["bob"]' }],
						},
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/user-episode-completion?tmdbIds=2,1,2",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			shows: [
				{ tmdbId: 1, users: [{ username: "alice", watched: 1, total: 1, percent: 100 }] },
				{ tmdbId: 2, users: [{ username: "bob", watched: 1, total: 1, percent: 100 }] },
			],
			evidence: authoritativeEvidence,
		});
		expect(mocks.loadInstanceSelectedEpisodeEvidence).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			{ userId: "user-1", instanceId: "plex-1", showTmdbIds: [2, 1] },
		);
		expect(mocks.loadInstanceSelectedEpisodeEvidence).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			{ userId: "user-1", instanceId: "plex-2", showTmdbIds: [2, 1] },
		);
	});
});
