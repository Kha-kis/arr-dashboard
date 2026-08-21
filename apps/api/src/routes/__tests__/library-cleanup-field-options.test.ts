/**
 * Cursor-pagination behavior for `GET /api/library-cleanup/field-options`
 * (issue #427 follow-up).
 *
 * Pins the v2.18.4 OOM fix: the field-options endpoint must walk
 * `libraryCache`, `tautulliCache`, `plexCache`, and `jellyfinCache` via
 * cursor pagination at FIELD_OPTIONS_BATCH_SIZE = 500. The previous
 * shape ran a single unbounded `findMany` per cache type, which
 * for a 50k+ Sonarr-heavy library trivially OOMs the 768 MB container
 * heap when the `data` JSON blob is loaded for every row.
 *
 * Specifically pinned:
 *   - libraryCache walk advances cursor across multiple batches and
 *     aggregates videoCodec values from BOTH batches.
 *   - plexCache walk is a SINGLE merged pass (not three) and aggregates
 *     users + libraries + collections + labels in one cursor loop.
 *   - Loop terminates on a short batch without an extra round-trip.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

// Unique user per test — the route caches field options per-user for 5
// minutes via a module-level Map. Without a unique id, test 2 + 3 see the
// cached response from test 1 and the prisma mocks are never invoked.
const counter = { value: 0 };
const SONARR_INSTANCE_ID = "sonarr-1";
const PLEX_INSTANCE_ID = "plex-1";

function makeLibraryRow(id: string, videoCodec: string) {
	return {
		id,
		data: JSON.stringify({
			episodeFile: { videoCodec, audioCodec: "AC3", resolution: "1080p" },
		}),
	};
}

function makePlexRow(
	id: string,
	overrides: {
		sectionTitle?: string;
		watchedByUsers?: string[];
		collections?: string[];
		labels?: string[];
	} = {},
) {
	return {
		id,
		instanceId: PLEX_INSTANCE_ID,
		tmdbId: Number(id.replace(/\D/g, "")) + 1,
		mediaType: "movie",
		sectionId: overrides.sectionTitle === "TV Shows" ? "shows" : "movies",
		sectionTitle: overrides.sectionTitle ?? "Movies",
		title: `Title ${id}`,
		ratingKey: `rating-${id}`,
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: JSON.stringify(overrides.watchedByUsers ?? []),
		onDeck: false,
		userRating: null,
		collections: JSON.stringify(overrides.collections ?? []),
		labels: JSON.stringify(overrides.labels ?? []),
		addedAt: null,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
}

let app: FastifyInstance;
let libraryCacheFindMany: ReturnType<typeof vi.fn>;
let plexCacheFindMany: ReturnType<typeof vi.fn>;
let jellyfinCacheFindMany: ReturnType<typeof vi.fn>;
let tautulliCacheFindMany: ReturnType<typeof vi.fn>;
let serviceInstanceFindMany: ReturnType<typeof vi.fn>;
let cacheRefreshStatusFindMany: ReturnType<typeof vi.fn>;
let currentUserId: string;

beforeEach(async () => {
	counter.value += 1;
	const userId = `user-${counter.value}`;
	currentUserId = userId;
	// Default to empty arrays so blocks tests don't exercise stay quiet —
	// each test overrides only the cache it cares about.
	libraryCacheFindMany = vi.fn().mockResolvedValue([]);
	plexCacheFindMany = vi.fn().mockResolvedValue([]);
	jellyfinCacheFindMany = vi.fn().mockResolvedValue([]);
	tautulliCacheFindMany = vi.fn().mockResolvedValue([]);
	serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
	cacheRefreshStatusFindMany = vi.fn().mockResolvedValue([]);

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: userId, username: "admin" });
	// Surface route errors as 500s — without this, Fastify's default reply
	// is a 200 with a serialization error in the body, which is harder to
	// debug when a test fixture is wrong.
	app.setErrorHandler((error: Error, _request, reply) =>
		reply.status(500).send({ error: error.message }),
	);

	app.decorate("prisma", {
		serviceInstance: { findMany: serviceInstanceFindMany },
		cacheRefreshStatus: { findMany: cacheRefreshStatusFindMany },
		libraryCache: { findMany: libraryCacheFindMany },
		plexCache: { findMany: plexCacheFindMany },
		jellyfinCache: { findMany: jellyfinCacheFindMany },
		tautulliCache: { findMany: tautulliCacheFindMany },
	} as never);

	// ARR client factory — returns a stub whose tag.getAll() yields nothing.
	// The field-options route fans out to each Sonarr/Radarr instance for
	// tags but failures are non-fatal, so we keep the stub minimal.
	app.decorate("arrClientFactory", {
		createAnyClient: () => ({ tag: { getAll: vi.fn().mockResolvedValue([]) } }),
	} as never);

	await app.register(registerLibraryCleanupRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("GET /library-cleanup/field-options — cursor pagination (issue #427)", () => {
	it("walks libraryCache via cursor across multiple batches and aggregates values from BOTH", async () => {
		// One Sonarr instance — only the libraryCache scan kicks in. The
		// other cache scans are gated behind their own `findMany` for
		// service instances (tautulli / plex / jellyfin) which we leave
		// at their default empty mock.
		serviceInstanceFindMany.mockImplementation(({ where }: { where: { service: unknown } }) => {
			const svc = where.service;
			if (
				typeof svc === "object" &&
				svc &&
				"in" in svc &&
				Array.isArray((svc as { in: unknown[] }).in) &&
				(svc as { in: string[] }).in.includes("SONARR")
			) {
				return Promise.resolve([
					{
						id: SONARR_INSTANCE_ID,
						baseUrl: "http://sonarr",
						encryptedApiKey: "x",
						encryptionIv: "x",
						service: "SONARR",
						label: "Sonarr",
					},
				]);
			}
			return Promise.resolve([]);
		});

		// Batch 1: 500 rows ending in id=lc-499 with videoCodec=h264
		const batch1 = Array.from({ length: 499 }, (_, i) => makeLibraryRow(`lc-${i}`, "h264"));
		batch1.push(makeLibraryRow("lc-499", "h264"));
		// Batch 2: 1 row with a NEW codec (proves cross-batch aggregation)
		const batch2 = [makeLibraryRow("lc-500", "hevc")];

		libraryCacheFindMany.mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2);

		const inject = createInjectAuthenticated(app);
		const res = await inject("GET", "/library-cleanup/field-options");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		expect(body.videoCodecs).toEqual(expect.arrayContaining(["h264", "hevc"]));
		expect(body.videoCodecs).toHaveLength(2);

		// Two findMany calls — pagination must have continued past batch 1.
		expect(libraryCacheFindMany).toHaveBeenCalledTimes(2);

		// First call has no cursor.
		const firstCallArg = libraryCacheFindMany.mock.calls[0]?.[0];
		expect(firstCallArg).toMatchObject({
			where: { instanceId: { in: [SONARR_INSTANCE_ID] } },
			take: 500,
			orderBy: { id: "asc" },
		});
		expect(firstCallArg?.cursor).toBeUndefined();

		// Second call advances past the last id of batch 1.
		const secondCallArg = libraryCacheFindMany.mock.calls[1]?.[0];
		expect(secondCallArg?.cursor).toEqual({ id: "lc-499" });
		expect(secondCallArg?.skip).toBe(1);
	});

	it("terminates after a short batch without an extra findMany call", async () => {
		serviceInstanceFindMany.mockImplementation(({ where }: { where: { service: unknown } }) => {
			const svc = where.service;
			if (
				typeof svc === "object" &&
				svc &&
				"in" in svc &&
				Array.isArray((svc as { in: unknown[] }).in) &&
				(svc as { in: string[] }).in.includes("SONARR")
			) {
				return Promise.resolve([
					{
						id: SONARR_INSTANCE_ID,
						baseUrl: "http://sonarr",
						encryptedApiKey: "x",
						encryptionIv: "x",
						service: "SONARR",
						label: "Sonarr",
					},
				]);
			}
			return Promise.resolve([]);
		});
		libraryCacheFindMany.mockResolvedValueOnce([makeLibraryRow("lc-1", "h264")]);

		const inject = createInjectAuthenticated(app);
		const res = await inject("GET", "/library-cleanup/field-options");
		expect(res.statusCode).toBe(200);

		// Only ONE call — short batch terminated the loop. The previous
		// (unbounded) shape made one call too; the proof here is no second
		// fetch when batch size < FIELD_OPTIONS_BATCH_SIZE.
		expect(libraryCacheFindMany).toHaveBeenCalledTimes(1);
	});

	it("aggregates Plex users / libraries / collections / labels in a SINGLE merged cursor walk", async () => {
		// Sonarr/Radarr empty so libraryCache loop is skipped; tautulli/jellyfin empty too.
		serviceInstanceFindMany.mockImplementation(({ where }: { where: { service: unknown } }) => {
			const svc = where.service;
			if (svc === "PLEX") {
				return Promise.resolve([
					{
						id: PLEX_INSTANCE_ID,
						userId: currentUserId,
						service: "PLEX",
						enabled: true,
						label: "Plex",
						expectedIdentity: "plex-machine-1",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityVerifiedAt: new Date(0),
						connectionGeneration: 1,
						identityGeneration: 1,
						updatedAt: new Date(0),
					},
				]);
			}
			return Promise.resolve([]);
		});

		// Two batches of plexCache rows. The fix collapses three formerly-
		// separate full-table scans into ONE cursor walk; verify only one
		// scan happens AND that it aggregates all four field types. To
		// trigger the second fetch, batch 1 must hit the page-size cap
		// (FIELD_OPTIONS_BATCH_SIZE=500); batch 2 carries the new values
		// that the cross-batch aggregation must pick up.
		const plexBatch1 = Array.from({ length: 499 }, (_, i) =>
			makePlexRow(`pc-${i}`, {
				sectionTitle: "Movies",
				watchedByUsers: ["alice"],
				collections: ["Marvel"],
				labels: ["fav"],
			}),
		);
		plexBatch1.push(
			makePlexRow("pc-499", {
				sectionTitle: "Movies",
				watchedByUsers: ["alice"],
				collections: ["Marvel"],
				labels: ["fav"],
			}),
		);
		const plexBatch2 = [
			makePlexRow("pc-500", {
				sectionTitle: "TV Shows",
				watchedByUsers: ["bob"],
				collections: ["Sci-Fi"],
				labels: ["new"],
			}),
		];
		plexCacheFindMany.mockResolvedValueOnce(plexBatch1).mockResolvedValueOnce(plexBatch2);
		cacheRefreshStatusFindMany.mockResolvedValue([
			{
				instanceId: PLEX_INSTANCE_ID,
				cacheType: "plex",
				lastRefreshedAt: new Date(),
				lastResult: "success",
				lastErrorMessage: null,
				lastAttemptAt: new Date(),
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				itemCount: 501,
				connectionGeneration: 1,
				identityGeneration: 1,
				generationId: "generation-1",
				generationMetadata: JSON.stringify({
					sections: [
						{ key: "movies", title: "Movies", type: "movie" },
						{ key: "shows", title: "TV Shows", type: "show" },
					],
				}),
			},
		]);

		const inject = createInjectAuthenticated(app);
		const res = await inject("GET", "/library-cleanup/field-options");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		expect(body.plexUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(body.plexLibraries).toEqual(expect.arrayContaining(["Movies", "TV Shows"]));
		expect(body.plexCollections).toEqual(expect.arrayContaining(["Marvel", "Sci-Fi"]));
		expect(body.plexLabels).toEqual(expect.arrayContaining(["fav", "new"]));
		expect(body.plexEvidence).toMatchObject({
			availability: "current",
			authority: "authoritative",
			attemptState: "success",
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
		});

		// CRITICAL: the merge means the same plex rows are scanned ONCE
		// per batch, not three times (users + libraries + collections/labels
		// previously each ran their own full-table scan). Two batches → 2
		// findMany calls total, NOT 6.
		expect(plexCacheFindMany).toHaveBeenCalledTimes(2);

		// Single merged select must include all four columns at once.
		const selectArg = plexCacheFindMany.mock.calls[0]?.[0]?.select;
		expect(selectArg).toMatchObject({
			id: true,
			sectionTitle: true,
			watchedByUsers: true,
			collections: true,
			labels: true,
		});
	});

	it("returns degraded evidence instead of treating unavailable Plex selectors as empty current values", async () => {
		serviceInstanceFindMany.mockImplementation(({ where }: { where: { service: unknown } }) => {
			if (where.service === "PLEX") {
				return Promise.resolve([
					{
						id: PLEX_INSTANCE_ID,
						userId: currentUserId,
						service: "PLEX",
						enabled: true,
						label: "Plex",
						expectedIdentity: "plex-machine-1",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityVerifiedAt: new Date(0),
						connectionGeneration: 1,
						identityGeneration: 1,
						updatedAt: new Date(0),
					},
				]);
			}
			return Promise.resolve([]);
		});
		plexCacheFindMany.mockResolvedValue([makePlexRow("pc-1", { collections: ["Historical"] })]);
		cacheRefreshStatusFindMany.mockResolvedValue([
			{
				instanceId: PLEX_INSTANCE_ID,
				cacheType: "plex",
				lastRefreshedAt: new Date(),
				lastResult: "success",
				lastErrorMessage: null,
				lastAttemptAt: new Date(),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "refresh failed",
				itemCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
				generationId: "generation-1",
				generationMetadata: JSON.stringify({ sections: [] }),
			},
		]);

		const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/field-options");
		const body = response.json();

		expect(response.statusCode).toBe(200);
		expect(body.plexCollections).toEqual([]);
		expect(body.plexEvidence).toMatchObject({
			availability: "last-known",
			authority: "unavailable",
			attemptState: "error",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["latest_attempt_failed"],
			publishedGeneration: { publicationLevel: "authoritative" },
		});
	});
});
