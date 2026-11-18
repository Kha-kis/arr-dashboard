import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Prisma } from "../../prisma.js";
import {
	cleanupCompletedJellyfinEpisodeArtifacts,
	cleanupPublishedJellyfinEpisodeArtifacts,
	cleanupTerminalJellyfinEpisodeStage,
} from "../jellyfin-native-watch-repository.js";

type TestPrisma = ReturnType<typeof createTestPrismaClient>;
const databases: Array<{ directory: string; prisma: TestPrisma }> = [];
const observedAt = new Date("2026-09-24T12:00:00.000Z");
const schema = new SqliteSchemaFixture();

beforeAll(() => schema.initialize(), 60_000);
afterAll(() => schema.dispose());

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-terminal-stage-"));
	const dbPath = join(directory, "test.db");
	schema.copyTo(dbPath);
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

// Observe only issued DML; completed-cleanup discovery SELECTs must never be held.
function observeDeletes(
	prisma: TestPrisma,
	afterDelete: (result: unknown, parameters: readonly unknown[]) => Promise<unknown>,
) {
	const raw = prisma as unknown as Record<
		"$executeRaw" | "$queryRaw",
		(...args: unknown[]) => PromiseLike<unknown>
	>;
	const spies = (["$executeRaw", "$queryRaw"] as const).map((method) => {
		const execute = raw[method].bind(prisma);
		return vi.spyOn(raw, method).mockImplementation(async (...args) => {
			const result = await Reflect.apply(execute, prisma, args);
			const statement = Array.isArray(args[0])
				? Prisma.sql(args[0], ...args.slice(1))
				: (args[0] as Prisma.Sql);
			return /^\s*DELETE\b/i.test(statement.sql) ? afterDelete(result, statement.values) : result;
		});
	});
	return () => {
		for (const spy of spies) spy.mockRestore();
	};
}

function deletionCount(result: unknown) {
	return Array.isArray(result) ? result.length : result;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("terminal Jellyfin episode stage cleanup", { timeout: 30_000 }, () => {
	it.each([
		["complete", undefined],
		["invalidated", undefined],
		["complete", "sqlite"],
		["invalidated", "sqlite"],
	] as const)(
		"reclaims only the exact %s run stage for %s and preserves every other table",
		async (state, dbProvider) => {
			const prisma = await database();
			await seedRun(prisma, "target", { state });
			await seedRun(prisma, "foreign", { instanceId: "other-instance" });
			await seedProtectedArtifacts(prisma);
			const protectedRows = await nonStageSnapshot(prisma);
			const otherStages = await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: { not: "target" } },
				orderBy: { id: "asc" },
			});
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", { dbProvider });
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
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", { dbProvider });
			expect(await nonStageSnapshot(prisma)).toEqual(protectedRows);
		},
	);

	it.each(
		[undefined, "sqlite"].flatMap((dbProvider) =>
			[
				{ state: "running" },
				{ state: "failed" },
				{ provider: "emby_episode" },
				{ cacheType: "plex_episode" },
				{ instanceId: "other-instance" },
			].map((overrides) => ({ overrides, dbProvider: dbProvider as "sqlite" | undefined })),
		),
	)(
		"refuses a nonterminal or differently scoped run at admission: %j",
		async ({ overrides, dbProvider }) => {
			const prisma = await database();
			await seedRun(prisma, "target", overrides);
			const before = await prisma.jellyfinEpisodeObservationStage.findMany();
			const writes = vi.fn(async (result: unknown) => result);
			const restore = observeDeletes(prisma, writes);
			try {
				await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", { dbProvider });
			} finally {
				restore();
			}
			expect(writes).not.toHaveBeenCalled();
			expect(await prisma.jellyfinEpisodeObservationStage.findMany()).toEqual(before);
		},
	);

	it("ignores a missing run", async () => {
		const prisma = await database();
		await seedRun(prisma, "other-run");
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "missing");
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(1);
	});

	it.each(
		[undefined, "sqlite"].flatMap((dbProvider) =>
			[
				{ state: "running" },
				{ provider: "emby_episode" },
				{ cacheType: "plex_episode" },
				{ instanceId: "other-instance" },
			].map((data) => ({ data, dbProvider: dbProvider as "sqlite" | undefined })),
		),
	)("rechecks execution-time run authority after admission: %j", async ({ data, dbProvider }) => {
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
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", { dbProvider });
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(1);
	});

	it.each([
		["terminal", undefined, 100],
		["terminal", "sqlite", 100],
		["published", "sqlite", 100],
		["completed", "sqlite", 100],
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
			const counts: unknown[] = [];
			const restore = observeDeletes(prisma, async (result) => {
				counts.push(deletionCount(result));
				if (counts.length === 1) {
					issued();
					await gate;
				}
				return result;
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
				restore();
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

	it("uses row order and the maximum acknowledged cursor across foreign prefixes, holes, and signed keys", async () => {
		const prisma = await database();
		await seedRun(prisma, "foreign", { instanceId: "other-instance" }, 128);
		await seedRun(prisma, "active", { state: "running" });
		await seedRun(prisma, "target", {}, 201);
		await prisma.$executeRaw`UPDATE jellyfin_episode_observation_stage SET rowid = rowid * 3 - 1000000`;
		for (let index = 99; index < 201; index++) {
			const id = `target-stage-${index}`;
			// Adjacent inexact-number keys cross the first 100-row boundary.
			const physicalRow =
				index >= 199
					? 9223372036854775807n - BigInt((200 - index) * 2)
					: 9007199254740995n + BigInt(index - 99);
			await prisma.$executeRaw`UPDATE jellyfin_episode_observation_stage SET rowid = ${physicalRow} WHERE id = ${id}`;
		}
		const ordered = await prisma.$queryRaw<Array<{ id: string; physicalRow: string }>>`
			SELECT id, CAST(rowid AS TEXT) AS physicalRow FROM jellyfin_episode_observation_stage
			WHERE runId = 'target' ORDER BY rowid
		`;
		const protectedRows = await prisma.jellyfinEpisodeObservationStage.findMany({
			where: { runId: { not: "target" } },
			orderBy: { id: "asc" },
		});
		const otherTables = await nonStageSnapshot(prisma);
		const counts: unknown[] = [];
		let acknowledgedMaximum: bigint | undefined;
		const restore = observeDeletes(prisma, async (result, parameters) => {
			if (acknowledgedMaximum !== undefined) expect(parameters).toContain(acknowledgedMaximum);
			counts.push(deletionCount(result));
			if (counts.length === 1) {
				const remaining = await prisma.jellyfinEpisodeObservationStage.findMany({
					where: { runId: "target" },
					select: { id: true },
				});
				expect(remaining.map(({ id }) => id).sort()).toEqual(
					ordered
						.slice(100)
						.map(({ id }) => id)
						.sort(),
				);
			}
			if (!Array.isArray(result)) return result;
			if (result.length > 0) {
				acknowledgedMaximum = result.reduce<bigint>(
					(maximum, row: { physicalRow: bigint | number | string }) =>
						BigInt(row.physicalRow) > maximum ? BigInt(row.physicalRow) : maximum,
					BigInt(result[0].physicalRow),
				);
			}
			// Driver acknowledgements need not preserve SELECT/RETURNING order.
			return result
				.map((row: { physicalRow: bigint | number | string }, index) => ({
					physicalRow: Number.isSafeInteger(Number(row.physicalRow))
						? Number(row.physicalRow)
						: index === 0
							? BigInt(row.physicalRow)
							: row.physicalRow,
				}))
				.reverse();
		});
		try {
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
				dbProvider: "sqlite",
			});
		} finally {
			restore();
		}
		expect(counts).toEqual([100, 100, 1, 0]);
		expect(
			await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: "target" },
				select: { id: true },
			}),
		).toEqual([]);
		expect(
			await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: { not: "target" } },
				orderBy: { id: "asc" },
			}),
		).toEqual(protectedRows);
		expect(await nonStageSnapshot(prisma)).toEqual(otherTables);
	});

	it("reports a failed acknowledgement after committed SQLite progress and retries the remainder", async () => {
		const prisma = await database();
		await seedRun(prisma, "target", {}, 101);
		await seedRun(prisma, "foreign", { instanceId: "other-instance" });
		const failure = new Error("Synthetic acknowledgement failure");
		const counts: unknown[] = [];
		const restore = observeDeletes(prisma, async (result) => {
			counts.push(deletionCount(result));
			throw failure;
		});
		try {
			await expect(
				cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
					dbProvider: "sqlite",
				}),
			).rejects.toBe(failure);
		} finally {
			restore();
		}
		expect(counts).toEqual([100]);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "target" } })).toBe(
			1,
		);
		await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
			dbProvider: "sqlite",
		});
		expect(
			await prisma.jellyfinEpisodeObservationStage.findMany({ select: { runId: true } }),
		).toEqual([{ runId: "foreign" }]);
	});

	it.each([
		["non-array", null],
		["missing key", [{}]],
		["duplicate", [{ physicalRow: 1n }, { physicalRow: 1n }]],
		["unsafe number", [{ physicalRow: Number.MAX_SAFE_INTEGER + 1 }]],
		["negative zero string", [{ physicalRow: "-0" }]],
		["leading zero string", [{ physicalRow: "01" }]],
		["leading plus string", [{ physicalRow: "+1" }]],
		["fractional string", [{ physicalRow: "1.5" }]],
		["whitespace string", [{ physicalRow: " 1" }]],
		["overlong string", [{ physicalRow: "100000000000000000000" }]],
		["string above signed range", [{ physicalRow: "9223372036854775808" }]],
		["above signed range", [{ physicalRow: 1n << 63n }]],
		["below signed range", [{ physicalRow: -(1n << 63n) - 1n }]],
		["oversized batch", Array.from({ length: 101 }, (_, physicalRow) => ({ physicalRow }))],
	] as const)(
		"rejects a %s SQLite acknowledgement without claiming rollback",
		async (_, malformed) => {
			const prisma = await database();
			await seedRun(prisma, "target", {}, 101);
			let issued = 0;
			const restore = observeDeletes(prisma, async () => {
				issued++;
				return malformed;
			});
			try {
				await expect(
					cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
						dbProvider: "sqlite",
					}),
				).rejects.toThrow("Invalid SQLite stage cleanup acknowledgement");
			} finally {
				restore();
			}
			expect(issued).toBe(1);
			expect(
				await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "target" } }),
			).toBe(1);
			await cleanupTerminalJellyfinEpisodeStage(prisma, "instance", "target", {
				dbProvider: "sqlite",
			});
			expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(0);
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
