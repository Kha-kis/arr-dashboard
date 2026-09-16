import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({ readProviderIdentity: vi.fn() }));

vi.mock("../../services/service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/service-identity.js")>()),
	readProviderIdentity: identityMocks.readProviderIdentity,
}));

import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
	recoverAbandonedObservationRuns,
} from "../../provider-observation/observation-run-repository.js";
import { reconcileInterruptedProviderCacheRefreshAttempts } from "../../services/provider-cache-status.js";
import { withGuardedProviderPublication } from "../../services/provider-identity-guard.js";
import { PlexAuthorityService } from "../plex-authority-service.js";
import { planPlexEpisodeRefresh } from "../plex-episode-refresh-plan.js";
import {
	finalizePlexEpisodeRun,
	stagePlexEpisodeUnit,
} from "../plex-episode-refresh-repository.js";
import {
	encodeAuthoritativePlexGenerationMetadata,
	encodePositivePlexGenerationMetadata,
} from "../plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../plex-generation-target-ledger.js";
import { createPlexEpisodeWorkItemRunner } from "../plex-refresh-orchestration.js";
import { plexConnectionFingerprint } from "../service-instance-fingerprint.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];

beforeEach(() => {
	identityMocks.readProviderIdentity.mockReset().mockResolvedValue({
		service: "PLEX",
		identityKind: "plex-machine-identifier",
		rawIdentity: "verified-provider",
		confirmationDigest: "a".repeat(64),
		fingerprint: "a".repeat(12),
	});
});

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "plex-episode-stage-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({
		data: { id: "user-1", username: `stage-${Date.now()}-${Math.random()}` },
	});
	await prisma.serviceInstance.create({
		data: {
			id: "plex-1",
			userId: "user-1",
			service: "PLEX",
			label: "Plex",
			baseUrl: "http://plex.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			connectionGeneration: 2,
			expectedIdentity: "verified-provider",
			identityStatus: "VERIFIED",
			identityGeneration: 3,
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: new Date("2026-09-06T00:00:00.000Z"),
		},
	});
	return prisma;
}

async function runAndClaim(prisma: Awaited<ReturnType<typeof database>>) {
	const expectedUnit = planPlexEpisodeRefresh([
		{
			instanceId: "plex-1",
			generationId: "parent-1",
			showTmdbId: 42,
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tvdbId: 99,
			ratingKey: "show-1",
		},
	]).units[0]!;
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "plex_episode",
			cacheType: "plex_episode",
			instanceId: "plex-1",
			parentGenerationId: "parent-1",
			targetDigest: "a".repeat(64),
			connectionGeneration: 2,
			identityGeneration: 3,
		},
		units: [
			{
				ordinal: 0,
				scopeKey: "plex-episode-unit:0",
				scopeDigest: expectedUnit.scopeDigest,
				phase: "collect",
				expectedTargets: 1,
			},
		],
	});
	return {
		run,
		expectedUnit,
		claim: await claimObservationUnit(prisma, {
			runId: run.id,
			now: new Date("2026-09-06T00:00:00.000Z"),
		}),
	};
}

async function completedFinalizerFixture(prisma: Awaited<ReturnType<typeof database>>) {
	const attemptedAt = new Date("2026-09-06T00:00:00.000Z");
	const attempt = { attemptedAt, resultMarker: "in_progress:episode-attempt" };
	const targets = [
		{
			instanceId: "plex-1",
			generationId: "parent-1",
			showTmdbId: 42,
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tvdbId: 99,
			ratingKey: "show-1",
		},
	];
	const plan = planPlexEpisodeRefresh(targets);
	const ledger = createPlexTargetLedgerBinding({
		instanceId: "plex-1",
		generationId: "parent-1",
		connectionGeneration: 2,
		identityGeneration: 3,
		targets: targets.map(({ showTmdbId, ...target }) => ({ ...target, tmdbId: showTmdbId })),
	});
	const metadata = encodeAuthoritativePlexGenerationMetadata({
		sections: [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1,
				updatedAt: 2,
			},
		],
		itemCount: 1,
		canonicalizationVersion: 1,
		roots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
		targetLedger: ledger,
		partialReasons: [],
		coverageReceipt: {
			version: 2,
			provider: "plex",
			attemptStartedAt: new Date(attemptedAt.getTime() - 1).toISOString(),
			observedAt: attemptedAt.toISOString(),
			evidence: "complete",
			units: [
				{
					scopeKey: "section:shows",
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
			publishedCanonicalEntities: 1,
			domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
				(domain) => ({
					domain,
					evidence: "complete" as const,
					valueSemantics: "exact" as const,
					units: [
						{
							scopeKey: "section:shows",
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
					publishedCanonicalEntities: 1,
				}),
			) as Array<{
				domain: "library-inventory" | "mapping" | "watch-count" | "watch-attribution" | "on-deck";
				evidence: "complete";
				valueSemantics: "exact";
				units: Array<{
					scopeKey: string;
					expectedRawCount: number;
					pagesAttempted: number;
					pagesCompleted: number;
					rawObserved: number;
					sourceBindings: number;
					canonicalEntities: number;
					acceptedSkips: never[];
					fatalCount: number;
				}>;
				publishedCanonicalEntities: number;
			}>,
		},
	});
	await prisma.cacheRefreshStatus.createMany({
		data: [
			{
				instanceId: "plex-1",
				cacheType: "plex",
				lastRefreshedAt: attemptedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 1,
				generationId: "parent-1",
				generationMetadata: metadata,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: 2,
				identityGeneration: 3,
			},
			{
				instanceId: "plex-1",
				cacheType: "plex_episode",
				lastRefreshedAt: attemptedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 1,
				generationId: "old",
				generationMetadata: "old",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: attempt.resultMarker,
				lastAttemptErrorMessage: null,
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		],
	});
	await prisma.plexCache.create({
		data: {
			instanceId: "plex-1",
			tmdbId: 42,
			mediaType: "series",
			sectionId: "shows",
			sectionTitle: "Shows",
			ratingKey: "show-1",
			watchedByUsers: "[]",
			collections: "[]",
			labels: "[]",
			connectionGeneration: 2,
			identityGeneration: 3,
		},
	});
	await prisma.plexGenerationTarget.create({
		data: {
			instanceId: "plex-1",
			generationId: "parent-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series",
			tmdbId: 42,
			tvdbId: 99,
			ratingKey: "show-1",
		},
	});
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "plex_episode",
			cacheType: "plex_episode",
			instanceId: "plex-1",
			parentGenerationId: "parent-1",
			targetDigest: plan.targetDigest,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
		units: plan.units.map((unit) => ({
			ordinal: unit.ordinal,
			scopeKey: unit.scopeKey,
			scopeDigest: unit.scopeDigest,
			phase: "collect" as const,
			expectedTargets: unit.targets.length,
		})),
	});
	const unit = await prisma.providerObservationUnit.findFirstOrThrow({ where: { runId: run.id } });
	await prisma.providerObservationUnit.update({
		where: { id: unit.id },
		data: { state: "complete", completedAt: attemptedAt },
	});
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: { completedUnits: 1, completedWork: 1 },
	});
	const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
	await prisma.plexEpisodeObservationStage.create({
		data: {
			runId: run.id,
			unitId: unit.id,
			showTmdbId: 42,
			parentRatingKey: "show-1",
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "episode-b",
			title: "Pilot",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			watchCount: 2,
			refreshedAt: attemptedAt,
			sourceFingerprint: plexConnectionFingerprint(instance),
		},
	});
	await prisma.plexEpisodeCache.create({
		data: {
			instanceId: "plex-1",
			showTmdbId: 1,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "old",
			title: "old",
			watched: true,
			watchedByUsers: "[]",
			watchCount: 1,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
	});
	return { run, attempt };
}

type ParentTarget = {
	instanceId: string;
	generationId: string;
	showTmdbId: number;
	sectionId: string;
	sectionUuid: string;
	mediaType: "series";
	tvdbId: number;
	ratingKey: string;
};

type StagedEpisode = {
	unitOrdinal: number;
	showTmdbId: number;
	parentRatingKey: string;
	seasonNumber: number;
	episodeNumber: number;
	ratingKey: string;
	title: string;
	watchCount: number;
};

async function completedFinalizerFixtureForTargets(
	prisma: Awaited<ReturnType<typeof database>>,
	input: {
		targets: readonly ParentTarget[];
		stages: readonly StagedEpisode[];
		parentPublicationLevel?: "authoritative" | "positive-only";
	},
) {
	const attemptedAt = new Date("2026-09-06T00:00:00.000Z");
	const attempt = { attemptedAt, resultMarker: "in_progress:episode-attempt" };
	const plan = planPlexEpisodeRefresh(input.targets);
	const ledger = createPlexTargetLedgerBinding({
		instanceId: "plex-1",
		generationId: "parent-1",
		connectionGeneration: 2,
		identityGeneration: 3,
		targets: input.targets.map(({ showTmdbId, ...target }) => ({ ...target, tmdbId: showTmdbId })),
	});
	const parentRows = [
		...new Map(input.targets.map((target) => [target.showTmdbId, target])).values(),
	];
	const receiptUnit = {
		scopeKey: "section:shows",
		expectedRawCount: parentRows.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: parentRows.length,
		sourceBindings: parentRows.length,
		canonicalEntities: parentRows.length,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const sections = [
		{
			key: "shows",
			uuid: "shows-uuid",
			title: "Shows",
			type: "show" as const,
			refreshing: false as const,
			scannedAt: 1,
			updatedAt: 2,
		},
	];
	const coverageReceipt = {
		version: 2 as const,
		provider: "plex" as const,
		attemptStartedAt: new Date(attemptedAt.getTime() - 1).toISOString(),
		observedAt: attemptedAt.toISOString(),
		evidence:
			input.parentPublicationLevel === "positive-only"
				? ("positive-only" as const)
				: ("complete" as const),
		units: [receiptUnit],
		publishedCanonicalEntities: parentRows.length,
		domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
			(domain) => ({
				domain,
				evidence: "complete" as const,
				valueSemantics: "exact" as const,
				units: [receiptUnit],
				publishedCanonicalEntities: parentRows.length,
			}),
		),
	} as never;
	const metadata =
		input.parentPublicationLevel === "positive-only"
			? encodePositivePlexGenerationMetadata({
					sections,
					itemCount: parentRows.length,
					canonicalizationVersion: 1,
					observedRoots: [
						{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) },
					],
					targetLedger: ledger,
					partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
					coverageReceipt,
				})
			: encodeAuthoritativePlexGenerationMetadata({
					sections,
					itemCount: parentRows.length,
					canonicalizationVersion: 1,
					roots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
					targetLedger: ledger,
					partialReasons: [],
					coverageReceipt,
				});
	await prisma.cacheRefreshStatus.createMany({
		data: [
			{
				instanceId: "plex-1",
				cacheType: "plex",
				lastRefreshedAt: attemptedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: parentRows.length,
				generationId: "parent-1",
				generationMetadata: metadata,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: input.parentPublicationLevel === "positive-only" ? "partial" : "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: 2,
				identityGeneration: 3,
			},
			{
				instanceId: "plex-1",
				cacheType: "plex_episode",
				lastRefreshedAt: attemptedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 1,
				generationId: "old",
				generationMetadata: "old",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: attempt.resultMarker,
				lastAttemptErrorMessage: null,
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		],
	});
	await prisma.plexCache.createMany({
		data: parentRows.map((target) => ({
			instanceId: "plex-1",
			tmdbId: target.showTmdbId,
			mediaType: "series",
			sectionId: target.sectionId,
			sectionTitle: "Shows",
			ratingKey: target.ratingKey,
			watchedByUsers: "[]",
			collections: "[]",
			labels: "[]",
			connectionGeneration: 2,
			identityGeneration: 3,
		})),
	});
	await prisma.plexGenerationTarget.createMany({
		data: input.targets.map((target) => ({
			instanceId: target.instanceId,
			generationId: target.generationId,
			sectionId: target.sectionId,
			sectionUuid: target.sectionUuid,
			mediaType: target.mediaType,
			tmdbId: target.showTmdbId,
			tvdbId: target.tvdbId,
			ratingKey: target.ratingKey,
		})),
	});
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "plex_episode",
			cacheType: "plex_episode",
			instanceId: "plex-1",
			parentGenerationId: "parent-1",
			targetDigest: plan.targetDigest,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
		units: plan.units.map((unit) => ({
			ordinal: unit.ordinal,
			scopeKey: unit.scopeKey,
			scopeDigest: unit.scopeDigest,
			phase: "collect" as const,
			expectedTargets: unit.targets.length,
		})),
	});
	await prisma.providerObservationUnit.updateMany({
		where: { runId: run.id },
		data: { state: "complete", completedAt: attemptedAt },
	});
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: { completedUnits: plan.units.length, completedWork: plan.targetCount },
	});
	const units = await prisma.providerObservationUnit.findMany({ where: { runId: run.id } });
	const unitsByOrdinal = new Map(units.map((unit) => [unit.ordinal, unit]));
	const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
	await prisma.plexEpisodeObservationStage.createMany({
		data: input.stages.map((row) => ({
			runId: run.id,
			unitId: unitsByOrdinal.get(row.unitOrdinal)!.id,
			showTmdbId: row.showTmdbId,
			parentRatingKey: row.parentRatingKey,
			seasonNumber: row.seasonNumber,
			episodeNumber: row.episodeNumber,
			ratingKey: row.ratingKey,
			title: row.title,
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			watchCount: row.watchCount,
			refreshedAt: attemptedAt,
			sourceFingerprint: plexConnectionFingerprint(instance),
		})),
	});
	await prisma.plexEpisodeCache.create({
		data: {
			instanceId: "plex-1",
			showTmdbId: 999_999,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "old",
			title: "old",
			watched: true,
			watchedByUsers: "[]",
			watchCount: 1,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
	});
	return { run, attempt, plan };
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("plex episode refresh repository", { timeout: 30_000 }, () => {
	it("atomically closes the current attempt and invalidates only unpublished work on live mismatch", async () => {
		const prisma = await database();
		const { run } = await completedFinalizerFixture(prisma);
		const stored = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		identityMocks.readProviderIdentity.mockResolvedValue({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "different-provider",
			confirmationDigest: "b".repeat(64),
			fingerprint: "b".repeat(12),
		});

		await expect(
			withGuardedProviderPublication(
				prisma,
				{ ...stored, apiKey: "plaintext" } as never,
				{ warn: () => undefined } as never,
				async () => ({ rows: [] }),
				async (_tx, snapshot) => snapshot,
			),
		).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
		expect(
			await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
		).toMatchObject({ identityStatus: "MISMATCH", identityGeneration: 3 });
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "invalidated", activeSlotKey: null });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			}),
		).toMatchObject({
			lastResult: "success",
			itemCount: 1,
			generationId: "old",
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "identity-changed",
		});
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ ratingKey: "old" }]);
	});

	it("rejects staging after verified identity becomes mismatched without a generation change", async () => {
		const prisma = await database();
		const { run, expectedUnit, claim } = await runAndClaim(prisma);
		await prisma.serviceInstance.update({
			where: { id: "plex-1" },
			data: { identityStatus: "MISMATCH" },
		});

		expect(
			await stagePlexEpisodeUnit(prisma, claim!, expectedUnit, {
				complete: true,
				refreshedTargets: 1,
				rows: [],
			}),
		).toBe(false);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
	});

	it("preserves publication when verified identity becomes mismatched without a generation change", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		const verified = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		await prisma.serviceInstance.update({
			where: { id: "plex-1" },
			data: { identityStatus: "MISMATCH" },
		});

		expect(
			await finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance: verified,
				runId: run.id,
				plexAuthority: null,
				attempt,
			}),
		).toEqual({ published: false, itemCount: 0, outcome: "superseded" });
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ ratingKey: "old" }]);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "running", activeSlotKey: expect.any(String) });
	});

	it("rolls back publication when identity becomes mismatched at the final authority fence", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		const verified = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });

		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance: verified,
				runId: run.id,
				plexAuthority: null,
				attempt,
				testHooks: {
					beforePublish: async (tx) => {
						await tx.serviceInstance.update({
							where: { id: "plex-1" },
							data: { identityStatus: "MISMATCH" },
						});
					},
				},
			}),
		).resolves.toEqual({ published: false, itemCount: 0, outcome: "superseded" });
		expect(
			await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
		).toMatchObject({ identityStatus: "VERIFIED" });
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ ratingKey: "old" }]);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "running", activeSlotKey: expect.any(String) });
	});

	it("resumes a recovered future lease through the production runner factory without replacing staged work", async () => {
		const prisma = await database();
		const targets = Array.from({ length: 101 }, (_, index) => ({
			instanceId: "plex-1",
			generationId: "parent-1",
			showTmdbId: index + 1,
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tvdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const seed = await completedFinalizerFixtureForTargets(prisma, {
			targets,
			stages: targets.map((target, index) => ({
				unitOrdinal: Math.floor(index / 50),
				showTmdbId: target.showTmdbId,
				parentRatingKey: target.ratingKey,
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: `seed-${index + 1}`,
				title: "seed",
				watchCount: 1,
			})),
		});
		await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "plex-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		const calls: string[] = [];
		const runner = createPlexEpisodeWorkItemRunner({
			createParentAuthority: () => ({
				readPositiveEpisodeParents: async () =>
					({
						available: true as const,
						generationId: "parent-1",
						connectionGeneration: 2,
						identityGeneration: 3,
						targets: targets.map(({ showTmdbId, ...target }) => ({
							...target,
							tmdbId: showTmdbId,
						})),
					}) as never,
			}),
			createClient: () =>
				({
					getEpisodes: async (ratingKey: string) => {
						calls.push(ratingKey);
						return [
							{
								ratingKey: `episode-${ratingKey}`,
								title: "episode",
								seasonNumber: 1,
								episodeNumber: 1,
								viewCount: 1,
							},
						];
					},
				}) as never,
		});
		const context = {
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
		};

		await runner(context);
		const firstRun = await prisma.providerObservationRun.findFirstOrThrow({
			where: { instanceId: "plex-1", cacheType: "plex_episode" },
		});
		expect(firstRun).toMatchObject({
			id: expect.any(String),
			targetDigest: planPlexEpisodeRefresh(targets).targetDigest,
			completedUnits: 1,
			completedWork: 50,
		});
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: firstRun.id } })).toBe(
			50,
		);
		expect(calls).toHaveLength(50);
		const firstOuterAttempt = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
		});
		expect(firstOuterAttempt.lastAttemptResult).toMatch(/^in_progress:/);

		const inherited = await claimObservationUnit(prisma, {
			runId: firstRun.id,
			now: new Date("2026-09-07T12:00:00.000Z"),
			claimToken: "inherited-future-lease",
		});
		expect(inherited).not.toBeNull();
		const beforeRecoveryStages = await prisma.plexEpisodeObservationStage.count({
			where: { runId: firstRun.id },
		});
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(prisma)).toBe(1);
		expect(await recoverAbandonedObservationRuns(prisma)).toBe(0);
		expect(
			await stagePlexEpisodeUnit(prisma, inherited!, planPlexEpisodeRefresh(targets).units[1]!, {
				complete: true,
				refreshedTargets: 50,
				rows: [],
			}),
		).toBe(false);

		await runner(context);
		const recovered = await prisma.providerObservationRun.findUniqueOrThrow({
			where: { id: firstRun.id },
		});
		expect(recovered).toMatchObject({
			id: firstRun.id,
			targetDigest: firstRun.targetDigest,
			completedUnits: 2,
			completedWork: 100,
			state: "running",
		});
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: firstRun.id } })).toBe(
			beforeRecoveryStages + 50,
		);
		expect(calls).toHaveLength(100);
		expect(new Set(calls)).toHaveLength(100);
		const resumedOuterAttempt = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
		});
		expect(resumedOuterAttempt.lastAttemptResult).toMatch(/^in_progress:/);
		expect(resumedOuterAttempt.lastAttemptResult).not.toBe(firstOuterAttempt.lastAttemptResult);
		const beforeStaleFinalize = await prisma.plexEpisodeObservationStage.count({
			where: { runId: firstRun.id },
		});
		const staleAttempt = {
			attemptedAt: new Date("2026-09-06T00:00:00.000Z"),
			resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
		};
		expect(
			await finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance,
				runId: firstRun.id,
				plexAuthority: {},
				attempt: staleAttempt,
			}),
		).toEqual({ published: false, itemCount: 0, outcome: "superseded" });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: firstRun.id } })).toBe(
			beforeStaleFinalize,
		);
	});

	it("terminally publishes the exact 622-target scale through the production runner factory", async () => {
		const prisma = await database();
		const targets = Array.from({ length: 622 }, (_, index) => ({
			instanceId: "plex-1",
			generationId: "parent-1",
			showTmdbId: index + 1,
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tvdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const seed = await completedFinalizerFixtureForTargets(prisma, {
			targets,
			stages: [],
		});
		await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "plex-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		const calls: string[] = [];
		const runner = createPlexEpisodeWorkItemRunner({
			createParentAuthority: () =>
				({
					readPositiveEpisodeParents: async () =>
						({
							available: true as const,
							generationId: "parent-1",
							connectionGeneration: 2,
							identityGeneration: 3,
							targets: targets.map(({ showTmdbId, ...target }) => ({
								...target,
								tmdbId: showTmdbId,
							})),
						}) as never,
				}) as never,
			createClient: () =>
				({
					getEpisodes: async (ratingKey: string) => {
						calls.push(ratingKey);
						return [
							{
								ratingKey: `episode-${ratingKey}`,
								title: "episode",
								seasonNumber: 1,
								episodeNumber: 1,
								viewCount: 1,
							},
						];
					},
				}) as never,
		});
		const context = {
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
		};
		const progress = [];
		let priorCallCount = 0;
		for (let invocation = 0; invocation < 13; invocation += 1) {
			progress.push(await runner(context));
			const unitCallCount = calls.length - priorCallCount;
			expect(unitCallCount).toBeGreaterThan(0);
			expect(unitCallCount).toBeLessThanOrEqual(50);
			priorCallCount = calls.length;
		}

		expect(progress.at(-1)).toMatchObject({
			state: "complete",
			completedUnits: 13,
			completedWork: 622,
		});
		const runs = await prisma.providerObservationRun.findMany({
			where: { instanceId: "plex-1", cacheType: "plex_episode" },
		});
		expect(runs).toHaveLength(1);
		const run = runs[0]!;
		expect(run).toMatchObject({
			state: "complete",
			completedUnits: 13,
			completedWork: 622,
			targetDigest: planPlexEpisodeRefresh(targets).targetDigest,
		});
		expect(calls).toHaveLength(622);
		expect(new Set(calls)).toHaveLength(622);
		expect(
			await prisma.providerObservationRun.count({
				where: {
					instanceId: "plex-1",
					cacheType: "plex_episode",
					activeSlotKey: { not: null },
				},
			}),
		).toBe(0);
		expect(await prisma.plexEpisodeCache.count({ where: { instanceId: "plex-1" } })).toBe(622);
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			}),
		).toMatchObject({ lastResult: "success", itemCount: 622 });
	});

	it("refuses a future-lease Plex claim without a matching outer marker", async () => {
		const prisma = await database();
		const { run, claim } = await runAndClaim(prisma);
		expect(claim).not.toBeNull();
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				showTmdbId: 42,
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "episode-1",
				title: "Episode",
				watched: true,
				watchedByUsers: "[]",
				lastWatchedAt: null,
				watchCount: 1,
				refreshedAt: new Date("2026-09-07T00:00:00.000Z"),
				parentRatingKey: "show-1",
				sourceFingerprint: "fingerprint",
			},
		});

		await expect(reconcileInterruptedProviderCacheRefreshAttempts(prisma)).rejects.toThrow(
			"unmatched inherited claim",
		);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				id: run.id,
				targetDigest: "a".repeat(64),
				state: "running",
			},
		);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		expect(
			await claimObservationUnit(prisma, {
				runId: run.id,
				now: new Date("2026-09-06T00:00:00.000Z"),
				claimToken: "resumed",
			}),
		).toBeNull();
	});

	it("does not persist rows when the claimed unit token is stale", async () => {
		const prisma = await database();
		const { run, claim, expectedUnit } = await runAndClaim(prisma);
		expect(claim).not.toBeNull();
		const staged = await stagePlexEpisodeUnit(
			prisma,
			{ ...claim!, claimToken: "stale" },
			expectedUnit,
			{
				complete: true,
				refreshedTargets: 1,
				rows: [
					{
						instanceId: "plex-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						title: "Pilot",
						watched: true,
						watchedByUsers: "[]",
						lastWatchedAt: null,
						watchCount: 2,
						refreshedAt: new Date("2026-09-06T00:00:00.000Z"),
						sourceFingerprint: "fingerprint",
						parentRatingKey: "show-1",
					},
				],
			},
		);
		expect(staged).toBe(false);
		expect(await prisma.plexEpisodeObservationStage.findMany({ where: { runId: run.id } })).toEqual(
			[],
		);
	});

	it("keeps the final staged unit running until atomic publication", async () => {
		const prisma = await database();
		const { run, claim, expectedUnit } = await runAndClaim(prisma);
		await expect(
			stagePlexEpisodeUnit(prisma, claim!, expectedUnit, {
				complete: true,
				refreshedTargets: 1,
				rows: [],
			}),
		).resolves.toBe(true);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{ state: "running", activeSlotKey: expect.any(String), completedUnits: 1, completedWork: 1 },
		);
	});

	it("stages a valid nonzero ordinal unit from a multi-unit plan", async () => {
		const prisma = await database();
		const targets = Array.from({ length: 51 }, (_, index) => ({
			instanceId: "plex-1",
			generationId: "parent-1",
			showTmdbId: index + 1,
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tvdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const plan = planPlexEpisodeRefresh(targets);
		const expectedUnit = plan.units[1]!;
		const run = await createOrLoadObservationRun(prisma, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId: "plex-1",
				parentGenerationId: "parent-1",
				targetDigest: "a".repeat(64),
				connectionGeneration: 2,
				identityGeneration: 3,
			},
			units: [
				{
					ordinal: expectedUnit.ordinal,
					scopeKey: expectedUnit.scopeKey,
					scopeDigest: expectedUnit.scopeDigest,
					phase: "collect",
					expectedTargets: expectedUnit.targets.length,
				},
			],
		});
		const claim = await claimObservationUnit(prisma, {
			runId: run.id,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});

		expect(
			await stagePlexEpisodeUnit(prisma, claim!, expectedUnit, {
				complete: true,
				refreshedTargets: expectedUnit.targets.length,
				rows: [],
			}),
		).toBe(true);
		expect(
			await prisma.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({ ordinal: 1, state: "complete" });
	});

	it("rejects a claimed row whose scope or source fingerprint no longer matches the owned service", async () => {
		const prisma = await database();
		const { run, claim, expectedUnit } = await runAndClaim(prisma);
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		const result = {
			complete: true as const,
			refreshedTargets: 1,
			rows: [
				{
					instanceId: "plex-1",
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-1",
					title: "Pilot",
					watched: true,
					watchedByUsers: "[]",
					lastWatchedAt: null,
					watchCount: 2,
					refreshedAt: new Date("2026-09-06T00:00:00.000Z"),
					sourceFingerprint: plexConnectionFingerprint(instance),
					parentRatingKey: "show-1",
				},
			],
		};
		expect(
			await stagePlexEpisodeUnit(
				prisma,
				{ ...claim!, scopeKey: "plex-episode-unit:99" },
				expectedUnit,
				result,
			),
		).toBe(false);
		result.rows[0]!.sourceFingerprint = "not-the-current-connection";
		expect(await stagePlexEpisodeUnit(prisma, claim!, expectedUnit, result)).toBe(false);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
	});

	it.each([
		["ordinal", { ordinal: 1 }],
		["scope digest", { scopeDigest: "c".repeat(64) }],
		["expected target count", { expectedTargets: 2 }],
	])("rejects a persisted %s drift without staging", async (_label, unitDrift) => {
		const prisma = await database();
		const { run, claim, expectedUnit } = await runAndClaim(prisma);
		await prisma.providerObservationUnit.update({
			where: { id: claim!.unitId },
			data: unitDrift,
		});
		expect(
			await stagePlexEpisodeUnit(prisma, claim!, expectedUnit, {
				complete: true,
				refreshedTargets: 1,
				rows: [],
			}),
		).toBe(false);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
	});

	it("rejects staged rows whose parent rating key and show id are not in the exact planned unit", async () => {
		const prisma = await database();
		const { run, claim, expectedUnit } = await runAndClaim(prisma);
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		expect(
			await stagePlexEpisodeUnit(prisma, claim!, expectedUnit, {
				complete: true,
				refreshedTargets: 1,
				rows: [
					{
						instanceId: "plex-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						title: "Pilot",
						watched: true,
						watchedByUsers: "[]",
						lastWatchedAt: null,
						watchCount: 2,
						refreshedAt: new Date("2026-09-06T00:00:00.000Z"),
						sourceFingerprint: plexConnectionFingerprint(instance),
						parentRatingKey: "different-show",
					},
				],
			}),
		).toBe(false);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
	});

	it.each([
		["in-progress", "in_progress:parent-attempt", null, "parent-refresh-in-progress", 1],
		["failed", "error", "provider-unavailable", "terminal-no-publication", 0],
		["partial authoritative", "partial", null, "terminal-no-publication", 0],
	])(
		"preserves the old episode cache when the parent latest attempt is %s",
		async (_name, marker, error, outcome, retainedStages) => {
			const prisma = await database();
			const { run, attempt } = await completedFinalizerFixture(prisma);
			await prisma.cacheRefreshStatus.update({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex" } },
				data: { lastAttemptResult: marker, lastAttemptErrorMessage: error },
			});
			await expect(
				finalizePlexEpisodeRun({
					prisma,
					userId: "user-1",
					instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
					runId: run.id,
					plexAuthority: null,
					attempt,
				}),
			).resolves.toEqual({ published: false, itemCount: 0, outcome });
			expect(
				await prisma.plexEpisodeCache.findUnique({
					where: {
						instanceId_showTmdbId_seasonNumber_episodeNumber: {
							instanceId: "plex-1",
							showTmdbId: 1,
							seasonNumber: 1,
							episodeNumber: 1,
						},
					},
				}),
			).toMatchObject({ ratingKey: "old" });
			expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
				retainedStages,
			);
			expect(
				await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
				}),
			).toMatchObject({
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "coverage-incomplete",
			});
		},
	);

	it("rejects a replacement episode attempt without adopting the old run stages", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			data: { lastAttemptResult: "in_progress:replacement" },
		});
		const result = await finalizePlexEpisodeRun({
			prisma,
			userId: "user-1",
			instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
			runId: run.id,
			plexAuthority: null,
			attempt,
		});
		expect(result).toEqual({ published: false, itemCount: 0, outcome: "superseded" });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		expect(await prisma.plexEpisodeCache.count({ where: { instanceId: "plex-1" } })).toBe(1);
	});

	it("publishes a fully staged run on a later invocation and only then terminalizes it", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		const result = await finalizePlexEpisodeRun({
			prisma,
			userId: "user-1",
			instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
			runId: run.id,
			plexAuthority: null,
			attempt,
		});
		expect(result).toEqual({ published: true, itemCount: 1 });
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "complete", activeSlotKey: null });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ showTmdbId: 42, ratingKey: "episode-b", watchCount: 2 }]);
	});

	it("publishes an episode digest accepted by the actual persisted authority reader", async () => {
		const prisma = await database();
		const fixture = await completedFinalizerFixtureForTargets(prisma, {
			targets: [
				{
					instanceId: "plex-1",
					generationId: "parent-1",
					showTmdbId: 42,
					sectionId: "shows",
					sectionUuid: "shows-uuid",
					mediaType: "series",
					tvdbId: 99,
					ratingKey: "show-1",
				},
			],
			stages: [
				{
					unitOrdinal: 0,
					showTmdbId: 42,
					parentRatingKey: "show-1",
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-1",
					title: "Episode 1",
					watchCount: 2,
				},
			],
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance,
				runId: fixture.run.id,
				plexAuthority: null,
				attempt: fixture.attempt,
				now: fixture.attempt.attemptedAt,
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });

		const authority = new PlexAuthorityService({ prisma, log: {} as never });
		const evidence = await authority.readPositiveEpisodeEvidence({
			userId: "user-1",
			instanceId: "plex-1",
			now: fixture.attempt.attemptedAt,
		});
		expect(evidence.available).toBe(true);
		if (evidence.available) expect(evidence.rows).toHaveLength(1);
	});

	it("keeps the 622-parent workload in exactly thirteen bounded durable units", () => {
		const plan = planPlexEpisodeRefresh(
			Array.from({ length: 622 }, (_, index) => ({
				instanceId: "plex-1",
				generationId: "parent-1",
				showTmdbId: index + 1,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tvdbId: index + 1,
				ratingKey: `show-${index + 1}`,
			})),
		);
		expect(plan.targetCount).toBe(622);
		expect(plan.units).toHaveLength(13);
		expect(plan.units.map((unit) => unit.targets.length)).toEqual([
			50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 22,
		]);
	});

	it.each(["authoritative", "positive-only"] as const)(
		"atomically publishes 622 staged parent targets from a %s parent",
		async (parentPublicationLevel) => {
			const prisma = await database();
			const targets = Array.from({ length: 622 }, (_, index) => ({
				instanceId: "plex-1",
				generationId: "parent-1",
				showTmdbId: index + 1,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tvdbId: index + 1,
				ratingKey: `show-${index + 1}`,
			}));
			const fixture = await completedFinalizerFixtureForTargets(prisma, {
				targets,
				parentPublicationLevel,
				stages: targets.map((target, index) => ({
					unitOrdinal: Math.floor(index / 50),
					showTmdbId: target.showTmdbId,
					parentRatingKey: target.ratingKey,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: `episode-${target.showTmdbId}`,
					title: `Episode ${target.showTmdbId}`,
					watchCount: 1,
				})),
			});
			expect(fixture.plan.units).toHaveLength(13);
			await expect(
				finalizePlexEpisodeRun({
					prisma,
					userId: "user-1",
					instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
					runId: fixture.run.id,
					plexAuthority: null,
					attempt: fixture.attempt,
				}),
			).resolves.toEqual({ published: true, itemCount: 622 });
			expect(await prisma.plexEpisodeCache.count({ where: { instanceId: "plex-1" } })).toBe(622);
			expect(
				await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: fixture.run.id } }),
			).toMatchObject({
				state: "complete",
				activeSlotKey: null,
				completedUnits: 13,
				completedWork: 622,
			});
			expect(
				await prisma.plexEpisodeObservationStage.count({ where: { runId: fixture.run.id } }),
			).toBe(0);
			expect(
				await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
				}),
			).toMatchObject({
				lastResult: "success",
				lastAttemptResult: "partial",
				lastAttemptErrorMessage: null,
				itemCount: 622,
			});
		},
	);

	it.each(["metadata-item-count", "receipt-observed-at"] as const)(
		"rejects a positive-only parent whose %s is not bound to its published status",
		async (corruption) => {
			const prisma = await database();
			const targets: ParentTarget[] = [
				{
					instanceId: "plex-1",
					generationId: "parent-1",
					showTmdbId: 42,
					sectionId: "shows",
					sectionUuid: "shows-uuid",
					mediaType: "series",
					tvdbId: 99,
					ratingKey: "show-1",
				},
			];
			const fixture = await completedFinalizerFixtureForTargets(prisma, {
				targets,
				parentPublicationLevel: "positive-only",
				stages: [
					{
						unitOrdinal: 0,
						showTmdbId: 42,
						parentRatingKey: "show-1",
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						title: "Episode 1",
						watchCount: 1,
					},
				],
			});
			const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex" } },
			});
			const metadata = JSON.parse(parent.generationMetadata!) as {
				itemCount: number;
				coverageReceipt: { observedAt: string };
			};
			if (corruption === "metadata-item-count") metadata.itemCount = 2;
			else metadata.coverageReceipt.observedAt = "2026-09-06T00:00:01.000Z";
			await prisma.cacheRefreshStatus.update({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex" } },
				data: { generationMetadata: JSON.stringify(metadata) },
			});

			await expect(
				finalizePlexEpisodeRun({
					prisma,
					userId: "user-1",
					instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
					runId: fixture.run.id,
					plexAuthority: null,
					attempt: fixture.attempt,
				}),
			).resolves.toEqual({ published: false, itemCount: 0, outcome: "terminal-no-publication" });
			expect(await prisma.plexEpisodeCache.count({ where: { instanceId: "plex-1" } })).toBe(1);
			expect(
				await prisma.plexEpisodeObservationStage.count({ where: { runId: fixture.run.id } }),
			).toBe(0);
		},
	);

	it("uses the greatest source watch count and lexical rating-key tie-break across units without summing", async () => {
		const prisma = await database();
		const targets: ParentTarget[] = [
			...Array.from({ length: 49 }, (_, index) => ({
				instanceId: "plex-1",
				generationId: "parent-1",
				showTmdbId: index + 1,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tvdbId: index + 1,
				ratingKey: `earlier-${index + 1}`,
			})),
			...["copy-a", "copy-b", "copy-c"].map((ratingKey) => ({
				instanceId: "plex-1",
				generationId: "parent-1",
				showTmdbId: 50,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tvdbId: 50,
				ratingKey,
			})),
		];
		const fixture = await completedFinalizerFixtureForTargets(prisma, {
			targets,
			stages: [
				{
					unitOrdinal: 0,
					showTmdbId: 50,
					parentRatingKey: "copy-a",
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-low",
					title: "Pilot",
					watchCount: 4,
				},
				{
					unitOrdinal: 1,
					showTmdbId: 50,
					parentRatingKey: "copy-b",
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-z",
					title: "Pilot",
					watchCount: 9,
				},
				{
					unitOrdinal: 1,
					showTmdbId: 50,
					parentRatingKey: "copy-c",
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-a",
					title: "Pilot",
					watchCount: 9,
				},
			],
		});
		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
				runId: fixture.run.id,
				plexAuthority: null,
				attempt: fixture.attempt,
				now: fixture.attempt.attemptedAt,
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
		expect(
			await prisma.plexEpisodeCache.findUniqueOrThrow({
				where: {
					instanceId_showTmdbId_seasonNumber_episodeNumber: {
						instanceId: "plex-1",
						showTmdbId: 50,
						seasonNumber: 1,
						episodeNumber: 1,
					},
				},
			}),
		).toMatchObject({ ratingKey: "episode-a", watchCount: 9 });
		const evidence = await new PlexAuthorityService({
			prisma,
			log: {} as never,
		}).readPositiveEpisodeEvidence({
			userId: "user-1",
			instanceId: "plex-1",
			now: fixture.attempt.attemptedAt,
		});
		expect(evidence.available).toBe(true);
		if (evidence.available) expect(evidence.rows).toHaveLength(0);
	});

	it("never joins stage rows from an invalidated previous attempt into the current run", async () => {
		const prisma = await database();
		const fixture = await completedFinalizerFixture(prisma);
		const oldRun = await prisma.providerObservationRun.create({
			data: {
				instanceId: "plex-1",
				provider: "plex_episode",
				cacheType: "plex_episode",
				authorityKey: "old-attempt",
				activeSlotKey: null,
				parentGenerationId: "old-parent",
				targetDigest: "f".repeat(64),
				targetCount: 1,
				connectionGeneration: 2,
				identityGeneration: 3,
				state: "invalidated",
				totalUnits: 1,
				totalWork: 1,
				completedAt: new Date("2026-09-06T00:00:00.000Z"),
				units: {
					create: {
						ordinal: 0,
						scopeKey: "plex-episode-unit:0",
						scopeDigest: "e".repeat(64),
						phase: "collect",
						expectedTargets: 1,
						state: "invalidated",
					},
				},
			},
			include: { units: true },
		});
		const oldUnit = oldRun.units[0]!;
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: oldRun.id,
				unitId: oldUnit.id,
				showTmdbId: 7,
				parentRatingKey: "old-show",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "old-episode",
				title: "old",
				watched: true,
				watchedByUsers: "[]",
				lastWatchedAt: null,
				watchCount: 99,
				refreshedAt: new Date("2026-09-06T00:00:00.000Z"),
				sourceFingerprint: plexConnectionFingerprint(instance),
			},
		});
		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance,
				runId: fixture.run.id,
				plexAuthority: null,
				attempt: fixture.attempt,
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: oldRun.id } })).toBe(1);
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ showTmdbId: 42, ratingKey: "episode-b", watchCount: 2 }]);
	});

	it("preserves the old cache for incomplete or drifted unit, parent, ledger, and run authority", async () => {
		const cases: Array<
			[
				string,
				(prisma: Awaited<ReturnType<typeof database>>, runId: string) => Promise<void>,
				"incomplete" | "terminal-no-publication" | "superseded",
				number,
			]
		> = [
			[
				"incomplete unit",
				async (prisma, runId) => {
					await prisma.providerObservationUnit.updateMany({
						where: { runId },
						data: { state: "pending", completedAt: null },
					});
					await prisma.providerObservationRun.update({
						where: { id: runId },
						data: { completedUnits: 0, completedWork: 0 },
					});
				},
				"incomplete",
				1,
			],
			[
				"drifted parent service generation",
				async (prisma) => {
					await prisma.serviceInstance.update({
						where: { id: "plex-1" },
						data: { connectionGeneration: 4 },
					});
				},
				"superseded",
				1,
			],
			[
				"invalidated target ledger",
				async (prisma) => {
					await prisma.plexGenerationTarget.deleteMany({ where: { instanceId: "plex-1" } });
				},
				"terminal-no-publication",
				0,
			],
			[
				"drifted run authority",
				async (prisma, runId) => {
					await prisma.providerObservationRun.update({
						where: { id: runId },
						data: { targetDigest: "0".repeat(64) },
					});
				},
				"terminal-no-publication",
				0,
			],
		];
		for (const [, drift, outcome, retainedStages] of cases) {
			const prisma = await database();
			const { run, attempt } = await completedFinalizerFixture(prisma);
			await drift(prisma, run.id);
			await expect(
				finalizePlexEpisodeRun({
					prisma,
					userId: "user-1",
					instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
					runId: run.id,
					plexAuthority: null,
					attempt,
				}),
			).resolves.toEqual({ published: false, itemCount: 0, outcome });
			expect(
				await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
			).toMatchObject([{ showTmdbId: 1, ratingKey: "old", watchCount: 1 }]);
			expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
				retainedStages,
			);
		}
	}, 30_000);

	it("rolls back the cache, status, run, and stages when the exact status-attempt CAS loses", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		const beforeStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
		});
		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
				runId: run.id,
				plexAuthority: null,
				attempt,
				testHooks: {
					beforePublish: async (tx) => {
						await tx.cacheRefreshStatus.update({
							where: {
								instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" },
							},
							data: { lastAttemptResult: "in_progress:replacement" },
						});
					},
				},
			}),
		).resolves.toEqual({ published: false, itemCount: 0, outcome: "superseded" });
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			}),
		).toMatchObject({
			lastResult: beforeStatus.lastResult,
			generationId: beforeStatus.generationId,
			lastAttemptResult: beforeStatus.lastAttemptResult,
		});
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ showTmdbId: 1, ratingKey: "old", watchCount: 1 }]);
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "running",
			activeSlotKey: expect.any(String),
		});
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
	});

	it("rolls back provider-cache publication when terminalization cannot continue", async () => {
		const prisma = await database();
		const { run, attempt } = await completedFinalizerFixture(prisma);
		await expect(
			finalizePlexEpisodeRun({
				prisma,
				userId: "user-1",
				instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } }),
				runId: run.id,
				plexAuthority: null,
				attempt,
				testHooks: {
					afterPublish: () => {
						throw new Error("injected terminalization failure");
					},
				},
			}),
		).rejects.toThrow("injected terminalization failure");
		expect(
			await prisma.plexEpisodeCache.findMany({ where: { instanceId: "plex-1" } }),
		).toMatchObject([{ showTmdbId: 1, ratingKey: "old", watchCount: 1 }]);
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" } },
			}),
		).toMatchObject({ generationId: "old", lastAttemptResult: attempt.resultMarker });
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "running",
			activeSlotKey: expect.any(String),
		});
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
	});
});
