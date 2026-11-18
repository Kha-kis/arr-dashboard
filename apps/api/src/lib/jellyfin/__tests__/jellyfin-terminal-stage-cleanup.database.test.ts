import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { Prisma } from "../../prisma.js";
import {
	cleanupCompletedJellyfinEpisodeArtifacts,
	cleanupPublishedJellyfinEpisodeArtifacts,
	cleanupTerminalJellyfinEpisodeStage,
} from "../jellyfin-native-watch-repository.js";

type TestPrisma = ReturnType<typeof createTestPrismaClient>;
const databases: Array<{ directory: string; prisma: TestPrisma }> = [];
const observedAt = new Date("2026-09-24T12:00:00.000Z");

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-terminal-stage-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	for (const id of ["instance", "other-instance"]) {
		await prisma.user.create({ data: { id: `${id}-owner`, username: `${id}-owner` } });
		await prisma.serviceInstance.create({
			data: {
				id,
				userId: `${id}-owner`,
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "http://jellyfin.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
			},
		});
	}
	return prisma;
}

async function seedRun(
	prisma: TestPrisma,
	id: string,
	overrides: Partial<Prisma.ProviderObservationRunUncheckedCreateInput> = {},
	count = 1,
) {
	await prisma.providerObservationRun.create({
		data: {
			id,
			instanceId: "instance",
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: `authority-${id}`,
			targetDigest: `digest-${id}`,
			targetCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "complete",
			totalUnits: 1,
			totalWork: 1,
			completedAt: observedAt,
			...overrides,
		},
	});
	await prisma.providerObservationUnit.create({
		data: {
			id: `${id}-unit`,
			runId: id,
			ordinal: 0,
			scopeKey: "synthetic-scope",
			scopeDigest: "synthetic-digest",
			phase: "collect",
			expectedTargets: 1,
			state: "complete",
		},
	});
	for (let offset = 0; offset < count; offset += 500) {
		await prisma.jellyfinEpisodeObservationStage.createMany({
			data: Array.from({ length: Math.min(500, count - offset) }, (_, index) => ({
				id: `${id}-stage-${offset + index}`,
				runId: id,
				unitId: `${id}-unit`,
				userKeyDigest: "synthetic-user",
				pass: "collect",
				jellyfinId: `episode-${offset + index}`,
				seriesId: "same-series",
				seasonNumber: 1,
				episodeNumber: offset + index,
				title: "Same synthetic title",
				played: false,
				userName: "",
			})),
		});
	}
}

async function seedProtectedArtifacts(prisma: TestPrisma) {
	for (const runId of ["target", "previous", "active"]) {
		if (runId !== "target") await seedRun(prisma, runId);
		await prisma.jellyfinNativeWatchRow.create({
			data: {
				instanceId: "instance",
				runId,
				userKeyDigest: "user",
				libraryId: "library",
				jellyfinId: "episode-0",
				seriesId: "same-series",
				seasonNumber: 1,
				episodeNumber: 0,
				played: true,
				observedAt,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await prisma.jellyfinNativeWatchScopeReceipt.create({
			data: {
				instanceId: "instance",
				runId,
				userKeyDigest: "user",
				libraryId: "library",
				expectedRawCount: 1,
				observedRawCount: 1,
				exact: true,
				contentFingerprint: "fingerprint",
				observedAt,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
	}
	await prisma.jellyfinNativeWatchPublication.create({
		data: {
			instanceId: "instance",
			activeRunId: "active",
			previousRunId: "previous",
			activeCacheGenerationId: "published-generation",
			activeObservedAt: observedAt,
			activeExpectedScopeCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	await prisma.jellyfinEpisodeObservationExclusion.create({
		data: {
			runId: "target",
			unitId: "target-unit",
			userKeyDigest: "user",
			pass: "collect",
			jellyfinId: "excluded",
			reason: "synthetic-exclusion",
		},
	});
	const episode = {
		instanceId: "instance",
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		jellyfinId: "published-episode",
		title: "Synthetic published episode",
		watched: true,
		watchedByUsers: "[]",
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	await prisma.jellyfinEpisodeCache.create({ data: episode });
	await prisma.jellyfinEpisodeGenerationRow.create({
		data: { ...episode, generationId: "target" },
	});
	await prisma.jellyfinEpisodeGenerationShowReceipt.create({
		data: {
			instanceId: "instance",
			generationId: "target",
			showTmdbId: 42,
			rowCount: 1,
			contentFingerprint: "fingerprint",
		},
	});
	await prisma.jellyfinEpisodePreparation.create({
		data: {
			instanceId: "instance",
			runId: "target",
			generationId: "target",
			token: "token",
			state: "ready",
			leaseExpiresAt: observedAt,
		},
	});
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: "instance",
			cacheType: "jellyfin_episode",
			lastRefreshedAt: observedAt,
			lastResult: "success",
			generationId: "target",
			generationMetadata: "synthetic-metadata",
		},
	});
	await prisma.providerNativeInventorySnapshot.create({
		data: {
			instanceId: "instance",
			domain: "episode",
			generationId: "inventory",
			itemCount: 1,
			items: { create: { nativeId: "episode-0", mediaType: "episode", libraryIds: "[]" } },
		},
	});
	await prisma.plexEpisodeObservationStage.create({
		data: {
			runId: "target",
			unitId: "target-unit",
			showTmdbId: 42,
			parentRatingKey: "show",
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "episode",
			title: "Synthetic other stage",
			watched: true,
			watchedByUsers: "[]",
			watchCount: 1,
			refreshedAt: observedAt,
			sourceFingerprint: "fingerprint",
		},
	});
}

async function nonStageSnapshot(prisma: TestPrisma) {
	const tables = await prisma.$queryRaw<Array<{ name: string }>>`
		SELECT name FROM sqlite_master WHERE type = 'table'
			AND name <> 'jellyfin_episode_observation_stage' ORDER BY name
	`;
	const result: Record<string, unknown[]> = {};
	for (const { name } of tables) {
		// Table names come only from the freshly pushed disposable schema.
		result[name] = await prisma.$queryRawUnsafe(
			`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
		);
	}
	return result;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("terminal Jellyfin episode stage cleanup", { timeout: 30_000 }, () => {
	it.each(["complete", "invalidated"])(
		"reclaims only the exact %s run stage and preserves every other table",
		async (state) => {
			const prisma = await database();
			await seedRun(prisma, "target", { state });
			await seedRun(prisma, "foreign", { instanceId: "other-instance" });
			await seedProtectedArtifacts(prisma);
			const protectedRows = await nonStageSnapshot(prisma);
			const otherStages = await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: { not: "target" } },
				orderBy: { id: "asc" },
			});
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target");
			expect(
				await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "target" } }),
			).toBe(0);
			expect(await nonStageSnapshot(prisma)).toEqual(protectedRows);
			expect(
				await prisma.jellyfinEpisodeObservationStage.findMany({
					where: { runId: { not: "target" } },
					orderBy: { id: "asc" },
				}),
			).toEqual(otherStages);
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target");
			expect(await nonStageSnapshot(prisma)).toEqual(protectedRows);
		},
	);

	it.each([
		{ state: "running" },
		{ state: "failed" },
		{ provider: "emby_episode" },
		{ cacheType: "plex_episode" },
		{ instanceId: "other-instance" },
	])("refuses a nonterminal or differently scoped run at admission: %j", async (overrides) => {
		const prisma = await database();
		await seedRun(prisma, "target", overrides);
		const before = await prisma.jellyfinEpisodeObservationStage.findMany();
		const writes = vi.spyOn(prisma, "$executeRaw");
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target");
		expect(writes).not.toHaveBeenCalled();
		expect(await prisma.jellyfinEpisodeObservationStage.findMany()).toEqual(before);
	});

	it("ignores a missing run", async () => {
		const prisma = await database();
		await seedRun(prisma, "other-run");
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "missing");
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(1);
	});

	it.each([
		{ state: "running" },
		{ provider: "emby_episode" },
		{ cacheType: "plex_episode" },
		{ instanceId: "other-instance" },
	])("rechecks execution-time run authority after admission: %j", async (data) => {
		const prisma = await database();
		await seedRun(prisma, "target");
		const find = prisma.providerObservationRun.findFirst.bind(prisma.providerObservationRun);
		const runs = prisma.providerObservationRun as unknown as {
			findFirst: (...args: unknown[]) => PromiseLike<unknown>;
		};
		vi.spyOn(runs, "findFirst").mockImplementationOnce(async (...args) => {
			const admitted = await Reflect.apply(find, prisma.providerObservationRun, args);
			await prisma.providerObservationRun.update({ where: { id: "target" }, data });
			return admitted;
		});
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target");
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(1);
	});

	it.each([
		["terminal", undefined, 100],
		["published", "sqlite", 100],
		["completed", "postgresql", 5000],
		["published", "postgresql", 5000],
	] as const)(
		"bounds %s cleanup for provider %s, joins cancellation, and resumes",
		async (mode, dbProvider, batchSize) => {
			const prisma = await database();
			await seedRun(prisma, "target", {}, batchSize + 1);
			await seedRun(prisma, "foreign", { instanceId: "other-instance" });
			const controller = new AbortController();
			const reason = new Error("Synthetic stage cleanup cancelled");
			let release!: () => void,
				issued!: () => void,
				settled = false;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const held = new Promise<void>((resolve) => {
				issued = resolve;
			});
			const execute = prisma.$executeRaw.bind(prisma);
			const raw = prisma as unknown as {
				$executeRaw: (...args: unknown[]) => PromiseLike<unknown>;
			};
			const counts: unknown[] = [];
			const spy = vi.spyOn(raw, "$executeRaw").mockImplementation(async (...args) => {
				const count = await Reflect.apply(execute, prisma, args);
				counts.push(count);
				if (counts.length === 1) {
					issued();
					await gate;
				}
				return count;
			});
			const cleanup = () => {
				const options = { dbProvider, signal: controller.signal };
				return mode === "completed"
					? cleanupCompletedJellyfinEpisodeArtifacts(prisma, "instance", options)
					: mode === "published"
						? cleanupPublishedJellyfinEpisodeArtifacts(prisma, "instance", "target", options)
						: cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", options);
			};
			const task = cleanup();
			void task.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await held;
				controller.abort(reason);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				release();
				await expect(task).rejects.toBe(reason);
			} finally {
				release();
				spy.mockRestore();
			}
			expect(counts).toEqual([batchSize]);
			expect(
				await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "target" } }),
			).toBe(1);
			await (mode === "completed"
				? cleanupCompletedJellyfinEpisodeArtifacts(prisma, "instance", { dbProvider })
				: mode === "published"
					? cleanupPublishedJellyfinEpisodeArtifacts(prisma, "instance", "target", { dbProvider })
					: cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", { dbProvider }));
			expect(
				await prisma.jellyfinEpisodeObservationStage.findMany({ select: { runId: true } }),
			).toEqual([{ runId: "foreign" }]);
		},
	);

	it("rejects cancellation before admission and before issuing a delete", async () => {
		const prisma = await database();
		await seedRun(prisma, "target");
		const controller = new AbortController();
		const reason = new Error("Synthetic stage cleanup cancelled");
		controller.abort(reason);
		const find = vi.spyOn(prisma.providerObservationRun, "findFirst");
		const writes = vi.spyOn(prisma, "$executeRaw");
		await expect(
			cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(find).not.toHaveBeenCalled();
		expect(writes).not.toHaveBeenCalled();
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(1);
	});
});
