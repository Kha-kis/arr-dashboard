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
			sections: [{ key: "1", title: "Movies", type: "movie" }],
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
			version: 1,
			parentPlexGenerationId: `generation-${instanceId}`,
			parentPublicationLevel: "authoritative",
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
				findMany: vi.fn().mockResolvedValue([verifiedPlexInstance()]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([completeStatus("plex-inst-1", new Date(), 501)]),
			},
			plexCache: { findMany: findManySpy, count: vi.fn().mockResolvedValue(501) },
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
