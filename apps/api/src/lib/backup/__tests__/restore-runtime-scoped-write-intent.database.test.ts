import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	hasSqliteTransactionWriteIntent,
	withSqliteTransactionWriteIntent,
} from "../../sqlite-transaction-intent.js";

afterEach(closeScopedWriteFixtures);

describe("scoped guarded SQLite transaction write intent", { timeout: 30_000 }, () => {
	// A process-global flag or reserving on scope entry would block this actual
	// concurrent sibling's WAL writer or change its deferred snapshot semantics.
	it("isolates a waiting write scope from a concurrent ordinary read-only transaction", async () => {
		const f = await createScopedWriteFixture();
		const sibling = f.newClient();
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve;
		});
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		await f.runtime.runOperation(async () => {
			const pending = withSqliteTransactionWriteIntent(async () => {
				expect(hasSqliteTransactionWriteIntent()).toBe(true);
				entered();
				await releasePromise;
				return await f.client.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=value+1 WHERE id=1");
				});
			});
			await enteredPromise;
			try {
				expect(hasSqliteTransactionWriteIntent()).toBe(false);
				await sibling.prisma.$transaction(async (tx) => {
					expect(await tx.$queryRawUnsafe("SELECT value FROM CompetitionProbe WHERE id=1")).toEqual(
						[{ value: 0 }],
					);
				});
				expect(competition.commits).toBe(1);
				expect(competition.blocked).toBe(0);
				// The sibling transaction finished while the write scope had not
				// entered BEGIN; entering an intent alone acquired no writer.
				expect(competition.reservations).toBe(0);
			} finally {
				release();
				await pending;
			}
		});
		expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
			value: 2,
		});
		expect(competition.reservations).toBe(1);
		expect(hasSqliteTransactionWriteIntent()).toBe(false);
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("scoped-concurrent-reader", competition);
	});

	// Reservation must refuse a real held writer before exposing a transaction
	// callback, release its native transaction, and leave the same client reusable.
	it("bounds held-writer refusal before callback entry and reuses the rolled-back client", async () => {
		const f = await createScopedWriteFixture();
		const before = snapshotProtectedRows(f);
		await f.runtime.runOperation(() => f.client.prisma.$connect());
		const competition = interceptScopedWriteCompetition(f, { holdBeforeReservation: true });
		let callbacks = 0;
		const started = performance.now();
		await f.runtime.runOperation(async () => {
			await expect(
				withSqliteTransactionWriteIntent(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							callbacks++;
							await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=7 WHERE id=1");
						},
						{ maxWait: 20_000, timeout: 20_000 },
					),
				),
			).rejects.toMatchObject({
				code: "P1008",
				meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
			});
			expect(performance.now() - started).toBeLessThan(10_000);
			expect(callbacks).toBe(0);
			expect(competition.nativeErrors).toContain("SQLITE_BUSY");
			expect(competition.rollbacks).toBeGreaterThan(0);
			expect([...f.applications].every((db) => !db.inTransaction)).toBe(true);
			expect(snapshotProtectedRows(f)).toEqual(before);
			f.writer.exec("ROLLBACK");
			expect(hasSqliteTransactionWriteIntent()).toBe(false);
			await withSqliteTransactionWriteIntent(() =>
				f.client.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=7 WHERE id=1");
				}),
			);
		});
		expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
			value: 7,
		});
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("scoped-held-writer", {
			...competition,
			elapsedMs: performance.now() - started,
			callbacks,
		});
	});

	// A rejected callback must roll back its write and clear intent for following
	// ordinary read transactions, rather than reserving their WAL writer.
	it("rolls back a failed scoped callback and restores default WAL read concurrency", async () => {
		const f = await createScopedWriteFixture();
		const sentinel = new Error("Synthetic scoped callback failure");
		await f.runtime.runOperation(async () => {
			await expect(
				withSqliteTransactionWriteIntent(() =>
					f.client.prisma.$transaction(async (tx) => {
						await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=7 WHERE id=1");
						throw sentinel;
					}),
				),
			).rejects.toBe(sentinel);
			expect(hasSqliteTransactionWriteIntent()).toBe(false);
			expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
				value: 0,
			});
			const competition = interceptScopedWriteCompetition(f, { compete: true });
			await f.client.prisma.$transaction(async (tx) => {
				expect(await tx.$queryRawUnsafe("SELECT value FROM CompetitionProbe WHERE id=1")).toEqual([
					{ value: 0 },
				]);
			});
			expect(competition.commits).toBe(1);
			expect(competition.blocked).toBe(0);
			expect(competition.reservations).toBe(0);
			recordScopedWriteEvidence("scoped-after-failure-reader", competition);
		});
		expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
			value: 1,
		});
		expect(f.losses).toEqual([]);
	});

	// Existing purpose-bound constructor clients must keep their behavior when
	// no AsyncLocalStorage intent scope exists.
	it("preserves constructor write intent without a scoped helper", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		await f.runtime.runOperation(() =>
			f.client.prisma.$transaction(async (tx) => {
				await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=7 WHERE id=1");
			}),
		);
		expect(competition.commits + competition.blocked).toBe(1);
		expect(competition.blocked).toBe(1);
		expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
			value: 7,
		});
		expect(f.losses).toEqual([]);
	});
});
