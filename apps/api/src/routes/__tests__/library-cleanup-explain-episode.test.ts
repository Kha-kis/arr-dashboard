import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlexTargetLedgerBinding } from "../../lib/plex/plex-generation-target-ledger.js";
import { plexConnectionFingerprint } from "../../lib/plex/service-instance-fingerprint.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const authorityMock = vi.hoisted(() => ({
	positiveEpisodeEvidence: new Map<string, unknown>(),
}));

const additionalWatchMocks = vi.hoisted(() => ({ read: vi.fn(async () => new Map()) }));
vi.mock("../../lib/library-cleanup/additional-target-watch-policy.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/library-cleanup/additional-target-watch-policy.js")
	>()),
	loadAdditionalTargetWatchFacts: additionalWatchMocks.read,
	revalidateMatchedTargetWatchFacts: vi.fn(async () => true),
}));

const cleanupExecutorOverrides = vi.hoisted(() => ({
	buildEvalContextWithHealth: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
	loadTargetScopedPlexWatchCountFacts: undefined as
		| ((...args: unknown[]) => Promise<unknown>)
		| undefined,
}));

vi.mock("../../lib/library-cleanup/cleanup-executor.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/library-cleanup/cleanup-executor.js")>();
	return {
		...actual,
		buildEvalContextWithHealth: (...args: Parameters<typeof actual.buildEvalContextWithHealth>) =>
			cleanupExecutorOverrides.buildEvalContextWithHealth?.(...args) ??
			actual.buildEvalContextWithHealth(...args),
		loadTargetScopedPlexWatchCountFacts: (
			...args: Parameters<typeof actual.loadTargetScopedPlexWatchCountFacts>
		) =>
			cleanupExecutorOverrides.loadTargetScopedPlexWatchCountFacts?.(...args) ??
			actual.loadTargetScopedPlexWatchCountFacts(...args),
	};
});

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
	const parentGenerationId = "plex-parent-generation-1";
	const parentTargets = [
		{
			id: "plex-target-1",
			instanceId: PLEX_INSTANCE_ID,
			generationId: parentGenerationId,
			sectionId: "1",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 12345,
			tvdbId: null,
			ratingKey: "plex-show-12345",
		},
	];
	const parentTargetLedger = createPlexTargetLedgerBinding({
		instanceId: PLEX_INSTANCE_ID,
		generationId: parentGenerationId,
		connectionGeneration: 4,
		identityGeneration: 9,
		targets: parentTargets,
	});
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
									version: 5,
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
									...parentTargetLedger,
									partialReasons: [],
									coverageReceipt: {
										version: 1,
										provider: "plex",
										attemptStartedAt: NOW.toISOString(),
										observedAt: NOW.toISOString(),
										evidence: "complete",
										units: [
											{
												scopeKey: "section:1",
												expectedRawCount: 1,
												pagesAttempted: 1,
												pagesCompleted: 1,
												rawObserved: 1,
												sourceBindings: 1,
												canonicalEntities: 1,
												acceptedSkips: [],
												fatalCount: 0,
											},
										],
									},
								}),
							}
						: {
								...common,
								cacheType: "plex_episode",
								generationId: "plex-episode-generation-1",
								generationMetadata: JSON.stringify({
									version: 3,
									parentPlexGenerationId: parentGenerationId,
									parentPublicationLevel: "authoritative",
									parentMetadataVersion: 5,
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
		plexGenerationTarget: {
			findMany: vi.fn().mockResolvedValue(parentTargets),
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
	additionalWatchMocks.read.mockReset().mockResolvedValue(new Map());
	authorityMock.positiveEpisodeEvidence.clear();
	cleanupExecutorOverrides.buildEvalContextWithHealth = undefined;
	cleanupExecutorOverrides.loadTargetScopedPlexWatchCountFacts = undefined;
	await app?.close();
});

describe("POST /library-cleanup/explain episode scope", () => {
	it.each(["jellyfin", "tautulli"] as const)(
		"explains current positive %s target proof when aggregate evidence is unavailable",
		async (family) => {
			libraryCleanupConfigFindUnique.mockResolvedValue({
				id: "cleanup-config",
				rules: [
					{
						...episodeRule(0),
						id: "positive-rule",
						ruleType: `${family}_watch_count`,
						parameters: JSON.stringify({ operator: "greater_than", count: 2 }),
						targetScope: "series",
					},
				],
			});
			cleanupExecutorOverrides.buildEvalContextWithHealth = async () => ({
				ctx: { now: NOW },
				failedSources: new Set([family]),
			});
			additionalWatchMocks.read.mockResolvedValue(
				new Map([
					[
						"series:12345",
						[
							{
								userId: USER_ID,
								provider: family.toUpperCase(),
								cacheType: family,
								instanceId: `${family}-1`,
								generationId: "g",
								targetKey: "series:12345",
								coordinate: "bound-proof",
								observedValue: 3,
								targetScoped: true,
								status: {
									availability: "current",
									evidence: "positive-only",
									reasonCodes: [],
									domains: [
										{
											domain: "watch-count",
											availability: "current",
											evidence: "positive-only",
											valueSemantics: "lower-bound",
											reasonCodes: [],
										},
									],
								},
							},
						],
					],
				]),
			);
			const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
				body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101 },
			});
			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.payload)).toMatchObject({
				results: [{ ruleId: "positive-rule", matched: true, filteredBy: null }],
			});
			expect(additionalWatchMocks.read).toHaveBeenCalledWith(
				expect.anything(),
				USER_ID,
				[expect.objectContaining({ arrItemId: 101 })],
				expect.any(Set),
				undefined,
				{ verifyPositiveCounts: true },
			);
		},
	);

	it("preserves same-key Jellyfin and target-scoped Plex facts in a series explanation", async () => {
		const exactStatus = {
			availability: "current",
			evidence: "complete",
			reasonCodes: [],
			domains: [
				{
					domain: "watch-count",
					availability: "current",
					evidence: "complete",
					valueSemantics: "exact",
					reasonCodes: [],
				},
			],
		} as const;
		libraryCleanupConfigFindUnique.mockResolvedValue({
			id: "cleanup-config",
			rules: [
				{ ...episodeRule(0), id: "plex-series-rule", targetScope: "series" },
				{
					...episodeRule(0),
					id: "jellyfin-series-rule",
					name: "Jellyfin watched",
					ruleType: "jellyfin_watch_count",
					targetScope: "series",
				},
			],
		});
		cleanupExecutorOverrides.buildEvalContextWithHealth = async () =>
			({
				ctx: {
					now: NOW,
					providerWatchCountFacts: new Map([
						[
							"series:12345",
							[
								{
									userId: USER_ID,
									provider: "JELLYFIN",
									cacheType: "jellyfin",
									instanceId: "jellyfin-1",
									generationId: "jellyfin-generation-1",
									targetKey: "series:12345",
									coordinate: "jellyfin-series-12345",
									observedValue: 2,
									status: exactStatus,
								},
							],
						],
					]),
				},
				failedSources: new Set(),
				providerEvidence: { dependencies: [], sources: [] },
			}) as never;
		cleanupExecutorOverrides.loadTargetScopedPlexWatchCountFacts = async () =>
			new Map([
				[
					"series:12345",
					[
						{
							userId: USER_ID,
							provider: "PLEX",
							cacheType: "plex",
							instanceId: PLEX_INSTANCE_ID,
							generationId: "plex-v6-generation-1",
							targetKey: "series:12345",
							coordinate: "1:plex-show-12345",
							sectionTitle: "TV",
							observedValue: 2,
							status: exactStatus,
							targetScoped: true,
						},
					],
				],
			]) as never;

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101 },
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			results: [
				{ ruleId: "plex-series-rule", matched: true, filteredBy: null },
				{ ruleId: "jellyfin-series-rule", matched: true, filteredBy: null },
			],
		});
	});

	it("does not read a target-scoped Plex ledger for an unrelated age explanation", async () => {
		libraryCleanupConfigFindUnique.mockResolvedValue({
			id: "cleanup-config",
			rules: [
				{
					...episodeRule(0),
					id: "age-rule",
					name: "Old item",
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 1 }),
					targetScope: "series",
				},
			],
		});
		const readTargetScopedFacts = vi.fn(async () => new Map());
		cleanupExecutorOverrides.loadTargetScopedPlexWatchCountFacts = readTargetScopedFacts;

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101 },
		});

		expect(response.statusCode).toBe(200);
		expect(readTargetScopedFacts).not.toHaveBeenCalled();
	});

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

	it("matches the exact positively observed episode for the reporter delete rule", async () => {
		libraryCleanupConfigFindUnique.mockResolvedValue({
			id: "cleanup-config",
			dryRunMode: true,
			requireApproval: true,
			rejectionMemoryDays: 0,
			rules: [episodeRule(0)],
		});
		authorityMock.positiveEpisodeEvidence.set(PLEX_INSTANCE_ID, {
			available: true,
			instanceId: PLEX_INSTANCE_ID,
			connectionGeneration: 4,
			identityGeneration: 9,
			provenance: {
				publicationLevel: "positive-only",
				completeness: "partial",
				parentPlexGenerationId: "parent-generation",
				parentTargetDigest: "parent-target-digest",
				episodeGenerationId: "episode-generation",
				episodeDigest: "episode-digest",
				publishedAt: NOW.toISOString(),
			},
			rows: [
				{
					showTmdbId: 12345,
					seasonNumber: 1,
					episodeNumber: 2,
					ratingKey: "plex-episode-202",
					lowerBound: 1,
					sourceFingerprint: plexConnectionFingerprint(plexInstance),
					soleParentTarget: { ratingKey: "plex-show-12345" },
				},
			],
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: SONARR_INSTANCE_ID, arrItemId: 101, arrEpisodeId: 202 },
		});
		const payload = JSON.parse(response.payload) as {
			item: { arrEpisodeId: number; seasonNumber: number; episodeNumber: number };
			results: Array<{ matched: boolean; reason: string | null }>;
		};

		expect(response.statusCode).toBe(200);
		expect(payload.item).toMatchObject({
			itemType: "episode",
			targetScope: "episode",
			arrEpisodeId: 202,
			seasonNumber: 1,
			episodeNumber: 2,
		});
		expect(payload.results).toEqual([
			expect.objectContaining({
				ruleId: "episode-rule",
				matched: true,
				reason: "Plex watch count 1 > 0",
				filteredBy: null,
			}),
		]);
		expect(JSON.stringify(payload)).not.toContain("http://");
		expect(JSON.stringify(payload)).not.toContain("parent-target-digest");
	});

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
