import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { runQuiTorrentStateSync } from "../../../lib/qui/torrent-state-sync.js";
import { registerFetchRoutes } from "../fetch-routes.js";

async function fixture() {
	const directory = await mkdtemp(
			path.join(process.env.ARR_LIBRARY_QUI_TEST_ROOT ?? tmpdir(), "library-qui-"),
		),
		database = path.join(directory, "owned.db");
	new Database(database).close();
	await synchronizeRuntimeSchema("file:" + database);
	const runtime = await openRestoreRuntime({ databaseUrl: "file:" + database });
	await runtime.bindDestination("synthetic-library-qui");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime),
		prisma = native.prisma,
		encryptor = new Encryptor("71".repeat(32));
	const app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("restoreRuntime", runtime);
	app.decorate("dbProvider", "sqlite");
	app.decorate("encryptor", encryptor);
	app.addHook("onRequest", async (request) => {
		request.currentUser = { id: "owner" } as typeof request.currentUser;
	});
	await app.register(registerFetchRoutes);
	await app.ready();
	const run = <T>(action: () => Promise<T>) => runtime.runOperation(action);
	const hash = (n: number) => n.toString(16).padStart(40, "0");
	const states = ["uploading", "pausedUP", "uploading", "uploading", "uploading", "pausedUP"];
	const inventories = new Map<string, Array<{ hash: string; state: string; ratio: number }>>([
		["/primary", states.map((state, n) => ({ hash: hash(n + 1), state, ratio: n + 1 }))],
		["/copy", [{ hash: hash(1), state: "uploading", ratio: 9 }]],
		["/foreign", [{ hash: hash(1), state: "pausedUP", ratio: 99 }]],
	]);
	const events: string[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url!, "http://synthetic.invalid");
		events.push(request.method + " " + url.pathname);
		const prefix = [...inventories.keys()].find(
			(key) => url.pathname === key + "/api/torrents/cross-instance",
		);
		if (
			!prefix ||
			request.method !== "GET" ||
			request.headers["x-api-key"] !== "synthetic-token" ||
			url.searchParams.get("page") !== "0" ||
			url.searchParams.get("limit") !== "2000"
		) {
			response.writeHead(403).end("{}");
			return;
		}
		const rows = inventories.get(prefix)!;
		response.writeHead(200, { "content-type": "application/json", connection: "close" }).end(
			JSON.stringify({
				cross_instance_torrents: rows.map((row) => ({
					...row,
					name: "Synthetic",
					progress: 1,
					num_seeds: 2,
					num_leechs: 0,
					save_path: "/synthetic",
					added_on: 1700000000,
					completion_on: 1700000001,
					eta: 0,
					dlspeed: 0,
					upspeed: 1,
					priority: 1,
					size: 1000,
					instance_id: 17,
				})),
				total: rows.length,
				hasMore: false,
				partialResults: false,
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	await run(async () => {
		await prisma.user.createMany({
			data: [
				{ id: "owner", username: "owner" },
				{ id: "foreign", username: "foreign" },
			],
		});
		for (const [id, userId, service, suffix] of [
			["arr", "owner", "RADARR", ""],
			["qui", "owner", "QUI", "/primary"],
			["copy", "owner", "QUI", "/copy"],
			["foreign-arr", "foreign", "RADARR", ""],
			["foreign-qui", "foreign", "QUI", "/foreign"],
		] as const) {
			const key = encryptor.encrypt("synthetic-token");
			await prisma.serviceInstance.create({
				data: {
					id,
					userId,
					service,
					label: "Synthetic",
					baseUrl: `http://127.0.0.1:${address.port}${suffix}`,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
		}
		for (const [n, title] of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].entries())
			await prisma.libraryCache.create({
				data: {
					id: "row-" + (n + 1),
					instanceId: "arr",
					arrItemId: n + 1,
					itemType: "movie",
					title,
					sortTitle: title,
					year: 2020 + n,
					status: n === 2 ? "announced" : "released",
					qualityProfileId: n === 2 ? 2 : 1,
					infoHash: hash(n + 1),
					data: JSON.stringify({
						id: n + 1,
						instanceId: "arr",
						instanceName: "Synthetic",
						service: "radarr",
						type: "movie",
						title,
						monitored: true,
					}),
				},
			});
		await prisma.libraryCache.create({
			data: {
				id: "foreign-row",
				instanceId: "foreign-arr",
				arrItemId: 1,
				itemType: "movie",
				title: "Foreign",
				infoHash: hash(1),
				data: "{}",
			},
		});
	});
	const sync = () => run(() => runQuiTorrentStateSync(app));
	expect(await sync()).toMatchObject({ errors: 0 });
	const api = async (query = "") => {
		const parameters = new URLSearchParams({ limit: "50" });
		for (const [key, value] of new URLSearchParams(query)) parameters.set(key, value);
		const response = await run(() =>
			app.inject({ method: "GET", url: "/library?" + parameters.toString() }),
		);
		expect(response.statusCode).toBe(200);
		return response.json();
	};
	return {
		app,
		prisma,
		run,
		sync,
		api,
		inventories,
		directory,
		async close() {
			await app.close();
			await native.close();
			await runtime.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			expect(events.every((event) => event.startsWith("GET "))).toBe(true);
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture | undefined;
afterEach(async () => {
	await f?.close();
	f = undefined;
});

describe("Library complete qUI publication read contract with actual guarded SQLite", () => {
	it("falls back without false empty results, scalars or counts for an incomplete publication and does not mutate GET", async () => {
		f = await fixture();
		await f.run(() =>
			f!.prisma.quiObservationPublication.update({
				where: { userId: "owner" },
				data: { complete: false },
			}),
		);
		const before = await f.run(() => f!.prisma.libraryCache.findMany());
		const result = await f.api("&torrentState=paused&sortBy=torrentRatio&sortOrder=desc&limit=2");
		expect(result.quiObservationStatus).toEqual({ status: "unavailable", observedAt: null });
		expect(result.appliedFilters).toMatchObject({
			torrentState: "all",
			sortBy: "sortTitle",
			sortOrder: "desc",
		});
		expect(result.pagination.totalItems).toBe(6);
		expect(result.items.map((item: { id: number }) => item.id)).toEqual([6, 5]);
		expect(
			result.items.every(
				(item: { torrentState: unknown; torrentRatio: unknown }) =>
					item.torrentState === null && item.torrentRatio === null,
			),
		).toBe(true);
		expect(result.torrentStateCounts).toBeUndefined();
		expect(await f.run(() => f!.prisma.libraryCache.findMany())).toEqual(before);
	});
	it.each(["missing", "stale", "future", "source-changed"] as const)(
		"refuses %s owner evidence without accepting a foreign complete head",
		async (kind) => {
			f = await fixture();
			await f.run(async () => {
				if (kind === "missing")
					await f!.prisma.quiObservationPublication.delete({ where: { userId: "owner" } });
				else if (kind === "source-changed")
					await f!.prisma.serviceInstance.update({
						where: { id: "qui" },
						data: { connectionGeneration: { increment: 1 } },
					});
				else
					await f!.prisma.quiObservationPublication.update({
						where: { userId: "owner" },
						data: { observedAt: new Date(Date.now() + (kind === "stale" ? -31 * 60000 : 60000)) },
					});
			});
			const result = await f.api("&torrentState=none");
			expect(result.quiObservationStatus).toEqual({ status: "unavailable", observedAt: null });
			expect(result.items).toHaveLength(6);
			expect(
				result.items.every(
					(item: { torrentState: unknown; torrentRatio: unknown }) =>
						item.torrentState === null && item.torrentRatio === null,
				),
			).toBe(true);
			expect(result.torrentStateCounts).toBeUndefined();
			expect(await f.sync()).toMatchObject({ errors: 0 });
			expect((await f.api()).quiObservationStatus.status).toBe("available");
		},
	);
	it("keeps valid nullable-ratio state and counts only verified rows under every non-qUI filter", async () => {
		f = await fixture();
		await f.run(() =>
			f!.prisma.libraryCache.update({
				where: { id: "row-4" },
				data: { torrentSyncedAt: new Date(0), torrentRatio: 999 },
			}),
		);
		const all = await f.api();
		const head = await f.run(() =>
			f!.prisma.quiObservationPublication.findUniqueOrThrow({ where: { userId: "owner" } }),
		);
		expect(all.quiObservationStatus).toEqual({
			status: "available",
			observedAt: head.observedAt!.toISOString(),
		});
		expect(all.items.find((item: { id: number }) => item.id === 1)).toMatchObject({
			torrentState: "seeding",
			torrentRatio: null,
		});
		expect(all.items.find((item: { id: number }) => item.id === 4)).toMatchObject({
			torrentState: null,
			torrentRatio: null,
		});
		const result = await f.api(
			"&torrentState=seeding&status=released&qualityProfileId=1&yearMin=2021&yearMax=2024",
		);
		expect(result.items.map((item: { id: number }) => item.id)).toEqual([5]);
		expect(result.torrentStateCounts).toMatchObject({ all: 3, seeding: 1, paused: 1, none: 1 });
		expect(
			(await f.api("&torrentState=none")).items.map((item: { id: number }) => item.id),
		).toEqual([4]);
	});
	it("paginates verified numeric ratios first and effective-null partitions last without trusting stale numeric ratios", async () => {
		f = await fixture();
		await f.run(() =>
			f!.prisma.libraryCache.update({
				where: { id: "row-4" },
				data: { torrentSyncedAt: new Date(0), torrentRatio: 999 },
			}),
		);
		const pages = [];
		for (const page of [1, 2, 3]) {
			const result = await f.api("&sortBy=torrentRatio&sortOrder=desc&limit=2&page=" + page);
			pages.push(result.items.map((item: { id: number }) => item.id));
			expect(result.pagination.totalItems).toBe(6);
		}
		expect(pages).toEqual([
			[6, 5],
			[3, 2],
			[1, 4],
		]);
		f.inventories.get("/primary")![2]!.ratio = 2;
		await f.sync();
		await f.run(() =>
			f!.prisma.libraryCache.update({
				where: { id: "row-4" },
				data: { torrentSyncedAt: new Date(0), torrentRatio: 999 },
			}),
		);
		const ascending = [];
		for (const page of [1, 2, 3])
			ascending.push(
				(await f.api("&sortBy=torrentRatio&sortOrder=asc&limit=2&page=" + page)).items.map(
					(item: { id: number }) => item.id,
				),
			);
		expect(ascending).toEqual([
			[2, 3],
			[5, 6],
			[1, 4],
		]);
		expect(
			(await f.api("&sortBy=torrentRatio&sortOrder=desc&limit=4")).items.map(
				(item: { id: number }) => item.id,
			),
		).toEqual([6, 5, 2, 3]);
	});
	it("retains available complete-empty and not-configured/no-library status without false counts", async () => {
		f = await fixture();
		f.inventories.set("/primary", []);
		f.inventories.set("/copy", []);
		await f.sync();
		const empty = await f.api();
		expect(empty.quiObservationStatus.status).toBe("available");
		expect(empty.torrentStateCounts).toMatchObject({ none: 6, all: 6 });
		await f.run(() =>
			f!.prisma.serviceInstance.updateMany({
				where: { userId: "owner", service: "QUI" },
				data: { enabled: false },
			}),
		);
		const none = await f.api("&sortBy=torrentRatio&torrentState=paused");
		expect(none.quiObservationStatus).toEqual({ status: "not_configured", observedAt: null });
		expect(none.items).toHaveLength(6);
		expect(none.torrentStateCounts).toBeUndefined();
		await f.run(() =>
			f!.prisma.serviceInstance.update({ where: { id: "arr" }, data: { enabled: false } }),
		);
		expect(await f.api()).toMatchObject({
			items: [],
			quiObservationStatus: { status: "not_configured", observedAt: null },
		});
	});
	it("preserves the existing foreign-instance 403 refusal rather than wrapping an already sent reply", async () => {
		f = await fixture();
		const response = await f.run(() =>
			f!.app.inject({ method: "GET", url: "/library?instanceId=foreign-arr" }),
		);
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "Instance not found" });
	});
	it("discards an available result changed during a held real query and reruns exactly once without qUI authority", async () => {
		f = await fixture();
		let ready!: () => void,
			release!: () => void,
			fired = false,
			reads = 0,
			producerActive = false;
		const reached = new Promise<void>((resolve) => {
				ready = resolve;
			}),
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
		const prisma = f.prisma;
		f.app.prisma = new Proxy(prisma, {
			get(target, name) {
				const value = Reflect.get(target, name, target);
				if (name === "libraryCache")
					return new Proxy(value, {
						get(delegate, key) {
							const method = Reflect.get(delegate, key, delegate);
							if (key === "findMany")
								return async (...args: unknown[]) => {
									const result = await Reflect.apply(method, delegate, args);
									if (!producerActive) reads++;
									if (!fired) {
										fired = true;
										ready();
										await held;
									}
									return result;
								};
							return typeof method === "function" ? method.bind(delegate) : method;
						},
					});
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const response = f.api("&torrentState=paused&sortBy=torrentRatio");
		await reached;
		try {
			producerActive = true;
			expect(await f.sync()).toMatchObject({ errors: 0 });
		} finally {
			producerActive = false;
			release();
		}
		const result = await response;
		expect(result.quiObservationStatus).toEqual({ status: "unavailable", observedAt: null });
		expect(result.items).toHaveLength(6);
		expect(result.appliedFilters).toMatchObject({ torrentState: "all", sortBy: "sortTitle" });
		expect(result.torrentStateCounts).toBeUndefined();
		expect(
			result.items.every((item: { torrentState: unknown }) => item.torrentState === null),
		).toBe(true);
		expect(reads).toBe(2); // actual initial page and the single bounded fallback, excluding the concurrent producer's reads
	});
});
