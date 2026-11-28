import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import {
	captureQuiObservationTopology,
	beginQuiObservationPublication,
	pruneQuiObservationGenerations,
	stageQuiTorrentObservations,
	completeQuiObservationPublication,
	readQuiTorrentObservations,
	invalidateQuiObservationPublication,
	invalidateQuiObservationTopology,
	withQuiObservationGenerationWrite,
} from "../torrent-observation-repository.js";

const fixtures: Awaited<ReturnType<typeof buildFixture>>[] = [];
async function fixture() {
	const f = await buildFixture();
	fixtures.push(f);
	return f;
}
async function buildFixture() {
	const directory = await mkdtemp(join(tmpdir(), "qui-observation-repository-")),
		file = join(directory, "owned.db");
	new Database(file).close();
	await synchronizeRuntimeSchema("file:" + file);
	const runtime = await openRestoreRuntime({ databaseUrl: "file:" + file });
	await runtime.bindDestination("synthetic-observation-repository");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime),
		prisma = native.prisma,
		run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn),
		key = new Encryptor("33".repeat(32)).encrypt("synthetic-token");
	await run(async () => {
		for (const id of ["owner", "foreign"])
			await prisma.user.create({ data: { id, username: "synthetic-" + id } });
		for (const userId of ["owner", "foreign"])
			await prisma.serviceInstance.create({
				data: {
					id: userId + "-qui",
					userId,
					service: "QUI",
					label: "Synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					connectionGeneration: 7,
					identityGeneration: 3,
				},
			});
	});
	const f = { directory, file, runtime, native, prisma, run };
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		await f.native.close();
		await f.runtime.close();
		const db = new Database(f.file, { readonly: true });
		expect(db.pragma("quick_check", { simple: true })).toBe("ok");
		db.close();
		await rm(f.directory, { recursive: true });
	}
});
const h = "a".repeat(40),
	other = "b".repeat(64);
async function publish(
	f: Awaited<ReturnType<typeof buildFixture>>,
	rows: { infoHash: string; state: string; ratio: number | null }[],
	owner = "owner",
	observedAt = new Date(),
) {
	return f.run(async () => {
		const topology = await captureQuiObservationTopology(f.prisma, owner),
			prior = await f.prisma.quiObservationPublication.findUnique({ where: { userId: owner } }),
			generation = await beginQuiObservationPublication(
				f.prisma,
				owner,
				topology.digest,
				rows.length,
				prior?.generation ?? null,
			);
		await pruneQuiObservationGenerations(f.prisma, owner, generation);
		await stageQuiTorrentObservations(f.prisma, owner, generation, rows);
		await completeQuiObservationPublication(
			f.prisma,
			owner,
			generation,
			topology.digest,
			rows.length,
			observedAt,
		);
		return { generation, topology };
	});
}

describe("typed owner/generation qUI observation publication on real native runtime", () => {
	it("fences a no-head publisher across explicit topology ABA invalidations", async () => {
		const f = await fixture(),
			topology = await f.run(() => captureQuiObservationTopology(f.prisma, "owner"));
		for (const baseUrl of ["http://changed.invalid", "http://synthetic.invalid"]) {
			await f.run(() =>
				f.prisma.$transaction(async (tx) => {
					await tx.serviceInstance.update({ where: { id: "owner-qui" }, data: { baseUrl } });
					await invalidateQuiObservationTopology(tx, "owner");
				}),
			);
		}
		expect((await f.run(() => captureQuiObservationTopology(f.prisma, "owner"))).digest).toBe(
			topology.digest,
		);
		await expect(
			f.run(() => beginQuiObservationPublication(f.prisma, "owner", topology.digest, 0, null)),
		).rejects.toThrow();
		await publish(f, []);
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"available",
		);
	});
	it("refuses newly enabled source authority before returning optional no-source behavior", async () => {
		const f = await fixture();
		await f.run(() =>
			f.prisma.serviceInstance.update({ where: { id: "owner-qui" }, data: { enabled: false } }),
		);
		const transaction = f.prisma.$transaction.bind(f.prisma),
			spy = vi.spyOn(f.prisma, "$transaction");
		spy.mockImplementationOnce((async (...args: any[]) => {
			const value = await transaction(...(args as Parameters<typeof transaction>));
			await f.prisma.serviceInstance.update({
				where: { id: "owner-qui" },
				data: { enabled: true },
			});
			return value;
		}) as any);
		try {
			expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
				"unavailable",
			);
		} finally {
			spy.mockRestore();
		}
		await publish(f, []);
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"available",
		);
	});
	it.each(["source", "count", "head"])(
		"rejects an actual %s change committed between snapshot and reader return",
		async (kind) => {
			const f = await fixture();
			await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
			const transaction = f.prisma.$transaction.bind(f.prisma),
				spy = vi.spyOn(f.prisma, "$transaction");
			spy.mockImplementationOnce((async (...args: any[]) => {
				const result = await transaction(...(args as Parameters<typeof transaction>));
				if (kind === "source")
					await f.prisma.serviceInstance.update({
						where: { id: "owner-qui" },
						data: { connectionGeneration: { increment: 1 } },
					});
				else if (kind === "count")
					await f.prisma.quiTorrentObservation.deleteMany({ where: { userId: "owner" } });
				else {
					const head = await f.prisma.quiObservationPublication.findUniqueOrThrow({
						where: { userId: "owner" },
					});
					await invalidateQuiObservationPublication(f.prisma, "owner", head.generation);
				}
				return result;
			}) as any);
			try {
				expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
					"unavailable",
				);
			} finally {
				spy.mockRestore();
			}
			await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
			expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
				"available",
			);
		},
	);
	it("publishes unmatched hash independently of Library correlation and proves complete absence", async () => {
		const f = await fixture();
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		const read = await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h, other]));
		expect(read.status).toBe("available");
		if (read.status === "available") {
			expect(read.rows.get(h)).toEqual({ state: "seeding", ratio: 1 });
			expect(read.rows.has(other)).toBe(false);
		}
		expect(await f.run(() => f.prisma.libraryCache.count())).toBe(0);
		await publish(f, []);
		const empty = await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]));
		expect(empty.status).toBe("available");
		if (empty.status === "available") expect(empty.rows.size).toBe(0);
	});
	it("never makes missing/in-flight/partial publication authoritative and recovers normally", async () => {
		const f = await fixture();
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
		const topo = await f.run(() => captureQuiObservationTopology(f.prisma, "owner")),
			gen = await f.run(() =>
				beginQuiObservationPublication(f.prisma, "owner", topo.digest, 2, null),
			);
		await f.run(() =>
			stageQuiTorrentObservations(f.prisma, "owner", gen, [
				{ infoHash: h, state: "seeding", ratio: 1 },
			]),
		);
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
		await expect(
			f.run(() =>
				completeQuiObservationPublication(f.prisma, "owner", gen, topo.digest, 2, new Date()),
			),
		).rejects.toThrow();
		await publish(f, [{ infoHash: h, state: "paused", ratio: null }]);
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"available",
		);
	});
	it("rejects future, stale, wrong count and wrong row shape without legacy fallback", async () => {
		const f = await fixture();
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		const now = new Date();
		for (const observedAt of [
			new Date(now.getTime() + 60000),
			new Date(now.getTime() - 31 * 60000),
		]) {
			await f.run(() =>
				f.prisma.quiObservationPublication.update({
					where: { userId: "owner" },
					data: { observedAt },
				}),
			);
			expect(
				(await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h], now))).status,
			).toBe("unavailable");
		}
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		await f.run(() => f.prisma.quiTorrentObservation.deleteMany({ where: { userId: "owner" } }));
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		await f.run(() =>
			f.prisma.quiTorrentObservation.updateMany({
				where: { userId: "owner" },
				data: { state: "invalid-native-corruption-control" },
			}),
		);
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
	});
	it("rejects topology add/remove/repoint/generation changes and preserves foreign generations", async () => {
		const f = await fixture();
		const foreign = await publish(f, [{ infoHash: h, state: "error", ratio: null }], "foreign");
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		for (const data of [
			{ baseUrl: "http://changed.invalid" },
			{ connectionGeneration: 8 },
			{ identityGeneration: 4 },
			{ enabled: false },
		]) {
			await f.run(() => f.prisma.serviceInstance.update({ where: { id: "owner-qui" }, data }));
			const read = await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]));
			expect(read.status).toBe(data.enabled === false ? "not_configured" : "unavailable");
			if (data.enabled !== false) await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		}
		expect(
			(
				await f.run(() =>
					f.prisma.quiObservationPublication.findUnique({ where: { userId: "foreign" } }),
				)
			)?.generation,
		).toBe(foreign.generation);
		await f.run(() =>
			f.prisma.serviceInstance.update({ where: { id: "owner-qui" }, data: { enabled: true } }),
		);
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		const q = await f.run(() =>
			f.prisma.serviceInstance.findUniqueOrThrow({ where: { id: "owner-qui" } }),
		);
		await f.run(() => f.prisma.serviceInstance.create({ data: { ...q, id: "owner-added" } }));
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
		await f.run(() => f.prisma.serviceInstance.delete({ where: { id: "owner-added" } }));
	});
	it("fences stale staging/finalization/invalidation and injected callback failure from newer publication", async () => {
		const f = await fixture(),
			first = await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]),
			second = await publish(f, [{ infoHash: h, state: "paused", ratio: null }]);
		await expect(
			f.run(() =>
				stageQuiTorrentObservations(f.prisma, "owner", first.generation, [
					{ infoHash: other, state: "seeding", ratio: 2 },
				]),
			),
		).rejects.toThrow();
		await expect(
			f.run(() => pruneQuiObservationGenerations(f.prisma, "owner", first.generation)),
		).rejects.toThrow();
		await expect(
			f.run(() =>
				completeQuiObservationPublication(
					f.prisma,
					"owner",
					first.generation,
					first.topology.digest,
					1,
					new Date(),
				),
			),
		).rejects.toThrow();
		expect(
			await f.run(() => invalidateQuiObservationPublication(f.prisma, "owner", first.generation)),
		).toBeNull();
		expect(
			(
				await f.run(() =>
					f.prisma.quiObservationPublication.findUniqueOrThrow({ where: { userId: "owner" } }),
				)
			).generation,
		).toBe(second.generation);
		const gen = await f.run(() =>
			beginQuiObservationPublication(
				f.prisma,
				"owner",
				second.topology.digest,
				1,
				second.generation,
			),
		);
		await expect(
			f.run(() =>
				withQuiObservationGenerationWrite(f.prisma, "owner", gen, async () => {
					throw new Error("INJECTED_CALLBACK_FAILURE_NOT_SQLITE_CONTENTION");
				}),
			),
		).rejects.toThrow("INJECTED_CALLBACK_FAILURE");
		expect((await f.run(() => readQuiTorrentObservations(f.prisma, "owner", [h]))).status).toBe(
			"unavailable",
		);
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
	});
	it("bounds native batches, rejects duplicate/45hex and reclaims exact owner crash leftovers", async () => {
		const f = await fixture(),
			rows = Array.from({ length: 1501 }, (_, i) => ({
				infoHash: (i + 1).toString(16).padStart(40, "0"),
				state: "seeding",
				ratio: 1,
			}));
		await publish(f, rows);
		expect(
			await f.run(() => f.prisma.quiTorrentObservation.count({ where: { userId: "owner" } })),
		).toBe(1501);
		await f.run(() =>
			f.prisma.quiTorrentObservation.create({
				data: {
					userId: "owner",
					generation: "explicit-crash-leftover-input",
					infoHash: other,
					state: "seeding",
					ratio: 1,
				},
			}),
		);
		await publish(f, [{ infoHash: h, state: "seeding", ratio: 1 }]);
		expect(
			await f.run(() => f.prisma.quiTorrentObservation.count({ where: { userId: "owner" } })),
		).toBe(1);
		for (const bad of [
			[{ infoHash: "a".repeat(45), state: "seeding", ratio: 1 }],
			[
				{ infoHash: h, state: "seeding", ratio: 1 },
				{ infoHash: h, state: "paused", ratio: null },
			],
		])
			await expect(publish(f, bad)).rejects.toThrow();
		await publish(f, []);
		expect(
			await f.run(() => f.prisma.quiTorrentObservation.count({ where: { userId: "owner" } })),
		).toBe(0);
	});
});
