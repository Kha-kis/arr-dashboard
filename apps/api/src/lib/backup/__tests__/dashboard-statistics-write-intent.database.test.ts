import type { DashboardStatisticsResponse } from "@arr/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { emptySonarrStatistics } from "../../statistics/dashboard-statistics.js";
import {
	claimDashboardRefresh,
	fingerprintDashboardSources,
	publishDashboardSnapshot,
	readDashboardSnapshot,
	renewDashboardRefreshClaim,
} from "../../statistics/dashboard-statistics-snapshot.js";

afterEach(closeScopedWriteFixtures);

async function fixture() {
	const f = await createScopedWriteFixture();
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
