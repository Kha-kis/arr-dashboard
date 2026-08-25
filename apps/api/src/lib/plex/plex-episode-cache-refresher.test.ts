import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClientInstance } from "../prisma.js";
import type { PlexClient } from "./plex-client.js";
import { refreshPlexEpisodeCache as refreshGuardedPlexEpisodeCache } from "./plex-episode-cache-refresher.js";

const publication = vi.hoisted(() => ({
	client: undefined as PlexClient | undefined,
	positiveParents: undefined as Array<Record<string, unknown>> | undefined,
}));

vi.mock("./plex-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plex-client.js")>();
	return {
		...actual,
		PlexClient: class {
			constructor() {
				if (!publication.client) throw new Error("Plex episode test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

vi.mock("../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: vi.fn(
			async (
				prisma: PrismaClientInstance,
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
			) => {
				const snapshot = await collect();
				return await prisma.$transaction(async (tx) => await publish(tx, snapshot));
			},
		),
	};
});

vi.mock("../services/provider-cache-status.js", () => ({
	beginPlexCacheRefreshAttempt: vi.fn().mockResolvedValue({
		attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
		resultMarker: "in_progress:test-attempt",
	}),
	finishPlexCacheRefreshAttemptFailure: vi.fn().mockResolvedValue("recorded"),
}));

vi.mock("./service-instance-fingerprint.js", () => ({
	plexConnectionFingerprint: vi.fn(() => "fingerprint-1"),
}));

vi.mock("./plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plex-authority-service.js")>();
	const repository = await import("./plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: PrismaClientInstance;

			constructor(input: { prisma: PrismaClientInstance }) {
				this.prisma = input.prisma;
			}

			async scanInstanceEpisodeParentPolicy(input: {
				userId: string;
				instanceId: string;
				now?: Date;
				maxAgeMs?: number;
				onTargets?: (
					targets: Array<{
						mediaType: "movie" | "series";
						tmdbId: number;
						ratingKey: string;
					}>,
				) => void | Promise<void>;
			}) {
				if (publication.positiveParents) {
					return {
						available: false,
						evidence: { publicationLevel: "unavailable", completeness: "unknown" },
					};
				}
				const scanned = await repository.scanInstanceEpisodeParentPolicyEvidence(
					this.prisma,
					input,
				);
				if (!scanned.available) return scanned;
				const rows = await this.prisma.plexCache.findMany({
					where: { mediaType: "series", watchCount: { gt: 0 } },
				});
				await input.onTargets?.(
					rows
						.filter(
							(row: { mediaType: string; ratingKey: string | null }) =>
								row.mediaType === "series" && Boolean(row.ratingKey),
						)
						.map((row) => ({
							mediaType: "series" as const,
							tmdbId: row.tmdbId,
							ratingKey: row.ratingKey!,
						})),
				);
				return scanned;
			}

			async readPositiveEpisodeParents() {
				if (!publication.positiveParents) {
					return {
						available: false,
						evidence: { publicationLevel: "unavailable", completeness: "unknown" },
					};
				}
				return (
					publication.positiveParents.shift() ?? {
						available: false,
						evidence: { publicationLevel: "unavailable", completeness: "unknown" },
					}
				);
			}
		},
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;

function episode(ratingKey = "episode-1", viewCount = 1) {
	return {
		ratingKey,
		title: "Pilot",
		seasonNumber: 1,
		episodeNumber: 1,
		viewCount,
		lastViewedAt: 1_700_000_000,
	};
}

function client(overrides: Partial<PlexClient> = {}): PlexClient {
	return {
		getHistory: vi.fn().mockResolvedValue([
			{
				type: "episode",
				ratingKey: "episode-1",
				accountID: 1,
				viewedAt: 1_700_000_000,
			},
		]),
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
		getEpisodes: vi.fn().mockResolvedValue([episode()]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as PlexClient;
}

async function refreshPlexEpisodeCache(
	plexClient: PlexClient,
	db: PrismaClientInstance,
	instanceId: string,
	refreshLog: FastifyBaseLogger,
	_sourceFingerprint: string,
	_expectedConnection: unknown,
) {
	publication.client = plexClient;
	return await refreshGuardedPlexEpisodeCache({
		prisma: db,
		instance: {
			id: instanceId,
			userId: "user-1",
			service: "PLEX",
			label: "Plex",
			baseUrl: "https://plex.invalid",
			apiKey: "token",
			httpAuthHeaders: {},
			enabled: true,
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "plex-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 7,
			identityGeneration: 11,
		},
		log: refreshLog,
	});
}

function prisma(
	shows: Array<{
		tmdbId: number;
		ratingKey: string;
		mediaType?: string;
		watchCount?: number;
	}> = [{ tmdbId: 42, ratingKey: "show-1" }],
	currentConnection = { service: "PLEX", enabled: true, connectionGeneration: 7 },
	parentStatuses: Array<Record<string, unknown> | null> = [],
) {
	const fixtureNow = Date.now();
	const publishedAt = new Date(fixtureNow - 60_000);
	const attemptedAt = new Date(fixtureNow - 30_000);
	const baseParentStatus = {
		id: "plex-status-1",
		instanceId: "plex-1",
		cacheType: "plex",
		lastRefreshedAt: publishedAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: shows.length,
		generationId: "parent-generation-1",
		generationMetadata: JSON.stringify({
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: shows.length,
			canonicalizationVersion: 1,
			sections: [
				{
					key: "shows",
					uuid: "shows-uuid",
					title: "Shows",
					type: "show",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			],
			roots: [{ sectionKey: "shows", domain: "membership", digest: "a".repeat(64) }],
		}),
		lastAttemptAt: attemptedAt,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 7,
		identityGeneration: 11,
	};
	const parentStatus = (overrides: Record<string, unknown> = {}) => ({
		...baseParentStatus,
		...overrides,
	});
	const statuses =
		parentStatuses.length > 0
			? [...parentStatuses]
			: [parentStatus(), parentStatus(), parentStatus(), parentStatus()];
	const fullShows = shows.map((show, index) => ({
		id: `plex-row-${index + 1}`,
		instanceId: "plex-1",
		mediaType: "series",
		sectionId: "shows",
		sectionTitle: "Shows",
		title: `Show ${index + 1}`,
		lastWatchedAt: new Date(),
		watchCount: 1,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		labels: "[]",
		addedAt: null,
		thumb: null,
		connectionGeneration: 7,
		identityGeneration: 11,
		...show,
	}));
	const published: unknown[] = [];
	const tx = {
		serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
		plexEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				published.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: {
			upsert: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	const db = {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue({
				id: "plex-1",
				userId: "user-1",
				service: "PLEX",
				enabled: true,
				label: "Plex",
				connectionGeneration: 7,
				identityGeneration: 11,
				identityStatus: "VERIFIED",
				expectedIdentity: "plex-a",
				identityKind: "plex-machine-identifier",
				identityVerifiedAt: new Date(0),
				updatedAt: new Date(0),
			}),
		},
		cacheRefreshStatus: {
			findMany: vi.fn(async () => [statuses.shift() ?? parentStatus()]),
		},
		plexCache: {
			count: vi.fn().mockResolvedValue(fullShows.length),
			findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
				if (where?.mediaType === "series" && where.watchCount) {
					return fullShows.filter((row) => row.mediaType === "series" && row.watchCount > 0);
				}
				return fullShows;
			}),
		},
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	} as unknown as PrismaClientInstance;
	return { db, tx, published, parentStatus };
}

describe("refreshPlexEpisodeCache authoritative publication", () => {
	beforeEach(() => {
		publication.positiveParents = undefined;
	});

	function positiveParent(overrides: Record<string, unknown> = {}) {
		const target = {
			instanceId: "plex-1",
			generationId: "parent-positive-generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: 84,
			ratingKey: "show-1",
		};
		return {
			available: true,
			instanceId: "plex-1",
			generationId: "parent-positive-generation-1",
			connectionGeneration: 7,
			identityGeneration: 11,
			capability: {
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
			partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			provenance: {
				publicationLevel: "positive-only",
				completeness: "partial",
				parentTargetDigest: "a".repeat(64),
				parentTargetCount: 1,
			},
			rows: [{ instanceId: "plex-1", tmdbId: 42, sectionId: "shows", ratingKey: "show-1" }],
			targets: [target],
			evidence: { publicationLevel: "positive-only", completeness: "partial" },
			...overrides,
		};
	}

	it("publishes settled V4 parent evidence as a partial V3 episode generation without history", async () => {
		const fixture = prisma();
		const getHistory = vi.fn();
		publication.positiveParents = [positiveParent(), positiveParent(), positiveParent()];

		const result = await refreshPlexEpisodeCache(
			client({
				getHistory,
				getEpisodes: vi
					.fn()
					.mockResolvedValue([episode("episode-positive", 2), episode("episode-zero", 0)]),
			} as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({
			publicationLevel: "positive-only",
			complete: false,
			errors: 0,
			upserted: 1,
		});
		expect(getHistory).not.toHaveBeenCalled();
		expect(fixture.published).toEqual([
			expect.objectContaining({ ratingKey: "episode-positive", watchCount: 2 }),
		]);
		const metadata = JSON.parse(
			fixture.tx.cacheRefreshStatus.updateMany.mock.calls[0]![0].data.generationMetadata,
		);
		expect(metadata).toMatchObject({
			version: 3,
			publicationLevel: "positive-only",
			completeness: "partial",
			parentMetadataVersion: 4,
			parentTargetDigest: "a".repeat(64),
			capability: {
				domain: "episodes",
				field: "watchCount",
				semantics: "lower-bound",
				operator: "greater_than",
			},
		});
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ lastResult: "success", lastAttemptResult: "partial" }),
			}),
		);
	});

	it("queries only parents explicitly observed by V4 and leaves ledger-only parents unknown", async () => {
		const fixture = prisma();
		const observed = positiveParent();
		const ledgerOnlyTarget = {
			...observed.targets[0]!,
			tmdbId: 84,
			tvdbId: 168,
			ratingKey: "show-ledger-only",
		};
		publication.positiveParents = [
			positiveParent({ targets: [...observed.targets, ledgerOnlyTarget] }),
			positiveParent({ targets: [...observed.targets, ledgerOnlyTarget] }),
			positiveParent({ targets: [...observed.targets, ledgerOnlyTarget] }),
		];
		const getEpisodes = vi.fn().mockResolvedValue([episode("episode-positive", 2)]);

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ publicationLevel: "positive-only", upserted: 1 });
		expect(getEpisodes).toHaveBeenCalledTimes(2);
		expect(getEpisodes).toHaveBeenNthCalledWith(1, "show-1");
		expect(getEpisodes).toHaveBeenNthCalledWith(2, "show-1");
		expect(getEpisodes).not.toHaveBeenCalledWith("show-ledger-only");
	});

	it("treats duplicate ledger parents as unknown even when stored parent rows are collapsed", async () => {
		const fixture = prisma();
		const duplicateTargets = [
			{
				instanceId: "plex-1",
				generationId: "parent-positive-generation-1",
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tmdbId: 42,
				tvdbId: 84,
				ratingKey: "show-copy-a",
			},
			{
				instanceId: "plex-1",
				generationId: "parent-positive-generation-1",
				sectionId: "shows-4k",
				sectionUuid: "shows-4k-uuid",
				mediaType: "series" as const,
				tmdbId: 42,
				tvdbId: 84,
				ratingKey: "show-copy-b",
			},
		];
		publication.positiveParents = [
			positiveParent({ targets: duplicateTargets }),
			positiveParent({ targets: duplicateTargets }),
			positiveParent({ targets: duplicateTargets }),
		];
		const getEpisodes = vi.fn().mockResolvedValue([episode("episode-positive", 2)]);

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes }),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(getEpisodes).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			publicationLevel: "positive-only",
			upserted: 0,
			partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		});
		expect(fixture.published).toEqual([]);
	});

	it("keeps the prior episode generation when the positive parent target digest changes", async () => {
		const fixture = prisma();
		publication.positiveParents = [
			positiveParent(),
			positiveParent({
				provenance: {
					publicationLevel: "positive-only",
					completeness: "partial",
					parentTargetDigest: "b".repeat(64),
					parentTargetCount: 1,
				},
			}),
		];

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes: vi.fn().mockResolvedValue([episode("episode-positive", 2)]) }),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
		expect(result.errorMessages.join(" ")).toMatch(/positive parent Plex generation changed/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
	});

	it("keeps the prior episode generation when the positive row digest changes", async () => {
		const fixture = prisma();
		publication.positiveParents = [positiveParent(), positiveParent(), positiveParent()];
		const getEpisodes = vi
			.fn()
			.mockResolvedValueOnce([episode("episode-positive", 2)])
			.mockResolvedValueOnce([episode("episode-positive", 3)]);

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
		expect(result.errorMessages.join(" ")).toMatch(/positive Plex episode evidence changed/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
	});

	it("does not replace rows when the positive episode publication CAS is superseded", async () => {
		const fixture = prisma();
		fixture.tx.cacheRefreshStatus.updateMany.mockResolvedValue({ count: 0 });
		publication.positiveParents = [positiveParent(), positiveParent(), positiveParent()];

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes: vi.fn().mockResolvedValue([episode("episode-positive", 2)]) }),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ superseded: true, errors: 0, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
	});

	it("rolls back positive episode row replacement when the atomic write fails", async () => {
		const fixture = prisma();
		const storedRows: Array<{ ratingKey: string }> = [{ ratingKey: "prior-episode" }];
		fixture.tx.plexEpisodeCache.deleteMany.mockImplementation(async () => {
			storedRows.splice(0, storedRows.length);
			return { count: 1 };
		});
		fixture.tx.plexEpisodeCache.createMany.mockRejectedValue(new Error("episode write failed"));
		fixture.db.$transaction = vi.fn(async (callback) => {
			const before = [...storedRows];
			try {
				return await callback(fixture.tx);
			} catch (error) {
				storedRows.splice(0, storedRows.length, ...before);
				throw error;
			}
		});
		publication.positiveParents = [positiveParent(), positiveParent(), positiveParent()];

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes: vi.fn().mockResolvedValue([episode("episode-positive", 2)]) }),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(storedRows).toEqual([{ ratingKey: "prior-episode" }]);
	});

	it("uses stable parent authority timestamps within one fixture", () => {
		vi.useFakeTimers();
		try {
			const initialTime = new Date("2026-08-20T12:00:00.000Z");
			vi.setSystemTime(initialTime);
			const statusFactory = prisma();
			const firstStatus = statusFactory.parentStatus();
			vi.setSystemTime(new Date(initialTime.getTime() + 1));
			const laterStatus = statusFactory.parentStatus();

			expect((firstStatus.lastRefreshedAt as Date).getTime()).toBe(
				(laterStatus.lastRefreshedAt as Date).getTime(),
			);
			expect((firstStatus.lastAttemptAt as Date).getTime()).toBe(
				(laterStatus.lastAttemptAt as Date).getTime(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects publication when the parent timestamp changes across authority reads", async () => {
		const statusFactory = prisma();
		const firstStatus = statusFactory.parentStatus();
		const changedStatus = {
			...firstStatus,
			lastRefreshedAt: new Date((firstStatus.lastRefreshedAt as Date).getTime() + 1),
		};
		const fixture = prisma(undefined, undefined, [firstStatus, changedStatus]);

		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/parent Plex generation is unavailable/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it("atomically replaces one instance and binds every row to the published generation", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "plex-1" },
		});
		expect(fixture.published).toEqual([
			expect.objectContaining({
				instanceId: "plex-1",
				showTmdbId: 42,
				watchCount: 1,
				watchedByUsers: JSON.stringify(["Alice"]),
				sourceFingerprint: "fingerprint-1",
				refreshedAt: result.completedAt,
			}),
		]);
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastRefreshedAt: result.completedAt,
					itemCount: 1,
					generationId: expect.any(String),
					generationMetadata: expect.any(String),
				}),
			}),
		);
		const metadata = JSON.parse(
			fixture.tx.cacheRefreshStatus.updateMany.mock.calls[0]![0].data.generationMetadata,
		);
		expect(metadata).toEqual({
			version: 2,
			parentPlexGenerationId: "parent-generation-1",
			parentPublicationLevel: "authoritative",
			parentMetadataVersion: 3,
			canonicalizationVersion: 1,
			episodeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			connectionGeneration: 7,
			identityGeneration: 11,
		});
	});

	it("ignores more than the show capacity of ineligible parent rows", async () => {
		const fixture = prisma([
			{ tmdbId: 42, ratingKey: "show-watched" },
			...Array.from({ length: 201 }, (_, index) => ({
				tmdbId: 1_000 + index,
				ratingKey: `movie-${index}`,
				mediaType: "movie",
			})),
			{ tmdbId: 126, ratingKey: "show-unwatched", watchCount: 0 },
		]);
		const getEpisodes = vi.fn().mockResolvedValue([episode()]);

		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, eligibleShows: 1, refreshedShows: 1 });
		expect(getEpisodes).toHaveBeenCalledTimes(1);
		expect(getEpisodes).toHaveBeenCalledWith("show-watched");
	});

	it("keeps prior episode rows when the authoritative parent metadata is unavailable", async () => {
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			{
				...prisma().parentStatus(),
				generationMetadata: null,
			},
		]);
		const plexClient = client();

		const result = await refreshPlexEpisodeCache(
			plexClient,
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(plexClient.getHistory).not.toHaveBeenCalled();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps prior episode rows when the parent latest attempt failed", async () => {
		const failedParent = prisma().parentStatus({
			lastAttemptAt: new Date(Date.now() - 1_000),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "parent inventory changed",
			lastErrorMessage: "parent inventory changed",
		});
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			failedParent,
			{ ...failedParent },
		]);
		const plexClient = client();

		const result = await refreshPlexEpisodeCache(
			plexClient,
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(plexClient.getHistory).not.toHaveBeenCalled();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps prior episode rows when the parent generation changes during collection", async () => {
		const base = prisma().parentStatus();
		const changed = { ...base, generationId: "parent-generation-2" };
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			base,
			{ ...base },
			changed,
			{ ...changed },
		]);

		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(result.errorMessages.join(" ")).toMatch(/parent Plex generation changed/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("publishes a complete eligible-empty inventory and evicts stale rows", async () => {
		const fixture = prisma([]);
		const result = await refreshPlexEpisodeCache(
			client({ getHistory: vi.fn().mockResolvedValue([]) } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).toHaveBeenCalledOnce();
		expect(fixture.tx.plexEpisodeCache.createMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledOnce();
	});

	it("leaves the previous generation unchanged when one duplicate show copy fails", async () => {
		const fixture = prisma([
			{ tmdbId: 42, ratingKey: "show-a" },
			{ tmdbId: 42, ratingKey: "show-b" },
		]);
		const getEpisodes = vi
			.fn()
			.mockResolvedValueOnce([episode()])
			.mockRejectedValueOnce(new Error("copy unavailable"));
		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("publishes complete episode evidence beyond the legacy 5,000-row cap", async () => {
		const fixture = prisma();
		const history = Array.from({ length: 5000 }, (_, index) => ({
			type: "episode",
			ratingKey: "episode-1",
			accountID: 1,
			viewedAt: 1_700_000_000 + index,
		}));
		const getHistory = vi.fn().mockResolvedValue(history);
		const result = await refreshPlexEpisodeCache(
			client({ getHistory } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(getHistory).toHaveBeenCalledWith({ maxResults: 100_000, requireComplete: true });
		expect(fixture.db.$transaction).toHaveBeenCalledOnce();
	});

	it("keeps the previous episode generation when complete history exceeds the safety bound", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({
				getHistory: vi
					.fn()
					.mockRejectedValue(
						new Error("Plex history contains 100001 rows, exceeding the safe 100000-row limit"),
					),
			} as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/exceeding the safe 100000-row limit/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous episode generation when complete history contains a repeated page", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({
				getHistory: vi
					.fn()
					.mockRejectedValue(new Error("Plex history returned a duplicate row while paging")),
			} as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/duplicate row while paging/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous episode generation when history changes during episode enrichment", async () => {
		const fixture = prisma();
		const verifyHistorySnapshot = vi
			.fn()
			.mockRejectedValue(new Error("Plex history changed before publication"));
		const result = await refreshPlexEpisodeCache(
			client({ verifyHistorySnapshot } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/revalidate Plex history/i);
		expect(verifyHistorySnapshot).toHaveBeenCalledOnce();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("fails closed when account attribution is absent from a complete account inventory", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({ getAccounts: vi.fn().mockResolvedValue([]) } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("rejects inventories beyond the bounded complete-show capacity", async () => {
		const shows = Array.from({ length: 201 }, (_, index) => ({
			tmdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const fixture = prisma(shows);
		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({
			complete: false,
			capacityDegraded: true,
			eligibleShows: 201,
			refreshedShows: 0,
		});
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});
});
