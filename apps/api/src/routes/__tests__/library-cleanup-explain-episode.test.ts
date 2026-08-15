import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plexConnectionFingerprint } from "../../lib/plex/service-instance-fingerprint.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const USER_ID = "user-episode-explain";
const SONARR_INSTANCE_ID = "sonarr-1";
const PLEX_INSTANCE_ID = "plex-1";
const NOW = new Date();

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
	expectedIdentity: "plex-machine-1",
	identityKind: "plex-machine-identifier",
	identityStatus: "VERIFIED",
	identityVerifiedAt: new Date(NOW.getTime() - 1_000),
	connectionGeneration: 4,
	identityGeneration: 9,
	updatedAt: NOW,
};

let app: FastifyInstance;
let plexEpisodeCacheFindMany: ReturnType<typeof vi.fn>;
let plexCacheFindMany: ReturnType<typeof vi.fn>;
let libraryCleanupConfigFindUnique: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	const serviceInstanceFindMany = vi
		.fn()
		.mockImplementation(({ where }: { where: { service?: string; enabled?: boolean } }) => {
			if (where.service === "PLEX") return Promise.resolve([plexInstance]);
			if (where.enabled === true) return Promise.resolve([sonarrInstance, plexInstance]);
			return Promise.resolve([]);
		});
	plexCacheFindMany = vi
		.fn()
		.mockResolvedValueOnce([
			{
				id: "plex-series",
				tmdbId: 12345,
				mediaType: "series",
				sectionId: "1",
				sectionTitle: "TV",
				lastWatchedAt: NOW,
				watchCount: 99,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: NOW,
			},
		])
		.mockResolvedValueOnce([]);
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
			connectionGeneration: 4,
			identityGeneration: 9,
		},
	]);
	libraryCleanupConfigFindUnique = vi.fn().mockResolvedValue({
		id: "cleanup-config",
		rules: [
			{
				id: "episode-rule",
				configId: "cleanup-config",
				name: "Watched episodes",
				enabled: true,
				priority: 0,
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 2 }),
				serviceFilter: null,
				instanceFilter: null,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				targetScope: "episode",
				action: "delete",
				operator: null,
				conditions: null,
				retentionMode: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	});

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: USER_ID, username: "admin" });
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(sonarrInstance),
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
				arrAddedAt: NOW,
				data: JSON.stringify({ remoteIds: { tmdbId: 12345 } }),
			}),
		},
		libraryCleanupConfig: {
			findUnique: libraryCleanupConfigFindUnique,
		},
		plexEpisodeCache: {
			findMany: plexEpisodeCacheFindMany,
			groupBy: vi.fn().mockResolvedValue([{ instanceId: PLEX_INSTANCE_ID, _count: { id: 1 } }]),
		},
		cacheRefreshStatus: {
			findMany: vi.fn().mockResolvedValue([
				{
					instanceId: PLEX_INSTANCE_ID,
					lastRefreshedAt: NOW,
					lastResult: "success",
					lastErrorMessage: null,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
					itemCount: 1,
					connectionGeneration: 4,
					identityGeneration: 9,
				},
			]),
		},
		plexCache: { findMany: plexCacheFindMany },
	} as never);
	app.decorate("arrClientFactory", {
		createSonarrClient: vi.fn().mockReturnValue({
			episode: {
				getAll: vi.fn().mockResolvedValue([
					{
						id: 202,
						seasonNumber: 1,
						episodeNumber: 2,
						title: "The Second Episode",
					},
				]),
			},
		}),
	} as never);

	await app.register(registerLibraryCleanupRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("POST /library-cleanup/explain episode scope", () => {
	it("evaluates the selected episode instead of the parent series aggregate", async () => {
		const inject = createInjectAuthenticated(app);
		const response = await inject("POST", "/library-cleanup/explain", {
			body: {
				instanceId: SONARR_INSTANCE_ID,
				arrItemId: 101,
				arrEpisodeId: 202,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			item: {
				itemType: "episode",
				targetScope: "episode",
				arrEpisodeId: 202,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeTitle: "The Second Episode",
			},
			results: [
				{
					ruleId: "episode-rule",
					matched: false,
					reason: null,
					filteredBy: null,
				},
			],
			retentionProtected: false,
		});
		expect(plexEpisodeCacheFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId: { in: [PLEX_INSTANCE_ID] },
					showTmdbId: 12345,
					seasonNumber: 1,
					episodeNumber: 2,
				},
			}),
		);
		expect(plexCacheFindMany).not.toHaveBeenCalled();
	});

	it("reports missing Plex episode evidence as unavailable", async () => {
		plexEpisodeCacheFindMany.mockResolvedValue([]);
		const inject = createInjectAuthenticated(app);
		const response = await inject("POST", "/library-cleanup/explain", {
			body: {
				instanceId: SONARR_INSTANCE_ID,
				arrItemId: 101,
				arrEpisodeId: 202,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			results: [
				{
					ruleId: "episode-rule",
					matched: false,
					reason: null,
					filteredBy: "evidence_unavailable",
				},
			],
		});
	});

	it.each([
		["series", undefined],
		["episode", 202],
	] as const)(
		"reports unavailable retention evidence as protective for a %s explanation",
		async (_scope, arrEpisodeId) => {
			libraryCleanupConfigFindUnique.mockResolvedValue({
				id: "cleanup-config",
				rules: [
					{
						id: "tautulli-retention",
						configId: "cleanup-config",
						name: "Keep watched series",
						enabled: true,
						priority: 0,
						ruleType: "tautulli_watch_count",
						parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
						serviceFilter: null,
						instanceFilter: null,
						excludeTags: null,
						excludeTitles: null,
						plexLibraryFilter: null,
						targetScope: "series",
						action: "delete",
						operator: null,
						conditions: null,
						retentionMode: true,
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			});
			const inject = createInjectAuthenticated(app);
			const response = await inject("POST", "/library-cleanup/explain", {
				body: {
					instanceId: SONARR_INSTANCE_ID,
					arrItemId: 101,
					...(arrEpisodeId === undefined ? {} : { arrEpisodeId }),
				},
			});

			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.payload)).toMatchObject({
				results: [
					{
						ruleId: "tautulli-retention",
						matched: false,
						filteredBy: "evidence_unavailable",
						retentionMode: true,
					},
				],
				retentionProtected: true,
			});
		},
	);
});
