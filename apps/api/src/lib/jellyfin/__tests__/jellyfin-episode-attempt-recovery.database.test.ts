import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { createOrLoadObservationRun } from "../../provider-observation/observation-run-repository.js";
import type { ProviderCacheRefreshAttempt } from "../../services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { invalidateJellyfinEpisodeAttempt } from "../jellyfin-episode-attempt-recovery.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-attempt-recovery-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.createMany({
		data: [
			{ id: "user-1", username: "attempt-recovery" },
			{ id: "user-2", username: "other-owner" },
		],
	});
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-1",
			userId: "user-1",
			service: "JELLYFIN",
			label: "Jellyfin",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			expectedIdentity: "server-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 4,
			identityGeneration: 7,
		},
	});
	const authority = createProviderPublicationAuthority(instance);
	const attemptedAt = new Date("2026-09-08T12:00:00.000Z");
	const attempt = {
		attemptedAt,
		resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
	};
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: instance.id,
			cacheType: "jellyfin_episode",
			lastRefreshedAt: new Date("2026-09-08T11:00:00.000Z"),
			lastResult: "success",
			itemCount: 1,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptAt: attemptedAt,
			lastAttemptResult: attempt.resultMarker,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
	});
	await prisma.jellyfinEpisodeCache.create({
		data: {
			instanceId: instance.id,
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			jellyfinId: "published-episode",
			title: "Published episode",
			watched: true,
			watchedByUsers: "[]",
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
	});
	const targetDigest = "a".repeat(64);
	const runAuthority = {
		provider: "jellyfin_episode" as const,
		cacheType: "jellyfin_episode" as const,
		instanceId: instance.id,
		parentGenerationId: "old-parent-generation",
		targetDigest,
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
	};
	const run = await createOrLoadObservationRun(prisma, {
		authority: runAuthority,
		units: [
			{
				ordinal: 0,
				scopeKey: "collect:user-1:library-1",
				scopeDigest: "b".repeat(64),
				phase: "collect",
				expectedTargets: 1,
			},
			{
				ordinal: 1,
				scopeKey: "verify:user-1:library-1",
				scopeDigest: "c".repeat(64),
				phase: "verify",
				expectedTargets: 0,
			},
		],
	});
	const collectUnit = await prisma.providerObservationUnit.findFirstOrThrow({
		where: { runId: run.id, phase: "collect" },
	});
	await prisma.jellyfinEpisodeObservationStage.create({
		data: {
			runId: run.id,
			unitId: collectUnit.id,
			userKeyDigest: "d".repeat(64),
			pass: "collect",
			jellyfinId: "staged-episode",
			seriesId: "series-1",
			seasonNumber: 1,
			episodeNumber: 2,
			title: "Staged episode",
			played: true,
			playCount: 1,
			lastPlayedAt: attemptedAt,
			userName: "",
		},
	});
	await prisma.jellyfinEpisodeObservationExclusion.create({
		data: {
			runId: run.id,
			unitId: collectUnit.id,
			userKeyDigest: "d".repeat(64),
			pass: "collect",
			jellyfinId: "excluded-episode",
			reason: "missing-episode-metadata",
		},
	});
	return { prisma, authority, attempt, run, runAuthority };
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("Jellyfin episode attempt recovery", { timeout: 30_000 }, () => {
	async function state(prisma: Awaited<ReturnType<typeof database>>["prisma"], runId: string) {
		return {
			status: await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: {
						instanceId: "jellyfin-1",
						cacheType: "jellyfin_episode",
					},
				},
			}),
			run: await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: runId } }),
			units: await prisma.providerObservationUnit.findMany({
				where: { runId },
				orderBy: { ordinal: "asc" },
			}),
			stages: await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId },
				orderBy: { id: "asc" },
			}),
			exclusions: await prisma.jellyfinEpisodeObservationExclusion.findMany({
				where: { runId },
				orderBy: { id: "asc" },
			}),
			cache: await prisma.jellyfinEpisodeCache.findMany({ where: { instanceId: "jellyfin-1" } }),
		};
	}

	it("atomically settles the exact outer marker and invalidates only unpublished run evidence", async () => {
		const { prisma, authority, attempt, run } = await database();

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority,
				attempt,
				runId: run.id,
				now: new Date("2026-09-08T12:01:00.000Z"),
			}),
		).resolves.toBe("recorded");

		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: {
						instanceId: authority.id,
						cacheType: "jellyfin_episode",
					},
				},
			}),
		).toMatchObject({
			lastResult: "success",
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "coverage-incomplete",
			generationId: "published-generation",
		});
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "invalidated",
			activeSlotKey: null,
		});
		expect(await prisma.providerObservationUnit.findMany({ where: { runId: run.id } })).toEqual(
			expect.arrayContaining([expect.objectContaining({ state: "invalidated", claimToken: null })]),
		);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			0,
		);
		expect(
			await prisma.jellyfinEpisodeObservationExclusion.count({ where: { runId: run.id } }),
		).toBe(0);
		expect(
			await prisma.jellyfinEpisodeCache.findMany({ where: { instanceId: authority.id } }),
		).toEqual([
			expect.objectContaining({ jellyfinId: "published-episode", title: "Published episode" }),
		]);
	});

	it("accepts an EMBY-owned episode attempt under the same exact authority fence", async () => {
		const { prisma, attempt, run } = await database();
		const instance = await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { service: "EMBY" },
		});
		const authority = createProviderPublicationAuthority(instance);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("recorded");
	});

	it.each<
		[string, { userId?: string; connectionGeneration?: number; identityGeneration?: number }]
	>([
		["wrong owner", { userId: "user-2" }],
		["wrong connection generation", { connectionGeneration: 5 }],
		["wrong identity generation", { identityGeneration: 8 }],
	])("returns superseded without mutation for %s authority", async (_label, overrides) => {
		const { prisma, authority, attempt, run } = await database();
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority: { ...authority, ...overrides },
				attempt,
				runId: run.id,
			}),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it.each<[string, { runId?: string; attempt?: Partial<ProviderCacheRefreshAttempt> }]>([
		["wrong run", { runId: "missing-run" }],
		[
			"wrong marker",
			{ attempt: { resultMarker: "in_progress:22222222-2222-4222-8222-222222222222" } },
		],
	])("returns superseded without mutation for %s", async (_label, overrides) => {
		const { prisma, authority, attempt, run } = await database();
		const before = await state(prisma, run.id);
		const nextAttempt = {
			...attempt,
			...(overrides.attempt ?? {}),
		};

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority,
				attempt: nextAttempt,
				runId: overrides.runId ?? run.id,
			}),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("rejects a run whose stored authority key no longer matches its stored parent and target", async () => {
		const { prisma, authority, attempt, run } = await database();
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { authorityKey: "f".repeat(64) },
		});
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("rejects a run whose active slot key is not the exact current episode slot", async () => {
		const { prisma, authority, attempt, run } = await database();
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { activeSlotKey: "f".repeat(64) },
		});
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("rejects a non-Jellyfin authority even when its stored fields otherwise look verified", async () => {
		const { prisma, authority, attempt, run } = await database();
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority: { ...authority, service: "PLEX" } as never,
				attempt,
				runId: run.id,
			}),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it.each([
		["earlier", new Date("2026-09-08T11:59:59.000Z")],
		["future relative to now", new Date("2026-09-08T12:02:00.000Z")],
	])("rejects an attempt with an %s timestamp", async (_label, attemptedAt) => {
		const { prisma, authority, attempt, run } = await database();
		if (_label === "future relative to now") {
			await prisma.cacheRefreshStatus.update({
				where: {
					instanceId_cacheType: {
						instanceId: authority.id,
						cacheType: "jellyfin_episode",
					},
				},
				data: { lastAttemptAt: attemptedAt },
			});
		}
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority,
				attempt: { ...attempt, attemptedAt },
				runId: run.id,
				now: new Date("2026-09-08T12:01:00.000Z"),
			}),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("does not invalidate while any unit still holds a live claim", async () => {
		const { prisma, authority, attempt, run } = await database();
		const unit = await prisma.providerObservationUnit.findFirstOrThrow({
			where: { runId: run.id },
		});
		await prisma.providerObservationUnit.update({
			where: { id: unit.id },
			data: { state: "running", claimToken: "live-claim" },
		});
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("does not invalidate an orphaned claim token on a non-running unit", async () => {
		const { prisma, authority, attempt, run } = await database();
		const unit = await prisma.providerObservationUnit.findFirstOrThrow({
			where: { runId: run.id },
		});
		await prisma.providerObservationUnit.update({
			where: { id: unit.id },
			data: { state: "pending", claimToken: "orphaned-claim" },
		});
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("rolls back the marker and all invalidation writes when a counted delete loses rows", async () => {
		const { prisma, authority, attempt, run } = await database();
		const before = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({
				prisma,
				authority,
				attempt,
				runId: run.id,
				testHooks: {
					afterStageCount: async (tx) => {
						const unit = await tx.providerObservationUnit.findFirstOrThrow({
							where: { runId: run.id, ordinal: 0 },
						});
						await tx.jellyfinEpisodeObservationStage.create({
							data: {
								runId: run.id,
								unitId: unit.id,
								userKeyDigest: "e".repeat(64),
								pass: "collect",
								jellyfinId: "another-staged-episode",
								seriesId: "series-1",
								seasonNumber: 1,
								episodeNumber: 3,
								title: "Another staged episode",
								played: false,
								playCount: 0,
								lastPlayedAt: null,
								userName: "",
							},
						});
					},
				},
			}),
		).rejects.toThrow("staging invalidation count changed");
		expect(await state(prisma, run.id)).toEqual(before);
	});

	it("settles the exact marker only once", async () => {
		const { prisma, authority, attempt, run } = await database();
		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("recorded");
		const afterFirst = await state(prisma, run.id);

		await expect(
			invalidateJellyfinEpisodeAttempt({ prisma, authority, attempt, runId: run.id }),
		).resolves.toBe("superseded");
		expect(await state(prisma, run.id)).toEqual(afterFirst);
	});
});
