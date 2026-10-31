import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../prisma.js";
import { createRecoverableSqliteAdapter } from "../../sqlite-adapter.js";

const { inventory } = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("../client-factory.js", () => ({
	createQuiClient: () => ({ listTorrentInventory: inventory }),
}));
vi.mock("../instance-helpers.js", () => ({
	listQuiInstances: async () => [{ id: "owned-qui", userId: "owned", label: "Synthetic" }],
}));

import { runQuiTorrentStateSync } from "../torrent-state-sync.js";
import { resolveQuiAwareGateReasons } from "../../queue-cleaner/qui-gate.js";

type Phase = "first-clear" | "staging" | "final-publication";
const pending: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of pending.splice(0)) await close();
	vi.restoreAllMocks();
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "qui-publication-busy-"));
	const path = join(directory, "fixture.db");
	const schema = readFileSync("prisma/runtime-schema/sqlite-v1.sql", "utf8");
	const registry = JSON.parse(
		readFileSync("prisma/runtime-schema/registry-sqlite-v1.json", "utf8"),
	);
	const atoms = new Map<string, string>(
		schema
			.split(/^-- arr-schema-atom /m)
			.slice(1)
			.map((chunk) => {
				const split = chunk.indexOf("\n");
				return [chunk.slice(0, split).trim(), chunk.slice(split + 1).trim()];
			}),
	);
	const setup = new Database(path);
	const indexIds = new Set<string>(
		registry.registry.tables.flatMap((table: { addIndexAtoms: Record<string, string> }) =>
			Object.values(table.addIndexAtoms),
		),
	);
	setup.transaction(() => {
		for (const table of registry.registry.tables) setup.exec(atoms.get(table.createAtom)!);
		for (const index of indexIds) setup.exec(atoms.get(index)!);
	})();
	setup.pragma("journal_mode=WAL");
	setup.close();
	const prisma = new PrismaClient({
		adapter: createRecoverableSqliteAdapter({ url: path, timeout: 10 }),
	});
	const writer = new Database(path, { fileMustExist: true, timeout: 0 });
	const observer = new Database(path, { fileMustExist: true, timeout: 0 });
	const timers = new Set<ReturnType<typeof setTimeout>>();
	pending.push(async () => {
		for (const timer of timers) clearTimeout(timer);
		if (writer.inTransaction) writer.exec("ROLLBACK");
		writer.close();
		observer.close();
		await prisma.$disconnect();
		rmSync(directory, { recursive: true });
	});
	await prisma.$connect();
	for (const userId of ["owned", "other"]) {
		await prisma.user.create({
			data: { id: userId, username: userId, hashedPassword: "synthetic" },
		});
		await prisma.serviceInstance.create({
			data: {
				id: `${userId}-qui`,
				userId,
				service: userId === "owned" ? "QUI" : "RADARR",
				label: "Synthetic",
				baseUrl: "http://fixture.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		await prisma.libraryCache.create({
			data: {
				id: `${userId}-row`,
				instanceId: `${userId}-qui`,
				arrItemId: 1,
				itemType: "movie",
				title: "Synthetic",
				data: "{}",
				infoHash: "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd",
				torrentState: "paused",
				torrentRatio: 0,
				torrentSyncedAt: new Date("2026-10-01T00:00:00Z"),
			},
		});
	}
	inventory.mockReset().mockResolvedValue({
		torrents: [{ hash: "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd", state: "uploading", ratio: 2 }],
		complete: true,
	});
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const app = { prisma, dbProvider: "sqlite", log } as any;
	return {
		prisma,
		writer,
		observer,
		app,
		read: (id = "owned-row") =>
			prisma.libraryCache.findUniqueOrThrow({
				where: { id },
				select: { torrentState: true, torrentRatio: true, torrentSyncedAt: true },
			}),
		after(ms: number, callback: () => void) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				callback();
			}, ms);
			timers.add(timer);
		},
	};
}

function contend(f: Awaited<ReturnType<typeof fixture>>, phase: Phase, transient: boolean) {
	let transactions = 0;
	let stages = 0;
	let locked = false;
	let releasedAt: number | undefined;
	const intermediate: Array<{ torrentState: string | null; torrentSyncedAt: string | null }> = [];
	const lock = () => {
		locked = true;
		f.writer.exec("BEGIN IMMEDIATE");
		if (transient)
			f.after(0, () => {
				f.writer.exec("ROLLBACK");
				releasedAt = Date.now();
			});
	};
	const record = () =>
		intermediate.push(
			f.observer
				.prepare("SELECT torrentState,torrentSyncedAt FROM library_cache WHERE id='owned-row'")
				.get() as any,
		);
	const transaction = f.prisma.$transaction.bind(f.prisma);
	vi.spyOn(f.prisma, "$transaction").mockImplementation((async (...args: any[]) => {
		transactions++;
		if (
			!locked &&
			((phase === "first-clear" && transactions === 1) ||
				(phase === "staging" && transactions === 4) ||
				(phase === "final-publication" && transactions === 7))
		)
			lock();
		try {
			return await transaction(...(args as Parameters<typeof transaction>));
		} catch (error) {
			record();
			throw error;
		}
	}) as any);
	const execute = f.prisma.$executeRaw.bind(f.prisma);
	vi.spyOn(f.prisma, "$executeRaw").mockImplementation((...args) => {
		stages++;
		// The generation fence now acquires the write lock before the SQL payload.
		// Contention must begin before that bounded transaction, not inside it.
		const pending = execute(...args);
		void pending.catch(() => {
			record();
		});
		return pending;
	});
	return { intermediate, releasedAt: () => releasedAt };
}

describe("qUI native SQLite publication contention", () => {
	it("retains committed generation while retrying prune after first150 obsolete rows committed", async () => {
		const f = await fixture(),
			hash = "abcd".repeat(10);
		inventory.mockResolvedValue({
			complete: true,
			torrents: [
				{ hash, state: "uploading", ratio: 2 },
				...Array.from({ length: 300 }, (_, i) => ({
					hash: (i + 5000).toString(16).padStart(40, "0"),
					state: "uploading",
					ratio: 1,
				})),
			],
		});
		expect((await runQuiTorrentStateSync(f.app)).errors).toBe(0);
		inventory
			.mockClear()
			.mockResolvedValue({ complete: true, torrents: [{ hash, state: "pausedUP", ratio: 0 }] });
		const prior = await f.prisma.quiObservationPublication.findUniqueOrThrow({
				where: { userId: "owned" },
			}),
			transaction = f.prisma.$transaction.bind(f.prisma);
		let attempts = 0,
			capturedGeneration = "",
			remaining = -1;
		vi.spyOn(f.prisma, "$transaction").mockImplementation((async (
			operation: any,
			...options: any[]
		) =>
			transaction(
				async (tx: any) =>
					operation(
						new Proxy(tx, {
							get(target, key) {
								if (key !== "quiTorrentObservation") return Reflect.get(target, key);
								const model = target.quiTorrentObservation;
								return new Proxy(model, {
									get(m, method) {
										if (method !== "findMany") return Reflect.get(m, method);
										return async (args: any) => {
											if (args.where?.generation?.not && ++attempts === 2) {
												remaining = await model.count({
													where: { userId: "owned", generation: prior.generation },
												});
												capturedGeneration = (
													await tx.quiObservationPublication.findUniqueOrThrow({
														where: { userId: "owned" },
													})
												).generation;
												throw Object.assign(new Error("INJECTED_PRUNE_BUSY_NOT_REAL_CONTENTION"), {
													code: "P1008",
													meta: {
														driverAdapterError: {
															cause: { originalCode: "SQLITE_BUSY", kind: "SocketTimeout" },
														},
													},
												});
											}
											return model.findMany(args);
										};
									},
								});
							},
						}),
					),
				...options,
			)) as any);
		const result = await runQuiTorrentStateSync(f.app);
		expect(result.errors).toBe(0);
		expect(remaining).toBe(151);
		expect(inventory).toHaveBeenCalledTimes(1);
		expect(
			await f.prisma.quiObservationPublication.findUniqueOrThrow({ where: { userId: "owned" } }),
		).toMatchObject({ generation: capturedGeneration, complete: true, rowCount: 1 });
		expect(await f.prisma.quiTorrentObservation.count({ where: { userId: "owned" } })).toBe(1);
		expect(await f.read()).toMatchObject({ torrentState: "paused", torrentRatio: 0 });
	});
	it.each([
		[["pausedUP", "downloading"], "downloading", "paused_or_error"],
		[["error", "uploading"], "seeding", "paused_or_error"],
		[["future-state"], "unknown", "evidence_unavailable"],
		[["future-state", "uploading"], "seeding", "evidence_unavailable"],
	] as const)(
		"keeps display winner separate from Queue Cleaner veto for %j",
		async (wire, display, reason) => {
			const f = await fixture(),
				hash = "abcd".repeat(10),
				good = "e".repeat(40);
			inventory.mockResolvedValue({
				complete: true,
				torrents: wire
					.map((state, instanceId) => ({ hash, state, ratio: 1, instanceId }))
					.concat([{ hash: good, state: "uploading", ratio: 1, instanceId: 99 }]),
			});
			expect((await runQuiTorrentStateSync(f.app)).errors).toBe(0);
			expect((await f.read()).torrentState).toBe(display);
			expect(
				await resolveQuiAwareGateReasons(
					f.prisma,
					"owned",
					new Map([
						["target", hash],
						["known", good],
					]),
				),
			).toEqual(new Map([["target", reason]]));
		},
	);
	it("retries only an injected second native staging batch without replaying committed batch1 or provider reads", async () => {
		const f = await fixture(),
			hashes = Array.from({ length: 301 }, (_, i) => i.toString(16).padStart(40, "0"));
		inventory.mockResolvedValue({
			complete: true,
			torrents: hashes.map((hash) => ({ hash, state: "uploading", ratio: 1 })),
		});
		const transaction = f.prisma.$transaction.bind(f.prisma);
		let attempts = 0;
		// Precise classified-Busy fault INPUT, not a claim of real lock contention.
		vi.spyOn(f.prisma, "$transaction").mockImplementation((async (
			operation: any,
			...options: any[]
		) =>
			transaction(
				async (tx: any) =>
					operation(
						new Proxy(tx, {
							get(target, key) {
								if (key !== "quiTorrentObservation") return Reflect.get(target, key);
								const model = target.quiTorrentObservation;
								return new Proxy(model, {
									get(delegate, method) {
										if (method !== "createMany") return Reflect.get(delegate, method);
										return async (args: any) => {
											attempts++;
											if (attempts === 2)
												throw Object.assign(
													new Error("INJECTED_SECOND_BATCH_BUSY_NOT_REAL_CONTENTION"),
													{
														code: "P1008",
														meta: {
															driverAdapterError: {
																cause: { originalCode: "SQLITE_BUSY", kind: "SocketTimeout" },
															},
														},
													},
												);
											return model.createMany(args);
										};
									},
								});
							},
						}),
					),
				...options,
			)) as any);
		const result = await runQuiTorrentStateSync(f.app);
		console.info(
			"SECOND_BATCH_NATIVE_BOUNDARY",
			JSON.stringify({
				result,
				attempts,
				providerReads: inventory.mock.calls.length,
				head: await f.prisma.quiObservationPublication.findUnique({ where: { userId: "owned" } }),
				rows: await f.prisma.quiTorrentObservation.count({ where: { userId: "owned" } }),
				errorCodes: f.app.log.error.mock.calls.map((c: any) => c[0]?.err?.code ?? null),
				injectedBusy: true,
				realLockContention: false,
			}),
		);
		expect(result.errors).toBe(0);
		expect(inventory).toHaveBeenCalledTimes(1);
		expect(attempts).toBe(4);
		expect(
			await f.prisma.quiObservationPublication.findUniqueOrThrow({ where: { userId: "owned" } }),
		).toMatchObject({ complete: true, rowCount: 301 });
		expect(await f.prisma.quiTorrentObservation.count({ where: { userId: "owned" } })).toBe(301);
		expect(
			await f.prisma.quiTorrentObservation.findMany({
				where: { userId: "owned" },
				select: { infoHash: true },
				orderBy: { infoHash: "asc" },
			}),
		).toEqual(hashes.map((infoHash) => ({ infoHash })));
	});
	it.each<Phase>(["first-clear", "staging", "final-publication"])(
		"publishes once after a transient %s lock without rereading the provider",
		async (phase) => {
			const f = await fixture();
			const c = contend(f, phase, true);
			const result = await runQuiTorrentStateSync(f.app);
			expect(result.errors).toBe(0);
			expect(result.rowsUpdated).toBe(1);
			expect(inventory).toHaveBeenCalledTimes(1);
			expect(c.intermediate.length).toBeGreaterThan(0);
			for (const row of c.intermediate) {
				if (phase === "first-clear") expect(row.torrentState).toBe("paused");
				else expect(row.torrentSyncedAt).toBeNull();
			}
			const row = await f.read();
			expect(row.torrentState).toBe("seeding");
			expect(row.torrentRatio).toBe(2);
			expect(row.torrentSyncedAt).not.toBeNull();
			expect(row.torrentSyncedAt!.getTime()).toBeLessThanOrEqual(c.releasedAt()!);
			expect(await f.read("other-row")).toEqual({
				torrentState: "paused",
				torrentRatio: 0,
				torrentSyncedAt: new Date("2026-10-01T00:00:00Z"),
			});
		},
	);

	it.each<Phase>(["first-clear", "staging", "final-publication"])(
		"bounds persistent %s contention and recovers on the same client after release",
		async (phase) => {
			const f = await fixture();
			const c = contend(f, phase, false);
			const result = await runQuiTorrentStateSync(f.app);
			expect(result.errors).toBe(2);
			expect(result.rowsUpdated).toBe(0);
			expect(inventory).toHaveBeenCalledTimes(1);
			expect(c.intermediate.length).toBeLessThanOrEqual(8);
			const row = await f.read();
			expect(row.torrentSyncedAt === null).toBe(phase !== "first-clear");
			f.writer.exec("ROLLBACK");
			expect((await runQuiTorrentStateSync(f.app)).errors).toBe(0);
			expect((await f.read()).torrentState).toBe("seeding");
		},
	);

	it.each([
		["sqlite", { code: "P1008" }],
		[
			"sqlite",
			{
				code: "P1008",
				meta: {
					driverAdapterError: { cause: { originalCode: "SQLITE_IOERR", kind: "SocketTimeout" } },
				},
			},
		],
		[
			"postgresql",
			{
				code: "P1008",
				meta: {
					driverAdapterError: { cause: { originalCode: "SQLITE_BUSY", kind: "SocketTimeout" } },
				},
			},
		],
	] as const)(
		"does not retry ambiguous/non-SQLite errors (%s case %#)",
		async (provider, fields) => {
			const f = await fixture();
			f.app.dbProvider = provider;
			const transaction = f.prisma.$transaction.bind(f.prisma);
			const spy = vi
				.spyOn(f.prisma, "$transaction")
				.mockRejectedValueOnce(Object.assign(new Error("synthetic"), fields));
			spy.mockImplementationOnce(transaction as any);
			const result = await runQuiTorrentStateSync(f.app);
			expect(result.errors).toBe(1);
			expect(spy).toHaveBeenCalledTimes(3);
			expect((await f.read()).torrentSyncedAt).toBeNull();
		},
	);
});
