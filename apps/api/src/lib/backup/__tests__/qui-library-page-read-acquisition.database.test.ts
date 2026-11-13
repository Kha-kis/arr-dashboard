import fastifyCookie from "@fastify/cookie";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../../config/env.js";
import { registerLibraryRoutes } from "../../../routes/qui/library-routes.js";
import { registerSessionValidationHook } from "../../../server.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { SessionService } from "../../auth/session.js";
import { createEpisodeFileInventoryReceipt } from "../../library-sync/episode-file-coverage.js";
import { createRuntimeSessionMetadataPrismaClient } from "../restore-runtime-client.js";

// Only external filesystem/provider work is synthetic. Session signing,
// runtime admission, ownership joins and every SQL statement remain real.
const external = vi.hoisted(() => ({ paths: [] as string[], ordinary: undefined as unknown }));
vi.mock("../../library-sync/infohash-backfill-by-inode.js", () => ({
	buildFileIdIndex: async (
		_client: unknown,
		_instance: unknown,
		_log: unknown,
		prisma: unknown,
	) => {
		expect(prisma).toBe(external.ordinary);
		return {
			byFileId: new Map(),
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
		};
	},
	getAllHashesForFileIdWithPathEvidence: async (path: string) => {
		external.paths.push(path);
		return { hashes: [path], pathVerified: true, correlationComplete: true };
	},
}));
vi.mock("../../qui/client-factory.js", () => ({
	createQuiClient: () => ({
		getTorrentByHash: async () => ({ instanceId: 1 }),
		getTrackers: async () => [{ url: "https://tracker.invalid/announce" }],
	}),
}));
vi.mock("../../qui/torrent-list-cache.js", () => ({ getCachedAllTorrents: async () => [] }));

afterEach(closeScopedWriteFixtures);

type Item = { arrInstanceId: string; itemId: number; itemType: "movie" | "series" };
const cachedAt = new Date("2026-01-02T00:00:00.000Z");

async function seedSources(f: ScopedWriteFixture) {
	await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
	await f.plain.serviceInstance.createMany({
		data: [
			["arr-a", "synthetic-user", "RADARR"],
			["arr-b", "synthetic-user", "SONARR"],
			["foreign-arr", "foreign-user", "SONARR"],
			["qui", "synthetic-user", "QUI"],
		].map(([id, userId, service]) => ({
			id: id!,
			userId: userId!,
			service: service as "RADARR" | "SONARR" | "QUI",
			label: "Synthetic",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic",
			encryptionIv: "synthetic",
			hasLocalFilesystemAccess: service === "QUI",
		})),
	});
}

async function seedItems(f: ScopedWriteFixture, items: Item[]) {
	for (const item of items) {
		const key = `${item.arrInstanceId}|${item.itemType}:${item.itemId}`;
		const files = [
			{ arrEpisodeFileId: item.itemId * 2, path: `/${key}/a.mkv`, size: 100n },
			{ arrEpisodeFileId: item.itemId * 2 + 1, path: `/${key}/b.mkv`, size: 200n },
		];
		await f.plain.libraryCache.create({
			data: {
				id: key,
				instanceId: item.arrInstanceId,
				arrItemId: item.itemId,
				itemType: item.itemType,
				title: "Same title",
				cachedAt,
				data: JSON.stringify({ path: `/${key}///`, movieFile: { relativePath: "movie.mkv" } }),
				episodeFileInventoryReceipt:
					item.itemType === "series"
						? createEpisodeFileInventoryReceipt(cachedAt, files, {
								episodeWithFileCount: 3,
								sizeOnDisk: 300n,
							})
						: null,
			},
		});
		if (item.itemType === "series")
			await f.plain.episodeFileCache.createMany({
				data: files.map((file) => ({
					...file,
					instanceId: item.arrInstanceId,
					arrSeriesId: item.itemId,
					seasonNumber: 1,
					relativePath: "synthetic.mkv",
				})),
			});
	}
}

async function createApp(f: ScopedWriteFixture) {
	external.paths = [];
	external.ordinary = f.client.prisma;
	const app = Fastify({ logger: false });
	const env = envSchema.parse({ NODE_ENV: "test", DATABASE_URL: `file:${f.path}` });
	const metadata = createRuntimeSessionMetadataPrismaClient(f.runtime);
	const sessions = new SessionService(f.client.prisma, env, app.log, metadata.prisma);
	const session = await f.runtime.runOperation(() => sessions.createSession("synthetic-user"));
	app.decorate("prisma", f.client.prisma);
	app.decorate("restoreRuntime", f.runtime);
	app.decorate("sessionService", sessions);
	await app.register(fastifyCookie, { secret: "synthetic-signing-secret".repeat(2) });
	registerSessionValidationHook(app);
	await app.register(registerLibraryRoutes);
	app.addHook("onClose", async () => {
		await sessions.drainValidations();
		await metadata.close();
	});
	await app.ready();
	return {
		app,
		request: (items: Item[]) =>
			f.runtime.runOperation(() =>
				app.inject({
					method: "POST",
					url: "/qui/library-seeding-summary",
					cookies: { arr_session: app.signCookie(session.token) },
					payload: { items },
				}),
			),
	};
}

function observePathSelects(f: ScopedWriteFixture) {
	const queries: string[] = [];
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (
			this.name === f.path &&
			/^SELECT\b/i.test(sql) &&
			(sql.includes("episode_file_cache") ||
				(sql.includes("library_cache") && sql.includes("data")))
		) {
			const all = statement.all;
			statement.all = function (...args: unknown[]) {
				queries.push(sql);
				return Reflect.apply(all, this, args);
			};
		}
		return statement;
	});
	return queries;
}

describe("qUI full-page cached path SELECT acquisition", { timeout: 30_000 }, () => {
	// Break caught: restoring a per-item SELECT loop amplifies guarded native
	// queries from two sets to an entire page, even on a leased read connection.
	it.each([50, 500])("uses two path SELECTs for a populated mixed page of %i", async (size) => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await seedSources(f);
		const items: Item[] = Array.from({ length: size }, (_, index) => ({
			arrInstanceId: index % 4 < 2 ? "arr-b" : "arr-a",
			itemId: Math.floor(index / 2) + 1,
			itemType: index % 2 === 0 ? "series" : "movie",
		}));
		await seedItems(f, items);
		const { app, request } = await createApp(f);
		let release = () => {};
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rollback = new Error("synthetic-page-publication-rollback");
		const publication = f.runtime
			.runOperation(() =>
				f.client.prisma.$transaction(
					async (tx) => {
						await tx.libraryCache.update({ where: { id: "arr-b|movie:1" }, data: { data: "{}" } });
						await tx.episodeFileCache.updateMany({
							where: { instanceId: "arr-b", arrSeriesId: 1 },
							data: { path: "/uncommitted" },
						});
						entered();
						await held;
						throw rollback;
					},
					{ timeout: 20_000 },
				),
			)
			.catch((error: unknown) => error);
		try {
			await started;
			const queries = observePathSelects(f);
			const response = await request(items);
			expect(response.statusCode, response.body).toBe(200);
			const result = response.json();
			expect(result.status).toBe("available");
			expect(Object.keys(result.summaries)).toEqual(
				items.map((item) => `${item.arrInstanceId}|${item.itemType}:${item.itemId}`),
			);
			for (const item of items)
				expect(result.summaries[`${item.arrInstanceId}|${item.itemType}:${item.itemId}`]).toEqual({
					trackerCount: 1,
					topHosts: ["tracker.invalid"],
					hashCount: item.itemType === "series" ? 2 : 1,
				});
			expect(external.paths).toHaveLength(size * 1.5);
			expect(external.paths).toContain("/arr-b|movie:1/movie.mkv");
			expect(external.paths).toContain("/arr-b|series:1/a.mkv");
			expect(external.paths).not.toContain("/uncommitted");
			expect(queries).toHaveLength(2);
		} finally {
			release();
			expect(await publication).toBe(rollback);
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("keeps foreign, missing and mismatched tuples unknown while preserving same-ID instances and types", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await seedSources(f);
		await seedItems(f, [
			{ arrInstanceId: "arr-a", itemId: 1, itemType: "movie" },
			{ arrInstanceId: "arr-a", itemId: 1, itemType: "series" },
			{ arrInstanceId: "arr-b", itemId: 1, itemType: "movie" },
			{ arrInstanceId: "arr-b", itemId: 2, itemType: "series" },
			{ arrInstanceId: "foreign-arr", itemId: 1, itemType: "movie" },
			{ arrInstanceId: "foreign-arr", itemId: 1, itemType: "series" },
		]);
		const { app, request } = await createApp(f);
		let release = () => {};
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rollback = new Error("synthetic-collision-publication-rollback");
		const publication = f.runtime
			.runOperation(() =>
				f.client.prisma.$transaction(
					async (tx) => {
						await tx.libraryCache.create({
							data: {
								instanceId: "arr-b",
								arrItemId: 2,
								itemType: "movie",
								title: "Uncommitted",
								data: JSON.stringify({
									path: "/uncommitted",
									movieFile: { relativePath: "movie.mkv" },
								}),
							},
						});
						await tx.episodeFileCache.create({
							data: {
								instanceId: "arr-a",
								arrSeriesId: 2,
								arrEpisodeFileId: 999,
								seasonNumber: 1,
								relativePath: "uncommitted.mkv",
								path: "/uncommitted",
								size: 100n,
							},
						});
						entered();
						await held;
						throw rollback;
					},
					{ timeout: 20_000 },
				),
			)
			.catch((error: unknown) => error);
		try {
			await started;
			const items: Item[] = [
				{ arrInstanceId: "arr-b", itemId: 1, itemType: "movie" },
				{ arrInstanceId: "arr-a", itemId: 1, itemType: "series" },
				{ arrInstanceId: "arr-a", itemId: 1, itemType: "movie" },
				{ arrInstanceId: "arr-a", itemId: 2, itemType: "series" },
				{ arrInstanceId: "arr-b", itemId: 2, itemType: "movie" },
				{ arrInstanceId: "foreign-arr", itemId: 1, itemType: "movie" },
				{ arrInstanceId: "foreign-arr", itemId: 1, itemType: "series" },
			];
			const response = await request(items);
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toEqual({
				status: "partial",
				summaries: {
					"arr-b|movie:1": { trackerCount: 1, topHosts: ["tracker.invalid"], hashCount: 1 },
					"arr-a|series:1": { trackerCount: 1, topHosts: ["tracker.invalid"], hashCount: 2 },
					"arr-a|movie:1": { trackerCount: 1, topHosts: ["tracker.invalid"], hashCount: 1 },
					"arr-a|series:2": { trackerCount: 0, topHosts: [], hashCount: 0 },
					"arr-b|movie:2": { trackerCount: 0, topHosts: [], hashCount: 0 },
					"foreign-arr|movie:1": { trackerCount: 0, topHosts: [], hashCount: 0 },
					"foreign-arr|series:1": { trackerCount: 0, topHosts: [], hashCount: 0 },
				},
			});
			expect(external.paths).toEqual([
				"/arr-b|movie:1/movie.mkv",
				"/arr-a|series:1/a.mkv",
				"/arr-a|series:1/b.mkv",
				"/arr-a|movie:1/movie.mkv",
			]);
		} finally {
			release();
			expect(await publication).toBe(rollback);
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("requires the exact series receipt, count, snapshot and file identities for complete coverage", async () => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const item: Item = { arrInstanceId: "arr-a", itemId: 1, itemType: "series" };
		await seedItems(f, [item]);
		const original = await f.plain.libraryCache.findUniqueOrThrow({
			where: { id: "arr-a|series:1" },
		});
		for (const defect of [
			"receipt",
			"count",
			"snapshot",
			"file id",
			"path",
			"size",
			"missing file",
		]) {
			await f.plain.libraryCache.update({
				where: { id: original.id },
				data: { cachedAt, episodeFileInventoryReceipt: original.episodeFileInventoryReceipt },
			});
			await f.plain.episodeFileCache.updateMany({
				where: {
					instanceId: "arr-a",
					relativePath: "synthetic.mkv",
					path: { not: "/arr-a|series:1/b.mkv" },
				},
				data: { arrEpisodeFileId: 2, path: "/arr-a|series:1/a.mkv", size: 100n },
			});
			if (defect === "receipt")
				await f.plain.libraryCache.update({
					where: { id: original.id },
					data: { episodeFileInventoryReceipt: null },
				});
			if (defect === "count")
				await f.plain.libraryCache.update({
					where: { id: original.id },
					data: {
						episodeFileInventoryReceipt: JSON.stringify({
							...JSON.parse(original.episodeFileInventoryReceipt!),
							fileCount: 1,
						}),
					},
				});
			if (defect === "snapshot")
				await f.plain.libraryCache.update({
					where: { id: original.id },
					data: { cachedAt: new Date("2026-01-03T00:00:00.000Z") },
				});
			if (defect === "file id" || defect === "path" || defect === "size")
				await f.plain.episodeFileCache.updateMany({
					where: { instanceId: "arr-a", arrEpisodeFileId: 2 },
					data:
						defect === "file id"
							? { arrEpisodeFileId: 999 }
							: defect === "path"
								? { path: "/changed.mkv" }
								: { size: 101n },
				});
			if (defect === "missing file")
				await f.plain.episodeFileCache.deleteMany({
					where: { instanceId: "arr-a", arrEpisodeFileId: 2 },
				});
			const { app, request } = await createApp(f);
			try {
				const response = await request([item]);
				expect(response.statusCode, defect).toBe(200);
				expect(response.json(), defect).toMatchObject({
					status: "partial",
					summaries: {
						"arr-a|series:1": { trackerCount: 1, hashCount: defect === "missing file" ? 1 : 2 },
					},
				});
			} finally {
				await app.close();
			}
		}
		expect(f.losses).toEqual([]);
	});
});
