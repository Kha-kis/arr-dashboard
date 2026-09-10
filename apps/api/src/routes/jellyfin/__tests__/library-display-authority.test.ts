import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JellyfinLibraryDisplayEvidence } from "../../../lib/jellyfin/jellyfin-display-evidence.js";
import type { JellyfinLibraryRow } from "../../../lib/jellyfin/jellyfin-evidence-repository.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const routeMocks = vi.hoisted(() => ({
	readDisplay: vi.fn(),
	readTautulliDisplay: vi.fn(),
}));

vi.mock("../../../lib/jellyfin/jellyfin-display-evidence.js", () => ({
	readOwnedJellyfinLibraryDisplaySources: routeMocks.readDisplay,
	isArithmeticAuthoritativeProviderObservationStatus: (providerStatus: {
		sources: Array<{ status: { availability: string; evidence: string } }>;
	}) =>
		providerStatus.sources.length > 0 &&
		providerStatus.sources.every(
			({ status }) =>
				status.evidence === "complete" &&
				(status.availability === "current" || status.availability === "last-known"),
		),
}));
vi.mock("../../../lib/tautulli/tautulli-observation-repository.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../lib/tautulli/tautulli-observation-repository.js")
	>()),
	readUserSelectedTautulliObservation: routeMocks.readTautulliDisplay,
}));

import { registerOnDeckRoutes } from "../on-deck-routes.js";
import { registerRecentlyAddedRoutes } from "../recently-added-routes.js";
import { registerSectionRoutes } from "../section-routes.js";
import { registerWatchEnrichmentRoutes } from "../watch-enrichment-routes.js";

const observedAt = new Date("2026-09-03T12:00:00.000Z");
const currentStatus = {
	availability: "current" as const,
	evidence: "complete" as const,
	observedAt: observedAt.toISOString(),
	ageSeconds: 0,
	latestAttempt: "successful" as const,
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt: observedAt.toISOString(),
			reasonCodes: [],
		},
		{
			domain: "watch-attribution" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt: observedAt.toISOString(),
			reasonCodes: [],
		},
	],
};

function row(
	instanceId: string,
	id: string,
	overrides: Partial<JellyfinLibraryRow> = {},
): JellyfinLibraryRow {
	return {
		id,
		instanceId,
		tmdbId: 42,
		mediaType: "movie",
		libraryId: "library-1",
		libraryName: "Movies",
		title: "Movie",
		jellyfinId: `${id}-provider`,
		lastWatchedAt: observedAt,
		watchCount: 2,
		watchedByUsers: '["user-1"]',
		onDeck: true,
		userRating: 8,
		collections: "[]",
		addedAt: observedAt,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
		...overrides,
	};
}

function source(
	instanceId: string,
	instanceName: string,
	rows: JellyfinLibraryRow[],
): JellyfinLibraryDisplayEvidence["sources"][number] {
	return { instanceId, instanceName, rows };
}

function display(
	sources: JellyfinLibraryDisplayEvidence["sources"],
	availability: "current" | "partial" | "unavailable" = "current",
): JellyfinLibraryDisplayEvidence {
	return {
		sources,
		providerStatus: {
			availability,
			sources: sources.map((entry) => ({
				instanceId: entry.instanceId,
				service: entry.instanceId.startsWith("emby") ? ("emby" as const) : ("jellyfin" as const),
				cacheType: "jellyfin" as const,
				status: {
					...currentStatus,
					availability,
					reasonCodes: availability === "partial" ? ["coverage-incomplete" as const] : [],
				},
			})),
		},
	};
}

describe("Jellyfin library display authority routes", () => {
	let app: FastifyInstance;
	let prisma: { serviceInstance: { findMany: ReturnType<typeof vi.fn> } };

	beforeEach(async () => {
		vi.clearAllMocks();
		prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{ id: "jellyfin-1", label: "Jellyfin One", service: "JELLYFIN" },
					{ id: "emby-1", label: "Emby One", service: "EMBY" },
				]),
			},
		};
		routeMocks.readDisplay.mockResolvedValue(
			display([
				source("jellyfin-1", "Jellyfin One", [row("jellyfin-1", "j-row")]),
				source("emby-1", "Emby One", [row("emby-1", "e-row")]),
			]),
		);
		routeMocks.readTautulliDisplay.mockResolvedValue({
			configured: false,
			available: true,
			rows: [],
			reasonCodes: [],
		});

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", prisma as never);
		app.decorate("encryptor", {} as never);
		registerTestErrorHandler(app);
		await app.register(registerSectionRoutes, { prefix: "/api/jellyfin/sections" });
		await app.register(registerOnDeckRoutes, { prefix: "/api/jellyfin/on-deck" });
		await app.register(registerRecentlyAddedRoutes, { prefix: "/api/jellyfin/recently-added" });
		await app.register(registerWatchEnrichmentRoutes, {
			prefix: "/api/jellyfin/watch-enrichment",
		});
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("projects current Jellyfin and Emby rows with the existing item shapes and status", async () => {
		const sections = await createInjectAuthenticated(app)("GET", "/api/jellyfin/sections");
		const onDeck = await createInjectAuthenticated(app)("GET", "/api/jellyfin/on-deck");
		const recentlyAdded = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/recently-added",
		);
		const enrichment = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42,42&types=movie,movie",
		);

		expect(sections.statusCode).toBe(200);
		expect(sections.json().sections).toEqual([
			{
				libraryId: "library-1",
				libraryName: "Movies",
				mediaType: "movie",
				instanceId: "emby-1",
				instanceName: "Emby One",
			},
			{
				libraryId: "library-1",
				libraryName: "Movies",
				mediaType: "movie",
				instanceId: "jellyfin-1",
				instanceName: "Jellyfin One",
			},
		]);
		expect(onDeck.json().items).toHaveLength(2);
		expect(recentlyAdded.json().items).toHaveLength(2);
		expect(enrichment.json().items["movie:42"]).toMatchObject({
			watchCount: 2,
			watchCountSemantics: "lower-bound",
			source: "jellyfin",
			instanceId: "emby-1",
		});
		for (const response of [sections, onDeck, recentlyAdded, enrichment]) {
			expect(response.json().providerStatus).toMatchObject({ availability: "current" });
			expect(JSON.stringify(response.json())).not.toMatch(
				/metadata|authority|generationId|fingerprint|scopeKey|receipt|error/i,
			);
		}
	});

	it("does not turn duplicate exact zero counts into a zero lower bound", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display([
				source("jellyfin-1", "Jellyfin One", [row("jellyfin-1", "j-row", { watchCount: 0 })]),
				source("emby-1", "Emby One", [row("emby-1", "e-row", { watchCount: 0 })]),
			]),
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items["movie:42"]).toMatchObject({
			watchCount: null,
			watchCountSemantics: "unknown",
			instanceId: "emby-1",
			jellyfinId: "e-row-provider",
		});
	});

	it("keeps the Jellyfin identity and exact attribution without Tautulli fallback", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display([source("jellyfin-1", "Jellyfin One", [row("jellyfin-1", "j-row")])]),
		);
		routeMocks.readTautulliDisplay.mockResolvedValue({
			configured: true,
			available: true,
			reasonCodes: [],
			rows: [
				{
					id: "tautulli-row",
					instanceId: "tautulli-1",
					tmdbId: 42,
					mediaType: "movie",
					lastWatchedAt: observedAt,
					watchCount: 5,
					watchedByUsers: '["tautulli-user"]',
				},
			],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				observedAt: observedAt.toISOString(),
				ageSeconds: 0,
				latestAttempt: "successful",
				reasonCodes: ["positive-only", "coverage-incomplete"],
				domains: [
					{
						domain: "watch-count",
						availability: "current",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
						observedAt: observedAt.toISOString(),
						reasonCodes: ["positive-only", "coverage-incomplete"],
					},
				],
			},
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items["movie:42"]).toMatchObject({
			watchCount: 2,
			watchCountSemantics: "exact",
			instanceId: "jellyfin-1",
			jellyfinId: "j-row-provider",
			lastWatchedAt: observedAt.toISOString(),
			watchedByUsers: ["user-1"],
		});
		expect(routeMocks.readTautulliDisplay).not.toHaveBeenCalled();
	});

	it("returns only current rows with partial status when another source is unavailable", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display(
				[
					source("jellyfin-1", "Jellyfin One", [row("jellyfin-1", "j-row")]),
					source("emby-1", "Emby One", []),
				],
				"partial",
			),
		);

		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/on-deck");

		expect(response.statusCode).toBe(200);
		expect(response.json().items).toHaveLength(1);
		expect(response.json().providerStatus.availability).toBe("partial");
	});

	it("returns an aggregate unavailable status instead of an unqualified empty response", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display(
				[source("jellyfin-1", "Jellyfin One", []), source("emby-1", "Emby One", [])],
				"unavailable",
			),
		);

		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/sections");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sections: [],
			providerStatus: { availability: "unavailable" },
		});
	});

	it("preserves an empty response and omits status when no source is configured", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([]);
		routeMocks.readDisplay.mockClear();

		const responses = await Promise.all([
			createInjectAuthenticated(app)("GET", "/api/jellyfin/sections"),
			createInjectAuthenticated(app)("GET", "/api/jellyfin/on-deck"),
			createInjectAuthenticated(app)("GET", "/api/jellyfin/recently-added"),
			createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
			),
		]);

		expect(responses.map((response) => response.json())).toEqual([
			{ sections: [] },
			{ items: [] },
			{ items: [] },
			{ items: {} },
		]);
		expect(routeMocks.readDisplay).not.toHaveBeenCalled();
	});

	it("caps on-deck globally after deterministic instance and row ordering", async () => {
		const rows = Array.from({ length: 51 }, (_, index) =>
			row(index % 2 === 0 ? "emby-1" : "jellyfin-1", `row-${String(index).padStart(2, "0")}`),
		);
		routeMocks.readDisplay.mockResolvedValue(
			display([
				source(
					"jellyfin-1",
					"Jellyfin One",
					rows.filter((entry) => entry.instanceId === "jellyfin-1"),
				),
				source(
					"emby-1",
					"Emby One",
					rows.filter((entry) => entry.instanceId === "emby-1"),
				),
			]),
		);

		const response = await createInjectAuthenticated(app)("GET", "/api/jellyfin/on-deck");
		const items = response.json().items;

		expect(items).toHaveLength(50);
		expect(items[0].instanceId).toBe("emby-1");
		expect(items[49].instanceId).toBe("jellyfin-1");
	});

	it("globally sorts recently-added rows and applies the validated limit", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display([
				source("jellyfin-1", "Jellyfin One", [
					row("jellyfin-1", "old", { addedAt: new Date("2026-09-01T12:00:00.000Z") }),
					row("jellyfin-1", "tie-j", { addedAt: observedAt }),
				]),
				source("emby-1", "Emby One", [
					row("emby-1", "new", { addedAt: new Date("2026-09-02T12:00:00.000Z") }),
					row("emby-1", "tie-e", { addedAt: observedAt }),
				]),
			]),
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/recently-added?limit=3",
		);
		const items = response.json().items;

		expect(items.map((item: { jellyfinId: string }) => item.jellyfinId)).toEqual([
			"tie-e-provider",
			"tie-j-provider",
			"new-provider",
		]);
	});

	it("preserves max-count enrichment and deterministic ties without exposing service", async () => {
		routeMocks.readDisplay.mockResolvedValue(
			display([
				source("jellyfin-1", "Jellyfin One", [
					row("jellyfin-1", "z-row", { watchCount: 4, watchedByUsers: '["z-user"]' }),
				]),
				source("emby-1", "Emby One", [
					row("emby-1", "a-row", { watchCount: 4, watchedByUsers: '["a-user"]' }),
				]),
			]),
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
		);
		const item = response.json().items["movie:42"];

		expect(item).toMatchObject({ watchCount: 4, watchedByUsers: ["a-user"], source: "jellyfin" });
		expect(item).not.toHaveProperty("service");
	});

	it("includes a published positive-only source in item enrichment", async () => {
		const evidence = display([
			source("jellyfin-1", "Jellyfin One", [row("jellyfin-1", "j-row", { watchCount: 2 })]),
			source("emby-1", "Emby One", [row("emby-1", "e-row", { watchCount: 9 })]),
		]);
		const positiveOnlySource = evidence.providerStatus!.sources.find(
			(entry) => entry.instanceId === "emby-1",
		)!;
		const providerStatus = evidence.providerStatus!;
		evidence.providerStatus = {
			...providerStatus,
			availability: "partial",
			sources: providerStatus.sources.map((entry) =>
				entry.instanceId === "emby-1"
					? {
							...positiveOnlySource,
							status: {
								...positiveOnlySource.status,
								evidence: "positive-only",
								reasonCodes: ["positive-only"],
							},
						}
					: entry,
			),
		};
		routeMocks.readDisplay.mockResolvedValueOnce(evidence);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/watch-enrichment?tmdbIds=42&types=movie",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().items["movie:42"]).toMatchObject({
			watchCount: 9,
			instanceId: "emby-1",
		});
	});

	it("passes the authenticated owner and selected instance topology to the display helper", async () => {
		await createInjectAuthenticated(app)("GET", "/api/jellyfin/sections");

		expect(prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: { userId: "user-1", service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});
		expect(routeMocks.readDisplay).toHaveBeenCalledWith({
			prisma,
			userId: "user-1",
			instances: [
				{ id: "jellyfin-1", label: "Jellyfin One", service: "JELLYFIN" },
				{ id: "emby-1", label: "Emby One", service: "EMBY" },
			],
		});
	});
});
