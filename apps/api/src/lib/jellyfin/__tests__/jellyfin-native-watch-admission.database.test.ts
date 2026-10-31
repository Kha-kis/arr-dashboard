import { setTimeout as delay } from "node:timers/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { prepareNativeWatchGeneration } from "../jellyfin-native-watch-repository.js";

afterEach(closeScopedWriteFixtures);

async function createNativeWatchAdmissionFixture() {
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
	return { f, input, pointer, oldRow };
}

describe("native-watch admission on guarded WAL SQLite", { timeout: 30_000 }, () => {
	it.each([
		{ admissionDelayMs: 2_200, expires: false },
		{ admissionDelayMs: 5_200, expires: true },
	])(
		"keeps guarded admission bounded: $admissionDelayMs ms, expires=$expires",
		async ({ admissionDelayMs, expires }) => {
			const { f, input, pointer, oldRow } = await createNativeWatchAdmissionFixture();
			const before = snapshotProtectedRows(f);
			const committedRows = () =>
				Number(
					(
						f.writer
							.prepare(
								'SELECT COUNT(*) AS count FROM jellyfin_native_watch_rows WHERE "instanceId"=? AND "runId"=?',
							)
							.get(input.instanceId, input.runId) as { count: number }
					).count,
				);
			let armed = false;
			let injected = false;
			let pendingAdmission: Promise<unknown> | undefined;
			let delayedAdmissionMs = 0;
			const connect = PrismaBetterSqlite3.prototype.connect;
			vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
				this: PrismaBetterSqlite3,
			) {
				const actual = await connect.call(this);
				const start = actual.startTransaction.bind(actual);
				vi.spyOn(actual, "startTransaction").mockImplementation(async (isolation) => {
					if (!armed || injected) return start(isolation);
					injected = true;
					const started = performance.now();
					// Delay admission, not the callback or SQLite result. The real guarded
					// driver and Prisma enforce their actual start/rollback behavior.
					const pending = (async () => {
						await delay(admissionDelayMs);
						return start(isolation);
					})();
					pendingAdmission = pending;
					try {
						return await pending;
					} finally {
						delayedAdmissionMs = performance.now() - started;
					}
				});
				return actual;
			});
			interceptScopedWriteCompetition(f);
			const rowPhases: string[] = [];
			let rowResets = 0;
			let failure: unknown;
			await f.runtime.runOperation(async () => {
				try {
					await prepareNativeWatchGeneration(
						f.client.prisma,
						input,
						(event) => {
							if (event.stage === "own-row-reset") rowResets++;
						},
						(event) => {
							if (event.kind !== "row-chunk") return;
							if (event.phase === "requested" && committedRows() === 100) armed = true;
							rowPhases.push(event.phase);
						},
					);
				} catch (error) {
					failure = error;
				} finally {
					// Even RED must join a late driver start before releasing its runtime
					// ticket. Prisma can then finish cancellation before fixture teardown.
					await pendingAdmission;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			});
			expect(injected).toBe(true);
			expect(delayedAdmissionMs).toBeGreaterThanOrEqual(admissionDelayMs);
			expect([...f.applications].every((db) => !db.inTransaction)).toBe(true);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(
				await f.plain.jellyfinNativeWatchPublication.findUnique({
					where: { instanceId: input.instanceId },
				}),
			).toEqual(pointer);
			expect(await f.plain.jellyfinNativeWatchRow.findUnique({ where: { id: oldRow.id } })).toEqual(
				oldRow,
			);
			recordScopedWriteEvidence(`native-watch-delayed-admission-${admissionDelayMs}`, {
				failureCode: failure && typeof failure === "object" ? Reflect.get(failure, "code") : null,
				stagedRows: committedRows(),
				rowResets,
				rowPhases,
				delayedAdmissionMs,
				publishedHeadUnchanged: true,
				protectedRowsUnchanged: true,
				admissionJoined: true,
				transactionsSettled: true,
				losses: f.losses,
			});
			if (expires) {
				expect(failure).toMatchObject({ code: "P2028" });
				expect(rowPhases).toEqual([
					"requested",
					"callback-entered",
					"succeeded",
					"requested",
					"failed",
				]);
			} else {
				if (failure) throw failure;
				expect(rowPhases).toEqual([
					"requested",
					"callback-entered",
					"succeeded",
					"requested",
					"callback-entered",
					"succeeded",
					"requested",
					"callback-entered",
					"succeeded",
				]);
			}
			expect(rowResets).toBe(1);
			expect(committedRows()).toBe(expires ? 100 : 201);
			expect(
				await f.plain.jellyfinNativeWatchScopeReceipt.count({
					where: { instanceId: input.instanceId, runId: input.runId },
				}),
			).toBe(expires ? 0 : 1);
			expect(f.losses).toEqual([]);
		},
	);

	it("keeps the first committed batch and the published head when a competing writer refuses the next start", async () => {
		const { f, input, pointer, oldRow } = await createNativeWatchAdmissionFixture();
		const { instanceId, runId } = input;
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
