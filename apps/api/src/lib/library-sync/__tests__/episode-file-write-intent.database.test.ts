import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { runEpisodeFileSync } from "../episode-file-backfill.js";
import {
	createEpisodeFileInventoryReceipt,
	hasCompleteEpisodeFileInventory,
} from "../episode-file-coverage.js";

afterEach(closeScopedWriteFixtures);

async function fixture() {
	const f = await createScopedWriteFixture();
	const cachedAt = new Date("2026-01-01T00:00:00.000Z");
	for (const id of ["synthetic-sonarr", "synthetic-neighbor"]) {
		const instance = await f.plain.serviceInstance.create({
			data: {
				id,
				userId: "synthetic-user",
				service: "SONARR",
				label: "Synthetic",
				baseUrl: "https://synthetic.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
			},
		});
		await f.plain.libraryCache.create({
			data: {
				id: `${id}-series`,
				instanceId: id,
				arrItemId: 1,
				itemType: "series",
				title: "Synthetic same title",
				hasFile: true,
				data: JSON.stringify({
					statistics: { episodeFileCount: 2 },
					sizeOnDisk: 2,
					_arrDashboardSource: { serviceFingerprint: createArrServiceFingerprint(instance) },
				}),
				cachedAt,
				episodeFileInventoryReceipt: createEpisodeFileInventoryReceipt(
					cachedAt,
					[10, 11].map((id) => ({
						arrEpisodeFileId: id,
						path: `/synthetic/old-${id}.mkv`,
						size: 1n,
					})),
					{ episodeWithFileCount: 2, sizeOnDisk: 2n },
				),
			},
		});
		for (const fileId of [10, 11]) {
			await f.plain.episodeFileCache.create({
				data: {
					instanceId: id,
					arrSeriesId: 1,
					arrEpisodeFileId: fileId,
					seasonNumber: 1,
					relativePath: `old-${fileId}.mkv`,
					path: `/synthetic/old-${fileId}.mkv`,
					size: 1n,
					infoHash: "synthetic-old-hash",
					infoHashSource: "inode-v2",
				},
			});
		}
	}
	let afterProviderReads: (() => void) | undefined;
	let providerReads = 0;
	let lastProviderReadAt = 0;
	const providerRead = () => {
		// An actual independent writer can commit during every provider request.
		// This fails if either write transaction leaks across provider I/O.
		f.writer.exec("BEGIN IMMEDIATE;UPDATE CompetitionProbe SET value=value+1 WHERE id=1;COMMIT");
		providerReads++;
		lastProviderReadAt = Date.now();
	};
	const getSeries = vi.fn(async () => {
		providerRead();
		return { id: 1, statistics: { episodeFileCount: 2, sizeOnDisk: 2 } };
	});
	const getFiles = vi.fn(async () => {
		providerRead();
		if (providerReads === 4) afterProviderReads?.();
		return [
			{
				id: 10,
				seriesId: 1,
				seasonNumber: 1,
				relativePath: "current.mkv",
				path: "/synthetic/current.mkv",
				size: 2,
			},
		];
	});
	const app = {
		prisma: f.client.prisma,
		arrClientFactory: {
			create: () => ({ series: { getById: getSeries }, episodeFile: { getAll: getFiles } }),
		},
	} as unknown as FastifyInstance;
	return {
		...f,
		getSeries,
		getFiles,
		lastProviderReadAt: () => lastProviderReadAt,
		armPublication(action: () => void) {
			afterProviderReads = action;
		},
		run() {
			return f.runtime.runOperation(() =>
				runEpisodeFileSync({
					app,
					seriesCap: 1,
					retrySeriesIds: ["synthetic-sonarr-series"],
				}),
			);
		},
		async neighbors() {
			return {
				series: await f.plain.libraryCache.findMany({
					where: { instanceId: "synthetic-neighbor" },
				}),
				files: await f.plain.episodeFileCache.findMany({
					where: { instanceId: "synthetic-neighbor" },
					orderBy: { arrEpisodeFileId: "asc" },
				}),
			};
		},
	};
}

async function expectPublished(f: Awaited<ReturnType<typeof fixture>>) {
	const series = await f.plain.libraryCache.findUniqueOrThrow({
		where: { id: "synthetic-sonarr-series" },
	});
	const files = await f.plain.episodeFileCache.findMany({
		where: { instanceId: "synthetic-sonarr", arrSeriesId: 1 },
	});
	expect(series.episodeFileInventoryAttemptToken).toBeNull();
	const receipt = JSON.parse(series.episodeFileInventoryReceipt!);
	expect(receipt).toMatchObject({
		v: 3,
		sourceFingerprint: expect.any(String),
		seriesContentDigest: expect.any(String),
	});
	expect(Date.parse(receipt.observedAt)).toBeGreaterThanOrEqual(f.lastProviderReadAt());
	expect(receipt.seriesContentDigest).toBe(createHash("sha256").update(series.data).digest("hex"));
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({
		where: { id: series.instanceId },
	});
	expect(receipt.sourceFingerprint).toBe(createArrServiceFingerprint(instance));
	expect(Date.parse(receipt.observedAt)).toBeLessThanOrEqual(Date.now());
	expect(
		hasCompleteEpisodeFileInventory(
			series.episodeFileInventoryReceipt,
			new Date(series.cachedAt.getTime() + 1),
			files,
		),
	).toBe(false);
	expect(
		hasCompleteEpisodeFileInventory(series.episodeFileInventoryReceipt, series.cachedAt, files),
	).toBe(true);
	expect(files).toMatchObject([
		{ arrEpisodeFileId: 10, path: "/synthetic/current.mkv", size: 2n, infoHash: null },
	]);
}

describe("Sonarr episode metadata write admission", { timeout: 30_000 }, () => {
	it.each([null, {}, { serviceFingerprint: "changed-source" }])(
		"refuses present invalid provenance without pruning: %j",
		async (marker) => {
			const f = await fixture();
			await f.plain.libraryCache.update({
				where: { id: "synthetic-sonarr-series" },
				data: {
					data: JSON.stringify({
						statistics: { episodeFileCount: 2 },
						sizeOnDisk: 2,
						_arrDashboardSource: marker,
					}),
				},
			});
			const before = await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } });
			const result = await f.run();
			expect(result).toMatchObject({ errors: 1, filesUpserted: 0, filesDeleted: 0 });
			expect(await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } })).toEqual(before);
			expect(
				await f.plain.libraryCache.findUniqueOrThrow({ where: { id: "synthetic-sonarr-series" } }),
			).toMatchObject({ episodeFileInventoryReceipt: null });
		},
	);

	it("keeps absent historical source provenance on v2 without inventing an observation time", async () => {
		const f = await fixture();
		await f.plain.libraryCache.update({
			where: { id: "synthetic-sonarr-series" },
			data: { data: JSON.stringify({ statistics: { episodeFileCount: 2 }, sizeOnDisk: 2 }) },
		});
		expect(await f.run()).toMatchObject({ errors: 0, filesUpserted: 1, filesDeleted: 1 });
		const row = await f.plain.libraryCache.findUniqueOrThrow({
			where: { id: "synthetic-sonarr-series" },
		});
		const receipt = JSON.parse(row.episodeFileInventoryReceipt!);
		expect(receipt.v).toBe(2);
		expect(receipt).not.toHaveProperty("observedAt");
	});

	for (const phase of ["invalidation", "publication"] as const) {
		// Both boundaries must reserve before the guard pins its WAL snapshot.
		// Publication is armed only after invalidation and all provider reads.
		it(`publishes once despite a competing commit at ${phase}`, async () => {
			const f = await fixture();
			const protectedRows = snapshotProtectedRows(f);
			const neighbors = await f.neighbors();
			let competition: ReturnType<typeof interceptScopedWriteCompetition> | undefined;
			const arm = () => {
				competition = interceptScopedWriteCompetition(f, { compete: true });
			};
			if (phase === "invalidation") arm();
			else f.armPublication(arm);
			const result = await f.run();
			recordScopedWriteEvidence(`episode-${phase}-competition`, { result, competition });
			expect(result, JSON.stringify(competition)).toMatchObject({
				seriesScanned: 1,
				filesUpserted: 1,
				filesDeleted: 1,
				errors: 0,
				attemptedSeriesIds: ["synthetic-sonarr-series"],
				failedSeriesIds: [],
			});
			expect(competition).toMatchObject({
				reservations: phase === "invalidation" ? 2 : 1,
				commits: 0,
				blocked: 1,
				rollbacks: 0,
				nativeErrors: [],
			});
			expect(f.getSeries).toHaveBeenCalledTimes(2);
			expect(f.getFiles).toHaveBeenCalledTimes(2);
			await expectPublished(f);
			expect(await f.neighbors()).toEqual(neighbors);
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			expect(f.losses).toEqual([]);
		});

		it(`conserves cached files when a writer refuses ${phase} and recovers on a fresh invocation`, async () => {
			const f = await fixture();
			const protectedRows = snapshotProtectedRows(f);
			const neighbors = await f.neighbors();
			const beforeSeries = await f.plain.libraryCache.findMany({ orderBy: { id: "asc" } });
			const beforeFiles = await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } });
			let competition: ReturnType<typeof interceptScopedWriteCompetition> | undefined;
			const arm = () => {
				competition = interceptScopedWriteCompetition(f, { holdBeforeReservation: true });
			};
			if (phase === "invalidation") arm();
			else f.armPublication(arm);
			const failed = await f.run();
			expect(failed).toMatchObject({
				errors: 1,
				filesUpserted: 0,
				filesDeleted: 0,
				failedSeriesIds: ["synthetic-sonarr-series"],
			});
			expect(failed.durationMs).toBeLessThan(5_000);
			expect(competition).toMatchObject({ reservations: 0, rollbacks: 1 });
			expect(competition?.nativeErrors).toContain("SQLITE_BUSY");
			expect(f.getSeries).toHaveBeenCalledTimes(phase === "invalidation" ? 0 : 2);
			expect(f.getFiles).toHaveBeenCalledTimes(phase === "invalidation" ? 0 : 2);
			expect(await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } })).toEqual(
				beforeFiles,
			);
			if (phase === "invalidation") {
				expect(await f.plain.libraryCache.findMany({ orderBy: { id: "asc" } })).toEqual(
					beforeSeries,
				);
			} else {
				expect(
					await f.plain.libraryCache.findUniqueOrThrow({
						where: { id: "synthetic-sonarr-series" },
					}),
				).toMatchObject({
					episodeFileInventoryReceipt: null,
					episodeFileInventoryAttemptToken: expect.any(String),
				});
			}
			f.writer.exec("ROLLBACK");
			const recovered = await f.run();
			expect(recovered).toMatchObject({ errors: 0, filesUpserted: 1, filesDeleted: 1 });
			expect(competition?.reservations).toBe(2);
			await expectPublished(f);
			expect(await f.neighbors()).toEqual(neighbors);
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			expect(f.losses).toEqual([]);
			recordScopedWriteEvidence(`episode-${phase}-refused-then-recovered`, {
				failed,
				recovered,
				competition,
			});
		});
	}

	it("rolls back the receipt and file effects without replaying an entered publication", async () => {
		const f = await fixture();
		const beforeFiles = await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } });
		const neighbors = await f.neighbors();
		const protectedRows = snapshotProtectedRows(f);
		f.writer.exec(`CREATE TRIGGER reject_episode_reap BEFORE DELETE ON episode_file_cache
			WHEN OLD.instanceId='synthetic-sonarr' AND OLD.arrEpisodeFileId=11
			BEGIN SELECT RAISE(ABORT,'Synthetic publication refusal'); END`);
		const competition = interceptScopedWriteCompetition(f);
		let fileWrites = 0;
		const prepare = vi.mocked(Database.prototype.prepare).getMockImplementation()!;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (
				this === f.writer ||
				this.name !== f.path ||
				!sql.startsWith("INSERT INTO `main`.`episode_file_cache`")
			)
				return statement;
			for (const method of ["all", "run"] as const) {
				const invoke = statement[method];
				Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
					fileWrites++;
					return Reflect.apply(invoke, this, args);
				});
			}
			return statement;
		});
		const failed = await f.run();
		expect(failed).toMatchObject({ errors: 1, filesUpserted: 0, filesDeleted: 0 });
		expect(fileWrites).toBe(1);
		expect(competition).toMatchObject({ reservations: 2, rollbacks: 1 });
		expect(f.getSeries).toHaveBeenCalledTimes(2);
		expect(f.getFiles).toHaveBeenCalledTimes(2);
		expect(await f.plain.episodeFileCache.findMany({ orderBy: { id: "asc" } })).toEqual(
			beforeFiles,
		);
		expect(
			await f.plain.libraryCache.findUniqueOrThrow({ where: { id: "synthetic-sonarr-series" } }),
		).toMatchObject({
			episodeFileInventoryReceipt: null,
			episodeFileInventoryAttemptToken: expect.any(String),
		});
		expect(await f.neighbors()).toEqual(neighbors);
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("episode-entered-publication-rollback", {
			failed,
			competition,
			fileWrites,
		});
	});
});
