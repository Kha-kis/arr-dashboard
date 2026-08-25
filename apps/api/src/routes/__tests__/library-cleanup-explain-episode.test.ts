import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plexConnectionFingerprint } from "../../lib/plex/service-instance-fingerprint.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const authorityMock = vi.hoisted(() => ({
	positiveEpisodeEvidence: new Map<string, unknown>(),
}));

vi.mock("../../lib/plex/plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/plex/plex-authority-service.js")>();
	const repository = await import("../../lib/plex/plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: {
				serviceInstance: { findMany: (input: unknown) => Promise<Array<Record<string, unknown>>> };
			};

			constructor(input: {
				prisma: {
					serviceInstance: {
						findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
					};
				};
			}) {
				this.prisma = input.prisma;
			}

			async readInstanceEpisodes(input: { userId: string; instanceId: string }) {
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				const instance = instances.find((entry) => entry.id === input.instanceId);
				return await repository.loadInstanceEpisodeEvidence(
					this.prisma as never,
					{
						...input,
						instance: instance as never,
					} as never,
				);
			}

			async readPositiveEpisodeEvidence(input: { instanceId: string }) {
				return (
					authorityMock.positiveEpisodeEvidence.get(input.instanceId) ?? {
						available: false as const,
						instanceId: input.instanceId,
						evidence: { reasonCodes: ["positive_episode_unavailable"] },
					}
				);
			}
		},
	};
});

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

function episodeRule(threshold = 2) {
	return {
		id: "episode-rule",
		configId: "cleanup-config",
		name: "Watched episodes",
		enabled: true,
		priority: 0,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: threshold }),
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
	};
}

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
				instanceId: PLEX_INSTANCE_ID,
				tmdbId: 12345,
				mediaType: "series",
				sectionId: "1",
				sectionTitle: "TV",
				ratingKey: "plex-show-12345",
				lastWatchedAt: NOW,
				watchCount: 99,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: NOW,
				refreshedAt: NOW,
				sourceFingerprint: plexConnectionFingerprint(plexInstance),
				connectionGeneration: 4,
				identityGeneration: 9,
			},
		])
		.mockResolvedValueOnce([]);
	plexEpisodeCacheFindMany = vi.fn().mockResolvedValue([
		{
			id: "plex-episode-row-202",
			instanceId: PLEX_INSTANCE_ID,
			showTmdbId: 12345,
			seasonNumber: 1,
			episodeNumber: 2,
			title: "The Second Episode",
			watched: true,
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
		rules: [episodeRule()],
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
		cacheRefreshStatus: {
			findMany: vi.fn(({ where }: { where: { cacheType: string } }) => {
				const parentGenerationId = "plex-parent-generation-1";
				const common = {
					instanceId: PLEX_INSTANCE_ID,
					lastRefreshedAt: NOW,
					lastResult: "success",
					lastErrorMessage: null,
					lastAttemptAt: NOW,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
					itemCount: 1,
					connectionGeneration: 4,
					identityGeneration: 9,
				};
				return Promise.resolve([
					where.cacheType === "plex"
						? {
								...common,
								cacheType: "plex",
								generationId: parentGenerationId,
								generationMetadata: JSON.stringify({
									version: 3,
									publicationLevel: "authoritative",
									completeness: "complete",
									itemCount: 1,
									canonicalizationVersion: 1,
									sections: [
										{
											key: "1",
											uuid: "shows-uuid",
											title: "TV",
											type: "show",
											refreshing: false,
											scannedAt: 1_777_000_000,
											updatedAt: 1_777_000_100,
										},
									],
									roots: [{ sectionKey: "1", domain: "membership", digest: "a".repeat(64) }],
									targetLedgerVersion: 1,
									targetCount: 1,
									targetDigest: "c".repeat(64),
								}),
							}
						: {
								...common,
								cacheType: "plex_episode",
								generationId: "plex-episode-generation-1",
								generationMetadata: JSON.stringify({
									version: 2,
									parentPlexGenerationId: parentGenerationId,
									parentPublicationLevel: "authoritative",
									parentMetadataVersion: 3,
									canonicalizationVersion: 1,
									episodeDigest: "b".repeat(64),
									connectionGeneration: 4,
									identityGeneration: 9,
								}),
							},
				]);
			}),
		},
		plexCache: { findMany: plexCacheFindMany, count: vi.fn().mockResolvedValue(1) },
		plexEpisodeCache: {
			findMany: plexEpisodeCacheFindMany,
			count: vi.fn().mockResolvedValue(1),
		},
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
	authorityMock.positiveEpisodeEvidence.clear();
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
			providerEvidence: {
				sources: [expect.objectContaining({ cacheType: "plex_episode" })],
			},
		});
		expect(plexEpisodeCacheFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: PLEX_INSTANCE_ID },
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
		["lower bound 2 greater than 0", 0, true, null],
		["lower bound 2 greater than 1", 1, true, null],
		["lower bound 2 not proven greater than 2", 2, false, "evidence_unavailable"],
		["lower bound 2 not proven greater than 3", 3, false, "evidence_unavailable"],
	] as const)(
		"uses positive-only episode semantics for %s",
		async (_case, threshold, matched, filteredBy) => {
			libraryCleanupConfigFindUnique.mockResolvedValue({
				id: "cleanup-config",
				rules: [episodeRule(threshold)],
			});
			authorityMock.positiveEpisodeEvidence.set(PLEX_INSTANCE_ID, {
				available: true,
				instanceId: PLEX_INSTANCE_ID,
				connectionGeneration: 4,
				identityGeneration: 9,
				provenance: {
					publicationLevel: "positive-only",
					completeness: "partial",
					parentPlexGenerationId: "parent-v4",
					parentTargetDigest: "parent-target-digest",
					episodeGenerationId: "episode-v3",
					episodeDigest: "episode-digest",
					publishedAt: NOW.toISOString(),
				},
				rows: [
					{
						showTmdbId: 12345,
						seasonNumber: 1,
						episodeNumber: 2,
						ratingKey: "plex-episode-202",
						lowerBound: 2,
						sourceFingerprint: plexConnectionFingerprint(plexInstance),
						soleParentTarget: { ratingKey: "plex-show-12345" },
					},
				],
			});

			const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
				body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101, arrEpisodeId: 202 },
			});

			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.payload)).toMatchObject({
				results: [{ ruleId: "episode-rule", matched, filteredBy }],
			});
		},
	);

	it("reports an authoritative exact zero as false instead of unavailable", async () => {
		libraryCleanupConfigFindUnique.mockResolvedValue({
			id: "cleanup-config",
			rules: [episodeRule(0)],
		});
		plexEpisodeCacheFindMany.mockResolvedValue([
			{
				id: "plex-episode-row-202",
				instanceId: PLEX_INSTANCE_ID,
				showTmdbId: 12345,
				seasonNumber: 1,
				episodeNumber: 2,
				title: "The Second Episode",
				watched: false,
				watchCount: 0,
				lastWatchedAt: null,
				watchedByUsers: "[]",
				ratingKey: "plex-episode-202",
				refreshedAt: NOW,
				sourceFingerprint: plexConnectionFingerprint(plexInstance),
				connectionGeneration: 4,
				identityGeneration: 9,
			},
		]);

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101, arrEpisodeId: 202 },
		});

		expect(JSON.parse(response.payload)).toMatchObject({
			results: [{ ruleId: "episode-rule", matched: false, filteredBy: null }],
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
