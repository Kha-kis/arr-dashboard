import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import { createTestPgClient } from "../../__tests__/test-prisma.js";
import { type HistoryService, normalizeHistoryObservation } from "../../dashboard/history-utils.js";
import {
	acquireHistoryCollectionLease,
	releaseHistoryCollectionLease,
} from "../history-collection-lease.js";
import {
	type HistoryObservationPublicationInput,
	publishHistoryObservations,
} from "../history-observation-publication-repository.js";
import type { HistorySourceProviderStartedAttempt } from "../history-source-attempt.js";
import {
	beginHistorySourceAttempt,
	markHistorySourceAttemptProviderStarted,
} from "../history-source-attempt.js";

const databaseSchema = resolve(process.cwd(), "prisma/schema.prisma");
const services = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const;
const serviceTypes = {
	sonarr: "SONARR",
	radarr: "RADARR",
	prowlarr: "PROWLARR",
	lidarr: "LIDARR",
	readarr: "READARR",
} as const;
const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const postgresCleanups: Array<() => Promise<void>> = [];
const postgresUsers: Array<{ prisma: PrismaClient; userId: string }> = [];
let prisma: PrismaClient;

type Fixture = {
	prisma: PrismaClient;
	userId: string;
	instanceId: string;
	lease: { userId: string; claimToken: string };
	attempt: HistorySourceProviderStartedAttempt;
};

describe("History observation publication repository", { timeout: 30_000 }, () => {
	beforeAll(async () => {
		const directory = mkdtempSync(join(tmpdir(), "history-publication-repository-"));
		const sqlitePath = join(directory, "history.db");
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", databaseSchema], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` },
			stdio: "pipe",
		});
		prisma = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: sqlitePath, timeout: 10_000 }),
		});
		await prisma.$connect();
		databases.push({ directory, prisma });
	}, 120_000);

	afterAll(async () => {
		for (const database of databases.splice(0)) {
			await database.prisma.$disconnect();
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	beforeEach(async () => {
		await prisma.historyObservation.deleteMany();
		await prisma.historySourceStatus.deleteMany();
		await prisma.historyCollectionLease.deleteMany();
		await prisma.serviceInstance.deleteMany();
		await prisma.user.deleteMany();
	});

	it.each(services)("publishes a canonical positive-only result for %s", async (service) => {
		const fixture = await createFixture(service);
		const result = await publish(fixture, [row(1, service)]);

		expect(result).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
			publishedObservationCount: 1,
			retainedObservationCount: 1,
			deletedObservationCount: 0,
		});
		const stored = await prisma.historyObservation.findMany({
			where: { instanceId: fixture.instanceId },
		});
		expect(
			await prisma.$queryRawUnsafe<Array<{ publicationRevision: number }>>(
				"SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?",
				fixture.instanceId,
			),
		).toEqual([{ publicationRevision: 1 }]);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			instanceId: fixture.instanceId,
			connectionGeneration: 3,
			providerEventId: 1,
			eventTypeKey: "download",
		});
		expect(stored[0]?.normalizedPayload).not.toContain("provider.invalid");
	});

	it("increments publication revision exactly once for new, updated, empty, and equivalent positive pages", async () => {
		const fixture = await createFixture("sonarr");
		const eventAt = new Date("2026-09-03T00:00:00.000Z");
		const firstRow = row(500, "sonarr", eventAt);
		const updatedRow = row(500, "sonarr", eventAt, "updated-title");
		const first = await publish(fixture, [firstRow]);
		expect(first).toMatchObject({ kind: "published" });
		expect(
			await prisma.$queryRawUnsafe<Array<{ publicationRevision: number }>>(
				"SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?",
				fixture.instanceId,
			),
		).toEqual([{ publicationRevision: 1 }]);

		const secondAttempt = await replaceAttempt(fixture);
		expect(await publish({ ...fixture, attempt: secondAttempt }, [updatedRow])).toMatchObject({
			kind: "published",
		});
		const thirdAttempt = await replaceAttempt(fixture);
		expect(await publish({ ...fixture, attempt: thirdAttempt }, [])).toMatchObject({
			kind: "published",
		});
		const fourthAttempt = await replaceAttempt(fixture);
		expect(await publish({ ...fixture, attempt: fourthAttempt }, [updatedRow])).toMatchObject({
			kind: "published",
		});
		expect(
			await prisma.$queryRawUnsafe<Array<{ publicationRevision: number }>>(
				"SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?",
				fixture.instanceId,
			),
		).toEqual([{ publicationRevision: 4 }]);
	});

	it("includes the prior publication revision in the successful status CAS and increments atomically", async () => {
		const fixture = await createFixture("radarr");
		const calls: unknown[][] = [];
		const captured = withPublicationCasCapture(prisma, calls);
		expect(await publish(fixture, [row(501, "radarr")], {}, captured)).toMatchObject({
			kind: "published",
		});
		const statusCall = calls.at(-1);
		if (!statusCall) throw new Error("expected status CAS call");
		const [args] = statusCall;
		expect(args).toMatchObject({
			where: { publicationRevision: 0 },
			data: { publicationRevision: { increment: 1 } },
		});
	});

	it("fails closed on publication revision overflow without mutating rows or status", async () => {
		const fixture = await createFixture("lidarr");
		await prisma.$executeRawUnsafe(
			"UPDATE history_source_statuses SET publicationRevision = ? WHERE instanceId = ?",
			2_147_483_647,
			fixture.instanceId,
		);
		const beforeStatus = await prisma.$queryRawUnsafe<unknown[]>(
			"SELECT * FROM history_source_statuses WHERE instanceId = ?",
			fixture.instanceId,
		);
		const result = await publish(fixture, [row(502, "lidarr")]);
		expect(result).toEqual({ kind: "failed" });
		expect(
			await prisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
		).toBe(0);
		expect(
			await prisma.$queryRawUnsafe<unknown[]>(
				"SELECT * FROM history_source_statuses WHERE instanceId = ?",
				fixture.instanceId,
			),
		).toEqual(beforeStatus);
	});

	it.each([
		[
			"preserve",
			31,
			async (fixture: Fixture) => {
				const result = await publish(fixture, [{} as never]);
				expect(result).toMatchObject({ kind: "preserved", reason: "rows-inconsistent" });
			},
		],
		[
			"superseded",
			32,
			async (fixture: Fixture) => {
				const result = await publish(fixture, [row(503, "sonarr")], {}, withFinalFenceMiss(prisma));
				expect(result).toEqual({ kind: "superseded" });
			},
		],
		[
			"transaction rollback",
			33,
			async (fixture: Fixture) => {
				const result = await publish(fixture, [row(504, "sonarr")], {}, withFinishCasMiss(prisma));
				expect(result).toEqual({ kind: "failed" });
				expect(
					await prisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
				).toBe(0);
			},
		],
	])("preserves a seeded nonzero revision across publisher %s", async (_name, revision, run) => {
		const fixture = await createFixture("sonarr");
		await setPublicationRevision(fixture.instanceId, revision);
		await run(fixture);
		expect(await readPublicationRevision(fixture.instanceId)).toBe(revision);
	});

	it("denies legacy and prepared publication markers before mutating rows", async () => {
		const fixture = await createFixture("sonarr");
		const beforeStatus = await prisma.historySourceStatus.findUniqueOrThrow({
			where: { instanceId: fixture.instanceId },
		});
		const beforeRows = await prisma.historyObservation.findMany();
		for (const marker of [
			`in_progress:v1:${"a".repeat(64)}:123e4567-e89b-42d3-a456-426614174000`,
			fixture.attempt.resultMarker.replace(":started:", ":prepared:"),
		]) {
			const result = await publishHistoryObservations(
				{
					attempt: { ...fixture.attempt, resultMarker: marker } as never,
					leaseClaim: fixture.lease,
					receipt: {
						kind: "completed",
						rawRecordCount: 1,
						normalizedRows: [row(999, "sonarr")],
						totalRecordsHint: null,
					},
				},
				prisma,
			);
			expect(result).toEqual({ kind: "failed" });
		}
		expect(await prisma.historyObservation.findMany()).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toEqual(beforeStatus);
	});

	it("commits an advanced head cursor before the retained backfill turn", async () => {
		const fixture = await createFixture("sonarr");
		const attempt = await setAttemptSchedule(fixture, "head", 1, 7);
		const result = await publish(
			{ ...fixture, attempt },
			Array.from({ length: 100 }, (_, index) => row(2_000 + index, "sonarr")),
		);
		expect(result).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: false, nextBackfillPage: 7, activeCollectionPage: null });
	});

	it("commits a backfill cursor advance and then resets after the head turn", async () => {
		const fixture = await createFixture("radarr");
		const backfillAttempt = await setAttemptSchedule(fixture, "backfill", 7, 7);
		const backfillResult = await publish(
			{ ...fixture, attempt: backfillAttempt },
			Array.from({ length: 100 }, (_, index) => row(3_000 + index, "radarr")),
		);
		expect(backfillResult).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: true, nextBackfillPage: 8, activeCollectionPage: null });

		const headAttempt = await replaceAttempt(fixture);
		const headResult = await publish({ ...fixture, attempt: headAttempt }, [row(3_200, "radarr")]);
		expect(headResult).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: true, nextBackfillPage: 2, activeCollectionPage: null });
	});

	it("resets a backfill schedule after a terminal short page", async () => {
		const fixture = await createFixture("prowlarr");
		const attempt = await setAttemptSchedule(fixture, "backfill", 7, 7);
		const result = await publish({ ...fixture, attempt }, [row(3_900, "prowlarr")]);
		expect(result).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: true, nextBackfillPage: 2, activeCollectionPage: null });
	});

	it("publishes a page 100 short receipt and resets the schedule", async () => {
		const fixture = await createFixture("lidarr");
		const attempt = await setAttemptSchedule(fixture, "backfill", 100, 100);
		const result = await publish({ ...fixture, attempt }, []);
		expect(result).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: true, nextBackfillPage: 2, activeCollectionPage: null });
	});

	it("publishes a page 100 exact-hint receipt as successful terminal evidence", async () => {
		const fixture = await createFixture("readarr");
		const attempt = await setAttemptSchedule(fixture, "backfill", 100, 100);
		const result = await publish(
			{ ...fixture, attempt },
			Array.from({ length: 100 }, (_, index) => row(4_000 + index, "readarr")),
			{ rawObserved: 100 },
			prisma,
			{
				receipt: {
					kind: "completed",
					rawRecordCount: 100,
					normalizedRows: Array.from({ length: 100 }, (_, index) => row(4_000 + index, "readarr")),
					totalRecordsHint: 10_000,
				},
			},
		);
		expect(result).toMatchObject({
			kind: "published",
			finish: { result: "success", reason: null },
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ collectHeadNext: true, nextBackfillPage: 2, activeCollectionPage: null });
	});

	it("classifies a publication row-count mismatch as rows-inconsistent", async () => {
		const fixture = await createFixture("sonarr");
		const beforeRows = await prisma.historyObservation.findMany();
		const result = await publishHistoryObservations(
			{
				attempt: fixture.attempt!,
				leaseClaim: fixture.lease,
				receipt: {
					kind: "completed",
					rawRecordCount: 1,
					normalizedRows: [],
					totalRecordsHint: null,
				},
			},
			prisma,
		);
		expect(result).toEqual({ kind: "preserved", finish: "recorded", reason: "rows-inconsistent" });
		expect(await prisma.historyObservation.findMany()).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptReason: "rows-inconsistent",
			activeCollectionPage: null,
		});
	});

	it("distinguishes a valid empty page from a zero-count invalid adapter envelope", async () => {
		const empty = await createFixture("sonarr");
		expect(
			await publishHistoryObservations(
				{
					attempt: empty.attempt!,
					leaseClaim: empty.lease,
					receipt: {
						kind: "completed",
						rawRecordCount: 0,
						normalizedRows: [],
						totalRecordsHint: null,
					},
				},
				prisma,
			),
		).toMatchObject({ kind: "published", publishedObservationCount: 0 });

		const invalid = await createFixture("radarr");
		expect(
			await publishHistoryObservations(
				{
					attempt: invalid.attempt!,
					leaseClaim: invalid.lease,
					receipt: { kind: "adapter-invalid", rawRecordCount: 0 },
				},
				prisma,
			),
		).toEqual({ kind: "preserved", finish: "recorded", reason: "receipt-invalid" });
	});

	it.each([[null], [10_001]])(
		"publishes a full page 100 with provider-limit finish when hint is %s",
		async (totalRecordsHint) => {
			const fixture = await createFixture("sonarr");
			const rows = Array.from({ length: 100 }, (_, index) => row(1_000 + index, "sonarr"));
			const status = await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			});
			if (!status.lastAttemptAt) throw new Error("expected attempt timestamp");
			await prisma.historySourceStatus.update({
				where: { instanceId: fixture.instanceId },
				data: { collectHeadNext: false, nextBackfillPage: 100, activeCollectionPage: 100 },
			});
			const page100Attempt = {
				...fixture.attempt!,
				phase: "backfill" as const,
				collectionPage: 100,
				backfillPage: 100,
				attemptedAt: status.lastAttemptAt,
			};

			const result = await publishHistoryObservations(
				{
					attempt: page100Attempt,
					leaseClaim: fixture.lease,
					receipt: {
						kind: "completed",
						rawRecordCount: 100,
						normalizedRows: rows,
						totalRecordsHint,
					},
				},
				prisma,
			);

			expect(result).toMatchObject({
				kind: "published",
				finish: { result: "error", reason: "provider-limit" },
				publishedObservationCount: 100,
				retainedObservationCount: 100,
				deletedObservationCount: 0,
			});
			expect(
				await prisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
			).toBe(100);
			expect(
				await prisma.historySourceStatus.findUniqueOrThrow({
					where: { instanceId: fixture.instanceId },
				}),
			).toMatchObject({
				lastAttemptResult: "error",
				lastAttemptReason: "provider-limit",
				collectHeadNext: true,
				nextBackfillPage: 2,
				activeCollectionPage: null,
			});
		},
	);

	it.each([
		["unknown kind", { kind: "unknown", rawRecordCount: 0 }, "receipt-invalid"],
		[
			"missing hint",
			{ kind: "completed", rawRecordCount: 0, normalizedRows: [] },
			"receipt-invalid",
		],
		[
			"extra field",
			{
				kind: "completed",
				rawRecordCount: 0,
				normalizedRows: [],
				totalRecordsHint: null,
				private: "echo",
			},
			"receipt-invalid",
		],
		[
			"malformed count",
			{ kind: "completed", rawRecordCount: "0", normalizedRows: [], totalRecordsHint: null },
			"receipt-invalid",
		],
	])("terminalizes %s without publication", async (_name, receipt, expectedReason) => {
		const fixture = await createFixture("sonarr");
		const beforeRows = await prisma.historyObservation.findMany();
		const result = await publishHistoryObservations(
			{ attempt: fixture.attempt!, leaseClaim: fixture.lease, receipt: receipt as never },
			prisma,
		);
		expect(result).toEqual({ kind: "preserved", finish: "recorded", reason: expectedReason });
		expect(await prisma.historyObservation.findMany()).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptReason: "receipt-invalid",
			collectHeadNext: false,
			nextBackfillPage: 2,
			activeCollectionPage: null,
		});
	});

	it("does not finalize a persisted future attempt or change publication state", async () => {
		const fixture = await createFixture("sonarr");
		await prisma.$executeRawUnsafe(
			"UPDATE history_source_statuses SET lastAttemptAt = datetime(CURRENT_TIMESTAMP, '+1 day') WHERE instanceId = ?",
			fixture.instanceId,
		);
		const futureStatus = await prisma.historySourceStatus.findUniqueOrThrow({
			where: { instanceId: fixture.instanceId },
		});
		if (!futureStatus.lastAttemptAt) throw new Error("expected future attempt timestamp");
		const beforeRows = await prisma.historyObservation.findMany();
		const result = await publishHistoryObservations(
			{
				attempt: { ...fixture.attempt!, attemptedAt: futureStatus.lastAttemptAt },
				leaseClaim: fixture.lease,
				receipt: {
					kind: "completed",
					rawRecordCount: 1,
					normalizedRows: [row(777, "sonarr")],
					totalRecordsHint: null,
				},
			},
			prisma,
		);
		expect(result).toEqual({ kind: "failed" });
		expect(await prisma.historyObservation.findMany()).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toEqual(futureStatus);
	});

	it("preserves all observations and retention metadata for a valid zero-row receipt", async () => {
		const fixture = await createFixture("radarr");
		const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
		const current = new Date(Date.now() - 60 * 60 * 1000);
		await prisma.historyObservation.createMany({
			data: [
				{
					instanceId: fixture.instanceId,
					connectionGeneration: 3,
					providerEventId: 1,
					eventAt: old,
					eventTypeKey: "download",
					searchText: "old",
					normalizedPayload: '{"version":1}',
					firstObservedAt: old,
					lastObservedAt: old,
				},
				...Array.from({ length: 10_000 }, (_, index) => ({
					instanceId: fixture.instanceId,
					connectionGeneration: 3,
					providerEventId: 2 + index,
					eventAt: current,
					eventTypeKey: "download",
					searchText: `current-${index}`,
					normalizedPayload: '{"version":1}',
					firstObservedAt: current,
					lastObservedAt: current,
				})),
			],
		});
		const beforeRows = await prisma.historyObservation.findMany({
			where: { instanceId: fixture.instanceId },
			orderBy: { providerEventId: "asc" },
		});
		await prisma.historySourceStatus.update({
			where: { instanceId: fixture.instanceId },
			data: { retainedObservationCount: beforeRows.length },
		});
		const beforeStatus = await prisma.historySourceStatus.findUniqueOrThrow({
			where: { instanceId: fixture.instanceId },
		});
		const result = await publishHistoryObservations(
			{
				attempt: fixture.attempt!,
				leaseClaim: fixture.lease,
				receipt: {
					kind: "completed",
					rawRecordCount: 0,
					normalizedRows: [],
					totalRecordsHint: null,
				},
			},
			prisma,
		);
		expect(result).toMatchObject({ kind: "published", publishedObservationCount: 0 });
		expect(
			await prisma.historyObservation.findMany({
				where: { instanceId: fixture.instanceId },
				orderBy: { providerEventId: "asc" },
			}),
		).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({
			retainedObservationCount: beforeRows.length,
			retentionEpoch: beforeStatus.retentionEpoch,
			publicationRevision: beforeStatus.publicationRevision + 1,
		});
	});

	it.each([
		[
			"oversized completed",
			{ kind: "completed", rawRecordCount: 101, normalizedRows: [], totalRecordsHint: null },
			"provider-limit",
		],
		["oversized adapter", { kind: "adapter-invalid", rawRecordCount: 101 }, "provider-limit"],
		[
			"malformed hint",
			{
				kind: "completed",
				rawRecordCount: 1,
				normalizedRows: [row(901, "sonarr")],
				totalRecordsHint: 0,
			},
			"receipt-invalid",
		],
	])("preserves %s with a bounded reason", async (_name, receipt, reason) => {
		const fixture = await createFixture("sonarr");
		expect(
			await publishHistoryObservations(
				{ attempt: fixture.attempt!, leaseClaim: fixture.lease, receipt: receipt as never },
				prisma,
			),
		).toEqual({ kind: "preserved", finish: "recorded", reason });
	});

	it("creates only the canonical row keys and updates mutable fields immutably", async () => {
		const fixture = await createFixture("sonarr");
		const eventAt = new Date(Date.now() - 60 * 60 * 1000);
		const first = await publish(fixture, [row(7, "sonarr", eventAt, "first title")]);
		expect(first.kind).toBe("published");
		const before = await prisma.historyObservation.findFirstOrThrow();

		const secondAttempt = await replaceAttempt(fixture);
		const second = await publish({ ...fixture, attempt: secondAttempt }, [
			row(7, "sonarr", eventAt, "updated title"),
		]);
		expect(second.kind).toBe("published");
		const after = await prisma.historyObservation.findFirstOrThrow();
		expect(after.id).toBe(before.id);
		expect(after.eventAt).toEqual(before.eventAt);
		expect(after.firstObservedAt).toEqual(before.firstObservedAt);
		expect(after.lastObservedAt.getTime()).toBeGreaterThanOrEqual(before.lastObservedAt.getTime());
		expect(after.searchText).toContain("updated title");
		expect(Object.keys(after).sort()).toEqual([
			"connectionGeneration",
			"eventAt",
			"eventTypeKey",
			"firstObservedAt",
			"id",
			"instanceId",
			"lastObservedAt",
			"normalizedPayload",
			"providerEventId",
			"searchText",
		]);
	});

	it("checks old identities without creating or updating them", async () => {
		const fixture = await createFixture("radarr");
		const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
		await prisma.historyObservation.create({
			data: {
				instanceId: fixture.instanceId,
				connectionGeneration: 3,
				providerEventId: 10,
				eventAt: oldDate,
				eventTypeKey: "old",
				searchText: "old",
				normalizedPayload: '{"version":1}',
				firstObservedAt: oldDate,
				lastObservedAt: oldDate,
			},
		});
		const before = await prisma.historyObservation.findFirstOrThrow();

		const result = await publish(fixture, [row(10, "radarr", oldDate)]);
		expect(result).toMatchObject({ kind: "published", publishedObservationCount: 0 });
		expect(await prisma.historyObservation.findFirst()).toBeNull();
		expect(before.id).toBeDefined();
	});

	it("blocks an immutable cross-attempt event-time conflict before all writes", async () => {
		const fixture = await createFixture("sonarr");
		const existingDate = new Date(Date.now() - 60 * 60 * 1000);
		await prisma.historyObservation.create({
			data: {
				instanceId: fixture.instanceId,
				connectionGeneration: 3,
				providerEventId: 12,
				eventAt: existingDate,
				eventTypeKey: "download",
				searchText: "existing",
				normalizedPayload: '{"version":1}',
				firstObservedAt: existingDate,
				lastObservedAt: existingDate,
			},
		});
		const beforeRows = await prisma.historyObservation.findMany();

		const result = await publish(fixture, [
			row(12, "sonarr", new Date(Date.now() - 30 * 60 * 1000)),
		]);
		expect(result).toEqual({ kind: "preserved", finish: "recorded", reason: "rows-inconsistent" });
		expect(await prisma.historyObservation.findMany()).toEqual(beforeRows);
		expect(
			await prisma.historySourceStatus.findUnique({ where: { instanceId: fixture.instanceId } }),
		).toMatchObject({ lastAttemptResult: "error", lastAttemptReason: "rows-inconsistent" });
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ publicationRevision: 0 });
	});

	it("blocks a within-attempt same-time canonical payload conflict", async () => {
		const fixture = await createFixture("sonarr");
		const eventAt = new Date(Date.now() - 60 * 60 * 1000);
		const result = await publish(fixture, [
			row(13, "sonarr", eventAt, "first"),
			row(13, "sonarr", eventAt, "second"),
		]);
		expect(result).toEqual({ kind: "preserved", finish: "recorded", reason: "rows-inconsistent" });
		expect(await prisma.historyObservation.count()).toBe(0);
	});

	it("checks an old persisted identity for immutable event-time conflicts", async () => {
		const fixture = await createFixture("radarr");
		const persistedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
		await prisma.historyObservation.create({
			data: {
				instanceId: fixture.instanceId,
				connectionGeneration: 3,
				providerEventId: 14,
				eventAt: persistedAt,
				eventTypeKey: "download",
				searchText: "old",
				normalizedPayload: '{"version":1}',
				firstObservedAt: persistedAt,
				lastObservedAt: persistedAt,
			},
		});
		const observedAt = new Date(persistedAt.getTime() + 1_000);
		expect(await publish(fixture, [row(14, "radarr", observedAt)])).toEqual({
			kind: "preserved",
			finish: "recorded",
			reason: "rows-inconsistent",
		});
	});

	it("collapses duplicates while preserving occurrence accounting and supports zero rows", async () => {
		const fixture = await createFixture("prowlarr");
		const duplicate = row(20, "prowlarr");
		const result = await publish(fixture, [duplicate, duplicate]);
		expect(result).toMatchObject({ kind: "published", publishedObservationCount: 1 });
		const metadata = await prisma.historySourceStatus.findUniqueOrThrow({
			where: { instanceId: fixture.instanceId },
		});
		expect(metadata.publicationMetadata).toContain('"rawObserved":2');
		expect(metadata.publicationMetadata).toContain('"sourceBindings":2');

		const zeroFixture = await createFixture("lidarr");
		expect(await publish(zeroFixture, [])).toMatchObject({
			kind: "published",
			publishedObservationCount: 0,
			retainedObservationCount: 0,
		});
	});

	it.each([
		[
			"later unavailable",
			{ result: "error" as const, reason: "provider-unavailable" as const },
			2,
			1,
			1,
		],
		["later limit", { result: "error" as const, reason: "provider-limit" as const }, 2, 1, 1],
	])(
		"publishes prior rows for a valid %s",
		async (_name, outcome, pagesAttempted, pagesCompleted, fatalCount) => {
			const fixture = await createFixture("readarr");
			const result = await publish(fixture, [row(30, "readarr")], {
				pagesAttempted,
				pagesCompleted,
				fatalCount,
				outcome,
			});
			expect(result).toMatchObject({
				kind: "published",
				finish: { result: "success", reason: null },
				publishedObservationCount: 1,
			});
		},
	);

	it.each([
		["first provider failure", 1, 0, 1, "provider-unavailable"],
		["no-page invalid failure", 0, 0, 0, "provider-unavailable"],
		["zero-request unavailable", 0, 0, 0, "provider-unavailable"],
	])(
		"preserves %s without a partial publication",
		async (_name, pagesAttempted, pagesCompleted, fatalCount, reason) => {
			const fixture = await createFixture("sonarr");
			const result = await publish(fixture, [], {
				pagesAttempted,
				pagesCompleted,
				fatalCount,
				outcome: { result: "error", reason: reason as never },
			});
			expect(result.kind).toBe("preserved");
			expect(result).toMatchObject({ reason: "receipt-invalid" });
		},
	);

	it("preserves the explicit zero-request provider-limit stop", async () => {
		const fixture = await createFixture("sonarr");
		expect(
			await publish(fixture, [], {
				pagesAttempted: 0,
				pagesCompleted: 0,
				fatalCount: 0,
				outcome: { result: "error", reason: "provider-limit" },
			}),
		).toEqual({ kind: "preserved", finish: "recorded", reason: "receipt-invalid" });
	});

	it("returns superseded for owner, generation, and lease mismatches", async () => {
		const fixture = await createFixture("sonarr");
		const cases = [
			{
				name: "owner",
				input: {
					leaseClaim: { ...fixture.lease, userId: "other" },
					attempt: { ...fixture.attempt, userId: "other" },
				},
			},
			{
				name: "token",
				input: {
					leaseClaim: { ...fixture.lease, claimToken: "stale-token" },
					attempt: { ...fixture.attempt, resultMarker: markerForClaim("stale-token") },
				},
			},
			{ name: "generation", input: { attempt: { ...fixture.attempt, connectionGeneration: 4 } } },
			{
				name: "marker",
				input: {
					attempt: { ...fixture.attempt, resultMarker: markerForClaim(fixture.lease.claimToken) },
				},
			},
			{ name: "time", input: { attempt: { ...fixture.attempt, attemptedAt: new Date(0) } } },
		];
		for (const testCase of cases) {
			const result = await publish(fixture, [row(40, "sonarr")], {}, prisma, testCase.input);
			expect(result.kind, testCase.name).toBe(
				testCase.name === "token" || testCase.name === "marker" ? "failed" : "superseded",
			);
		}
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ publicationRevision: 0 });
	});

	it("rejects disabled and service-changed instances without changing rows", async () => {
		const fixture = await createFixture("sonarr");
		await prisma.serviceInstance.update({
			where: { id: fixture.instanceId },
			data: { enabled: false },
		});
		expect(await publish(fixture, [row(41, "sonarr")])).toEqual({ kind: "superseded" });
		expect(await prisma.historyObservation.count()).toBe(0);

		const changed = await createFixture("sonarr");
		await prisma.serviceInstance.update({
			where: { id: changed.instanceId },
			data: { service: "RADARR", connectionGeneration: 4 },
		});
		expect(await publish(changed, [row(42, "sonarr")])).toEqual({ kind: "superseded" });
		expect(
			await prisma.historyObservation.count({ where: { instanceId: changed.instanceId } }),
		).toBe(0);
	});

	it("retains the inclusive 90-day boundary and deletes expired rows in bounded batches", async () => {
		const fixture = await createFixture("radarr");
		const now = new Date();
		const databaseNow = await readDatabaseNow();
		const boundary = new Date(databaseNow.getTime() - 90 * 24 * 60 * 60 * 1000 + 2_000);
		await prisma.historyObservation.createMany({
			data: Array.from({ length: 600 }, (_, index) => {
				const expired = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000 - index * 1_000);
				return {
					instanceId: fixture.instanceId,
					connectionGeneration: 3,
					providerEventId: index + 100,
					eventAt: expired,
					eventTypeKey: "download",
					searchText: "expired",
					normalizedPayload: '{"version":1}',
					firstObservedAt: expired,
					lastObservedAt: expired,
				};
			}),
		});
		const result = await publish(fixture, [row(9999, "radarr", boundary)]);
		expect(result).toMatchObject({ kind: "published", deletedObservationCount: 600 });
		expect(
			await prisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
		).toBe(1);
	});

	it("does not advance retention epoch when no row is deleted", async () => {
		const fixture = await createFixture("radarr");
		expect(await publish(fixture, [row(9_500, "radarr")])).toMatchObject({
			kind: "published",
			deletedObservationCount: 0,
		});
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({
			retentionEpoch: 0,
			publicationRevision: 1,
		});
	});

	it("enforces deterministic overflow ties and exact retained/deleted counts", async () => {
		const fixture = await createFixture("lidarr");
		const eventAt = new Date(Date.now() - 60 * 60 * 1000);
		await prisma.historyObservation.createMany({
			data: Array.from({ length: 10_000 }, (_, index) => ({
				instanceId: fixture.instanceId,
				connectionGeneration: 3,
				providerEventId: index + 1,
				eventAt,
				eventTypeKey: "download",
				searchText: "existing",
				normalizedPayload: '{"version":1}',
				firstObservedAt: eventAt,
				lastObservedAt: eventAt,
			})),
		});
		const result = await publish(fixture, [row(10_001, "lidarr")]);
		expect(result).toMatchObject({
			kind: "published",
			publishedObservationCount: 1,
			retainedObservationCount: 10_000,
			deletedObservationCount: 1,
		});
		const oldest = await prisma.historyObservation.findFirst({
			orderBy: [{ eventAt: "asc" }, { id: "asc" }],
		});
		expect(oldest?.providerEventId).toBe(2);
	});

	it("uses bounded identity chunks for more than 999 identities", async () => {
		const fixture = await createFixture("readarr");
		const result = await publish(
			fixture,
			Array.from({ length: 100 }, (_, index) => row(index + 50_000, "readarr")),
		);
		expect(result).toMatchObject({
			kind: "published",
			publishedObservationCount: 100,
			retainedObservationCount: 100,
		});
	});

	it.each([
		["negative raw", { rawObserved: -1 }, "receipt-invalid"],
		["fractional pages", { pagesAttempted: 1.5 }, "receipt-invalid"],
		["unsafe completed", { pagesCompleted: Number.MAX_SAFE_INTEGER + 1 }, "receipt-invalid"],
		["negative fatal", { fatalCount: -1 }, "receipt-invalid"],
		["over request bound", { pagesAttempted: 101, pagesCompleted: 101 }, "receipt-invalid"],
		["over raw bound", { rawObserved: 10_001, normalizedRows: [] }, "provider-limit"],
		[
			"raw page contradiction",
			{
				rawObserved: 101,
				normalizedRows: Array.from({ length: 101 }, (_, index) => row(index + 99, "sonarr")),
			},
			"provider-limit",
		],
	])("preserves malformed structural collection input: %s", async (_name, overrides, reason) => {
		const fixture = await createFixture("sonarr");
		const result = await publish(fixture, [row(99, "sonarr")], overrides);
		expect(result).toMatchObject({ kind: "preserved", reason });
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ publicationRevision: 0 });
	});

	it("preserves future and malformed rows without echoing the input", async () => {
		const fixture = await createFixture("sonarr");
		const future = await publish(fixture, [row(100, "sonarr", new Date(Date.now() + 86_400_000))]);
		expect(future).toEqual({ kind: "preserved", finish: "recorded", reason: "rows-inconsistent" });
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ publicationRevision: 0 });
		const malformed = await publish(await createFixture("sonarr"), [{} as never]);
		expect(malformed).toEqual({
			kind: "preserved",
			finish: "recorded",
			reason: "rows-inconsistent",
		});
	});

	it.each([
		[
			"tampered payload",
			() => ({
				...row(101, "sonarr"),
				payload: { ...row(101, "sonarr").payload, title: "tampered" },
			}),
		],
		["oversized payload", () => ({ ...row(102, "sonarr"), normalizedPayload: "x".repeat(9_000) })],
		[
			"noncanonical payload",
			() => ({
				...row(103, "sonarr"),
				normalizedPayload: `${row(103, "sonarr").normalizedPayload} `,
			}),
		],
	])("preserves %s C5 row input", async (_name, makeRow) => {
		const fixture = await createFixture("sonarr");
		expect(await publish(fixture, [makeRow() as never])).toMatchObject({
			kind: "preserved",
			reason: "rows-inconsistent",
		});
	});

	it("preserves incomplete-page accounting without changing publication", async () => {
		const fixture = await createFixture("sonarr");
		expect(
			await publish(fixture, [row(104, "sonarr")], {
				pagesAttempted: 2,
				pagesCompleted: 2,
				fatalCount: 1,
				outcome: { result: "success" },
			}),
		).toMatchObject({ kind: "preserved", reason: "receipt-invalid" });
	});

	it("creates and reobserves a bounded page through the bulk path", async () => {
		const fixture = await createFixture("prowlarr");
		const input = Array.from({ length: 100 }, (_, index) => row(index + 70_000, "prowlarr"));
		const created = await publish(fixture, input);
		expect(created).toMatchObject({
			kind: "published",
			publishedObservationCount: 100,
			retainedObservationCount: 100,
		});
		const second = await replaceAttempt(fixture);
		const reobserved = await publish({ ...fixture, attempt: second }, input);
		expect(reobserved).toMatchObject({
			kind: "published",
			publishedObservationCount: 100,
			retainedObservationCount: 100,
		});
	});

	it("rolls back observation, retention, publication, epoch, and finish on final fence loss", async () => {
		const fixture = await createFixture("sonarr");
		const fenced = withFinalFenceMiss(prisma);
		const result = await publish(fixture, [row(80, "sonarr")], {}, fenced);
		expect(result).toEqual({ kind: "superseded" });
		expect(await prisma.historyObservation.count()).toBe(0);
		expect(
			await prisma.historySourceStatus.findUnique({ where: { instanceId: fixture.instanceId } }),
		).toMatchObject({
			lastAttemptResult: fixture.attempt?.resultMarker,
			lastAttemptReason: null,
			retentionEpoch: 0,
			publicationRevision: 0,
			collectHeadNext: true,
			nextBackfillPage: 2,
			activeCollectionPage: 1,
		});
	});

	it("rolls back a late finish CAS after update and retention work", async () => {
		const fixture = await createFixture("sonarr");
		const result = await publish(fixture, [row(805, "sonarr")], {}, withFinishCasMiss(prisma));
		expect(result).toEqual({ kind: "failed" });
		expect(await prisma.historyObservation.count()).toBe(0);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({
			lastAttemptResult: fixture.attempt?.resultMarker,
			lastAttemptReason: null,
			publicationRevision: 0,
			collectHeadNext: true,
			nextBackfillPage: 2,
			activeCollectionPage: 1,
		});
	});

	it("replays the complete action on P2034 and returns failed after exhaustion", async () => {
		const fixture = await createFixture("sonarr");
		const retrying = withTransactionFailures(prisma, [{ code: "P2034" }]);
		expect(await publish(fixture, [row(81, "sonarr")], {}, retrying)).toMatchObject({
			kind: "published",
		});
		const exhaustedFixture = await createFixture("radarr");
		const exhausted = withTransactionFailures(prisma, [
			{ code: "P2034" },
			{ code: "P2034" },
			{ code: "P2034" },
		]);
		const before = await prisma.historySourceStatus.findUniqueOrThrow({
			where: { instanceId: exhaustedFixture.instanceId },
		});
		expect(await publish(exhaustedFixture, [row(82, "radarr")], {}, exhausted)).toEqual({
			kind: "failed",
		});
		expect(
			await prisma.historyObservation.count({ where: { instanceId: exhaustedFixture.instanceId } }),
		).toBe(0);
		expect(
			await prisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: exhaustedFixture.instanceId },
			}),
		).toMatchObject({
			lastAttemptResult: before.lastAttemptResult,
			lastAttemptReason: null,
		});
	});

	it("returns a sanitized failed result for an arbitrary database failure", async () => {
		const fixture = await createFixture("sonarr");
		const failing = {
			$transaction: async () => {
				throw new Error("raw database secret");
			},
		} as unknown as PrismaClient;
		expect(await publish(fixture, [row(83, "sonarr")], {}, failing)).toEqual({ kind: "failed" });
	});

	it("does not expose private input, raw errors, provider calls, or arbitrary caller fields", async () => {
		const fixture = await createFixture("sonarr");
		const input = await buildInput(fixture, [row(90, "sonarr")]);
		const injected = {
			...input,
			providerTotal: "999",
			url: "http://secret.invalid",
			cursor: "private-cursor",
			ownerLabel: "private-owner",
			instanceLabel: "private-instance",
			receipt: { provider: "fake" },
			metadata: "raw",
			reasonCodes: ["fake"],
		};
		const result = await publishHistoryObservations(injected as never, prisma);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("secret.invalid");
		expect(serialized).not.toContain("private-cursor");
		expect(serialized).not.toContain("private-owner");
		expect(serialized).not.toContain("private-instance");
		expect(serialized).not.toContain("fake");
	});
});

afterEach(async () => {
	for (const { prisma: postgresPrisma, userId } of postgresUsers.splice(0)) {
		await postgresPrisma.user.deleteMany({ where: { id: userId } });
	}
	for (const cleanup of postgresCleanups.splice(0)) await cleanup();
});

const postgresUrl = process.env.HISTORY_LEASE_POSTGRES_URL ?? "";
const postgresDescribe = isGuardedPostgresUrl(postgresUrl) ? describe : describe.skip;

postgresDescribe("guarded disposable PostgreSQL History publication", { timeout: 30_000 }, () => {
	it("publishes and reobserves through the PostgreSQL bulk update path", async () => {
		const { prisma: postgresPrisma } = await createPostgresDatabase();
		const fixture = await createPostgresFixture(postgresPrisma, "sonarr");
		const eventAt = new Date(Date.now() - 60 * 60 * 1000);
		const first = await withPostgresDialect(() =>
			publish(fixture, [row(20_001, "sonarr", eventAt, "postgres first")], {}, postgresPrisma),
		);
		expect(first).toMatchObject({
			kind: "published",
			publishedObservationCount: 1,
			retainedObservationCount: 1,
		});
		const replacementAttempt = await replacePostgresAttempt(fixture, postgresPrisma);
		const second = await withPostgresDialect(() =>
			publish(
				{ ...fixture, attempt: replacementAttempt },
				[row(20_001, "sonarr", eventAt, "postgres updated")],
				{},
				postgresPrisma,
			),
		);
		expect(second).toMatchObject({ kind: "published", publishedObservationCount: 1 });
		expect(
			await postgresPrisma.historyObservation.findFirstOrThrow({
				where: { instanceId: fixture.instanceId },
				select: { searchText: true },
			}),
		).toMatchObject({ searchText: expect.stringContaining("postgres updated") });
	});

	it("preserves an immutable provider identity conflict on PostgreSQL", async () => {
		const { prisma: postgresPrisma } = await createPostgresDatabase();
		const fixture = await createPostgresFixture(postgresPrisma, "radarr");
		const eventAt = new Date(Date.now() - 60 * 60 * 1000);
		await withPostgresDialect(() =>
			publish(fixture, [row(20_002, "radarr", eventAt)], {}, postgresPrisma),
		);
		const replacementAttempt = await replacePostgresAttempt(fixture, postgresPrisma);
		const result = await withPostgresDialect(() =>
			publish(
				{ ...fixture, attempt: replacementAttempt },
				[row(20_002, "radarr", new Date(eventAt.getTime() + 1_000))],
				{},
				postgresPrisma,
			),
		);
		expect(result).toEqual({ kind: "preserved", finish: "recorded", reason: "rows-inconsistent" });
		expect(
			await postgresPrisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
		).toBe(1);
	});

	it("applies bounded PostgreSQL retention and exact publication counts", async () => {
		const { prisma: postgresPrisma } = await createPostgresDatabase();
		const fixture = await createPostgresFixture(postgresPrisma, "prowlarr");
		const now = new Date(Date.now() - 60 * 1000);
		const expiredAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
		await postgresPrisma.historyObservation.createMany({
			data: Array.from({ length: 501 }, (_, index) => ({
				instanceId: fixture.instanceId,
				connectionGeneration: 3,
				providerEventId: 30_000 + index,
				eventAt: new Date(expiredAt.getTime() + index),
				eventTypeKey: "download",
				searchText: `old-${index}`,
				normalizedPayload: JSON.stringify({ providerEventId: 30_000 + index }),
				firstObservedAt: expiredAt,
				lastObservedAt: expiredAt,
			})),
		});
		const result = await withPostgresDialect(() =>
			publish(fixture, [row(30_999, "prowlarr", now)], {}, postgresPrisma),
		);
		expect(result).toMatchObject({
			kind: "published",
			publishedObservationCount: 1,
			retainedObservationCount: 1,
			deletedObservationCount: 501,
		});
		expect(
			await postgresPrisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ retentionEpoch: 1, retainedObservationCount: 1 });
	});

	it("replays the complete PostgreSQL transaction after P2034", async () => {
		const { prisma: postgresPrisma } = await createPostgresDatabase();
		const fixture = await createPostgresFixture(postgresPrisma, "lidarr");
		const retrying = withTransactionFailures(postgresPrisma, [{ code: "P2034" }]);
		const result = await withPostgresDialect(() =>
			publish(fixture, [row(20_004, "lidarr")], {}, retrying),
		);
		expect(result).toMatchObject({ kind: "published", publishedObservationCount: 1 });
		expect(
			await postgresPrisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
		).toBe(1);
	});

	it("rolls back PostgreSQL publication writes on a final lease fence loss", async () => {
		const { prisma: postgresPrisma } = await createPostgresDatabase();
		const fixture = await createPostgresFixture(postgresPrisma, "readarr");
		const result = await withPostgresDialect(() =>
			publish(fixture, [row(20_005, "readarr")], {}, withFinalFenceMiss(postgresPrisma)),
		);
		expect(result).toEqual({ kind: "superseded" });
		expect(
			await postgresPrisma.historyObservation.count({ where: { instanceId: fixture.instanceId } }),
		).toBe(0);
		expect(
			await postgresPrisma.historySourceStatus.findUniqueOrThrow({
				where: { instanceId: fixture.instanceId },
			}),
		).toMatchObject({ lastAttemptResult: fixture.attempt?.resultMarker, retentionEpoch: 0 });
	});
});

async function createFixture(service: HistoryService): Promise<Fixture> {
	const userId = `publication-owner-${randomUUID()}`;
	const instanceId = `publication-instance-${randomUUID()}`;
	await prisma.user.create({ data: { id: userId, username: userId, hashedPassword: "synthetic" } });
	await prisma.serviceInstance.create({
		data: {
			id: instanceId,
			userId,
			service: serviceTypes[service],
			label: instanceId,
			baseUrl: "http://provider.invalid",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			connectionGeneration: 3,
		},
	});
	const lease = await acquireHistoryCollectionLease(prisma, userId, { dialect: "sqlite" });
	if (!lease) throw new Error("expected lease");
	const attempt = await beginHistorySourceAttempt(
		prisma,
		{ userId, instanceId, leaseClaim: lease },
		{ dialect: "sqlite" },
	);
	if (!attempt) throw new Error("expected source attempt");
	const started = await markHistorySourceAttemptProviderStarted(
		prisma,
		{ ...attempt, leaseClaim: lease },
		{ dialect: "sqlite" },
	);
	if (started.kind !== "started") throw new Error("expected started source attempt");
	return { prisma, userId, instanceId, lease, attempt: started.attempt };
}

async function replaceAttempt(fixture: Fixture) {
	await releaseHistoryCollectionLease(prisma, fixture.lease, { dialect: "sqlite" });
	const lease = await acquireHistoryCollectionLease(prisma, fixture.userId, { dialect: "sqlite" });
	if (!lease) throw new Error("expected replacement lease");
	const attempt = await beginHistorySourceAttempt(
		prisma,
		{ userId: fixture.userId, instanceId: fixture.instanceId, leaseClaim: lease },
		{ dialect: "sqlite" },
	);
	if (!attempt) throw new Error("expected replacement attempt");
	const started = await markHistorySourceAttemptProviderStarted(
		prisma,
		{ ...attempt, leaseClaim: lease },
		{ dialect: "sqlite" },
	);
	if (started.kind !== "started") throw new Error("expected started replacement attempt");
	fixture.lease = lease;
	return started.attempt;
}

async function setAttemptSchedule(
	fixture: Fixture,
	phase: "head" | "backfill",
	collectionPage: number,
	backfillPage: number,
) {
	await prisma.historySourceStatus.update({
		where: { instanceId: fixture.instanceId },
		data: {
			collectHeadNext: phase === "head",
			nextBackfillPage: backfillPage,
			activeCollectionPage: collectionPage,
		},
	});
	const status = await prisma.historySourceStatus.findUniqueOrThrow({
		where: { instanceId: fixture.instanceId },
	});
	if (!status.lastAttemptAt) throw new Error("expected attempt timestamp");
	return {
		...fixture.attempt!,
		phase,
		collectionPage,
		backfillPage,
		attemptedAt: status.lastAttemptAt,
	};
}

async function createPostgresDatabase(): Promise<{ prisma: PrismaClient }> {
	const client = await createTestPgClient(postgresUrl);
	postgresCleanups.push(client.cleanup);
	return { prisma: client.prisma };
}

async function createPostgresFixture(
	postgresPrisma: PrismaClient,
	service: HistoryService,
): Promise<Fixture> {
	const userId = `publication-pg-owner-${randomUUID()}`;
	const instanceId = `publication-pg-instance-${randomUUID()}`;
	postgresUsers.push({ prisma: postgresPrisma, userId });
	await postgresPrisma.user.create({
		data: { id: userId, username: userId, hashedPassword: "synthetic" },
	});
	await postgresPrisma.serviceInstance.create({
		data: {
			id: instanceId,
			userId,
			service: serviceTypes[service],
			label: instanceId,
			baseUrl: "http://provider.invalid",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			connectionGeneration: 3,
		},
	});
	const lease = await acquireHistoryCollectionLease(postgresPrisma, userId, {
		dialect: "postgresql",
	});
	if (!lease) throw new Error("expected PostgreSQL lease");
	const attempt = await beginHistorySourceAttempt(
		postgresPrisma,
		{ userId, instanceId, leaseClaim: lease },
		{ dialect: "postgresql" },
	);
	if (!attempt) throw new Error("expected PostgreSQL source attempt");
	const started = await markHistorySourceAttemptProviderStarted(
		postgresPrisma,
		{ ...attempt, leaseClaim: lease },
		{ dialect: "postgresql" },
	);
	if (started.kind !== "started") throw new Error("expected PostgreSQL started attempt");
	return { prisma: postgresPrisma, userId, instanceId, lease, attempt: started.attempt };
}

async function replacePostgresAttempt(
	fixture: Fixture,
	postgresPrisma: PrismaClient,
): Promise<HistorySourceProviderStartedAttempt> {
	await releaseHistoryCollectionLease(postgresPrisma, fixture.lease, { dialect: "postgresql" });
	const lease = await acquireHistoryCollectionLease(postgresPrisma, fixture.userId, {
		dialect: "postgresql",
	});
	if (!lease) throw new Error("expected replacement PostgreSQL lease");
	const attempt = await beginHistorySourceAttempt(
		postgresPrisma,
		{ userId: fixture.userId, instanceId: fixture.instanceId, leaseClaim: lease },
		{ dialect: "postgresql" },
	);
	if (!attempt) throw new Error("expected replacement PostgreSQL source attempt");
	const started = await markHistorySourceAttemptProviderStarted(
		postgresPrisma,
		{ ...attempt, leaseClaim: lease },
		{ dialect: "postgresql" },
	);
	if (started.kind !== "started")
		throw new Error("expected replacement PostgreSQL started attempt");
	fixture.lease = lease;
	return started.attempt;
}

async function withPostgresDialect<T>(action: () => Promise<T>): Promise<T> {
	const previous = process.env.DATABASE_URL;
	process.env.DATABASE_URL = postgresUrl;
	try {
		return await action();
	} finally {
		if (previous === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previous;
	}
}

function isGuardedPostgresUrl(value: string): boolean {
	if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
	try {
		return new URL(value).pathname === "/history_lease_test";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function row(
	providerEventId: number,
	service: HistoryService,
	eventAt = new Date(Date.now() - 60 * 60 * 1000),
	title = `title-${providerEventId}`,
) {
	const normalized = normalizeHistoryObservation(
		{ id: providerEventId, date: eventAt.toISOString(), eventType: "Download", title },
		service,
	);
	if (!normalized.ok) throw new Error("expected normalized row");
	return normalized.observation;
}

async function buildInput(
	fixture: Fixture,
	rows: readonly ReturnType<typeof row>[],
	overrides: Record<string, unknown> = {},
): Promise<HistoryObservationPublicationInput> {
	const rawObserved = overrides.rawObserved;
	const outcome = overrides.outcome;
	const pagesAttempted = overrides.pagesAttempted;
	const pagesCompleted = overrides.pagesCompleted;
	const fatalCount = overrides.fatalCount;
	const validLegacyShape =
		(rawObserved === undefined ||
			(typeof rawObserved === "number" && Number.isSafeInteger(rawObserved) && rawObserved >= 0)) &&
		(pagesAttempted === undefined ||
			(typeof pagesAttempted === "number" && pagesAttempted === 1)) &&
		(pagesCompleted === undefined ||
			(typeof pagesCompleted === "number" && pagesCompleted === 1)) &&
		(fatalCount === undefined || (typeof fatalCount === "number" && fatalCount === 0));
	const laterPartialSuccess =
		isRecord(outcome) && outcome.result === "error" && pagesAttempted === 2 && pagesCompleted === 1;
	const adapterCount = typeof rawObserved === "number" ? rawObserved : rows.length;
	return {
		attempt: fixture.attempt!,
		leaseClaim: { userId: fixture.lease.userId, claimToken: fixture.lease.claimToken },
		receipt:
			(!validLegacyShape && !laterPartialSuccess) ||
			(isRecord(outcome) && outcome.result === "error" && !laterPartialSuccess)
				? { kind: "adapter-invalid", rawRecordCount: adapterCount }
				: {
						kind: "completed",
						rawRecordCount: adapterCount,
						normalizedRows: rows,
						totalRecordsHint: null,
					},
	};
}

async function publish(
	fixture: Fixture,
	rows: readonly ReturnType<typeof row>[],
	overrides: Record<string, unknown> = {},
	client = prisma,
	inputOverrides: Record<string, unknown> = {},
) {
	const input = await buildInput(fixture, rows, overrides);
	return await publishHistoryObservations({ ...input, ...inputOverrides }, client);
}

function withTransactionFailures(prismaClient: PrismaClient, failures: unknown[]): PrismaClient {
	let index = 0;
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) => {
			return await prismaClient.$transaction(async (tx) => {
				const value = await action(tx);
				if (index < failures.length) throw failures[index++];
				return value;
			}, options);
		},
	} as unknown as PrismaClient;
}

function withFinalFenceMiss(prismaClient: PrismaClient): PrismaClient {
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prismaClient.$transaction(async (tx) => {
				let fenceCount = 0;
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "$executeRawUnsafe") return Reflect.get(target, property, receiver);
						return async (...args: unknown[]) => {
							if (typeof args[0] === "string" && args[0].includes("history_collection_leases")) {
								fenceCount += 1;
								if (fenceCount === 2) return 0;
							}
							return await (target.$executeRawUnsafe as (...values: unknown[]) => Promise<number>)(
								...args,
							);
						};
					},
				});
				return await action(proxy);
			}, options),
	} as unknown as PrismaClient;
}

function withFinishCasMiss(prismaClient: PrismaClient): PrismaClient {
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prismaClient.$transaction(async (tx) => {
				let statusUpdates = 0;
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "historySourceStatus") return Reflect.get(target, property, receiver);
						return new Proxy(target.historySourceStatus, {
							get(model, modelProperty, modelReceiver) {
								if (modelProperty !== "updateMany")
									return Reflect.get(model, modelProperty, modelReceiver);
								return async (...args: unknown[]) => {
									statusUpdates += 1;
									if (statusUpdates === 1) return { count: 0 };
									return await model.updateMany(...(args as Parameters<typeof model.updateMany>));
								};
							},
						});
					},
				});
				return await action(proxy);
			}, options),
	} as unknown as PrismaClient;
}

function withPublicationCasCapture(prismaClient: PrismaClient, calls: unknown[][]): PrismaClient {
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prismaClient.$transaction(async (tx) => {
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "historySourceStatus") return Reflect.get(target, property, receiver);
						return new Proxy(target.historySourceStatus, {
							get(model, modelProperty, modelReceiver) {
								if (modelProperty !== "updateMany")
									return Reflect.get(model, modelProperty, modelReceiver);
								return async (...args: unknown[]) => {
									calls.push(args);
									return await model.updateMany(...(args as Parameters<typeof model.updateMany>));
								};
							},
						});
					},
				});
				return await action(proxy);
			}, options),
	} as unknown as PrismaClient;
}

function markerForClaim(claimToken: string): `in_progress:v1:${string}:${string}` {
	return `in_progress:v1:${createHash("sha256").update(claimToken, "utf8").digest("hex")}:${randomUUID()}`;
}

async function readDatabaseNow(): Promise<Date> {
	const rows = await prisma.$queryRawUnsafe<Array<{ now: string }>>(
		"SELECT CURRENT_TIMESTAMP AS now",
	);
	const value = rows[0]?.now;
	if (!value) throw new Error("expected database timestamp");
	return new Date(`${value.replace(" ", "T")}Z`);
}

async function setPublicationRevision(instanceId: string, revision: number): Promise<void> {
	await prisma.$executeRawUnsafe(
		"UPDATE history_source_statuses SET publicationRevision = ? WHERE instanceId = ?",
		revision,
		instanceId,
	);
}

async function readPublicationRevision(instanceId: string): Promise<number> {
	const rows = await prisma.$queryRawUnsafe<Array<{ publicationRevision: number }>>(
		"SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?",
		instanceId,
	);
	const revision = rows[0]?.publicationRevision;
	if (typeof revision !== "number") throw new Error("expected publication revision");
	return revision;
}
