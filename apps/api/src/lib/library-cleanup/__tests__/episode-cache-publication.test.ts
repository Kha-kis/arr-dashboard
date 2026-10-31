import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { buildSeriesItem } from "../../library/series-normalizer.js";
import {
	EPISODE_CACHE_PUBLICATION_WARNING,
	publishSonarrEpisodeDeletion,
} from "../episode-cache-publication.js";
import { createArrServiceFingerprint } from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "episode-publication-")),
		database = join(directory, "owned.db");
	new Database(database).close();
	await synchronizeRuntimeSchema(`file:${database}`);
	const runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
	await runtime.bindDestination("synthetic-episode-publication");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime),
		prisma = native.prisma;
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	await run(async () => {
		for (const id of ["owner", "foreign"]) await prisma.user.create({ data: { id, username: id } });
	});
	const instance = await run(() =>
		prisma.serviceInstance.create({
			data: {
				id: "sonarr",
				userId: "owner",
				service: "SONARR",
				label: "Private label",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "secret",
				encryptionIv: "iv",
			},
		}),
	);
	const foreign = await run(() =>
		prisma.serviceInstance.create({
			data: {
				id: "foreign",
				userId: "foreign",
				service: "SONARR",
				label: "Private label",
				baseUrl: instance.baseUrl,
				encryptedApiKey: "secret",
				encryptionIv: "iv",
			},
		}),
	);
	const series = {
		id: 41,
		tvdbId: 99,
		title: "Private title",
		path: "/tv/show",
		monitored: false,
		statistics: { sizeOnDisk: 3000, episodeFileCount: 1, totalEpisodeCount: 4, episodeCount: 4 },
		seasons: [
			{
				seasonNumber: 1,
				monitored: false,
				statistics: { sizeOnDisk: 3000, episodeFileCount: 1, totalEpisodeCount: 4 },
			},
		],
	};
	const files = [
		{ id: 62, seriesId: 41, seasonNumber: 1, path: "/tv/show/retained.mkv", size: 3000 },
	];
	const prior = {
		...buildSeriesItem(instance, "sonarr", series),
		title: "Preserved title",
		monitored: true,
		hasFile: true,
		sizeOnDisk: 5000,
		_arrDashboardSource: {
			serviceFingerprint: createArrServiceFingerprint(instance),
			witness: "preserve",
		},
		tags: [2, 7],
		custom: { untouched: true },
		statistics: { episodeFileCount: 2, totalEpisodeCount: 4, extra: "keep" },
		seasons: [
			{
				seasonNumber: 1,
				monitored: true,
				title: "Keep season",
				episodeCount: 4,
				episodeFileCount: 2,
				missingEpisodeCount: 2,
			},
		],
	};
	await run(async () => {
		for (const inst of [instance, foreign]) {
			await prisma.libraryCache.create({
				data: {
					id: inst.id,
					instanceId: inst.id,
					arrItemId: 41,
					itemType: "series",
					title: "Preserved title",
					monitored: true,
					hasFile: true,
					sizeOnDisk: 5000n,
					data: JSON.stringify(prior),
				},
			});
			for (const id of [61, 62])
				await prisma.episodeFileCache.create({
					data: {
						id: `${inst.id}-${id}`,
						instanceId: inst.id,
						arrSeriesId: 41,
						arrEpisodeFileId: id,
						seasonNumber: 1,
						path: `/tv/show/${id}.mkv`,
						relativePath: `${id}.mkv`,
						size: id === 61 ? 2000n : 3000n,
					},
				});
		}
	});
	const before = await run(() =>
		prisma.libraryCache.findUniqueOrThrow({ where: { id: instance.id } }),
	);
	const client = {
		series: { getById: vi.fn(async () => series) },
		episodeFile: { getBySeries: vi.fn(async () => files) },
	};
	const log = { warn: vi.fn() } as unknown as CleanupExecutorDeps["log"];
	const options = {
		prisma,
		log,
		arrClientFactory: {
			createSonarrClient: vi.fn(() => client),
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		instance,
		arrItemId: 41,
		plan: {
			kind: "verified_sonarr_episode",
			target: {
				serviceFingerprint: createArrServiceFingerprint(instance),
				externalId: 99,
				mediaPath: { value: "/tv/show", windows: false },
			},
			selectedFile: { episodeFileId: 61 },
		} as Parameters<typeof publishSonarrEpisodeDeletion>[0]["plan"],
		deletedFileIds: [61],
	};
	return {
		directory,
		database,
		native,
		runtime,
		prisma,
		run,
		options,
		client,
		files,
		series,
		before,
		prior,
		instance,
		publish: () => run(() => publishSonarrEpisodeDeletion(options)),
		row: () => run(() => prisma.libraryCache.findUniqueOrThrow({ where: { id: instance.id } })),
		selected: () => run(() => prisma.episodeFileCache.findUnique({ where: { id: "sonarr-61" } })),
		async close() {
			await native.close();
			await runtime.close();
			const db = new Database(database, { readonly: true });
			const integrity = db.pragma("quick_check", { simple: true });
			db.close();
			expect(integrity).toBe("ok");
			await rm(directory, { recursive: true });
		},
	};
}
describe("episode deletion cache publication on actual native transactions", () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	beforeEach(async () => {
		f = await fixture();
	});
	afterEach(async () => {
		await f?.close();
	});
	it("atomically publishes observed flat/JSON facts while preserving unrelated state and foreign rows", async () => {
		const foreign = await f.run(() =>
			f.prisma.libraryCache.findUniqueOrThrow({ where: { id: "foreign" } }),
		);
		expect(await f.publish()).toEqual({ published: true });
		const row = await f.row();
		expect(row).toMatchObject({
			hasFile: true,
			sizeOnDisk: 3000n,
			monitored: true,
			cachedAt: f.before.cachedAt,
		});
		expect(JSON.parse(row.data)).toMatchObject({
			...JSON.parse(JSON.stringify(f.prior)),
			sizeOnDisk: 3000,
			statistics: { ...f.prior.statistics, episodeFileCount: 1 },
			seasons: [{ ...f.prior.seasons[0], episodeFileCount: 1, missingEpisodeCount: 3 }],
		});
		expect(await f.selected()).toBeNull();
		expect(
			await f.run(() => f.prisma.libraryCache.findUniqueOrThrow({ where: { id: "foreign" } })),
		).toEqual(foreign);
		expect(await f.run(() => f.prisma.episodeFileCache.count())).toBe(3);
	});
	it("publishes complete consistent empty observations as zero", async () => {
		f.files.length = 0;
		f.series.statistics.sizeOnDisk = 0;
		f.series.statistics.episodeFileCount = 0;
		Object.assign(f.series.seasons[0]!.statistics, { sizeOnDisk: 0, episodeFileCount: 0 });
		expect(await f.publish()).toEqual({ published: true });
		expect(await f.row()).toMatchObject({ hasFile: false, sizeOnDisk: 0n });
		expect(JSON.parse((await f.row()).data)).toMatchObject({
			hasFile: false,
			sizeOnDisk: 0,
			statistics: { episodeFileCount: 0 },
		});
		// Only independently confirmed selected file is removed; no claim over retained native inventory.
		expect(
			await f.run(() => f.prisma.episodeFileCache.findUnique({ where: { id: "sonarr-62" } })),
		).not.toBeNull();
	});
	it("uses provider totals despite incomplete native inventory", async () => {
		await f.run(() => f.prisma.episodeFileCache.deleteMany({ where: { id: "sonarr-62" } }));
		expect(await f.publish()).toEqual({ published: true });
		expect((await f.row()).sizeOnDisk).toBe(3000n);
	});
	it("does not equate physical file cardinality with episode-file statistics", async () => {
		f.series.statistics.episodeFileCount = 2;
		f.series.seasons[0]!.statistics.episodeFileCount = 2;
		expect(await f.publish()).toEqual({ published: true });
		expect(JSON.parse((await f.row()).data).statistics.episodeFileCount).toBe(2);
	});
	it("preserves monitoring and metadata across specials and multiple seasons", async () => {
		f.files.push({
			id: 63,
			seriesId: 41,
			seasonNumber: 2,
			path: "/tv/show/season-two.mkv",
			size: 500,
		});
		Object.assign(f.series.statistics, {
			sizeOnDisk: 3500,
			episodeFileCount: 3,
			totalEpisodeCount: 12,
		});
		f.series.seasons.push(
			{
				seasonNumber: 0,
				monitored: false,
				statistics: { sizeOnDisk: 0, episodeFileCount: 0, totalEpisodeCount: 2 },
			},
			{
				seasonNumber: 2,
				monitored: true,
				statistics: { sizeOnDisk: 500, episodeFileCount: 2, totalEpisodeCount: 6 },
			},
		);
		await f.run(() =>
			f.prisma.libraryCache.update({
				where: { id: "sonarr" },
				data: {
					data: JSON.stringify({
						...f.prior,
						statistics: { ...f.prior.statistics, totalEpisodeCount: 12 },
						seasons: [
							...f.prior.seasons,
							{ seasonNumber: 0, monitored: true, episodeCount: 2, title: "Specials retained" },
							{ seasonNumber: 2, monitored: false, episodeCount: 6, title: "Season retained" },
						],
					}),
				},
			}),
		);
		expect(await f.publish()).toEqual({ published: true });
		expect(JSON.parse((await f.row()).data).seasons).toEqual([
			{ ...f.prior.seasons[0], episodeFileCount: 1, missingEpisodeCount: 3 },
			{
				seasonNumber: 0,
				monitored: true,
				episodeCount: 2,
				title: "Specials retained",
				episodeFileCount: 0,
				missingEpisodeCount: 2,
			},
			{
				seasonNumber: 2,
				monitored: false,
				episodeCount: 6,
				title: "Season retained",
				episodeFileCount: 2,
				missingEpisodeCount: 0,
			},
		]);
	});
	it.each(["projection", "source", "owner"] as const)(
		"refuses an in-flight %s change without deleting native rows",
		async (kind) => {
			f.client.episodeFile.getBySeries.mockImplementationOnce(async () => {
				if (kind === "projection")
					await f.prisma.libraryCache.update({
						where: { id: "sonarr" },
						data: { data: JSON.stringify({ newer: true }) },
					});
				else
					await f.prisma.serviceInstance.update({
						where: { id: "sonarr" },
						data: kind === "source" ? { encryptedApiKey: "rotated" } : { userId: "foreign" },
					});
				return f.files;
			});
			expect(await f.publish()).toEqual({
				published: false,
				warning: EPISODE_CACHE_PUBLICATION_WARNING,
			});
			expect(await f.selected()).not.toBeNull();
			if (kind === "projection") expect(JSON.parse((await f.row()).data)).toEqual({ newer: true });
			else expect((await f.row()).data).toBe(f.before.data);
		},
	);
	it("rolls back parent publication when native selected-row deletion fails", async () => {
		const db = new Database(f.database);
		db.exec(
			"CREATE TRIGGER reject_selected BEFORE DELETE ON episode_file_cache WHEN OLD.id='sonarr-61' BEGIN SELECT RAISE(ABORT, 'synthetic abort'); END;",
		);
		db.close();
		expect(await f.publish()).toEqual({
			published: false,
			warning: EPISODE_CACHE_PUBLICATION_WARNING,
		});
		expect(await f.row()).toEqual(f.before);
		expect(await f.selected()).not.toBeNull();
	});
	it.each([
		"missing-stats",
		"negative-size",
		"duplicate-file",
		"wrong-series",
		"missing-season",
		"inconsistent-size",
		"inconsistent-count",
		"missing-season-total",
		"selected-present",
		"bad-path",
		"wrong-tvdb",
		"wrong-path",
		"bad-cache",
		"bad-witness",
		"missing-cache",
		"read-error",
	])("warns without partial native publication for %s", async (kind) => {
		const raw = f.series as unknown as Record<string, any>;
		if (kind === "missing-stats") delete raw.statistics;
		if (kind === "negative-size") raw.statistics.sizeOnDisk = -1;
		if (kind === "duplicate-file") f.files.push({ ...f.files[0]! });
		if (kind === "wrong-series") f.files[0]!.seriesId = 42;
		if (kind === "missing-season") raw.seasons = [];
		if (kind === "inconsistent-size") raw.statistics.sizeOnDisk = 0;
		if (kind === "inconsistent-count") raw.statistics.episodeFileCount = 0;
		if (kind === "missing-season-total") delete raw.seasons[0].statistics.totalEpisodeCount;
		if (kind === "selected-present") f.files[0]!.id = 61;
		if (kind === "bad-path") f.files[0]!.path = "relative.mkv";
		if (kind === "wrong-tvdb") raw.tvdbId = 100;
		if (kind === "wrong-path") raw.path = "/tv/replacement";
		if (kind === "bad-cache" || kind === "bad-witness")
			await f.run(() =>
				f.prisma.libraryCache.update({
					where: { id: "sonarr" },
					data: {
						data:
							kind === "bad-cache" ? "{" : JSON.stringify({ ...f.prior, _arrDashboardSource: {} }),
					},
				}),
			);
		if (kind === "missing-cache")
			await f.run(() => f.prisma.libraryCache.delete({ where: { id: "sonarr" } }));
		if (kind === "read-error")
			f.client.series.getById.mockRejectedValueOnce(new Error("PRIVATE provider body secret"));
		const before = await f.run(() => f.prisma.libraryCache.findUnique({ where: { id: "sonarr" } }));
		expect(await f.publish()).toEqual({
			published: false,
			warning: EPISODE_CACHE_PUBLICATION_WARNING,
		});
		expect(
			await f.run(() => f.prisma.libraryCache.findUnique({ where: { id: "sonarr" } })),
		).toEqual(before);
		expect(await f.selected()).not.toBeNull();
		expect(JSON.stringify(vi.mocked(f.options.log.warn).mock.calls)).not.toMatch(
			/PRIVATE|secret|synthetic.invalid|Private title/,
		);
	});
});
