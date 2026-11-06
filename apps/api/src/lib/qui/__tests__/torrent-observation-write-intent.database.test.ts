import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { RestoreRuntimeAdmissionError } from "../../backup/restore-runtime-admission.js";
import {
	isRetryableSqlitePublicationStartRefusal,
	withIsolatedRuntimePrismaTransaction,
} from "../../backup/restore-runtime-client.js";
import * as sqlite from "../../sqlite-adapter.js";
const { inventory } = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("../client-factory.js", () => ({
	createQuiClient: () => ({ listTorrentInventory: inventory }),
}));
vi.mock("../instance-helpers.js", () => ({
	listQuiInstances: async () => [
		{ id: "synthetic-qui", userId: "synthetic-user", label: "Synthetic" },
	],
}));
import { runQuiTorrentStateSync } from "../torrent-state-sync.js";
import {
	beginQuiObservationPublication,
	captureQuiObservationTopology,
	invalidateQuiObservationPublication,
	withQuiObservationGenerationWrite,
} from "../torrent-observation-repository.js";

afterEach(closeScopedWriteFixtures);

const hash = "a".repeat(40);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture() {
	const f = await createScopedWriteFixture();
	await f.plain.serviceInstance.create({
		data: {
			id: "synthetic-qui",
			userId: "synthetic-user",
			service: "QUI",
			label: "Synthetic",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
	});
	await f.plain.user.create({ data: { id: "other-user", username: "other-user" } });
	for (const userId of ["synthetic-user", "other-user"]) {
		await f.plain.quiObservationPublication.create({
			data: {
				userId,
				generation: "previous",
				topologyDigest: "previous-topology",
				rowCount: 1,
				complete: false,
			},
		});
		await f.plain.quiTorrentObservation.create({
			data: { userId, generation: "previous", infoHash: hash, state: "paused", ratio: 0 },
		});
	}
	const topology = await captureQuiObservationTopology(f.plain, "synthetic-user");
	return {
		...f,
		topology,
		protectedQuiRows: async () => ({
			head: await f.plain.quiObservationPublication.findUnique({ where: { userId: "other-user" } }),
			rows: await f.plain.quiTorrentObservation.findMany({ where: { userId: "other-user" } }),
		}),
	};
}

describe("qUI observation guarded SQLite write admission", { timeout: 30_000 }, () => {
	// Break caught: a physically discarded, unentered prune start must not abort
	// a complete scan; entered callbacks and committed earlier work never replay.
	it.each([false, true])(
		"publication admission retry bounds native prune start refusal (persistent=%s)",
		async (persistent) => {
			let armed = false,
				starts = 0,
				heldStarts = 0;
			const createAdapter = sqlite.createRecoverableSqliteAdapter;
			vi.spyOn(sqlite, "createRecoverableSqliteAdapter").mockImplementation((...args) => {
				const adapter = createAdapter(...args),
					connect = adapter.connect.bind(adapter);
				vi.spyOn(adapter, "connect").mockImplementation(async () => {
					const driver = await connect(),
						start = driver.startTransaction.bind(driver);
					return new Proxy(driver, {
						get(target, property) {
							if (property === "startTransaction")
								return async (...args: Parameters<typeof start>) => {
									const ordinal = armed ? ++starts : 0;
									const transaction = await start(...args);
									if (ordinal >= 2 && ordinal < 2 + (persistent ? 4 : 1)) {
										heldStarts++;
										await delay(2200);
									}
									return transaction;
								};
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				});
				return adapter;
			});
			const f = await fixture(),
				before = snapshotProtectedRows(f),
				beforeQui = await f.protectedQuiRows();
			const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			inventory.mockReset().mockResolvedValue({
				complete: true,
				torrents: [{ hash, state: "uploading", ratio: 1 }],
			});
			armed = true;
			const result = await f.runtime.runOperation(() =>
				runQuiTorrentStateSync({
					prisma: f.client.prisma,
					dbProvider: "sqlite",
					log,
				} as unknown as FastifyInstance),
			);
			const head = await f.plain.quiObservationPublication.findUniqueOrThrow({
				where: { userId: "synthetic-user" },
			});
			recordScopedWriteEvidence(
				`qui-publication-admission-retry-${persistent ? "persistent" : "transient"}`,
				{
					starts,
					heldStarts,
					providerReads: inventory.mock.calls.length,
					result,
					complete: head.complete,
					errorCodes: log.error.mock.calls.map((call) => call[0]?.err?.code ?? null),
					nativeStartDelayInjected: true,
					actualHostLockCauseReproduced: false,
				},
			);
			expect(heldStarts).toBe(persistent ? 4 : 1);
			if (result.errors) expect(log.error.mock.calls[0]?.[0]?.err).toMatchObject({ code: "P2028" });
			expect(result.errors).toBe(persistent ? 1 : 0);
			expect(inventory).toHaveBeenCalledTimes(1);
			expect(head).toMatchObject({ complete: !persistent, rowCount: persistent ? 0 : 1 });
			expect(head.generation).not.toBe("previous");
			expect(
				await f.plain.quiTorrentObservation.findMany({ where: { userId: "synthetic-user" } }),
			).toEqual([
				expect.objectContaining({
					generation: persistent ? "previous" : head.generation,
					infoHash: hash,
					state: persistent ? "paused" : "seeding",
				}),
			]);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(await f.protectedQuiRows()).toEqual(beforeQui);
			expect(f.losses).toEqual([]);
		},
	);

	it("publication admission retry never grants proof to an entered P2028 or a foreign error", async () => {
		const f = await fixture(),
			before = snapshotProtectedRows(f),
			beforeQui = await f.protectedQuiRows();
		const failure = Object.assign(new Error("Synthetic entered transaction failure"), {
			code: "P2028",
		});
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
					callbacks++;
					await tx.quiTorrentObservation.updateMany({
						where: { userId: "synthetic-user" },
						data: { state: "seeding" },
					});
					throw failure;
				}),
			),
		).rejects.toBe(failure);
		expect(callbacks).toBe(1);
		expect(isRetryableSqlitePublicationStartRefusal(failure)).toBe(false);
		expect(
			isRetryableSqlitePublicationStartRefusal(
				Object.assign(new Error("Synthetic foreign timeout"), { code: "P2028" }),
			),
		).toBe(false);
		expect(isRetryableSqlitePublicationStartRefusal(null)).toBe(false);
		expect(isRetryableSqlitePublicationStartRefusal("P2028")).toBe(false);
		expect(
			await f.plain.quiTorrentObservation.findFirstOrThrow({ where: { userId: "synthetic-user" } }),
		).toMatchObject({ state: "paused" });
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(await f.protectedQuiRows()).toEqual(beforeQui);
		expect(f.losses).toEqual([]);
	});

	// Break caught: Prisma may refuse a native start before its physical
	// admission/rollback settles. That connection must not be lent again yet.
	it("joins timed-out native publication admission before lending the companion again", async () => {
		const held = deferred(),
			release = deferred();
		let armed = false,
			starts = 0;
		const createAdapter = sqlite.createRecoverableSqliteAdapter;
		vi.spyOn(sqlite, "createRecoverableSqliteAdapter").mockImplementation((...args) => {
			const adapter = createAdapter(...args),
				connect = adapter.connect.bind(adapter);
			vi.spyOn(adapter, "connect").mockImplementation(async () => {
				const driver = await connect(),
					start = driver.startTransaction.bind(driver);
				return new Proxy(driver, {
					get(target, property) {
						if (property === "startTransaction")
							return async (...args: Parameters<typeof start>) => {
								const ordinal = armed ? ++starts : 0;
								const transaction = await start(...args);
								if (ordinal === 1) {
									held.resolve();
									await release.promise;
								}
								return transaction;
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			});
			return adapter;
		});
		const f = await fixture();
		const before = snapshotProtectedRows(f),
			beforeQui = await f.protectedQuiRows();
		armed = true;
		let callbacks = 0,
			firstSettled = false;
		const result = await f.runtime.runOperation(async () => {
			const first = withIsolatedRuntimePrismaTransaction(
				f.client.prisma,
				async () => {
					callbacks++;
				},
				{ maxWait: 40 },
			)
				.catch((error: unknown) => error)
				.finally(() => {
					firstSettled = true;
				});
			await held.promise;
			await delay(100);
			const second = withIsolatedRuntimePrismaTransaction(
				f.client.prisma,
				(tx) => tx.quiObservationPublication.count(),
				{ maxWait: 1000 },
			);
			let beforeRelease: { starts: number; firstSettled: boolean };
			try {
				await delay(20);
				beforeRelease = { starts, firstSettled };
			} finally {
				release.resolve();
			}
			const [failure, nextCount] = await Promise.all([first, second]);
			return { beforeRelease, failure, nextCount };
		});
		recordScopedWriteEvidence("qui-publication-start-timeout", {
			beforeRelease: result.beforeRelease,
			starts,
			callbacks,
			failureCode:
				result.failure instanceof Error && "code" in result.failure ? result.failure.code : null,
			nextCount: result.nextCount,
		});
		expect(result.beforeRelease).toEqual({ starts: 1, firstSettled: false });
		expect(result.failure).toMatchObject({ code: "P2028" });
		expect(isRetryableSqlitePublicationStartRefusal(result.failure)).toBe(true);
		expect(isRetryableSqlitePublicationStartRefusal({ code: "P2028" })).toBe(false);
		// An old refusal object cannot authorize replay if a later callback
		// enters and throws that same object.
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, async () => {
					throw result.failure;
				}),
			),
		).rejects.toBe(result.failure);
		expect(isRetryableSqlitePublicationStartRefusal(result.failure)).toBe(false);
		expect(result.nextCount).toBe(2);
		expect(callbacks).toBe(0);
		expect(starts).toBe(3);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(await f.protectedQuiRows()).toEqual(beforeQui);
		expect(f.losses).toEqual([]);
	});

	// Break caught: a timed-out waiter must be removed, not enter after its
	// caller has already been told that publication admission failed.
	it("expires queued publication admission without later entering its callback", async () => {
		const f = await fixture();
		const entered = deferred(),
			release = deferred();
		let expiredCalls = 0;
		const active = f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
				entered.resolve();
				await release.promise;
				return tx.quiObservationPublication.count();
			}),
		);
		try {
			await entered.promise;
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaTransaction(
						f.client.prisma,
						async () => {
							expiredCalls++;
						},
						{ maxWait: 40 },
					),
				),
			).rejects.toBeInstanceOf(RestoreRuntimeAdmissionError);
			expect(expiredCalls).toBe(0);
		} finally {
			release.resolve();
			await active;
		}
		expect(
			await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, (tx) =>
					tx.quiObservationPublication.count(),
				),
			),
		).toBe(2);
		expect(expiredCalls).toBe(0);
		expect(f.losses).toEqual([]);
	});

	// Break caught: an entered callback failure must roll back once and release
	// the shared connection to queued callers in order, without replaying work.
	it("releases publication admission after rollback and serves queued callers in order", async () => {
		const f = await fixture();
		const entered = deferred(),
			release = deferred();
		const rejection = new Error("Synthetic queued publication rollback");
		const order: string[] = [];
		const first = f.runtime
			.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
					order.push("first");
					await tx.quiTorrentObservation.updateMany({
						where: { userId: "synthetic-user" },
						data: { state: "seeding" },
					});
					entered.resolve();
					await release.promise;
					throw rejection;
				}),
			)
			.catch((error: unknown) => error);
		await entered.promise;
		const second = f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
				order.push("second");
				return tx.quiTorrentObservation.findFirstOrThrow({ where: { userId: "synthetic-user" } });
			}),
		);
		const third = f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
				order.push("third");
				return tx.quiObservationPublication.count();
			}),
		);
		try {
			await delay(20);
			expect(order).toEqual(["first"]);
		} finally {
			release.resolve();
		}
		expect(await first).toBe(rejection);
		expect(await second).toMatchObject({ state: "paused" });
		expect(await third).toBe(2);
		expect(order).toEqual(["first", "second", "third"]);
		expect(f.losses).toEqual([]);
	});

	// Break caught: closing the client must immediately cancel queued admission
	// even while the active callback is still held, and refuse future work.
	it("cancels queued publication admission on client closure before releasing active work", async () => {
		const f = await fixture();
		const entered = deferred(),
			release = deferred();
		let queuedCalls = 0;
		const first = f.runtime
			.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, async () => {
					entered.resolve();
					await release.promise;
				}),
			)
			.catch(() => undefined);
		await entered.promise;
		const queued = f.runtime
			.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(
					f.client.prisma,
					async () => {
						queuedCalls++;
					},
					{ maxWait: 1000 },
				),
			)
			.catch((error: unknown) => error);
		await delay(20);
		const closing = f.client.close();
		try {
			expect(await queued).toBeInstanceOf(RestoreRuntimeAdmissionError);
			expect(queuedCalls).toBe(0);
		} finally {
			release.resolve();
		}
		await first;
		await closing;
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaTransaction(f.client.prisma, async () => {
					queuedCalls++;
				}),
			),
		).rejects.toBeInstanceOf(RestoreRuntimeAdmissionError);
		expect(queuedCalls).toBe(0);
	});

	// Break caught: runtime admission closure must not cancel already-accepted
	// queued publication or let drain finish before those transactions settle.
	it("retains accepted queued publication admission through runtime drain", async () => {
		const f = await fixture();
		const entered = deferred(),
			release = deferred();
		let drained = false;
		let draining!: Promise<void>;
		const results = await f.runtime.runOperation(async () => {
			const first = withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
				entered.resolve();
				await release.promise;
				return tx.quiObservationPublication.count();
			});
			await entered.promise;
			const second = withIsolatedRuntimePrismaTransaction(f.client.prisma, (tx) =>
				tx.quiObservationPublication.count(),
			);
			f.runtime.closeAdmission();
			draining = f.runtime.drain().then(() => {
				drained = true;
			});
			try {
				await delay(20);
				expect(drained).toBe(false);
			} finally {
				release.resolve();
			}
			return Promise.all([first, second]);
		});
		await draining;
		expect(results).toEqual([2, 2]);
		expect(drained).toBe(true);
		await expect(f.runtime.runOperation(() => 1)).rejects.toBeInstanceOf(
			RestoreRuntimeAdmissionError,
		);
		expect(f.losses).toEqual([]);
	});

	it("serializes concurrent publication admission before guard reads can pin another writer", async () => {
		let current: Awaited<ReturnType<typeof fixture>> | undefined;
		let held = false;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const createAdapter = sqlite.createRecoverableSqliteAdapter;
		vi.spyOn(sqlite, "createRecoverableSqliteAdapter").mockImplementation((...args) => {
			const adapter = createAdapter(...args),
				connect = adapter.connect.bind(adapter);
			vi.spyOn(adapter, "connect").mockImplementation(async () => {
				const driver = await connect(),
					start = driver.startTransaction.bind(driver);
				return new Proxy(driver, {
					get(target, property) {
						if (property === "startTransaction")
							return async (...args: Parameters<typeof start>) => {
								const transaction = await start(...args);
								if (!held && current) {
									held = true;
									await barrier;
								}
								return transaction;
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			});
			return adapter;
		});
		const f = await fixture();
		current = f;
		const protectedRows = snapshotProtectedRows(f),
			protectedQuiRows = await f.protectedQuiRows();
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		const first = f.runtime
			.runOperation(() =>
				beginQuiObservationPublication(
					f.client.prisma,
					"synthetic-user",
					f.topology.digest,
					1,
					"previous",
				),
			)
			.then(
				(value) => ({ ok: true as const, value }),
				() => ({ ok: false as const }),
			);
		let second: Promise<{ ok: boolean }> | undefined;
		try {
			await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000, interval: 5 });
			second = f.runtime
				.runOperation(() =>
					withIsolatedRuntimePrismaTransaction(f.client.prisma, (tx) =>
						tx.quiObservationPublication.count(),
					),
				)
				.then(
					() => ({ ok: true }),
					() => ({ ok: false }),
				);
			// Give the actual second admission an opportunity to reach its guard.
			// The first transaction remains held regardless of scheduling speed.
			await delay(100);
		} finally {
			release();
		}
		const results = await Promise.all([first, second]);
		recordScopedWriteEvidence("qui-concurrent-publication-admission", {
			held,
			competition,
			completed: results.map((r) => r?.ok ?? false),
		});
		expect(held).toBe(true);
		expect(results.map((r) => r?.ok)).toEqual([true, true]);
		expect(competition.commits).toBe(0);
		expect(competition.blocked).toBe(1);
		expect(competition.reservations).toBe(1);
		expect(competition.nativeErrors).not.toContain("SQLITE_BUSY_SNAPSHOT");
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(await f.protectedQuiRows()).toEqual(protectedQuiRows);
	});

	// Break caught: a committed writer between runtime guard reads and the first
	// publication write must not turn a valid fenced update into BUSY_SNAPSHOT.
	it.each(["begin", "generation-write", "invalidate-new"] as const)(
		"reserves the writer before guarded reads for %s without replaying work",
		async (phase) => {
			const f = await fixture();
			if (phase === "invalidate-new") {
				await f.plain.quiObservationPublication.delete({ where: { userId: "synthetic-user" } });
			}
			const protectedRows = snapshotProtectedRows(f);
			const protectedQuiRows = await f.protectedQuiRows();
			const competition = interceptScopedWriteCompetition(f, { compete: true });
			let callbacks = 0;
			let failure: unknown;
			let result: unknown;
			try {
				result = await f.runtime.runOperation(async () => {
					const prisma = f.client.prisma;
					if (phase === "begin") {
						return beginQuiObservationPublication(
							prisma,
							"synthetic-user",
							f.topology.digest,
							1,
							"previous",
						);
					}
					if (phase === "invalidate-new") {
						return invalidateQuiObservationPublication(prisma, "synthetic-user", null);
					}
					return withQuiObservationGenerationWrite(
						prisma,
						"synthetic-user",
						"previous",
						async (tx) => {
							callbacks++;
							return (
								await tx.quiTorrentObservation.updateMany({
									where: { userId: "synthetic-user", generation: "previous", infoHash: hash },
									data: { state: "seeding", ratio: 2 },
								})
							).count;
						},
					);
				});
			} catch (error) {
				failure = error;
			}
			recordScopedWriteEvidence(`qui-${phase}-competing-commit`, {
				competition,
				failed: failure !== undefined,
				callbacks,
			});
			expect(failure).toBeUndefined();
			expect(competition).toMatchObject({
				reservations: 1,
				commits: 0,
				blocked: 1,
				nativeErrors: [],
			});
			const head = await f.plain.quiObservationPublication.findUniqueOrThrow({
				where: { userId: "synthetic-user" },
			});
			expect(head.complete).toBe(false);
			expect(head.observedAt).toBeNull();
			if (phase === "generation-write") {
				expect(result).toBe(1);
				expect(callbacks).toBe(1);
				expect(head.generation).toBe("previous");
				expect(
					await f.plain.quiTorrentObservation.findFirstOrThrow({
						where: { userId: "synthetic-user" },
					}),
				).toMatchObject({ state: "seeding", ratio: 2 });
			} else {
				expect(callbacks).toBe(0);
				expect(typeof result).toBe("string");
				expect(head.generation).toBe(result);
				expect(head.generation).not.toBe("previous");
				expect(head.rowCount).toBe(phase === "begin" ? 1 : 0);
			}
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			expect(await f.protectedQuiRows()).toEqual(protectedQuiRows);
			expect(f.losses).toEqual([]);
		},
	);

	// Break caught: admission must not bypass a superseded generation fence.
	it("refuses a superseded generation without entering the write callback", async () => {
		const f = await fixture();
		const before = await f.plain.quiObservationPublication.findMany();
		const rows = await f.plain.quiTorrentObservation.findMany();
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withQuiObservationGenerationWrite(
					f.client.prisma,
					"synthetic-user",
					"obsolete",
					async () => {
						callbacks++;
					},
				),
			),
		).rejects.toThrow("qUI observation generation or source changed");
		expect(callbacks).toBe(0);
		expect(await f.plain.quiObservationPublication.findMany()).toEqual(before);
		expect(await f.plain.quiTorrentObservation.findMany()).toEqual(rows);
		expect(f.losses).toEqual([]);
	});

	// Break caught: entered publication work is rolled back, not replayed, when
	// the callback fails after updating a projection.
	it("rolls back an entered write and propagates the same rejection once", async () => {
		const f = await fixture();
		const before = await f.plain.quiTorrentObservation.findMany();
		const rejection = new Error("Synthetic publication refusal");
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withQuiObservationGenerationWrite(
					f.client.prisma,
					"synthetic-user",
					"previous",
					async (tx) => {
						callbacks++;
						await tx.quiTorrentObservation.updateMany({
							where: { userId: "synthetic-user" },
							data: { state: "seeding" },
						});
						throw rejection;
					},
				),
			),
		).rejects.toBe(rejection);
		expect(callbacks).toBe(1);
		expect(await f.plain.quiTorrentObservation.findMany()).toEqual(before);
		expect(f.losses).toEqual([]);
	});
});
