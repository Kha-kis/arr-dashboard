import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { createArrServiceFingerprint } from "../shared-plex-safety.js";
import {
	captureUnmonitorCachePreimage,
	publishConfirmedUnmonitor,
	UNMONITOR_CACHE_PUBLICATION_WARNING,
} from "../unmonitor-cache-publication.js";

// SEEDED owned resources on real native SQLite. No provider/DB success doubles.
async function fixture(service: "RADARR" | "SONARR" = "RADARR") {
	const directory = await mkdtemp(join(tmpdir(), "unmonitor-publication-")),
		database = join(directory, "owned.db");
	new Database(database).close();
	await synchronizeRuntimeSchema("file:" + database);
	const runtime = await openRestoreRuntime({ databaseUrl: "file:" + database });
	await runtime.bindDestination("synthetic-unmonitor-publication");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime),
		prisma = native.prisma,
		run = <T>(op: () => Promise<T>) => runtime.runOperation(op);
	await run(async () => {
		for (const id of ["owner", "foreign"]) await prisma.user.create({ data: { id, username: id } });
	});
	const instance = await run(() =>
		prisma.serviceInstance.create({
			data: {
				id: "selected",
				userId: "owner",
				service,
				label: "Same title",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		}),
	);
	const foreign = await run(() =>
		prisma.serviceInstance.create({
			data: {
				id: "foreign",
				userId: "foreign",
				service,
				label: "Same title",
				baseUrl: instance.baseUrl,
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
			},
		}),
	);
	const type = service === "RADARR" ? "movie" : "series";
	const plan = {
		kind: "verified_arr_target" as const,
		target: {
			serviceFingerprint: createArrServiceFingerprint(instance),
			externalId: 42,
			mediaPath: { value: "/synthetic/item", windows: false },
		},
	};
	const prior = {
		id: 101,
		instanceId: instance.id,
		service: service.toLowerCase(),
		type,
		title: "Same title",
		monitored: true,
		path: "/synthetic/item",
		remoteIds: service === "RADARR" ? { tmdbId: 42 } : { tvdbId: 42 },
		seasons: [{ seasonNumber: 1, monitored: true }],
		statistics: { monitoredSeasons: 1, size: 123 },
		custom: { keep: "byte semantics" },
		_arrDashboardSource: {
			serviceFingerprint: createArrServiceFingerprint(instance),
			extra: "keep",
		},
	};
	await run(async () => {
		for (const [inst, id] of [
			[instance, 101],
			[instance, 102],
			[foreign, 101],
		] as const)
			await prisma.libraryCache.create({
				data: {
					id: inst.id + "-" + id,
					instanceId: inst.id,
					arrItemId: id,
					itemType: type,
					title: "Same title",
					monitored: true,
					hasFile: true,
					sizeOnDisk: 123n,
					cachedAt: new Date("2026-01-01T00:00:00Z"),
					data: JSON.stringify({ ...prior, id, instanceId: inst.id }),
				},
			});
	});
	const options = { prisma, instance, userId: "owner", arrItemId: 101, itemType: type, plan };
	const read = () => run(() => prisma.libraryCache.findMany({ orderBy: { id: "asc" } }));
	const capture = () => run(() => captureUnmonitorCachePreimage(options));
	const publish = (
		preimage: Awaited<ReturnType<typeof capture>>,
		observation: unknown = {
			id: 101,
			monitored: false,
			path: "/synthetic/item",
			...(service === "RADARR" ? { tmdbId: 42 } : { tvdbId: 42 }),
		},
	) => run(() => publishConfirmedUnmonitor({ prisma, preimage, observation }));
	return {
		prisma,
		run,
		options,
		prior,
		capture,
		publish,
		read,
		database,
		async close() {
			await native.close();
			await runtime.close();
			const db = new Database(database, { readonly: true });
			expect(db.pragma("quick_check", { simple: true })).toBe("ok");
			db.close();
			await rm(directory, { recursive: true });
		},
	};
}
async function withFixture(
	run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	service: "RADARR" | "SONARR" = "RADARR",
) {
	const f = await fixture(service);
	try {
		await run(f);
	} finally {
		await f.close();
	}
}

describe("confirmed parent unmonitor publication on real native SQLite", () => {
	for (const service of ["RADARR", "SONARR"] as const)
		it(`publishes only parent monitoring atomically for ${service}, preserving metadata/freshness/foreign/sibling`, async () =>
			withFixture(async (f) => {
				const before = await f.read(),
					captured = await f.capture();
				expect(captured).toBeDefined();
				expect(await f.publish(captured)).toEqual({ published: true });
				const after = await f.read(),
					selected = after.find((r) => r.id === "selected-101")!,
					old = before.find((r) => r.id === "selected-101")!;
				expect(selected.monitored).toBe(false);
				expect(JSON.parse(selected.data)).toEqual({ ...JSON.parse(old.data), monitored: false });
				expect(selected.cachedAt).toEqual(old.cachedAt);
				expect(selected.sizeOnDisk).toBe(123n);
				expect(selected.hasFile).toBe(true);
				expect(after.filter((r) => r.id !== selected.id)).toEqual(
					before.filter((r) => r.id !== selected.id),
				);
			}, service));
	for (const data of ["", "null", "[]", "not-json", JSON.stringify({ id: 101, monitored: true })])
		it(`refuses missing or malformed/binding-incomplete JSON ${data}`, async () =>
			withFixture(async (f) => {
				await f.run(() =>
					f.prisma.libraryCache.update({ where: { id: "selected-101" }, data: { data } }),
				);
				const before = await f.read();
				expect(await f.capture()).toBeUndefined();
				expect(await f.publish(undefined)).toEqual({
					published: false,
					warning: UNMONITOR_CACHE_PUBLICATION_WARNING,
				});
				expect(await f.read()).toEqual(before);
			}));
	for (const change of [
		{ id: 102 },
		{ instanceId: "foreign" },
		{ service: "sonarr" },
		{ type: "series" },
		{ path: "/other" },
		{ remoteIds: { tmdbId: 99 } },
		{ monitored: "true" },
	])
		it(`refuses contradictory selected projection ${JSON.stringify(change)}`, async () =>
			withFixture(async (f) => {
				await f.run(() =>
					f.prisma.libraryCache.update({
						where: { id: "selected-101" },
						data: { data: JSON.stringify({ ...f.prior, ...change }) },
					}),
				);
				expect(await f.capture()).toBeUndefined();
			}));
	it("refuses foreign capture and source drift without writing either representation", async () =>
		withFixture(async (f) => {
			expect(
				await f.run(() => captureUnmonitorCachePreimage({ ...f.options, userId: "foreign" })),
			).toBeUndefined();
			const captured = await f.capture();
			await f.run(() =>
				f.prisma.serviceInstance.update({
					where: { id: "selected" },
					data: { connectionGeneration: 3 },
				}),
			);
			const before = await f.read();
			expect(await f.publish(captured)).toEqual({
				published: false,
				warning: UNMONITOR_CACHE_PUBLICATION_WARNING,
			});
			expect(await f.read()).toEqual(before);
		}));
	it("does not overwrite concurrent metadata or a replaced selected cache row", async () =>
		withFixture(async (f) => {
			const captured = await f.capture();
			await f.run(() =>
				f.prisma.libraryCache.update({
					where: { id: "selected-101" },
					data: { data: JSON.stringify({ ...f.prior, custom: { new: "sync" } }) },
				}),
			);
			const before = await f.read();
			expect((await f.publish(captured)).published).toBe(false);
			expect(await f.read()).toEqual(before);
			const current = await f.capture();
			await f.run(async () => {
				await f.prisma.libraryCache.delete({ where: { id: "selected-101" } });
				await f.prisma.libraryCache.create({
					data: { ...before.find((r) => r.id === "selected-101")!, id: "replacement" },
				});
			});
			const replaced = await f.read();
			expect((await f.publish(current)).published).toBe(false);
			expect(await f.read()).toEqual(replaced);
		}));
	it("requires exact fresh false observation, never ACK/cache alone", async () =>
		withFixture(async (f) => {
			const captured = await f.capture(),
				before = await f.read();
			for (const observation of [
				{ id: 101, monitored: true },
				{ id: 101 },
				{ id: 102, monitored: false },
				{ id: 101, monitored: false, tmdbId: 99, path: "/synthetic/item" },
			])
				expect((await f.publish(captured, observation)).published).toBe(false);
			expect(await f.read()).toEqual(before);
		}));
	it("native statement failure cannot partially publish the flat column", async () =>
		withFixture(async (f) => {
			const captured = await f.capture(),
				before = await f.read();
			const db = new Database(f.database);
			db.exec(
				"CREATE TRIGGER synthetic_publication_abort BEFORE UPDATE OF data ON library_cache BEGIN SELECT RAISE(ABORT, 'synthetic atomic fault'); END",
			);
			db.close();
			expect((await f.publish(captured)).published).toBe(false);
			expect(await f.read()).toEqual(before);
		}));
});
