import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plexConnectionFingerprint } from "../../lib/plex/service-instance-fingerprint.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const USER_ID = "user-episode-explain";
const SONARR_INSTANCE_ID = "sonarr-1";
const PLEX_INSTANCE_ID = "plex-1";
const NOW = new Date("2026-08-12T12:00:00.000Z");

const sonarrInstance = {
	id: SONARR_INSTANCE_ID,
	userId: USER_ID,
	service: "SONARR",
	label: "Sonarr",
	baseUrl: "http://sonarr",
	encryptedApiKey: "sonarr-key",
	encryptionIv: "sonarr-iv",
	enabled: true,
	updatedAt: NOW,
};

const plexInstance = {
	id: PLEX_INSTANCE_ID,
	userId: USER_ID,
	service: "PLEX",
	label: "Plex",
	baseUrl: "http://plex",
	encryptedApiKey: "plex-key",
	encryptionIv: "plex-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
	updatedAt: NOW,
};

function makeEpisodeRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "episode-rule",
		configId: "cleanup-config",
		name: "Watched episodes",
		enabled: true,
		priority: 0,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "episode",
		action: "delete",
		operator: null,
		conditions: null,
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

let app: FastifyInstance;
let episodeGetAll: ReturnType<typeof vi.fn>;
let plexEpisodeCacheFindMany: ReturnType<typeof vi.fn>;
let serviceInstanceFindFirst: ReturnType<typeof vi.fn>;
let serviceInstanceFindMany: ReturnType<typeof vi.fn>;
let libraryCleanupConfigFindUnique: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	episodeGetAll = vi.fn().mockResolvedValue([
		{
			id: 202,
			seasonNumber: 1,
			episodeNumber: 2,
			episodeFileId: 7002,
			title: "The Second Episode",
		},
	]);
	plexEpisodeCacheFindMany = vi.fn().mockResolvedValue([
		{
			instanceId: PLEX_INSTANCE_ID,
			showTmdbId: 12345,
			seasonNumber: 1,
			episodeNumber: 2,
			watchCount: 1,
			lastWatchedAt: NOW,
			watchedByUsers: "[]",
			ratingKey: "plex-episode-202",
			refreshedAt: NOW,
			sourceFingerprint: plexConnectionFingerprint(plexInstance),
		},
	]);
	serviceInstanceFindFirst = vi.fn().mockResolvedValue(sonarrInstance);
	serviceInstanceFindMany = vi.fn().mockResolvedValue([sonarrInstance, plexInstance]);
	libraryCleanupConfigFindUnique = vi
		.fn()
		.mockResolvedValue({ id: "cleanup-config", rules: [makeEpisodeRule()] });

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: USER_ID, username: "admin" });
	registerTestErrorHandler(app);
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: serviceInstanceFindFirst,
			findMany: serviceInstanceFindMany,
		},
		libraryCache: {
			findFirst: vi.fn().mockResolvedValue({
				id: "series-cache",
				instanceId: SONARR_INSTANCE_ID,
				arrItemId: 101,
				itemType: "series",
				title: "Example Series",
				year: 2024,
				monitored: true,
				hasFile: true,
				status: "continuing",
				qualityProfileId: 1,
				qualityProfileName: "HD",
				sizeOnDisk: 1_000n,
				arrAddedAt: new Date(0),
				data: JSON.stringify({ remoteIds: { tmdbId: 12345 } }),
			}),
		},
		libraryCleanupConfig: {
			findUnique: libraryCleanupConfigFindUnique,
		},
		plexEpisodeCache: { findMany: plexEpisodeCacheFindMany },
		plexCache: { findMany: vi.fn().mockResolvedValue([]) },
	} as never);
	app.decorate("arrClientFactory", {
		createSonarrClient: vi.fn().mockReturnValue({ episode: { getAll: episodeGetAll } }),
	} as never);
	await app.register(registerLibraryCleanupRoutes);
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

function explainEpisode() {
	return createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
		body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101, arrEpisodeId: 202 },
	});
}

function explainSeries() {
	return createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
		body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101 },
	});
}

describe("POST /library-cleanup/explain episode scope", () => {
	it("evaluates the requested Sonarr episode against fresh, source-bound Plex evidence", async () => {
		const response = await explainEpisode();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			item: {
				itemType: "episode",
				targetScope: "episode",
				arrEpisodeId: 202,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeTitle: "The Second Episode",
			},
			results: [{ ruleId: "episode-rule", matched: true, filteredBy: null }],
			retentionProtected: false,
		});
		expect(plexEpisodeCacheFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: { in: [PLEX_INSTANCE_ID] }, watchCount: { gt: 0 } },
			}),
		);
	});

	it("reports disabled episode rules before scope, evidence, or predicate evaluation", async () => {
		libraryCleanupConfigFindUnique.mockResolvedValueOnce({
			id: "cleanup-config",
			rules: [makeEpisodeRule({ enabled: false })],
		});

		const response = await explainEpisode();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			results: [{ ruleId: "episode-rule", matched: false, filteredBy: "disabled" }],
		});
	});

	it("keeps a matching parent series retention rule protective during an episode explanation", async () => {
		libraryCleanupConfigFindUnique.mockResolvedValueOnce({
			id: "cleanup-config",
			rules: [
				{
					...makeEpisodeRule({
						id: "series-retention",
						name: "Keep aged series",
						priority: 0,
						targetScope: "series",
						ruleType: "age",
						parameters: JSON.stringify({ operator: "older_than", days: 0 }),
						serviceFilter: null,
						retentionMode: true,
					}),
				},
				makeEpisodeRule({ priority: 1 }),
			],
		});

		const response = await explainEpisode();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			results: [
				{ ruleId: "series-retention", matched: true, filteredBy: null, retentionMode: true },
				{ ruleId: "episode-rule", matched: true, filteredBy: null, retentionMode: false },
			],
			retentionProtected: true,
		});
	});

	it("returns explicit series identity when no episode is requested", async () => {
		const response = await explainSeries();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ item: { itemType: "series", targetScope: "series" } });
	});

	it("rejects episode explain requests for non-Sonarr instances", async () => {
		serviceInstanceFindFirst.mockResolvedValueOnce({ ...sonarrInstance, service: "RADARR" });

		const response = await explainEpisode();

		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "Episode explanations are supported for Sonarr only",
		});
	});

	it("reports a missing Sonarr episode without falling back to the series", async () => {
		episodeGetAll.mockResolvedValueOnce([]);

		const response = await explainEpisode();

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Episode not found for this series" });
	});

	it("reports an episode without a file as unavailable for cleanup explanation", async () => {
		episodeGetAll.mockResolvedValueOnce([
			{ id: 202, seasonNumber: 1, episodeNumber: 2, title: "The Second Episode" },
		]);

		const response = await explainEpisode();

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Episode file not found for this episode" });
	});

	it.each([
		["a different Plex connection", "wrong-fingerprint"],
		["stale Plex evidence", plexConnectionFingerprint(plexInstance)],
	] as const)("does not use %s as an episode witness", async (_label, sourceFingerprint) => {
		plexEpisodeCacheFindMany.mockResolvedValueOnce([
			{
				instanceId: PLEX_INSTANCE_ID,
				showTmdbId: 12345,
				seasonNumber: 1,
				episodeNumber: 2,
				watchCount: 1,
				lastWatchedAt: NOW,
				watchedByUsers: "[]",
				ratingKey: "plex-episode-202",
				refreshedAt:
					sourceFingerprint === "wrong-fingerprint" ? NOW : new Date("2026-08-10T11:59:59.000Z"),
				sourceFingerprint,
			},
		]);

		const response = await explainEpisode();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			results: [{ ruleId: "episode-rule", matched: false, filteredBy: "evidence_unavailable" }],
		});
	});

	it("reports unavailable evidence when no enabled Plex source exists", async () => {
		serviceInstanceFindMany.mockResolvedValueOnce([sonarrInstance]);

		const response = await explainEpisode();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			results: [{ ruleId: "episode-rule", matched: false, filteredBy: "evidence_unavailable" }],
		});
	});
});
