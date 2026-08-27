/**
 * Cross-batch Map merge test for `prefetchPlexData` — pins the v2.18.4
 * cursor-pagination behavior. Distinct from the auto-tag pagination test
 * because the prefetcher *aggregates* across batches (same `mediaType:tmdbId`
 * appearing in batch 1 and batch 2 must merge into one map entry with summed
 * watchCount, deduped watchedByUsers, and union'd collections/labels).
 *
 * Without this test, a refactor that reset the map per batch (or used
 * `new Map()` inside the loop) would silently drop watch data and the
 * auto-tag test wouldn't catch it.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { plexConnectionFingerprint } from "../../plex/service-instance-fingerprint.js";
import {
	buildEvalContextWithHealth,
	prefetchFreshPlexEpisodeWatchData,
	prefetchPlexData,
} from "../cleanup-executor.js";
import { evaluateItemAgainstRules } from "../rule-evaluators.js";
import type { CleanupExecutorDeps } from "../types.js";

const authorityMock = vi.hoisted(() => ({
	policyEvidence: new Map<string, unknown>(),
	positiveEpisodeEvidence: new Map<string, unknown>(),
}));

vi.mock("../../plex/plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../plex/plex-authority-service.js")>();
	const repository = await import("../../plex/plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: {
				serviceInstance?: { findMany: (input: unknown) => Promise<Array<Record<string, unknown>>> };
			};

			constructor(input: {
				prisma: {
					serviceInstance?: {
						findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
					};
				};
			}) {
				this.prisma = input.prisma;
			}

			private async instance(input: { userId: string; instanceId: string }) {
				if (!this.prisma.serviceInstance) {
					return {
						id: input.instanceId,
						userId: input.userId,
						service: "PLEX",
						enabled: true,
						label: "Plex",
						expectedIdentity: "stored-plex-machine-identity",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityVerifiedAt: new Date(0),
						connectionGeneration: 3,
						identityGeneration: 7,
					};
				}
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				return instances.find((instance) => instance.id === input.instanceId);
			}

			private repositoryInput() {
				return this.prisma as never;
			}

			private repositoryWithInstance(instance: Record<string, unknown> | undefined) {
				return {
					...this.prisma,
					serviceInstance: {
						...this.prisma.serviceInstance,
						findFirst: vi.fn().mockResolvedValue(instance ?? null),
					},
				} as never;
			}

			async readInstance(input: { userId: string; instanceId: string }) {
				const scanned = authorityMock.policyEvidence.get(input.instanceId);
				if (scanned) return scanned;
				const instance = await this.instance(input);
				return repository.loadInstanceEvidence(this.repositoryWithInstance(instance), input);
			}

			async readInstanceSelected(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.loadInstanceSelectedEvidence(
					this.repositoryWithInstance(instance),
					input as never,
				);
			}

			async scanInstancePolicy(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				const evidence = await repository.scanInstancePolicyEvidence(
					this.repositoryWithInstance(instance),
					input,
				);
				authorityMock.policyEvidence.set(input.instanceId, evidence);
				return evidence;
			}

			async scanInstanceExactPolicy(input: { userId: string; instanceId: string }) {
				return await this.scanInstancePolicy(input);
			}

			async scanInstanceExactPolicyPersisted(input: { userId: string; instanceId: string }) {
				return await this.scanInstancePolicy(input);
			}

			scanUserPolicy(input: never) {
				return repository.scanUserPolicyEvidence(this.repositoryInput(), input);
			}

			async readInstanceEpisodes(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.loadInstanceEpisodeEvidence(this.repositoryInput(), {
					...input,
					instance: instance as never,
				});
			}

			async readInstanceSelectedEpisodes(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.loadInstanceSelectedEpisodeEvidence(this.repositoryInput(), {
					...input,
					instance: instance as never,
				} as never);
			}

			async readPositiveEpisodeEvidence(input: { instanceId: string }) {
				return (
					authorityMock.positiveEpisodeEvidence.get(input.instanceId) ?? {
						available: false,
						instanceId: input.instanceId,
						evidence: { reasonCode: "positive_episode_unavailable" },
					}
				);
			}
		},
	};
});

function makePlexRow(overrides: {
	id: string;
	instanceId?: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle?: string;
	watchCount?: number;
	watchedByUsers?: string[];
	collections?: string[];
	labels?: string[];
	lastWatchedAt?: Date | null;
	addedAt?: Date | null;
	onDeck?: boolean;
	userRating?: number | null;
	connectionGeneration?: number | null;
	identityGeneration?: number | null;
}) {
	return {
		id: overrides.id,
		instanceId: overrides.instanceId ?? "plex-inst-1",
		tmdbId: overrides.tmdbId,
		mediaType: overrides.mediaType,
		sectionId: overrides.sectionId,
		sectionTitle: overrides.sectionTitle ?? `Section ${overrides.sectionId}`,
		lastWatchedAt: overrides.lastWatchedAt ?? null,
		watchCount: overrides.watchCount ?? 0,
		watchedByUsers: JSON.stringify(overrides.watchedByUsers ?? []),
		onDeck: overrides.onDeck ?? false,
		userRating: overrides.userRating ?? null,
		collections: JSON.stringify(overrides.collections ?? []),
		labels: JSON.stringify(overrides.labels ?? []),
		addedAt: overrides.addedAt ?? null,
		connectionGeneration: overrides.connectionGeneration ?? 3,
		identityGeneration: overrides.identityGeneration ?? 7,
	};
}

function verifiedPlexInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "plex-inst-1",
		userId: "user-1",
		service: "PLEX",
		enabled: true,
		baseUrl: "http://plex.internal:32400",
		encryptedApiKey: "encrypted-token",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "stored-plex-machine-identity",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date(0),
		connectionGeneration: 3,
		identityGeneration: 7,
		updatedAt: new Date(0),
		...overrides,
	};
}

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

function completeStatus(instanceId: string, completedAt = new Date(), itemCount = 0) {
	return {
		instanceId,
		lastRefreshedAt: completedAt,
		lastResult: "success",
		itemCount,
		generationId: `generation-${instanceId}`,
		generationMetadata: JSON.stringify({
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount,
			canonicalizationVersion: 1,
			sections: [
				{
					key: "1",
					uuid: "movies-uuid",
					title: "Movies",
					type: "movie",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			],
			roots: [{ sectionKey: "1", domain: "membership", digest: "a".repeat(64) }],
			targetLedgerVersion: 1,
			targetCount: itemCount,
			targetDigest: "c".repeat(64),
		}),
		lastErrorMessage: null,
		lastAttemptAt: completedAt,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 3,
		identityGeneration: 7,
	};
}

function completeEpisodeStatus(instanceId: string, completedAt: Date, itemCount: number) {
	return {
		...completeStatus(instanceId, completedAt, itemCount),
		cacheType: "plex_episode",
		generationId: `episode-generation-${instanceId}`,
		generationMetadata: JSON.stringify({
			version: 2,
			parentPlexGenerationId: `generation-${instanceId}`,
			parentPublicationLevel: "authoritative",
			parentMetadataVersion: 3,
			canonicalizationVersion: 1,
			episodeDigest: "b".repeat(64),
			connectionGeneration: 3,
			identityGeneration: 7,
		}),
	};
}

function episodeStatuses(instanceId: string, completedAt: Date, itemCount: number) {
	const parent = completeStatus(instanceId, completedAt, 1);
	const episode = completeEpisodeStatus(instanceId, completedAt, itemCount);
	return vi.fn(async ({ where }: { where: { cacheType: string } }) =>
		where.cacheType === "plex" ? [parent] : [episode],
	);
}

function plexCleanupRule(ruleType = "plex_watch_count") {
	return {
		id: `rule-${ruleType}`,
		configId: "config-1",
		name: ruleType,
		enabled: true,
		priority: 1,
		ruleType,
		parameters: JSON.stringify(
			ruleType === "plex_episode_completion"
				? { operator: "less_than", percent: 100 }
				: { operator: "greater_than", count: 0 },
		),
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "series",
		action: "delete",
		scanMediaServerAfterDelete: false,
		operator: null,
		conditions: null,
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: new Date("2026-08-10T00:00:00.000Z"),
		updatedAt: new Date("2026-08-10T00:00:00.000Z"),
	};
}

const plexDecisionItem = {
	id: "library-1",
	instanceId: "sonarr-1",
	arrItemId: 42,
	itemType: "series" as const,
	title: "Example Series",
	year: 2020,
	monitored: true,
	hasFile: true,
	status: "ended",
	qualityProfileId: 1,
	qualityProfileName: "Default",
	sizeOnDisk: 1n,
	arrAddedAt: new Date("2026-01-01T00:00:00.000Z"),
	data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
};

type PlexStatusOverride =
	| Partial<{
			lastRefreshedAt: Date;
			lastResult: string;
			lastAttemptResult: string;
			lastErrorMessage: string | null;
			lastAttemptErrorMessage: string | null;
			itemCount: number;
			connectionGeneration: number | null;
			identityGeneration: number | null;
	  }>
	| undefined;

const unavailablePlexEvidenceCases = [
	["missing status", () => undefined],
	["stale timestamp", () => ({ lastRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })],
	["failed result", () => ({ lastResult: "error" })],
	["failed latest attempt", () => ({ lastAttemptResult: "error" })],
	["latest-attempt error", () => ({ lastAttemptErrorMessage: "refresh failed" })],
	["missing connection generation", () => ({ connectionGeneration: null })],
	["missing identity generation", () => ({ identityGeneration: null })],
	["stale connection generation", () => ({ connectionGeneration: 2 })],
	["stale identity generation", () => ({ identityGeneration: 6 })],
	["connection repoint", () => ({ lastRefreshedAt: new Date("2026-08-10T10:00:00.000Z") })],
	["normal cache row-count mismatch", () => ({ itemCount: 2 })],
] satisfies ReadonlyArray<readonly [string, () => PlexStatusOverride]>;

describe("prefetchPlexData — cross-batch Map merge (v2.18.4 OOM fix)", () => {
	it("does not authorize cleanup from an unverified Plex cache source", async () => {
		const instance = {
			id: "plex-inst-1",
			updatedAt: new Date(0),
			service: "PLEX",
			enabled: true,
			expectedIdentity: "raw-identity-must-not-be-used-as-evidence",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "UNVERIFIED",
			identityVerifiedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus(instance.id, new Date(), 1)]),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule()],
		);

		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.failedSources).toContain("plex");
	});

	it("rejects ambiguous Tautulli sources instead of combining their watch history", async () => {
		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{ ...verifiedPlexInstance(), id: "tautulli-a", service: "TAUTULLI" },
					{ ...verifiedPlexInstance(), id: "tautulli-b", service: "TAUTULLI" },
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "tautulli_watch_count",
					parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
					conditions: null,
					plexLibraryFilter: null,
				},
			],
		);

		expect(result.ctx.tautulliMap).toBeUndefined();
		expect(result.failedSources).toContain("tautulli");
	});

	it("keeps complete single-source Tautulli evidence unavailable without section-to-ARR mapping", async () => {
		const instance = {
			...verifiedPlexInstance(),
			id: "tautulli-1",
			service: "TAUTULLI",
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus(instance.id, new Date(), 1)]),
			},
			tautulliCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "tautulli-row-1",
						instanceId: instance.id,
						generationId: `generation-${instance.id}`,
						tmdbId: 42,
						mediaType: "movie",
						lastWatchedAt: null,
						watchCount: 5,
						watchedByUsers: '["alice"]',
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const rule = {
			enabled: true,
			ruleType: "tautulli_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			conditions: null,
			plexLibraryFilter: null,
		};
		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[rule],
		);

		expect(result.ctx.tautulliMap).toBeUndefined();
		expect(result.failedSources).toContain("tautulli");
	});

	it.each(unavailablePlexEvidenceCases)(
		"blocks Plex cleanup evidence for %s",
		async (caseName, overrides) => {
			const instance = verifiedPlexInstance({
				updatedAt:
					caseName === "connection repoint"
						? new Date("2026-08-10T11:00:00.000Z")
						: new Date("2026-08-10T00:00:00.000Z"),
			});
			const baseStatus = completeStatus(instance.id, new Date(), 1);
			const statusOverride = overrides();
			const status = statusOverride ? { ...baseStatus, ...statusOverride } : undefined;
			const prisma = {
				serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
				cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue(status ? [status] : []) },
				plexCache: {
					count: vi.fn().mockResolvedValue(1),
					findMany: vi
						.fn()
						.mockResolvedValue([
							makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
						]),
				},
			} as unknown as CleanupExecutorDeps["prisma"];
			const rule = plexCleanupRule();

			const result = await buildEvalContextWithHealth(
				{ prisma, log } as CleanupExecutorDeps,
				"user-1",
				[rule],
			);

			expect(result.ctx.plexMap).toBeUndefined();
			expect(result.failedSources).toContain("plex");
			expect(
				evaluateItemAgainstRules(
					plexDecisionItem,
					[rule],
					"SONARR",
					result.ctx,
					result.failedSources,
				),
			).toBeNull();
		},
	);

	it("preserves prior rows while withholding cleanup authority after a failed latest attempt", async () => {
		const instance = verifiedPlexInstance();
		const publishedAt = new Date(Date.now() - 60_000);
		const status = {
			...completeStatus(instance.id, publishedAt, 1),
			lastErrorMessage: "refresh failed after publication",
			lastAttemptAt: new Date(),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "refresh failed after publication",
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule()],
		);

		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(prisma.plexCache.findMany).toHaveBeenCalled();
	});

	it("keeps a complete Plex generation available for cleanup evaluation", async () => {
		const completedAt = new Date();
		const instance = verifiedPlexInstance();
		const status = completeStatus(instance.id, completedAt, 1);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule()],
		);

		expect(result.failedSources).not.toContain("plex");
		expect(result.ctx.plexMap?.get("series:42")).toEqual(
			expect.objectContaining({ watchCount: 0 }),
		);
		expect(result.providerEvidence?.sources).toEqual([
			expect.objectContaining({
				service: "PLEX",
				cacheType: "plex",
				generationId: status.generationId,
				targetLedgerVersion: 1,
				targetCount: 1,
				targetDigest: "c".repeat(64),
			}),
		]);
	});

	it("rejects a Plex map when its published generation changes while rows are read", async () => {
		const instance = verifiedPlexInstance();
		const first = completeStatus(instance.id, new Date(), 1);
		const second = { ...first, identityGeneration: 8 };
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]),
			},
			plexCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			prefetchPlexData({ prisma, log } as CleanupExecutorDeps, "user-1"),
		).resolves.toBeUndefined();
	});

	it("blocks Plex episode cleanup when the episode cache row count mismatches", async () => {
		const instance = {
			id: "plex-inst-1",
			updatedAt: new Date(0),
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			label: null,
			expectedIdentity: "stored-plex-machine-identity",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(0),
			connectionGeneration: 3,
			identityGeneration: 7,
		};
		const completedAt = new Date();
		const normalStatus = completeStatus(instance.id, completedAt, 1);
		const episodeStatus = completeStatus(instance.id, completedAt, 2);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
					Promise.resolve([where.cacheType === "plex_episode" ? episodeStatus : normalStatus]),
				),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: instance.id,
						refreshedAt: completedAt,
						sourceFingerprint: plexConnectionFingerprint(instance as never),
					},
				]),
				groupBy: vi.fn().mockResolvedValue([]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule("plex_episode_completion")],
		);

		expect(result.ctx.plexEpisodeMap).toBeUndefined();
		expect(result.failedSources).toContain("plex");
		expect(
			evaluateItemAgainstRules(
				plexDecisionItem,
				[plexCleanupRule("plex_episode_completion")],
				"SONARR",
				result.ctx,
				result.failedSources,
			),
		).toBeNull();
	});

	it("rejects an interleaved map/section generation", async () => {
		const instance = verifiedPlexInstance();
		const completedAt = new Date();
		const status = (generationId: string, includeNewSection: boolean) => {
			const complete = completeStatus(instance.id, completedAt, 1);
			const metadata = JSON.parse(complete.generationMetadata);
			return {
				...complete,
				generationId,
				generationMetadata: JSON.stringify({
					...metadata,
					sections: [
						metadata.sections[0],
						...(includeNewSection
							? [
									{
										key: "2",
										uuid: "new-movies-uuid",
										title: "New Movies",
										type: "movie",
										refreshing: false,
										scannedAt: 1_777_000_000,
										updatedAt: 1_777_000_100,
									},
								]
							: []),
					],
				}),
				lastErrorMessage: null,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
			};
		};
		const statusReads = vi
			.fn()
			.mockResolvedValueOnce([status("generation-1", false)])
			.mockResolvedValueOnce([status("generation-2", true)])
			.mockResolvedValueOnce([status("generation-2", true)]);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: statusReads },
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValueOnce([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "movie", sectionId: "1" }),
					]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 30 }),
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies"]),
				},
			],
		);

		expect(statusReads).toHaveBeenCalledTimes(2);
		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.ctx.plexSectionTitles).toBeUndefined();
		expect(result.providerEvidence?.dependencies).toEqual([]);
		expect(result.providerEvidence?.sources).toEqual([]);
	});

	it("withholds a configured Plex policy when one contributing instance has no published sections", async () => {
		const first = verifiedPlexInstance({ id: "plex-inst-a" });
		const second = verifiedPlexInstance({ id: "plex-inst-b" });
		const completedAt = new Date();
		const firstStatus = {
			...completeStatus(first.id, completedAt, 1),
			generationId: "plex-generation-a",
			generationMetadata: JSON.stringify({ sections: [] }),
		};
		const secondStatus = {
			...completeStatus(second.id, completedAt, 1),
			generationId: "plex-generation-b",
			generationMetadata: JSON.stringify({
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
			}),
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([first, second]) },
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string | { in: string[] } } }) => {
					const ids =
						typeof where.instanceId === "string" ? [where.instanceId] : where.instanceId.in;
					return ids.map((id) => (id === first.id ? firstStatus : secondStatus));
				}),
			},
			plexCache: {
				count: vi.fn(async ({ where }: { where: { instanceId: string } }) =>
					where.instanceId === first.id || where.instanceId === second.id ? 1 : 0,
				),
				findMany: vi.fn(
					async ({ where, cursor }: { where: { instanceId: string }; cursor?: { id: string } }) =>
						cursor
							? []
							: [
									makePlexRow({
										id: "row-a",
										instanceId: first.id,
										tmdbId: 41,
										mediaType: "movie",
										sectionId: "missing",
										sectionTitle: "Missing inventory",
									}),
									makePlexRow({
										id: "row-b",
										instanceId: second.id,
										tmdbId: 42,
										mediaType: "movie",
										sectionId: "movies",
										sectionTitle: "Movies",
									}),
								].filter((row) => row.instanceId === where.instanceId),
				),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 30 }),
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies"]),
				},
			],
		);

		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.ctx.plexSectionTitles).toBeUndefined();
		expect(result.providerEvidence?.dependencies).toEqual([]);
		expect(result.providerEvidence?.sources).toEqual([]);
	});

	it("withholds all configured Plex policy evidence when one instance advances generation during the read", async () => {
		const stable = verifiedPlexInstance({ id: "plex-inst-stable" });
		const advancing = verifiedPlexInstance({ id: "plex-inst-advancing" });
		const completedAt = new Date();
		const stableStatus = {
			...completeStatus(stable.id, completedAt, 1),
			generationId: "stable-generation-a",
			generationMetadata: JSON.stringify({
				sections: [{ key: "stable", title: "Stable Movies", type: "movie" }],
			}),
		};
		const advancingA = {
			...completeStatus(advancing.id, completedAt, 1),
			generationId: "advancing-generation-a",
			generationMetadata: JSON.stringify({
				sections: [{ key: "advancing-a", title: "Advancing Movies A", type: "movie" }],
			}),
		};
		const advancingB = {
			...advancingA,
			generationId: "advancing-generation-b",
			generationMetadata: JSON.stringify({
				sections: [{ key: "advancing-b", title: "Advancing Movies B", type: "movie" }],
			}),
		};
		let advancingStatusReads = 0;
		const rows = [
			makePlexRow({
				id: "stable-row",
				instanceId: stable.id,
				tmdbId: 41,
				mediaType: "movie",
				sectionId: "stable",
				sectionTitle: "Stable Movies",
				watchCount: 0,
			}),
			makePlexRow({
				id: "advancing-row",
				instanceId: advancing.id,
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "advancing-a",
				sectionTitle: "Advancing Movies A",
				watchCount: 0,
			}),
		];
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([stable, advancing]) },
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => {
					if (where.instanceId === stable.id) return [stableStatus];
					advancingStatusReads += 1;
					return [advancingStatusReads === 1 ? advancingA : advancingB];
				}),
			},
			plexCache: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) =>
					rows.filter((row) => row.instanceId === where.instanceId),
				),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 30 }),
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Stable Movies"]),
				},
			],
		);

		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.ctx.plexSectionTitles).toBeUndefined();
		expect(result.providerEvidence?.dependencies).toEqual([]);
		expect(result.providerEvidence?.sources).toEqual([]);
	});

	it("does not validate a configured B-only section against A generation rows", async () => {
		const instance = verifiedPlexInstance();
		const status = {
			...completeStatus(instance.id, new Date(), 1),
			generationId: "plex-generation-a",
			generationMetadata: JSON.stringify({
				sections: [{ key: "movies-a", title: "Movies A", type: "movie" }],
			}),
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			plexCache: {
				findMany: vi.fn().mockResolvedValue([
					makePlexRow({
						id: "row-a",
						tmdbId: 42,
						mediaType: "movie",
						sectionId: "movies-a",
						sectionTitle: "Movies A",
						watchCount: 0,
					}),
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 30 }),
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies B"]),
				},
			],
		);

		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.ctx.plexSectionTitles).toBeUndefined();
	});

	it("merges watch data when the same tmdbId appears across two batches", async () => {
		// Batch 1: 500 unique rows (forces a second findMany call). Last row is
		// movie tmdbId=42 in section "lib-1" with one user watch.
		const batch1 = Array.from({ length: 499 }, (_, i) =>
			makePlexRow({
				id: `pc-${i}`,
				tmdbId: 1000 + i,
				mediaType: "movie",
				sectionId: "lib-1",
			}),
		);
		batch1.push(
			makePlexRow({
				id: `pc-499`, // last id in batch — used as cursor for batch 2
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "lib-1",
				watchCount: 3,
				watchedByUsers: ["alice"],
				collections: ["Marvel"],
				labels: ["favorite"],
				lastWatchedAt: new Date("2026-01-01"),
			}),
		);

		// Batch 2: same tmdbId=42 in a different section "lib-2" with another user.
		// The cross-batch merge must (a) push a second `sections` entry,
		// (b) sum watchCount → 5, (c) dedupe watchedByUsers, (d) union
		// collections + labels, (e) take the latest lastWatchedAt.
		const batch2 = [
			makePlexRow({
				id: `pc-extra`,
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "lib-2",
				watchCount: 2,
				watchedByUsers: ["bob"],
				collections: ["Action"],
				labels: ["favorite"],
				lastWatchedAt: new Date("2026-02-01"),
			}),
		];

		const findManySpy = vi.fn().mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2);

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([verifiedPlexInstance()]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 501)]),
			},
			plexCache: { findMany: findManySpy, count: vi.fn().mockResolvedValue(501) },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		// Two paginated reads; the central service carries the proven fixed point.
		expect(findManySpy).toHaveBeenCalledTimes(2);

		// Single merged entry for movie:42 — NOT two separate entries.
		const merged = map?.get("movie:42");
		expect(merged).toBeDefined();
		expect(merged?.watchCount).toBe(5); // 3 + 2 across batches
		expect(merged?.watchedByUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(merged?.watchedByUsers).toHaveLength(2); // deduped
		expect(merged?.collections).toEqual(expect.arrayContaining(["Marvel", "Action"]));
		expect(merged?.labels).toEqual(["favorite"]); // deduped union
		expect(merged?.sections).toHaveLength(2); // one section per batch
		expect(merged?.lastWatchedAt?.toISOString()).toBe(new Date("2026-02-01").toISOString());
	});

	it("consumes each policy batch before requesting the next page", async () => {
		let firstBatchConsumed = false;
		const firstBatch = Array.from({ length: 500 }, (_, index) => {
			const row = makePlexRow({
				id: `pc-stream-${String(index).padStart(3, "0")}`,
				tmdbId: 10_000 + index,
				mediaType: "movie",
				sectionId: "lib-1",
			});
			if (index === 0) {
				Object.defineProperty(row, "watchCount", {
					configurable: true,
					enumerable: true,
					get: () => {
						firstBatchConsumed = true;
						return 0;
					},
				});
			}
			return row;
		});
		const findMany = vi
			.fn()
			.mockResolvedValueOnce(firstBatch)
			.mockImplementationOnce(async () => {
				if (!firstBatchConsumed) {
					throw new Error("second page was requested before the first page was consumed");
				}
				return [
					makePlexRow({
						id: "pc-stream-final",
						tmdbId: 20_000,
						mediaType: "movie",
						sectionId: "lib-1",
					}),
				];
			});
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([verifiedPlexInstance()]) },
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 501)]),
			},
			plexCache: { findMany, count: vi.fn().mockResolvedValue(501) },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		expect(firstBatchConsumed).toBe(true);
		expect(map?.size).toBe(501);
		expect(findMany).toHaveBeenCalledTimes(2);
	});

	it("consumes one instance's policy rows before reading the next instance", async () => {
		let firstInstanceConsumed = false;
		const instanceA = verifiedPlexInstance({ id: "plex-a", label: "Plex A" });
		const instanceB = verifiedPlexInstance({ id: "plex-b", label: "Plex B" });
		const completedAt = new Date(Date.now() - 60_000);
		const rowA = makePlexRow({
			id: "row-a",
			instanceId: "plex-a",
			tmdbId: 1,
			mediaType: "movie",
			sectionId: "movies-a",
		});
		Object.defineProperty(rowA, "watchCount", {
			configurable: true,
			enumerable: true,
			get: () => {
				firstInstanceConsumed = true;
				return 0;
			},
		});
		const findMany = vi.fn(async ({ where }: { where: { instanceId: string } }) => {
			if (where.instanceId === "plex-a") return [rowA];
			if (!firstInstanceConsumed) {
				throw new Error("second instance was read before the first instance was consumed");
			}
			return [
				makePlexRow({
					id: "row-b",
					instanceId: "plex-b",
					tmdbId: 2,
					mediaType: "movie",
					sectionId: "movies-b",
				}),
			];
		});
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instanceA, instanceB]) },
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					completeStatus(where.instanceId, completedAt, 1),
				]),
			},
			plexCache: { findMany, count: vi.fn().mockResolvedValue(1) },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		expect(firstInstanceConsumed).toBe(true);
		expect(map?.size).toBe(2);
		expect(findMany).toHaveBeenCalledTimes(2);
	});

	it("returns undefined when no Plex instances are configured", async () => {
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
			plexCache: { findMany: vi.fn() },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");
		expect(map).toBeUndefined();
	});

	it("terminates after a single short batch (no extra findMany call)", async () => {
		const findManySpy = vi
			.fn()
			.mockResolvedValueOnce([
				makePlexRow({ id: "pc-1", tmdbId: 1, mediaType: "movie", sectionId: "lib-1" }),
			]);

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([verifiedPlexInstance()]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 1)]),
			},
			plexCache: { findMany: findManySpy, count: vi.fn().mockResolvedValue(1) },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		expect(findManySpy).toHaveBeenCalledTimes(1);
		expect(map?.size).toBe(1);
	});
});

describe("prefetchFreshPlexEpisodeWatchData", () => {
	it("uses one positive lower-bound source without requiring a complete V2 episode generation", async () => {
		const now = new Date("2026-08-24T12:00:00.000Z");
		const instance = verifiedPlexInstance();
		authorityMock.positiveEpisodeEvidence.set(instance.id, {
			available: true,
			instanceId: instance.id,
			connectionGeneration: 3,
			identityGeneration: 7,
			provenance: {
				publicationLevel: "positive-only",
				completeness: "partial",
				connectionGeneration: 3,
				identityGeneration: 7,
				parentPlexGenerationId: "parent-v4",
				parentTargetDigest: "parent-target-digest",
				parentTargetCount: 1,
				episodeGenerationId: "episode-v3",
				episodeDigest: "episode-digest",
				publishedAt: now.toISOString(),
			},
			rows: [
				{
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-a",
					lowerBound: 2,
					sourceFingerprint: plexConnectionFingerprint(instance as never),
					soleParentTarget: { ratingKey: "show-a" },
				},
			],
		});
		const warnings: string[] = [];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{
				prisma: { serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) } },
				log,
			} as never,
			[instance] as never,
			now,
			warnings,
		);

		expect(result.get("42:1:1")).toMatchObject([{ lowerBound: 2, watchCount: 0 }]);
		expect(warnings).toEqual([]);
		authorityMock.positiveEpisodeEvidence.clear();
	});

	it("retains one valid positive source when another Plex source has no complete exact generation", async () => {
		const now = new Date("2026-08-24T12:00:00.000Z");
		const positiveInstance = verifiedPlexInstance({ id: "plex-positive" });
		const unavailableInstance = verifiedPlexInstance({
			id: "plex-unavailable",
			baseUrl: "http://plex-unavailable.internal:32400",
		});
		authorityMock.positiveEpisodeEvidence.set(positiveInstance.id, {
			available: true,
			instanceId: positiveInstance.id,
			connectionGeneration: 3,
			identityGeneration: 7,
			provenance: {
				publicationLevel: "positive-only",
				completeness: "partial",
				connectionGeneration: 3,
				identityGeneration: 7,
				parentPlexGenerationId: "parent-v4",
				parentTargetDigest: "parent-target-digest",
				parentTargetCount: 1,
				episodeGenerationId: "episode-v3",
				episodeDigest: "episode-digest",
				publishedAt: now.toISOString(),
			},
			rows: [
				{
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-a",
					lowerBound: 2,
					sourceFingerprint: plexConnectionFingerprint(positiveInstance as never),
					soleParentTarget: { ratingKey: "show-a" },
				},
			],
		});
		const warnings: string[] = [];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{
				prisma: {
					serviceInstance: {
						findMany: vi.fn().mockResolvedValue([positiveInstance, unavailableInstance]),
					},
					cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
				},
				log,
			} as never,
			[positiveInstance, unavailableInstance] as never,
			now,
			warnings,
		);

		expect(result.get("42:1:1")).toMatchObject([
			{ plexInstanceId: "plex-positive", lowerBound: 2, watchCount: 0 },
		]);
		expect(warnings).toContainEqual(
			expect.stringContaining("no complete fresh published generation"),
		);
		authorityMock.positiveEpisodeEvidence.clear();
	});

	it.each([
		["metadata-only instance update", "updatedAt"],
		["same-identity reverification", "identityVerifiedAt"],
	] as const)("keeps current episode evidence after a %s", async (_label, field) => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const completedAt = new Date("2026-07-30T11:45:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "stored-plex-machine-identity",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(0),
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: new Date(0),
			[field]: new Date("2026-07-30T11:50:00.000Z"),
		};
		const prisma = {
			plexCache: { count: vi.fn().mockResolvedValue(1) },
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([{ instanceId: "plex-inst-1", _count: { id: 1 } }]),
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 3,
						lastWatchedAt: now,
						watchedByUsers: '["Viewer"]',
						ratingKey: "episode-123",
						refreshedAt: completedAt,
						sourceFingerprint: plexConnectionFingerprint(currentInstance as never),
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				]),
			},
			cacheRefreshStatus: {
				findMany: episodeStatuses("plex-inst-1", completedAt, 1),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result.get("42:1:2")).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	it("ignores fresh-looking evidence produced by the pre-repoint Plex connection", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://new-plex.internal:32400",
			encryptedApiKey: "new-encrypted-token",
			encryptionIv: "new-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "stored-plex-machine-identity",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(0),
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: new Date("2026-07-30T11:30:00.000Z"),
		};
		const oldFingerprint = plexConnectionFingerprint({
			...currentInstance,
			baseUrl: "http://old-plex.internal:32400",
			encryptedApiKey: "old-encrypted-token",
			encryptionIv: "old-iv",
		} as never);
		const prisma = {
			plexCache: { count: vi.fn().mockResolvedValue(1) },
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([{ instanceId: "plex-inst-1", _count: { id: 1 } }]),
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 1,
						lastWatchedAt: now,
						watchedByUsers: "[]",
						ratingKey: "episode-123",
						// This timestamp is after the repoint. It models an old
						// in-flight refresh committing after settings changed.
						refreshedAt: new Date("2026-07-30T11:45:00.000Z"),
						sourceFingerprint: oldFingerprint,
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				]),
			},
			cacheRefreshStatus: {
				findMany: episodeStatuses("plex-inst-1", new Date("2026-07-30T11:45:00.000Z"), 1),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result).toEqual(new Map());
		expect(warnings).toContainEqual(expect.stringContaining("stale Plex episode watch"));
	});

	it("rejects rows from an older completed generation", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const completedAt = new Date("2026-07-30T11:45:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "stored-plex-machine-identity",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(0),
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: new Date("2026-07-30T10:00:00.000Z"),
		};
		const prisma = {
			plexCache: { count: vi.fn().mockResolvedValue(1) },
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([{ instanceId: "plex-inst-1", _count: { id: 1 } }]),
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 1,
						lastWatchedAt: now,
						watchedByUsers: "[]",
						ratingKey: "episode-123",
						refreshedAt: new Date("2026-07-30T11:44:59.999Z"),
						sourceFingerprint: plexConnectionFingerprint(currentInstance as never),
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				]),
			},
			cacheRefreshStatus: {
				findMany: episodeStatuses("plex-inst-1", completedAt, 1),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result).toEqual(new Map());
		expect(warnings).toContainEqual(expect.stringContaining("stale Plex episode watch"));
	});

	it("accepts fresh episode evidence bound to the current Plex connection", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "stored-plex-machine-identity",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(0),
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: new Date("2026-07-30T10:00:00.000Z"),
		};
		const prisma = {
			plexCache: { count: vi.fn().mockResolvedValue(1) },
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([{ instanceId: "plex-inst-1", _count: { id: 1 } }]),
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 3,
						lastWatchedAt: now,
						watchedByUsers: '["Viewer"]',
						ratingKey: "episode-123",
						refreshedAt: new Date("2026-07-30T11:45:00.000Z"),
						sourceFingerprint: plexConnectionFingerprint(currentInstance as never),
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				]),
			},
			cacheRefreshStatus: {
				findMany: episodeStatuses("plex-inst-1", new Date("2026-07-30T11:45:00.000Z"), 1),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result.get("42:1:2")).toEqual([
			expect.objectContaining({
				plexInstanceId: "plex-inst-1",
				ratingKey: "episode-123",
				watchCount: 3,
			}),
		]);
		expect(warnings).toEqual([]);
	});
});
