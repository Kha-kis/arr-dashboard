import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { prepareNativeWatchGeneration } from "../jellyfin-native-watch-repository.js";

afterEach(closeScopedWriteFixtures);

describe("native-watch admission on guarded WAL SQLite", { timeout: 30_000 }, () => {
	it("keeps the first committed batch and the published head when a competing writer refuses the next start", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const now = new Date();
		const instanceId = "synthetic-jellyfin";
		const runId = "synthetic-pending-run";
		await f.plain.providerObservationRun.create({
			data: {
				id: runId,
				instanceId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				authorityKey: "synthetic-authority",
				targetDigest: "synthetic-target",
				targetCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
				state: "running",
				activeSlotKey: "synthetic-active",
				totalUnits: 2,
				completedUnits: 2,
				totalWork: 1,
				completedWork: 1,
			},
		});
		await f.plain.jellyfinEpisodePreparation.create({
			data: {
				runId,
				instanceId,
				generationId: "synthetic-generation",
				token: "synthetic-token",
				state: "verified",
				leaseExpiresAt: new Date(Date.now() + 300_000),
			},
		});
		const pointer = await f.plain.jellyfinNativeWatchPublication.create({
			data: {
				instanceId,
				activeRunId: "synthetic-published-run",
				activeCacheGenerationId: "synthetic-published-generation",
				activeObservedAt: now,
				activeExpectedScopeCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		const oldRow = await f.plain.jellyfinNativeWatchRow.create({
			data: {
				instanceId,
				runId: pointer.activeRunId,
				userKeyDigest: "digest",
				libraryId: "library",
				jellyfinId: "published-episode",
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: 1,
				played: true,
				playCount: 1,
				observedAt: now,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		const input = {
			userId: "synthetic-user",
			instanceId,
			runId,
			cacheGenerationId: "synthetic-generation",
			preparationToken: "synthetic-token",
			connectionGeneration: 1,
			identityGeneration: 1,
			observedAt: now,
			expectedScopeCount: 1,
			candidates: Array.from({ length: 201 }, (_, index) => ({
				userKeyDigest: "digest",
				libraryId: "library",
				jellyfinId: `episode-${String(index).padStart(3, "0")}`,
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: index + 1,
				played: false,
				playCount: 0,
				lastPlayedAt: null,
			})),
			receipts: [
				{
					userKeyDigest: "digest",
					libraryId: "library",
					expectedRawCount: 201,
					observedRawCount: 201,
					exact: true,
					contentFingerprint: "a".repeat(64),
				},
			],
		};
		const before = snapshotProtectedRows(f);
		await f.runtime.runOperation(() => f.client.prisma.$connect());
		const competition = interceptScopedWriteCompetition(f);
		const failures: Array<{ committedRows: number; released: boolean; rollbackSettled: boolean }> =
			[];
		const phases: string[] = [];
		let held = false;
		let rowResets = 0;
		const committedRows = () =>
			Number(
				(
					f.writer
						.prepare(
							'SELECT COUNT(*) AS count FROM jellyfin_native_watch_rows WHERE "instanceId"=? AND "runId"=?',
						)
						.get(instanceId, runId) as { count: number }
				).count,
			);
		await f.runtime.runOperation(() =>
			prepareNativeWatchGeneration(
				f.client.prisma,
				input,
				(event) => {
					if (event.stage === "own-row-reset") rowResets++;
					// Stage callbacks inside the first transaction see zero committed rows;
					// only the following batch can arm the real, separate WAL writer.
					if (event.stage === "row-chunk-write" && !held && committedRows() === 100) {
						f.writer.exec("BEGIN IMMEDIATE");
						held = true;
					}
				},
				(event) => {
					if (held && event.kind === "row-chunk") phases.push(event.phase);
					if (event.phase === "failed" && f.writer.inTransaction) {
						const count = committedRows();
						f.writer.exec("ROLLBACK");
						failures.push({
							committedRows: count,
							released: !f.writer.inTransaction,
							rollbackSettled: [...f.applications].every((db) => !db.inTransaction),
						});
					}
				},
			),
		);
		expect(failures).toEqual([{ committedRows: 100, released: true, rollbackSettled: true }]);
		expect(phases.slice(0, 5)).toEqual([
			"requested",
			"failed",
			"requested",
			"callback-entered",
			"succeeded",
		]);
		expect(competition.nativeErrors).toContain("SQLITE_BUSY");
		expect(competition.rollbacks).toBeGreaterThan(0);
		expect(rowResets).toBe(1);
		expect(committedRows()).toBe(201);
		expect(
			await f.plain.jellyfinNativeWatchScopeReceipt.count({ where: { instanceId, runId } }),
		).toBe(1);
		expect(
			await f.plain.jellyfinNativeWatchPublication.findUnique({ where: { instanceId } }),
		).toEqual(pointer);
		expect(await f.plain.jellyfinNativeWatchRow.findUnique({ where: { id: oldRow.id } })).toEqual(
			oldRow,
		);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("native-watch-pending-batch-recovery", {
			stagedRows: committedRows(),
			rowResets,
			failures,
			nativeErrors: competition.nativeErrors,
			publishedHeadUnchanged: true,
			protectedRowsUnchanged: true,
			losses: f.losses,
		});
	});
});
