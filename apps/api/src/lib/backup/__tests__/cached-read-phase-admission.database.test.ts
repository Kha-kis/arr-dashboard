import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import type { PrismaClientInstance } from "../../prisma.js";
import { withIsolatedRuntimePrismaBulkReadClient } from "../restore-runtime-client.js";

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
