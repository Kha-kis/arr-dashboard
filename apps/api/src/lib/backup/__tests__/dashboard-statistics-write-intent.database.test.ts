import type { DashboardStatisticsResponse } from "@arr/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { Prisma, type PrismaClient } from "../../prisma.js";
import { emptySonarrStatistics } from "../../statistics/dashboard-statistics.js";
import {
	claimDashboardRefresh,
	failDashboardRefresh,
	fingerprintDashboardSources,
	publishDashboardSnapshot,
	readDashboardSnapshot,
	renewDashboardRefreshClaim,
} from "../../statistics/dashboard-statistics-snapshot.js";

afterEach(closeScopedWriteFixtures);

async function fixture(journalMode: "WAL" | "DELETE" = "WAL") {
	const f = await createScopedWriteFixture({ journalMode });
	const source = await f.plain.serviceInstance.create({
		data: {
			id: "synthetic-arr",
			userId: "synthetic-user",
			service: "SONARR",
			label: "Synthetic",
			baseUrl: "https://example.invalid",
			encryptedApiKey: "synthetic",
			encryptionIv: "synthetic",
		},
	});
	const fingerprint = fingerprintDashboardSources([source]);
	const now = new Date();
	const payload: DashboardStatisticsResponse = {
		sonarr: {
			instances: [
				{
					instanceId: source.id,
					instanceName: source.label,
					data: { ...emptySonarrStatistics, totalSeries: 17 },
					error: false,
				},
			],
		},
		radarr: { instances: [] },
		prowlarr: { instances: [] },
		lidarr: { instances: [] },
		readarr: { instances: [] },
	};
	await f.plain.dashboardStatisticsSnapshot.create({
		data: {
			userId: "synthetic-user",
			sourceFingerprint: fingerprint,
			payload: JSON.stringify(payload),
			result: "complete",
			observedAt: new Date(now.getTime() - 16 * 60_000),
		},
	});
	return { ...f, fingerprint, now, payload };
}

describe("Statistics write progress during guarded WAL competition", { timeout: 30_000 }, () => {
	// Break caught: a real commit after the guard snapshot must not repeatedly
	// defeat an otherwise eligible refresh claim. The competing writer is real.
	it("claims a stale publication before a competing commit can invalidate its write snapshot", async () => {
		const f = await fixture();
		const before = snapshotProtectedRows(f);
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		const claimed = await f.runtime.runOperation(() =>
			claimDashboardRefresh(f.client.prisma, "synthetic-user", f.fingerprint, "claim", f.now),
		);
		expect(claimed).toBe(true);
		expect(competition.reservations).toBe(1);
		expect(competition.commits).toBe(0);
		expect(competition.blocked).toBe(1);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(
			await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({
				where: { userId: "synthetic-user" },
			}),
		).toMatchObject({ claimToken: "claim", claimFingerprint: f.fingerprint });
		expect(f.losses).toEqual([]);
	});

	// Break caught: a renewal is also a read-before-write transaction; a live
	// claim must not lose its renewal just because another writer commits.
	it("renews the exact live claim without a stale WAL snapshot", async () => {
		const f = await fixture();
		expect(
			await f.runtime.runOperation(() =>
				claimDashboardRefresh(f.client.prisma, "synthetic-user", f.fingerprint, "claim", f.now),
			),
		).toBe(true);
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		const next = new Date(f.now.getTime() + 30_000);
		expect(
			await f.runtime.runOperation(() =>
				renewDashboardRefreshClaim(f.client.prisma, "synthetic-user", f.fingerprint, "claim", next),
			),
		).toBe(true);
		expect(competition.reservations).toBe(1);
		expect(competition.commits).toBe(0);
		expect(competition.blocked).toBe(1);
		expect(
			await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({
				where: { userId: "synthetic-user" },
			}),
		).toMatchObject({ claimToken: "claim", leaseUntil: new Date(next.getTime() + 120_000) });
		expect(f.losses).toEqual([]);
	});

	// Break caught: a refused writer reservation is transient storage contention,
	// not evidence that the live lease was lost. The heartbeat must be able to retry.
	it("keeps a held-writer renewal failure retryable instead of reporting a lost claim", async () => {
		const f = await fixture();
		expect(
			await f.runtime.runOperation(() =>
				claimDashboardRefresh(f.client.prisma, "synthetic-user", f.fingerprint, "claim", f.now),
			),
		).toBe(true);
		interceptScopedWriteCompetition(f, { holdBeforeReservation: true });
		const next = new Date(f.now.getTime() + 30_000);
		try {
			await expect(
				f.runtime.runOperation(() =>
					renewDashboardRefreshClaim(
						f.client.prisma,
						"synthetic-user",
						f.fingerprint,
						"claim",
						next,
					),
				),
			).rejects.toMatchObject({ code: "P1008" });
			expect(
				await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({
					where: { userId: "synthetic-user" },
				}),
			).toMatchObject({ claimToken: "claim", leaseUntil: new Date(f.now.getTime() + 120_000) });
		} finally {
			if (f.writer.inTransaction) f.writer.exec("ROLLBACK");
		}
		expect(
			await f.runtime.runOperation(() =>
				renewDashboardRefreshClaim(f.client.prisma, "synthetic-user", f.fingerprint, "claim", next),
			),
		).toBe(true);
		expect(f.losses).toEqual([]);
	});

	// Break caught: successful collection is not success until the matching live
	// claim actually commits its publication under the same source/lease fences.
	it("publishes collected data before a competing commit can invalidate its write snapshot", async () => {
		const f = await fixture();
		expect(
			await f.runtime.runOperation(() =>
				claimDashboardRefresh(f.client.prisma, "synthetic-user", f.fingerprint, "claim", f.now),
			),
		).toBe(true);
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		expect(
			await f.runtime.runOperation(() =>
				publishDashboardSnapshot(
					f.client.prisma,
					"synthetic-user",
					f.fingerprint,
					"claim",
					f.now,
					f.payload,
					"complete",
					f.now,
				),
			),
		).toBe(true);
		expect(competition.reservations).toBe(1);
		expect(competition.commits).toBe(0);
		expect(competition.blocked).toBe(1);
		expect(
			await f.runtime.runOperation(() =>
				readDashboardSnapshot(f.client.prisma, "synthetic-user", f.fingerprint, f.now),
			),
		).toEqual({ availability: "current", observedAt: f.now, data: f.payload, refreshDue: false });
		expect(f.losses).toEqual([]);
	});
});

describe("Statistics failed-claim settlement under a competing writer", { timeout: 15_000 }, () => {
	it.each(["WAL", "DELETE"] as const)(
		"settles the exact claim without pinning a %s read snapshot",
		async (mode) => {
			const f = await fixture(mode);
			expect(f.writer.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
			const userId = "synthetic-user";
			const token = "active-claim";
			const where = { userId };
			const prisma = f.client.prisma;
			await expect(
				f.runtime.runOperation(() =>
					claimDashboardRefresh(prisma, userId, f.fingerprint, token, f.now),
				),
			).resolves.toBe(true);
			const before = await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({ where });
			const protectedRows = snapshotProtectedRows(f);
			const writes: Array<{ inTransaction: boolean; outcome: string }> = [];
			let writerOutcome: string | undefined;
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				const statement = prepare.call(this, sql);
				if (
					this.name !== f.path ||
					!/^\s*UPDATE\b/iu.test(sql) ||
					!sql.includes("dashboard_statistics_snapshots")
				)
					return statement;
				const database = this;
				for (const name of ["all", "get", "run"] as const) {
					const execute = statement[name];
					Reflect.set(statement, name, function (this: typeof statement, ...args: unknown[]) {
						if (f.writer.inTransaction) {
							try {
								f.writer.exec("COMMIT");
								writerOutcome = "committed";
							} catch (error) {
								if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
									throw error;
								writerOutcome = error.code;
							}
						}
						const inTransaction = database.inTransaction;
						try {
							const value = Reflect.apply(execute, this, args);
							writes.push({ inTransaction, outcome: "completed" });
							return value;
						} catch (error) {
							writes.push({
								inTransaction,
								outcome: error instanceof Database.SqliteError ? error.code : "unknown",
							});
							throw error;
						}
					});
				}
				return statement;
			});
			f.writer.exec("BEGIN IMMEDIATE; UPDATE CompetitionProbe SET value=1 WHERE id=1");
			const settle = (owner = userId, fingerprint = f.fingerprint, claim = token) =>
				f.runtime.runOperation(() =>
					failDashboardRefresh(prisma, owner, fingerprint, claim, f.now, "timeout"),
				);
			const result = await settle().then(
				(value) => ({ value }),
				(error: unknown) => ({
					code: error && typeof error === "object" && "code" in error ? error.code : "unknown",
				}),
			);
			expect({ result, writerOutcome, writeCount: writes.length, firstWrite: writes[0] }).toEqual({
				result: { value: true },
				writerOutcome: "committed",
				writeCount: 1,
				firstWrite: { inTransaction: false, outcome: "completed" },
			});
			expect(f.writer.prepare("SELECT value FROM CompetitionProbe WHERE id=1").get()).toEqual({
				value: 1,
			});
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			const after = await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({ where });
			expect(after).toMatchObject({
				userId,
				sourceFingerprint: before.sourceFingerprint,
				payload: before.payload,
				result: before.result,
				observedAt: before.observedAt,
				claimFingerprint: null,
				claimToken: null,
				leaseUntil: null,
				retryFingerprint: f.fingerprint,
				retryAt: new Date(f.now.getTime() + 60_000),
				lastFailureCategory: "timeout",
			});
			const replacement = {
				claimFingerprint: f.fingerprint,
				claimToken: "newer-claim",
				leaseUntil: new Date(f.now.getTime() + 120_000),
			};
			await f.plain.dashboardStatisticsSnapshot.update({ where, data: replacement });
			await expect(settle("unknown-user", f.fingerprint, replacement.claimToken)).resolves.toBe(
				false,
			);
			await expect(settle(userId, "old-source", replacement.claimToken)).resolves.toBe(false);
			await expect(settle()).resolves.toBe(false);
			expect(await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({ where })).toMatchObject(
				replacement,
			);
			expect(f.losses).toEqual([]);
		},
	);
});

it.each([
	Object.assign(new Error("untyped lookalike"), { code: "P2025" }),
	new Prisma.PrismaClientKnownRequestError("uncertain settlement", {
		code: "P1008",
		clientVersion: "test",
	}),
])("propagates an uncertain settlement without replay (%s)", async (error) => {
	const update = vi.fn().mockRejectedValue(error);
	const prisma = { dashboardStatisticsSnapshot: { update } } as unknown as PrismaClient;
	await expect(
		failDashboardRefresh(prisma, "owner", "fingerprint", "token", new Date(), "timeout"),
	).rejects.toBe(error);
	expect(update).toHaveBeenCalledTimes(1);
});
