import { createHash } from "node:crypto";
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
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { SessionService } from "../../auth/session.js";
import { createEpisodeFileInventoryReceipt } from "../../library-sync/episode-file-coverage.js";
import { invalidateTorrentListCache } from "../../qui/torrent-list-cache.js";
import { createRuntimeSessionMetadataPrismaClient } from "../restore-runtime-client.js";

// Only external filesystem/provider work is synthetic. Session signing,
// runtime admission, ownership joins and every SQL statement remain real.
const external = vi.hoisted(() => ({
	paths: [] as string[],
	ordinary: undefined as unknown,
	trackerReads: 0,
	arrReads: 0,
	trackerGate: undefined as Promise<void> | undefined,
}));
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
		// These synthetic files each have one current, verified torrent association.
		listTorrentInventory: async () => ({
			torrents: [...new Set(external.paths)].map((hash) => ({ hash, instanceId: 1 })),
			complete: true,
		}),
		getTorrentByHash: async () => ({ instanceId: 1 }),
		getTrackers: async () => {
			external.trackerReads++;
			await external.trackerGate;
			return [{ url: "https://tracker.invalid/announce" }];
		},
	}),
}));

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
	invalidateTorrentListCache();
	external.paths = [];
	external.trackerReads = 0;
	external.arrReads = 0;
	external.trackerGate = undefined;
	external.ordinary = f.client.prisma;
	const app = Fastify({ logger: false });
	const env = envSchema.parse({ NODE_ENV: "test", DATABASE_URL: `file:${f.path}` });
	const metadata = createRuntimeSessionMetadataPrismaClient(f.runtime);
	const sessions = new SessionService(f.client.prisma, env, app.log, metadata.prisma);
	const session = await f.runtime.runOperation(() => sessions.createSession("synthetic-user"));
	app.decorate("prisma", f.client.prisma);
	app.decorate("arrClientFactory", {
		create: () => {
			external.arrReads++;
			throw new Error("summary must not query Sonarr");
		},
	} as never);
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

async function seedV3Observation(f: ScopedWriteFixture, item: Item, observedAt = new Date()) {
	await seedItems(f, [item]);
	const key = `${item.arrInstanceId}|series:${item.itemId}`;
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({
		where: { id: item.arrInstanceId },
	});
	const sourceFingerprint = createArrServiceFingerprint(instance);
	const data = JSON.stringify({
		id: item.itemId,
		statistics: { episodeFileCount: 3 },
		sizeOnDisk: 300,
		_arrDashboardSource: { serviceFingerprint: sourceFingerprint },
	});
	const row = await f.plain.libraryCache.findUniqueOrThrow({ where: { id: key } });
	// Construct the proposed wire format independently, so RED exercises the
	// existing route rather than failing because a new helper is absent.
	const receipt = JSON.stringify({
		...JSON.parse(row.episodeFileInventoryReceipt!),
		v: 3,
		observedAt: observedAt.toISOString(),
		seriesContentDigest: createHash("sha256").update(data).digest("hex"),
		sourceFingerprint,
	});
	await f.plain.libraryCache.update({
		where: { id: key },
		data: { data, episodeFileInventoryReceipt: receipt },
	});
	return { key, data, receipt, observedAt };
}

describe("qUI full-page cached path SELECT acquisition", { timeout: 30_000 }, () => {
	// Break caught: restoring a per-item SELECT loop amplifies guarded native
	// queries from fixed sets to an entire page, even on a leased read connection.
	it.each([50, 500])(
		"uses three bounded content/file/movie SELECTs for a populated mixed page of %i",
		async (size) => {
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
							await tx.libraryCache.update({
								where: { id: "arr-b|movie:1" },
								data: { data: "{}" },
							});
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
					expect(result.summaries[`${item.arrInstanceId}|${item.itemType}:${item.itemId}`]).toEqual(
						{
							trackerCount: 1,
							topHosts: ["tracker.invalid"],
							hashCount: item.itemType === "series" ? 2 : 1,
						},
					);
				expect(external.paths).toHaveLength(size * 1.5);
				expect(external.paths).toContain("/arr-b|movie:1/movie.mkv");
				expect(external.paths).toContain("/arr-b|series:1/a.mkv");
				expect(external.paths).not.toContain("/uncommitted");
				// The existing series authority SELECT now includes content for v3.
				// Episode paths and movie paths remain one set each, never per item.
				expect(queries).toHaveLength(3);
			} finally {
				release();
				expect(await publication).toBe(rollback);
				await app.close();
			}
			expect(f.losses).toEqual([]);
		},
	);

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

	it("retains independently observed inventory after an unchanged catalog timestamp advance", async () => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const item: Item = { arrInstanceId: "arr-b", itemId: 1, itemType: "series" };
		const observation = await seedV3Observation(f, item);
		await f.plain.libraryCache.update({
			where: { id: observation.key },
			data: { cachedAt: new Date(cachedAt.getTime() + 1) },
		});
		const { app, request } = await createApp(f);
		try {
			const response = await request([item]);
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toMatchObject({
				status: "available",
				summaries: {
					[observation.key]: {
						trackerCount: 1,
						hashCount: 2,
						episodeInventory: { status: "fresh", observedAt: observation.observedAt.toISOString() },
					},
				},
			});
			const trackerReads = external.trackerReads;
			const fileReads = external.paths.length;
			await f.plain.libraryCache.update({
				where: { id: observation.key },
				data: { cachedAt: new Date(cachedAt.getTime() + 2) },
			});
			expect((await request([item])).json()).toEqual(response.json());
			expect(external.trackerReads).toBe(trackerReads);
			expect(external.paths).toHaveLength(fileReads);
			expect(external.arrReads).toBe(0);
		} finally {
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("expires an observation inside the ten-minute available summary cache", async () => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const item: Item = { arrInstanceId: "arr-b", itemId: 1, itemType: "series" };
		const now = Date.now();
		const observation = await seedV3Observation(
			f,
			item,
			new Date(now - 6 * 60 * 60_000 + 5 * 60_000),
		);
		const { app, request } = await createApp(f);
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect((await request([item])).json()).toMatchObject({
				status: "available",
				summaries: { [observation.key]: { episodeInventory: { status: "fresh" } } },
			});
			const reads = external.trackerReads;
			// The inventory's five-hour-old as-of clock must not become the
			// ten-minute tracker-cache build time and force repeat fanout.
			expect((await request([item])).json().status).toBe("available");
			expect(external.trackerReads).toBe(reads);
			clock.mockReturnValue(now + 5 * 60_000);
			expect((await request([item])).json()).toMatchObject({
				status: "partial",
				summaries: {
					[observation.key]: {
						trackerCount: 1,
						hashCount: 2,
						episodeInventory: { status: "stale", observedAt: observation.observedAt.toISOString() },
					},
				},
			});
			expect(external.arrReads).toBe(0);
		} finally {
			clock.mockRestore();
			await app.close();
		}
	});

	it.each([
		"receipt",
		"source",
		"content",
		"file",
		"future",
		"malformed",
		"marker",
		"revoked source",
		"malformed receipt source",
		"legacy receipt source",
	])("invalidates cached available inventory on %s changes", async (defect) => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const item: Item = { arrInstanceId: "arr-b", itemId: 1, itemType: "series" };
		const observation = await seedV3Observation(f, item);
		const { app, request } = await createApp(f);
		try {
			expect((await request([item])).json().status).toBe("available");
			if (defect === "source")
				await f.plain.serviceInstance.update({
					where: { id: "arr-b" },
					data: { encryptedApiKey: "replacement" },
				});
			if (defect === "content")
				await f.plain.libraryCache.update({
					where: { id: observation.key },
					data: { data: `${observation.data} ` },
				});
			if (defect === "marker")
				await f.plain.libraryCache.update({
					where: { id: observation.key },
					data: {
						data: JSON.stringify({ ...JSON.parse(observation.data), _arrDashboardSource: null }),
					},
				});
			if (defect === "file")
				await f.plain.episodeFileCache.updateMany({
					where: { instanceId: "arr-b", arrEpisodeFileId: 2 },
					data: { path: "/replaced.mkv" },
				});
			if (defect === "receipt" || defect === "future" || defect === "malformed")
				await f.plain.libraryCache.update({
					where: { id: observation.key },
					data: {
						episodeFileInventoryReceipt:
							defect === "receipt"
								? null
								: JSON.stringify({
										...JSON.parse(observation.receipt),
										observedAt:
											defect === "future" ? new Date(Date.now() + 60_000).toISOString() : "invalid",
									}),
					},
				});
			if (defect.endsWith(" source")) {
				await f.plain.serviceInstance.update({
					where: { id: "arr-b" },
					data: { encryptedApiKey: "replacement" },
				});
				const legacy = JSON.parse(observation.receipt);
				delete legacy.observedAt;
				delete legacy.sourceFingerprint;
				delete legacy.seriesContentDigest;
				legacy.v = 2;
				await f.plain.libraryCache.update({
					where: { id: observation.key },
					data: {
						episodeFileInventoryReceipt:
							defect === "revoked source"
								? null
								: defect === "malformed receipt source"
									? "invalid"
									: JSON.stringify(legacy),
					},
				});
			}
			const result = (await request([item])).json();
			expect(result.status).toBe("partial");
			if (defect !== "receipt")
				expect(result.summaries[observation.key].episodeInventory).toEqual({
					status: "unknown",
					observedAt: null,
				});
			if (defect === "source" || defect === "marker" || defect.endsWith(" source"))
				expect(result.summaries[observation.key]).toMatchObject({
					hashCount: 0,
					trackerCount: 0,
				});
			expect(external.arrReads).toBe(0);
		} finally {
			await app.close();
		}
	});

	it("keeps independent observations scoped across same-title, same-ID instances and foreign owners", async () => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const other = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: "arr-b" } });
		await f.plain.serviceInstance.create({ data: { ...other, id: "arr-c" } });
		const items: Item[] = ["arr-b", "arr-c", "foreign-arr"].map((arrInstanceId) => ({
			arrInstanceId,
			itemId: 1,
			itemType: "series",
		}));
		const observations = [];
		for (const item of items) observations.push(await seedV3Observation(f, item));
		// Matching file counts/bytes, title and provider IDs do not transfer
		// one instance's source authority to another instance.
		await f.plain.libraryCache.update({
			where: { id: observations[1]!.key },
			data: { episodeFileInventoryReceipt: observations[0]!.receipt },
		});
		const { app, request } = await createApp(f);
		try {
			const result = (await request(items)).json();
			expect(result.status).toBe("partial");
			expect(result.summaries[observations[0]!.key]).toMatchObject({
				trackerCount: 1,
				hashCount: 2,
				episodeInventory: { status: "fresh" },
			});
			expect(result.summaries[observations[1]!.key]).toMatchObject({
				trackerCount: 0,
				hashCount: 0,
				episodeInventory: { status: "unknown", observedAt: null },
			});
			expect(result.summaries[observations[2]!.key]).toEqual({
				trackerCount: 0,
				hashCount: 0,
				topHosts: [],
			});
			expect(external.paths).toEqual(["/arr-b|series:1/a.mkv", "/arr-b|series:1/b.mkv"]);
			expect(external.arrReads).toBe(0);
		} finally {
			await app.close();
		}
	});

	it("resumes meaningful tracker collection across an unchanged catalog poll", async () => {
		const f = await createScopedWriteFixture();
		await seedSources(f);
		const item: Item = { arrInstanceId: "arr-b", itemId: 1, itemType: "series" };
		const observation = await seedV3Observation(f, item);
		const { app, request } = await createApp(f);
		let release = () => {};
		external.trackerGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			expect((await request([item])).json().status).toBe("building");
			expect(external.trackerReads).toBe(2);
			await f.plain.libraryCache.update({
				where: { id: observation.key },
				data: { cachedAt: new Date(cachedAt.getTime() + 1) },
			});
			release();
			expect((await request([item])).json()).toMatchObject({
				status: "available",
				summaries: { [observation.key]: { trackerCount: 1, hashCount: 2 } },
			});
			expect(external.trackerReads).toBe(2);
			expect(external.arrReads).toBe(0);
		} finally {
			release();
			await app.close();
		}
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
