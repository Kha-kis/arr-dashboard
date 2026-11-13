import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	recordScopedWriteEvidence,
} from "../../__tests__/scoped-write-intent-fixture.js";
import type { PrismaClientInstance } from "../../prisma.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import {
	withIsolatedRuntimePrismaBulkReadClient,
	withIsolatedRuntimePrismaReadClient,
} from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// The cast lets the regression exercise the missing option against the baseline.
const phased = withIsolatedRuntimePrismaBulkReadClient as <T>(
	client: PrismaClientInstance,
	operation: (client: PrismaClientInstance) => Promise<T>,
	options: { lease: "phase" },
) => Promise<T>;

describe("cached read phase admission", { timeout: 20_000 }, () => {
	it("records only bounded generic ownership on a real mixed-lane timeout", async () => {
		const f = await createScopedWriteFixture();
		const app = Fastify({ logger: false });
		app.decorate("restoreRuntime", f.runtime);
		await app.register(lifecyclePlugin);
		const holders = [
			["/api/library/provider-inventory", "primary-inventory", undefined],
			["/api/library/poster/:instanceId/:itemType/:itemId", "library-poster", undefined],
			["/api/plex/watch-enrichment", "plex-watch", "bulk-cache"],
			["/api/jellyfin/series-progress", "jellyfin-series", "bulk-cache"],
		] as const;
		const ready = holders.map(signal),
			release = holders.map(signal);
		const queued = [signal(), signal()],
			nextReady = [signal(), signal()],
			nextRelease = [signal(), signal()];
		const nextEntered = [false, false];
		const native = new Set<Database.Database>();
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (this.name === f.path && this !== f.writer) native.add(this);
			return prepare.call(this, sql);
		});
		for (const [i, [url, , workload]] of holders.entries())
			app.get(url, async () =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async (reader) => {
						expect(
							await reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						).toBe(2);
						ready[i]!.resolve();
						await release[i]!.promise;
						return { ok: true };
					},
					{ workload },
				),
			);
		for (const [i, url] of ["/api/plex/on-deck", "/api/jellyfin/on-deck"].entries())
			app.get(url, () => {
				queued[i]!.resolve();
				return withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async (reader) => {
						expect(
							await reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						).toBe(2);
						nextEntered[i] = true;
						nextReady[i]!.resolve();
						await nextRelease[i]!.promise;
						return { ok: true };
					},
					{ workload: "bulk-cache" },
				);
			});
		let captured: Error | undefined,
			entered = false;
		app.setErrorHandler<Error>((error, _request, reply) => {
			captured = error;
			return reply.code(503).send({ error: error.name, message: error.message });
		});
		app.get("/api/plex/series-progress", () =>
			withIsolatedRuntimePrismaReadClient(
				f.client.prisma,
				async () => {
					entered = true;
					return { ok: true };
				},
				{ maxWait: 40 },
			),
		);
		const pending = holders.map(([url]) =>
			app.inject(
				url.replace(":instanceId/:itemType/:itemId", "private-instance/movie/private-item") +
					"?private=decoy",
			),
		);
		const following: Array<PromiseLike<unknown>> = [];
		try {
			await Promise.all(ready.map((s) => s.promise));
			following.push(app.inject("/api/plex/on-deck"));
			await queued[0]!.promise;
			following.push(app.inject("/api/jellyfin/on-deck"));
			await queued[1]!.promise;
			const response = await app.inject("/api/plex/series-progress?private=not-a-category");
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({
				error: "RestoreRuntimeAdmissionError",
				message: "Restore runtime admission is unavailable.",
			});
			expect(entered).toBe(false);
			const queue = Reflect.get(captured!, "readQueue");
			expect(queue).toEqual({
				reason: "read-lane-acquisition-timeout",
				source: "plex-series",
				workload: "ordinary",
				maxWaitMs: 40,
				waitedMs: expect.any(Number),
				queuedWaiters: 2,
				busyLanes: holders.map(([, source, workload]) => ({
					source,
					workload: workload ?? "ordinary",
					heldMs: expect.any(Number),
				})),
			});
			expect(Object.isFrozen(queue)).toBe(true);
			expect(Object.isFrozen(queue.busyLanes)).toBe(true);
			expect(queue.busyLanes.every(Object.isFrozen)).toBe(true);
			for (const ms of [
				queue.waitedMs,
				...queue.busyLanes.map((lane: { heldMs: number }) => lane.heldMs),
			])
				expect(Number.isFinite(ms) && ms >= 0).toBe(true);
			const serialized = pino.stdSerializers.err(captured!);
			expect(serialized.readQueue).toEqual(queue);
			expect(JSON.stringify(queue)).not.toMatch(
				/private|synthetic|SELECT|userId|instanceId|callback|client/,
			);
			const frozen = JSON.stringify(queue);
			release[2]!.resolve();
			await nextReady[0]!.promise;
			expect(nextEntered).toEqual([true, false]);
			expect((await app.inject("/api/plex/series-progress")).statusCode).toBe(503);
			const handed = Reflect.get(captured!, "readQueue");
			expect(handed.queuedWaiters).toBe(1);
			expect(handed.busyLanes[2]).toEqual({
				source: "plex-on-deck",
				workload: "bulk-cache",
				heldMs: expect.any(Number),
			});
			nextRelease[0]!.resolve();
			await nextReady[1]!.promise;
			expect((await app.inject("/api/plex/series-progress")).statusCode).toBe(503);
			const afterHandoff = Reflect.get(captured!, "readQueue");
			expect(afterHandoff.queuedWaiters).toBe(0);
			expect(afterHandoff.busyLanes[2]).toEqual({
				source: "jellyfin-on-deck",
				workload: "bulk-cache",
				heldMs: expect.any(Number),
			});
			await f.runtime.runOperation(async () => {
				const clock = vi.spyOn(performance, "now").mockImplementation(() => {
					throw new Error("synthetic diagnostic clock failure");
				});
				try {
					const error = await withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							throw new Error("timeout callback entered");
						},
						{ maxWait: 1 },
					).catch((error) => error);
					expect(error).toMatchObject({
						name: "RestoreRuntimeAdmissionError",
						statusCode: 503,
						message: "Restore runtime admission is unavailable.",
					});
					expect(Reflect.has(error, "readQueue")).toBe(false);
				} finally {
					clock.mockRestore();
				}
			});
			for (const s of release) s.resolve();
			for (const s of nextRelease) s.resolve();
			await Promise.all(following);
			expect(
				(await Promise.all(pending)).every(
					(r) => r.statusCode === 200 && !r.body.includes("readQueue"),
				),
			).toBe(true);
			expect((await app.inject("/api/plex/series-progress")).statusCode).toBe(200);
			expect(JSON.stringify(queue)).toBe(frozen);
			recordScopedWriteEvidence("read-queue-native", {
				reason: queue.reason,
				source: queue.source,
				workload: queue.workload,
				busyLanes: queue.busyLanes,
				queuedWaiters: queue.queuedWaiters,
				callbackEnteredOnTimeout: false,
				progressAfterRelease: true,
				providerIo: 0,
			});
		} finally {
			for (const s of release) s.resolve();
			for (const s of nextRelease) s.resolve();
			await Promise.allSettled([...pending, ...following]);
			await app.close();
			await f.client.close();
			expect(native.size).toBeGreaterThanOrEqual(4);
			expect([...native].every((db) => !db.open)).toBe(true);
			recordScopedWriteEvidence("read-queue-native-closure", {
				nativeHandles: native.size,
				nativeHandlesClosedBeforeRemoval: [...native].every((db) => !db.open),
				losses: f.losses,
			});
		}
		expect(f.losses).toEqual([]);
	});
	it("admits another bulk read while two callbacks wait between independent phases", async () => {
		const f = await createScopedWriteFixture();
		const between = signal(),
			release = signal();
		let reached = 0;
		const holders = [0, 1].map(() =>
			f.runtime.runOperation(() =>
				phased(
					f.client.prisma,
					async (reader) => {
						expect(
							await reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						).toBe(2);
						if (++reached === 2) between.resolve();
						await release.promise;
						return reader.serviceInstance.count({ where: { userId: "synthetic-user" } });
					},
					{ lease: "phase" },
				),
			),
		);
		let probe: Promise<number> | undefined;
		try {
			await between.promise;
			probe = f.runtime.runOperation(() =>
				phased(
					f.client.prisma,
					(reader) => reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
					{ lease: "phase" },
				),
			);
			const guard = new AbortController();
			try {
				expect(
					await Promise.race([
						probe.then(() => "admitted-between-phases"),
						delay(1000, "bulk-slot-retained", { signal: guard.signal }),
					]),
				).toBe("admitted-between-phases");
			} finally {
				guard.abort();
			}
			expect(await probe).toBe(2);
		} finally {
			release.resolve();
			await Promise.allSettled([...holders, ...(probe ? [probe] : [])]);
		}
		expect(f.losses).toEqual([]);
	});

	it("keeps interactive snapshots intact and performs postchecks after settlement without retry", async () => {
		const f = await createScopedWriteFixture();
		let callbacks = 0;
		const sentinel = new Error("synthetic-phase-rollback");
		await f.runtime.runOperation(() =>
			phased(
				f.client.prisma,
				async (reader) => {
					const read = (client: Pick<PrismaClientInstance, "$queryRawUnsafe">) =>
						client.$queryRawUnsafe<Array<{ value: number }>>("SELECT value FROM CompetitionProbe");
					await expect(
						reader.$transaction(
							async (tx) => {
								callbacks++;
								expect(await read(tx)).toEqual([{ value: 0 }]);
								f.writer.exec("UPDATE CompetitionProbe SET value=1 WHERE id=1");
								expect(await read(tx)).toEqual([{ value: 0 }]);
								throw sentinel;
							},
							{ maxWait: 2000, timeout: 5000 },
						),
					).rejects.toBe(sentinel);
					expect(await read(reader)).toEqual([{ value: 1 }]);
					expect(
						await reader.$transaction([
							reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
							reader.$queryRaw`SELECT value FROM CompetitionProbe`,
						]),
					).toEqual([2, [{ value: 1 }]]);
				},
				{ lease: "phase" },
			),
		);
		expect(callbacks).toBe(1);
		expect(f.losses).toEqual([]);
	});

	it("refuses foreign, consumed, duplicate, write and escaped queries before executing them", async () => {
		const f = await createScopedWriteFixture();
		let escaped!: PrismaClientInstance;
		let lazy!: ReturnType<PrismaClientInstance["serviceInstance"]["count"]>;
		await f.runtime.runOperation(() =>
			phased(
				f.client.prisma,
				async (reader) => {
					const foreign = f.plain.serviceInstance.count();
					await expect(reader.$transaction([foreign])).rejects.toMatchObject({ statusCode: 503 });
					const used = reader.serviceInstance.count();
					expect(await used).toBe(2);
					await expect(reader.$transaction([used])).rejects.toMatchObject({ statusCode: 503 });
					const duplicate = reader.serviceInstance.count();
					await expect(reader.$transaction([duplicate, duplicate])).rejects.toMatchObject({
						statusCode: 503,
					});
					expect(() => reader.serviceInstance.deleteMany()).toThrow();
					expect(() => reader.$disconnect()).toThrow();
					lazy = reader.serviceInstance.count();
					escaped = reader;
				},
				{ lease: "phase" },
			),
		);
		await expect(Promise.resolve(lazy)).rejects.toMatchObject({ statusCode: 503 });
		expect(() => escaped.serviceInstance.count()).toThrow();
		expect(await f.plain.serviceInstance.count()).toBe(2);
		expect(f.losses).toEqual([]);
	});

	it("preserves the unregistered client callback with the opt-in", async () => {
		const f = await createScopedWriteFixture();
		expect(
			await phased(
				f.plain,
				async (reader) => {
					expect(reader).toBe(f.plain);
					return reader.serviceInstance.count();
				},
				{ lease: "phase" },
			),
		).toBe(2);
	});

	it("materializes lazy batch reads in one native snapshot and releases it before the postcheck", async () => {
		const f = await createScopedWriteFixture();
		const prepare = Database.prototype.prepare;
		let armed = true;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name !== f.path || this === f.writer) return statement;
			if (sql === "BEGIN") f.applications.add(this);
			if (sql === "SELECT value FROM CompetitionProbe") {
				const all = statement.all;
				statement.all = function (...args: unknown[]) {
					const result = Reflect.apply(all, this, args);
					if (armed) {
						armed = false;
						f.writer.exec("UPDATE CompetitionProbe SET value=7 WHERE id=1");
					}
					return result;
				};
			}
			return statement;
		});
		await f.runtime.runOperation(() =>
			phased(
				f.client.prisma,
				async (reader) => {
					const first = reader.$queryRawUnsafe("SELECT value FROM CompetitionProbe");
					const second = reader.$queryRawUnsafe("SELECT value FROM CompetitionProbe WHERE id=?", 1);
					expect(armed).toBe(true);
					expect(
						await reader.$transaction([first, second], { isolationLevel: "Serializable" }),
					).toEqual([[{ value: 0 }], [{ value: 0 }]]);
					expect(armed).toBe(false);
					expect(await reader.$queryRawUnsafe("SELECT value FROM CompetitionProbe")).toEqual([
						{ value: 7 },
					]);
				},
				{ lease: "phase" },
			),
		);
		expect(f.losses).toEqual([]);
	});

	it("does not enter a phase callback after its registered client closes", async () => {
		const f = await createScopedWriteFixture();
		await f.client.close();
		let entered = false;
		await expect(
			f.runtime.runOperation(() =>
				phased(
					f.client.prisma,
					async () => {
						entered = true;
					},
					{ lease: "phase" },
				),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(entered).toBe(false);
	});
});
