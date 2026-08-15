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
	buildEvalContext,
	prefetchFreshPlexEpisodeWatchData,
	prefetchPlexData,
} from "../cleanup-executor.js";
import { evaluateItemAgainstRules } from "../rule-evaluators.js";
import type { CleanupExecutorDeps } from "../types.js";

function makePlexRow(overrides: {
	id: string;
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
}) {
	return {
		id: overrides.id,
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

async function buildPlexEvalContextWithHealth(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		conditions: string | null;
		plexLibraryFilter?: string | null;
	}>,
) {
	const ctx = await buildEvalContext(deps, userId, rules);
	const failedSources = new Set<"plex">();
	const needsEpisodeEvidence = rules.some(
		(rule) => rule.enabled && rule.ruleType === "plex_episode_completion",
	);
	if (!ctx.plexMap || (needsEpisodeEvidence && !ctx.plexEpisodeMap)) {
		failedSources.add("plex");
	}
	return { ctx, failedSources };
}

function completeStatus(instanceId: string, completedAt = new Date(), itemCount = 0) {
	return {
		instanceId,
		lastRefreshedAt: completedAt,
		lastResult: "success",
		itemCount,
		generationId: `generation-${instanceId}`,
		generationMetadata: JSON.stringify({
			sections: [{ key: "1", title: "Movies", type: "movie" }],
		}),
		lastErrorMessage: null,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
	};
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
		scanMediaServerInstanceIds: null,
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
	  }>
	| undefined;

const unavailablePlexEvidenceCases = [
	["missing status", () => undefined],
	["stale timestamp", () => ({ lastRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })],
	["future timestamp", () => ({ lastRefreshedAt: new Date(Date.now() + 60 * 1000) })],
	["failed result", () => ({ lastResult: "error" })],
	["failed latest attempt", () => ({ lastAttemptResult: "error" })],
	["completed-generation error", () => ({ lastErrorMessage: "refresh failed" })],
	["latest-attempt error", () => ({ lastAttemptErrorMessage: "refresh failed" })],
	["connection repoint", () => ({ lastRefreshedAt: new Date("2026-08-10T10:00:00.000Z") })],
	["normal cache row-count mismatch", () => ({ itemCount: 2 })],
] satisfies ReadonlyArray<readonly [string, () => PlexStatusOverride]>;

describe("prefetchPlexData — cross-batch Map merge (v2.18.4 OOM fix)", () => {
	it.each(unavailablePlexEvidenceCases)(
		"blocks Plex cleanup evidence for %s",
		async (caseName, overrides) => {
			const instance = {
				id: "plex-inst-1",
				updatedAt:
					caseName === "connection repoint"
						? new Date("2026-08-10T11:00:00.000Z")
						: new Date("2026-08-10T00:00:00.000Z"),
			};
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

			const result = await buildPlexEvalContextWithHealth(
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

	it("withholds episode evidence when the normal Plex inventory is rejected", async () => {
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
		};
		const completedAt = new Date();
		const rejectedNormalStatus = {
			...completeStatus(instance.id, completedAt, 2),
			generationId: "normal-generation",
		};
		const episodeStatus = {
			...completeStatus(instance.id, completedAt, 1),
			generationId: "episode-generation",
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
					Promise.resolve([
						where.cacheType === "plex_episode" ? episodeStatus : rejectedNormalStatus,
					]),
				),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: vi.fn().mockResolvedValue([{ instanceId: instance.id, tmdbId: 42 }]),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
			plexEpisodeCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: vi
					.fn()
					.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
					.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
					.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }])
					.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const ctx = await buildEvalContext({ prisma, log } as CleanupExecutorDeps, "user-1", [
			plexCleanupRule("plex_episode_completion"),
		]);

		expect(ctx.plexMap).toBeUndefined();
		expect(ctx.plexEpisodeMap).toBeUndefined();
	});

	it("keeps a complete Plex generation available for cleanup evaluation", async () => {
		const completedAt = new Date();
		const instance = { id: "plex-inst-1", updatedAt: new Date(0) };
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

		const result = await buildPlexEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule()],
		);

		expect(result.failedSources).not.toContain("plex");
		expect(result.ctx.plexMap?.get("series:42")).toEqual(
			expect.objectContaining({ watchCount: 0 }),
		);
	});

	it("keeps fresh retained episode rows from earlier incremental refreshes", async () => {
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
		};
		const completedAt = new Date();
		const normalStatus = completeStatus(instance.id, completedAt, 1);
		const episodeStatus = completeStatus(instance.id, completedAt, 1);
		const episodeGroupBy = vi
			.fn()
			.mockResolvedValueOnce([
				{ showTmdbId: 42, _count: { id: 1 } },
				{ showTmdbId: 84, _count: { id: 1 } },
			])
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([
				{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } },
				{ showTmdbId: 84, seasonNumber: 1, _count: { id: 1 } },
			])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }]);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
					Promise.resolve([where.cacheType === "plex_episode" ? episodeStatus : normalStatus]),
				),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: vi.fn().mockResolvedValue([
					{ instanceId: instance.id, tmdbId: 42 },
					{ instanceId: instance.id, tmdbId: 84 },
				]),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
			plexEpisodeCache: {
				findMany: vi.fn(() => {
					throw new Error("episode evidence validation must stay database-bounded");
				}),
				count: vi.fn().mockResolvedValue(2),
				groupBy: episodeGroupBy,
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildPlexEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule("plex_episode_completion")],
		);

		expect(result.failedSources).not.toContain("plex");
		expect(result.ctx.plexEpisodeMap?.get(42)).toMatchObject({ total: 1, watched: 1 });
		expect(result.ctx.plexEpisodeMap?.get(84)).toMatchObject({ total: 1, watched: 0 });
		expect(episodeGroupBy).toHaveBeenCalledTimes(4);
	});

	it("ignores episode rows orphaned from the current eligible Plex inventory", async () => {
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
		};
		const completedAt = new Date();
		const normalStatus = completeStatus(instance.id, completedAt, 1);
		const episodeStatus = completeStatus(instance.id, completedAt, 1);
		const episodeGroupBy = vi
			.fn()
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }]);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
					Promise.resolve([where.cacheType === "plex_episode" ? episodeStatus : normalStatus]),
				),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: vi.fn().mockResolvedValue([{ instanceId: instance.id, tmdbId: 42 }]),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
			plexEpisodeCache: {
				findMany: vi.fn(() => {
					throw new Error("orphan rows must not be materialized for validation");
				}),
				count: vi.fn().mockResolvedValue(1),
				groupBy: episodeGroupBy,
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildPlexEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule("plex_episode_completion")],
		);

		expect(result.failedSources).not.toContain("plex");
		expect(result.ctx.plexEpisodeMap?.get(42)).toMatchObject({ total: 1, watched: 1 });
		expect(result.ctx.plexEpisodeMap?.has(84)).toBe(false);
		for (const call of episodeGroupBy.mock.calls) {
			const where = JSON.stringify(call[0]?.where);
			expect(where).toContain(`"instanceId":"${instance.id}"`);
			expect(where).toContain('"showTmdbId":{"in":[42]}');
			expect(where).not.toContain('"showTmdbId":{"in":[84]}');
		}
	});

	it.each(["generation", "row"] as const)(
		"rejects a future-dated Plex episode %s",
		async (futureTarget) => {
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
			};
			const completedAt = new Date();
			const futureAt = new Date(completedAt.getTime() + 60 * 1000);
			const normalStatus = completeStatus(instance.id, completedAt, 1);
			const episodeStatus = completeStatus(
				instance.id,
				futureTarget === "generation" ? futureAt : completedAt,
				1,
			);
			const episodeGroupBy = vi.fn().mockResolvedValue([]);
			const prisma = {
				serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
				cacheRefreshStatus: {
					findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
						Promise.resolve([where.cacheType === "plex_episode" ? episodeStatus : normalStatus]),
					),
				},
				plexCache: {
					count: vi.fn().mockResolvedValue(1),
					groupBy: vi.fn().mockResolvedValue([{ instanceId: instance.id, tmdbId: 42 }]),
					findMany: vi
						.fn()
						.mockResolvedValue([
							makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
						]),
				},
				plexEpisodeCache: {
					findMany: vi.fn(() => {
						throw new Error("episode evidence validation must stay database-bounded");
					}),
					count: vi
						.fn()
						.mockResolvedValueOnce(1)
						.mockResolvedValueOnce(futureTarget === "row" ? 0 : 1),
					groupBy: episodeGroupBy,
				},
			} as unknown as CleanupExecutorDeps["prisma"];

			const result = await buildPlexEvalContextWithHealth(
				{ prisma, log } as CleanupExecutorDeps,
				"user-1",
				[plexCleanupRule("plex_episode_completion")],
			);

			expect(result.ctx.plexEpisodeMap).toBeUndefined();
			expect(result.failedSources).toContain("plex");
			expect(episodeGroupBy).not.toHaveBeenCalled();
		},
	);

	it("rejects episode aggregates interleaved with a newer cache generation", async () => {
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
		};
		const completedAt = new Date();
		const normalStatus = completeStatus(instance.id, completedAt, 1);
		const episodeStatus = completeStatus(instance.id, completedAt, 1);
		let episodeStatusReads = 0;
		const episodeGroupBy = vi
			.fn()
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 100 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 100 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }]);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) => {
					if (where.cacheType !== "plex_episode") return Promise.resolve([normalStatus]);
					episodeStatusReads += 1;
					return Promise.resolve([
						episodeStatusReads === 1
							? episodeStatus
							: { ...episodeStatus, generationId: "generation-plex-inst-2" },
					]);
				}),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: vi.fn().mockResolvedValue([{ instanceId: instance.id, tmdbId: 42 }]),
				findMany: vi
					.fn()
					.mockResolvedValue([
						makePlexRow({ id: "row-1", tmdbId: 42, mediaType: "series", sectionId: "1" }),
					]),
			},
			plexEpisodeCache: {
				count: vi.fn().mockResolvedValue(1),
				groupBy: episodeGroupBy,
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await buildPlexEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[plexCleanupRule("plex_episode_completion")],
		);

		expect(episodeGroupBy).toHaveBeenCalledTimes(4);
		expect(episodeStatusReads).toBe(2);
		expect(result.ctx.plexEpisodeMap).toBeUndefined();
		expect(result.failedSources).toContain("plex");
	});

	it("rejects an interleaved map/section generation", async () => {
		const instance = { id: "plex-inst-1", updatedAt: new Date(0) };
		const completedAt = new Date();
		const status = (generationId: string, includeNewSection: boolean) => ({
			...completeStatus(instance.id, completedAt, 1),
			generationId,
			generationMetadata: JSON.stringify({
				sections: [
					{ key: "1", title: "Movies", type: "movie" },
					...(includeNewSection ? [{ key: "2", title: "New Movies", type: "movie" }] : []),
				],
			}),
			lastErrorMessage: null,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
		});
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

		const result = await buildPlexEvalContextWithHealth(
			{ prisma, log } as CleanupExecutorDeps,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "age",
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies"]),
				},
			],
		);

		expect(statusReads).toHaveBeenCalledTimes(3);
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
				findMany: vi.fn().mockResolvedValue([{ id: "plex-inst-1", updatedAt: new Date(0) }]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 501)]),
			},
			plexCache: { findMany: findManySpy },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		// Two findMany calls — pagination must have continued past batch 1.
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
				findMany: vi.fn().mockResolvedValue([{ id: "plex-inst-1", updatedAt: new Date(0) }]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 1)]),
			},
			plexCache: { findMany: findManySpy },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		expect(findManySpy).toHaveBeenCalledTimes(1);
		expect(map?.size).toBe(1);
	});
});

describe("prefetchFreshPlexEpisodeWatchData", () => {
	it("keeps distinct Plex sources separate and rejects stale connection evidence", async () => {
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
			updatedAt: new Date("2026-07-30T11:30:00.000Z"),
		};
		const oldFingerprint = plexConnectionFingerprint({
			...currentInstance,
			baseUrl: "http://old-plex.internal:32400",
			encryptedApiKey: "old-encrypted-token",
			encryptionIv: "old-iv",
		} as never);
		const prisma = {
			plexEpisodeCache: {
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
						refreshedAt: new Date("2026-07-30T11:45:00.000Z"),
						sourceFingerprint: oldFingerprint,
					},
				]),
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

	it("rejects future-dated episode-scoped watch evidence", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const warnings: string[] = [];
		const instance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			updatedAt: new Date("2026-07-30T11:30:00.000Z"),
		};
		const prisma = {
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: instance.id,
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 1,
						lastWatchedAt: now,
						watchedByUsers: "[]",
						ratingKey: "episode-123",
						refreshedAt: new Date("2026-07-30T12:01:00.000Z"),
						sourceFingerprint: plexConnectionFingerprint(instance as never),
					},
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[instance] as never,
			now,
			warnings,
		);

		expect(result).toEqual(new Map());
		expect(warnings).toContainEqual(expect.stringContaining("stale Plex episode watch"));
	});
});
