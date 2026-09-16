import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	readJellyfinEvidence: vi.fn(),
	readPlexEvidence: vi.fn(),
	readTautulliDisplay: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-display-evidence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/jellyfin/jellyfin-display-evidence.js")>()),
	readOwnedJellyfinLibraryDisplaySources: routeMocks.readJellyfinEvidence,
}));
vi.mock("../../lib/plex/plex-authority-service.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/plex/plex-authority-service.js")>()),
	PlexAuthorityService: class {
		async readUserSelectedDisplay(input: unknown) {
			return await routeMocks.readPlexEvidence(input);
		}
	},
}));
vi.mock("../../lib/tautulli/tautulli-observation-repository.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/tautulli/tautulli-observation-repository.js")
	>()),
	readUserSelectedTautulliObservation: routeMocks.readTautulliDisplay,
}));

import { registerWatchEnrichmentRoutes as registerJellyfinWatchEnrichmentRoutes } from "../jellyfin/watch-enrichment-routes.js";
import { registerWatchEnrichmentRoutes as registerPlexWatchEnrichmentRoutes } from "../plex/watch-enrichment-routes.js";

const observedAt = "2026-09-03T12:00:00.000Z";
const exactStatus = {
	availability: "current" as const,
	evidence: "complete" as const,
	observedAt,
	ageSeconds: 0,
	latestAttempt: "successful" as const,
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
		{
			domain: "watch-attribution" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
		{
			domain: "on-deck" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
	],
};

function plexEvidence(watchCount = 2) {
	return [
		{
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "generation-1",
			publishedAt: new Date(observedAt),
			itemCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
			rows: [
				{
					tmdbId: 42,
					mediaType: "movie",
					instanceId: "plex-1",
					lastWatchedAt: new Date(observedAt),
					watchCount,
					onDeck: false,
					userRating: null,
					ratingKey: "plex-rating-key",
					watchedByUsers: '["plex-viewer"]',
					collections: "[]",
					labels: "[]",
				},
			],
			providerStatus: exactStatus,
		},
	];
}

function jellyfinEvidence(watchCount = 2) {
	return {
		sources: [
			{
				instanceId: "jellyfin-1",
				instanceName: "Jellyfin",
				rows: [
					{
						id: "jellyfin-row-1",
						tmdbId: 42,
						mediaType: "movie",
						instanceId: "jellyfin-1",
						lastWatchedAt: new Date(observedAt),
						watchCount,
						onDeck: false,
						userRating: null,
						jellyfinId: "jellyfin-item-1",
						watchedByUsers: '["jellyfin-viewer"]',
						collections: "[]",
					},
				],
			},
		],
		providerStatus: {
			availability: "current",
			sources: [
				{
					instanceId: "jellyfin-1",
					service: "jellyfin",
					cacheType: "jellyfin",
					status: exactStatus,
				},
			],
		},
	};
}

const positiveTautulliRow = {
	id: "tautulli-row-1",
	instanceId: "tautulli-1",
	tmdbId: 42,
	mediaType: "movie",
	lastWatchedAt: new Date(observedAt),
	watchCount: 99,
	watchedByUsers: '["tautulli-viewer"]',
};

describe("native watch-enrichment isolation", () => {
	let app: FastifyInstance;
	let prisma: {
		serviceInstance: { findMany: ReturnType<typeof vi.fn> };
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		routeMocks.readJellyfinEvidence.mockResolvedValue({ sources: [], providerStatus: undefined });
		routeMocks.readPlexEvidence.mockResolvedValue([]);
		routeMocks.readTautulliDisplay.mockRejectedValue(
			new Error("optional Tautulli dependency must not be read by native routes"),
		);
		prisma = {
			serviceInstance: {
				findMany: vi.fn(async () => []),
			},
		};

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", prisma as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerPlexWatchEnrichmentRoutes, {
			prefix: "/api/plex/watch-enrichment",
		});
		await app.register(registerJellyfinWatchEnrichmentRoutes, {
			prefix: "/api/jellyfin/watch-enrichment",
		});
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it.each([
		["Plex", "/api/plex/watch-enrichment?tmdbIds=42&types=movie"],
		["Jellyfin", "/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie"],
	])(
		"does not await hostile Tautulli when the %s endpoint has no native rows",
		async (_label, url) => {
			const response = await createInjectAuthenticated(app)("GET", url);

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ items: {} });
			expect(routeMocks.readTautulliDisplay).not.toHaveBeenCalled();
		},
	);

	it("keeps the native Plex count and provenance when Tautulli has an overlapping larger count", async () => {
		routeMocks.readPlexEvidence.mockResolvedValue(plexEvidence(2));
		routeMocks.readTautulliDisplay.mockResolvedValue({
			configured: true,
			available: true,
			rows: [positiveTautulliRow],
			providerStatus: exactStatus,
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/watch-enrichment?tmdbIds=42&types=movie",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items["movie:42"]).toMatchObject({
			watchCount: 2,
			watchCountSemantics: "exact",
			source: "plex",
		});
		expect(response.json().tautulliStatus).toBeUndefined();
		expect(routeMocks.readTautulliDisplay).not.toHaveBeenCalled();
	});

	it("keeps the native Jellyfin count and provenance when Tautulli has an overlapping larger count", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([
			{ id: "jellyfin-1", label: "Jellyfin", service: "JELLYFIN" },
		]);
		routeMocks.readJellyfinEvidence.mockResolvedValue(jellyfinEvidence(2));
		routeMocks.readTautulliDisplay.mockResolvedValue({
			configured: true,
			available: true,
			rows: [positiveTautulliRow],
			providerStatus: exactStatus,
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items["movie:42"]).toMatchObject({
			watchCount: 2,
			watchCountSemantics: "exact",
			source: "jellyfin",
		});
		expect(response.json().tautulliStatus).toBeUndefined();
		expect(routeMocks.readTautulliDisplay).not.toHaveBeenCalled();
	});

	it("omits a requested target without native evidence despite a positive Tautulli row", async () => {
		routeMocks.readPlexEvidence.mockResolvedValue(plexEvidence(2));
		routeMocks.readTautulliDisplay.mockResolvedValue({
			configured: true,
			available: true,
			rows: [positiveTautulliRow],
			providerStatus: exactStatus,
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/watch-enrichment?tmdbIds=42,99&types=movie,series",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items).toHaveProperty("movie:42");
		expect(response.json().items).not.toHaveProperty("series:99");
		expect(routeMocks.readTautulliDisplay).not.toHaveBeenCalled();
	});
});
