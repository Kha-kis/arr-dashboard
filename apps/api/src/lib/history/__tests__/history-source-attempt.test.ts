import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import { createTestPgClient } from "../../__tests__/test-prisma.js";
import {
	acquireHistoryCollectionLease,
	releaseHistoryCollectionLease,
} from "../history-collection-lease.js";
import type {
	HistorySourceAttempt,
	HistorySourceProviderPreparedAttempt,
	HistorySourceProviderStartedAttempt,
} from "../history-source-attempt.js";
import {
	beginHistorySourceAttempt,
	decodeHistorySourceAttemptProjection,
	deferHistorySourceAttemptBeforeProvider,
	finishHistorySourceAttemptFailure,
	HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS,
	markHistorySourceAttemptProviderStarted,
} from "../history-source-attempt.js";

describe("History source-attempt projection decoder", () => {
	const fingerprint = "a".repeat(64);
	const marker = `in_progress:v1:${fingerprint}:123e4567-e89b-42d3-a456-426614174000`;
	const attemptedAt = "2026-09-03T12:00:00.000Z";
	const preparedMarker = `in_progress:v2:prepared:${fingerprint}:123e4567-e89b-42d3-a456-426614174000`;
	const startedMarker = `in_progress:v2:started:${fingerprint}:123e4567-e89b-42d3-a456-426614174000`;

	it.each([
		["idle", null, null, null, { valid: true, state: "idle", attemptedAt: null, reason: null }],
		[
			"successful",
			attemptedAt,
			"success",
			null,
			{ valid: true, state: "successful", attemptedAt: new Date(attemptedAt), reason: null },
		],
		[
			"successful finite Date",
			new Date(attemptedAt),
			"success",
			null,
			{ valid: true, state: "successful", attemptedAt: new Date(attemptedAt), reason: null },
		],
		[
			"successful SQLite timestamp",
			"2026-09-03 12:00:00",
			"success",
			null,
			{ valid: true, state: "successful", attemptedAt: new Date(attemptedAt), reason: null },
		],
		[
			"running",
			attemptedAt,
			marker,
			null,
			{ valid: true, state: "running", attemptedAt: new Date(attemptedAt), reason: null },
		],
		[
			"prepared running",
			attemptedAt,
			preparedMarker,
			null,
			{ valid: true, state: "running", attemptedAt: new Date(attemptedAt), reason: null },
		],
		[
			"started running",
			attemptedAt,
			startedMarker,
			null,
			{ valid: true, state: "running", attemptedAt: new Date(attemptedAt), reason: null },
		],
		...[
			"provider-unavailable",
			"provider-limit",
			"rows-inconsistent",
			"receipt-invalid",
			"unknown-failure",
		].map((reason) => [
			`failed ${reason}`,
			attemptedAt,
			"error",
			reason,
			{ valid: true, state: "failed", attemptedAt: new Date(attemptedAt), reason },
		]),
		[
			"collection deferred",
			attemptedAt,
			"error",
			"collection-deferred",
			{
				valid: true,
				state: "failed",
				attemptedAt: new Date(attemptedAt),
				reason: "collection-deferred",
			},
		],
	] as Array<[string, unknown, unknown, unknown, unknown]>)(
		"decodes %s",
		(_name, lastAttemptAt, lastAttemptResult, lastAttemptReason, expected) => {
			const result = decodeHistorySourceAttemptProjection(
				lastAttemptAt,
				lastAttemptResult,
				lastAttemptReason,
			);
			expect(result).toEqual(expected);
			if (result.valid && result.attemptedAt) {
				expect(result.attemptedAt).not.toBe(lastAttemptAt);
			}
		},
	);

	it.each([
		[
			"uppercase fingerprint",
			attemptedAt,
			`in_progress:v1:${fingerprint.toUpperCase()}:123e4567-e89b-42d3-a456-426614174000`,
			null,
		],
		[
			"non-v4 UUID",
			attemptedAt,
			`in_progress:v1:${fingerprint}:123e4567-e89b-12d3-a456-426614174000`,
			null,
		],
		[
			"wrong marker prefix",
			attemptedAt,
			`running:v1:${fingerprint}:123e4567-e89b-42d3-a456-426614174000`,
			null,
		],
		[
			"wrong marker separators",
			attemptedAt,
			`in_progress:v1:${fingerprint}:123e4567e89b42d3a456426614174000`,
			null,
		],
		["partial nulls", null, "success", null],
		["malformed date", "not-a-date", "success", null],
		["invalid Date", new Date("invalid"), "success", null],
		["non-finite Date", new Date(Number.NaN), "success", null],
		["success with reason", attemptedAt, "success", "provider-limit"],
		["error without reason", attemptedAt, "error", null],
		["error with raw reason", attemptedAt, "error", "provider secret"],
		["marker with reason", attemptedAt, marker, "provider-limit"],
	] as const)("rejects %s", (_name, lastAttemptAt, lastAttemptResult, lastAttemptReason) => {
		expect(
			decodeHistorySourceAttemptProjection(lastAttemptAt, lastAttemptResult, lastAttemptReason),
		).toEqual({ valid: false });
	});

	it("does not expose marker fingerprints or private marker fields", () => {
		const result = decodeHistorySourceAttemptProjection(attemptedAt, marker, null);
		expect(JSON.stringify(result)).not.toContain(fingerprint);
		expect(Object.keys(result).sort()).toEqual(["attemptedAt", "reason", "state", "valid"]);
	});

	it("exposes a separate terminal reason vocabulary without widening operational failures", async () => {
		const source = await import("../history-source-attempt.js");
		expect(source.HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS).toEqual([
			"provider-unavailable",
			"provider-limit",
			"rows-inconsistent",
			"receipt-invalid",
			"unknown-failure",
		]);
		expect(source.HISTORY_SOURCE_ATTEMPT_TERMINAL_REASONS).toEqual([
			"provider-unavailable",
			"provider-limit",
			"rows-inconsistent",
			"receipt-invalid",
			"unknown-failure",
			"collection-deferred",
		]);
	});
});

const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];
const postgresCleanups: Array<() => Promise<void>> = [];
const postgresUsers: Array<{ prisma: PrismaClient; userId: string }> = [];
const databasePath = resolve(process.cwd(), "prisma/schema.prisma");

afterEach(async () => {
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		rmSync(directory, { recursive: true, force: true });
	}
	for (const { prisma, userId } of postgresUsers.splice(0)) {
		await prisma.user.deleteMany({ where: { id: userId } });
	}
	for (const cleanup of postgresCleanups.splice(0)) await cleanup();
});

describe("History source-attempt CAS", { timeout: 30_000 }, () => {
	it("creates a database-timestamped strict private running marker", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-begin", "source-begin");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-begin", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");

		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-begin", instanceId: "source-begin", leaseClaim: lease },
			{ dialect: "sqlite" },
		);

		expect(attempt).toMatchObject({
			userId: "owner-begin",
			instanceId: "source-begin",
			connectionGeneration: 3,
			phase: "head",
			collectionPage: 1,
			backfillPage: 2,
		});
		if (!attempt) throw new Error("expected attempt");
		expect(Number.isFinite(attempt.attemptedAt.getTime())).toBe(true);
		expect(attempt.resultMarker).toMatch(
			/^in_progress:v2:prepared:[0-9a-f]{64}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(attempt.resultMarker).toContain(
			createHash("sha256").update(lease.claimToken).digest("hex"),
		);
		expect(await readStatus(prisma, "source-begin")).toMatchObject({
			connectionGeneration: 3,
			lastAttemptResult: attempt.resultMarker,
			lastAttemptReason: null,
			collectHeadNext: true,
			nextBackfillPage: 2,
			activeCollectionPage: 1,
		});
	});

	it("transitions one prepared marker to started without changing attempt identity or schedule", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-start", "source-start");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-start", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-start", instanceId: "source-start", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const before = await readStatus(prisma, "source-start");
		const result = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...prepared, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(result.kind).toBe("started");
		if (result.kind !== "started") return;
		expect(Object.keys(result.attempt).sort()).toEqual([
			"attemptedAt",
			"backfillPage",
			"collectionPage",
			"connectionGeneration",
			"instanceId",
			"phase",
			"resultMarker",
			"userId",
		]);
		expect(JSON.stringify(result.attempt)).not.toContain(lease.claimToken);
		expect(result.attempt).toMatchObject({
			...prepared,
			resultMarker: prepared.resultMarker.replace(":prepared:", ":started:"),
		});
		expect(await readStatus(prisma, "source-start")).toMatchObject({
			lastAttemptAt: before.lastAttemptAt,
			lastAttemptResult: result.attempt.resultMarker,
			lastAttemptReason: null,
			collectHeadNext: before.collectHeadNext,
			nextBackfillPage: before.nextBackfillPage,
			activeCollectionPage: before.activeCollectionPage,
		});
	});

	it("records prepared head deferral with an exact older timestamp and preserves retry schedule", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-defer", "source-defer");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-defer", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-defer", instanceId: "source-defer", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const older = new Date("2026-09-03T00:00:00.000Z");
		await prisma.historySourceStatus.update({
			where: { instanceId: "source-defer" },
			data: { lastAttemptAt: older },
		});
		const deferred = await deferHistorySourceAttemptBeforeProvider(
			prisma,
			{ ...prepared, attemptedAt: older, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(deferred).toBe("recorded");
		expect(await readStatus(prisma, "source-defer")).toMatchObject({
			lastAttemptAt: older,
			lastAttemptResult: "error",
			lastAttemptReason: "collection-deferred",
			collectHeadNext: true,
			nextBackfillPage: 2,
			activeCollectionPage: null,
		});
	});

	it("preserves a deferred backfill page for the next begin under the same lease", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-defer-page", "source-defer-page");
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "source-defer-page",
				connectionGeneration: 3,
				collectHeadNext: false,
				nextBackfillPage: 7,
				activeCollectionPage: null,
			},
		});
		const lease = await acquireHistoryCollectionLease(prisma, "owner-defer-page", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-defer-page", instanceId: "source-defer-page", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		expect(prepared).toMatchObject({ phase: "backfill", collectionPage: 7, backfillPage: 7 });
		expect(
			await deferHistorySourceAttemptBeforeProvider(
				prisma,
				{ ...prepared, leaseClaim: lease },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		const retry = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-defer-page", instanceId: "source-defer-page", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(retry).toMatchObject({ phase: "backfill", collectionPage: 7, backfillPage: 7 });
	});

	it("rejects deferral after start and makes the generic finisher reject collection-deferred", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-stage", "source-stage");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-stage", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-stage", instanceId: "source-stage", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...prepared, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		expect(
			await deferHistorySourceAttemptBeforeProvider(
				prisma,
				{ ...prepared, leaseClaim: lease },
				{ dialect: "sqlite" },
			),
		).toBe("superseded");
		expect(
			await deferHistorySourceAttemptBeforeProvider(
				prisma,
				{ ...started.attempt, leaseClaim: lease } as never,
				{ dialect: "sqlite" },
			),
		).toBe("failed");
		const before = await readStatus(prisma, "source-stage");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "collection-deferred" } as never,
				{ dialect: "sqlite" },
			),
		).toBe("failed");
		expect(await readStatus(prisma, "source-stage")).toEqual(before);
	});

	it("allows only unknown-failure for prepared generic failure and preserves invalid rows", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-pairing", "source-pairing");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-pairing", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-pairing", instanceId: "source-pairing", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const before = await readStatus(prisma, "source-pairing");
		for (const reason of [
			"provider-unavailable",
			"provider-limit",
			"rows-inconsistent",
			"receipt-invalid",
		]) {
			expect(
				await finishHistorySourceAttemptFailure(
					prisma,
					{ ...prepared, leaseClaim: lease, reason } as never,
					{ dialect: "sqlite" },
				),
			).toBe("failed");
			expect(await readStatus(prisma, "source-pairing")).toEqual(before);
		}
	});

	it("fails closed for malformed start and deferral claims without throwing or echoing inputs", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-claim-shape", "source-claim-shape");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-claim-shape", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-claim-shape", instanceId: "source-claim-shape", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const before = await readStatus(prisma, "source-claim-shape");
		const privateValue = "owner-secret source-secret https://secret.invalid token-secret";
		const malformedClaims: unknown[] = [
			null,
			1,
			{},
			{ userId: "owner-claim-shape" },
			{ claimToken: lease.claimToken },
			{ userId: privateValue, claimToken: privateValue },
		];
		for (const claim of malformedClaims) {
			const started = await markHistorySourceAttemptProviderStarted(
				prisma,
				{ ...prepared, leaseClaim: claim } as never,
				{ dialect: "sqlite" },
			);
			expect(started).toEqual({ kind: "failed" });
			expect(JSON.stringify(started)).not.toContain(privateValue);
			const deferred = await deferHistorySourceAttemptBeforeProvider(
				prisma,
				{ ...prepared, leaseClaim: claim } as never,
				{ dialect: "sqlite" },
			);
			expect(deferred).toBe("failed");
			expect(deferred).not.toContain(privateValue);
		}
		expect(await readStatus(prisma, "source-claim-shape")).toEqual(before);
	}, 90_000);

	it("commits exactly one transition when provider start races prepared deferral", async () => {
		const { clients, prisma } = await createDatabase(2);
		await createUserAndInstance(prisma, "owner-race", "source-race");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-race", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-race", instanceId: "source-race", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const [started, deferred] = await Promise.all([
			markHistorySourceAttemptProviderStarted(
				clients[0]!,
				{ ...prepared, leaseClaim: lease },
				{ dialect: "sqlite" },
			),
			deferHistorySourceAttemptBeforeProvider(
				clients[1]!,
				{ ...prepared, leaseClaim: lease },
				{ dialect: "sqlite" },
			),
		]);
		expect([started.kind === "started", deferred === "recorded"].filter(Boolean)).toHaveLength(1);
		const status = await readStatus(prisma, "source-race");
		if (started.kind === "started") {
			expect(deferred).toBe("superseded");
			expect(status).toMatchObject({
				lastAttemptResult: started.attempt.resultMarker,
				lastAttemptReason: null,
			});
		} else {
			expect(started.kind).toBe("superseded");
			expect(deferred).toBe("recorded");
			expect(status).toMatchObject({
				lastAttemptResult: "error",
				lastAttemptReason: "collection-deferred",
			});
		}
	});

	it("rolls back a transition when its post-write invariant reread is inconsistent", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-reread", "source-reread");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-reread", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const prepared = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-reread", instanceId: "source-reread", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!prepared) throw new Error("expected prepared attempt");
		const beforeStatus = await readStatus(prisma, "source-reread");
		const beforeLease = await readLease(prisma, "owner-reread");
		const result = await markHistorySourceAttemptProviderStarted(
			withPostWriteReadMismatch(prisma),
			{ ...prepared, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(result).toEqual({ kind: "failed" });
		expect(await readStatus(prisma, "source-reread")).toEqual(beforeStatus);
		expect(await readLease(prisma, "owner-reread")).toEqual(beforeLease);
	});

	it("allows one same-lease winner and denies the second begin", async () => {
		const { clients, prisma } = await createDatabase(2);
		await createUserAndInstance(prisma, "owner-concurrent", "source-concurrent");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-concurrent", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const results = await Promise.all(
			clients.map(
				async (client) =>
					await beginHistorySourceAttempt(
						client,
						{
							userId: "owner-concurrent",
							instanceId: "source-concurrent",
							leaseClaim: lease,
						},
						{ dialect: "sqlite" },
					),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.filter((result) => result?.resultMarker)).toHaveLength(1);
		const persisted = await readStatus(prisma, "source-concurrent");
		expect(persisted.lastAttemptResult).toBe(results.find(Boolean)?.resultMarker);
	});

	it("binds an advanced persisted backfill page to the next attempt", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-advanced", "source-advanced");
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "source-advanced",
				connectionGeneration: 3,
				collectHeadNext: false,
				nextBackfillPage: 7,
			},
		});
		const lease = await acquireHistoryCollectionLease(prisma, "owner-advanced", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-advanced", instanceId: "source-advanced", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(attempt).toMatchObject({ phase: "backfill", collectionPage: 7, backfillPage: 7 });
		expect(await readStatus(prisma, "source-advanced")).toMatchObject({
			collectHeadNext: false,
			nextBackfillPage: 7,
			activeCollectionPage: 7,
		});
	});

	it("recovers a stranded backfill marker into a head turn while retaining its cursor", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-stranded-backfill", "source-stranded-backfill");
		const firstLease = await acquireHistoryCollectionLease(prisma, "owner-stranded-backfill", {
			dialect: "sqlite",
		});
		if (!firstLease) throw new Error("expected first lease");
		const first = await beginHistorySourceAttempt(
			prisma,
			{
				userId: "owner-stranded-backfill",
				instanceId: "source-stranded-backfill",
				leaseClaim: firstLease,
			},
			{ dialect: "sqlite" },
		);
		if (!first) throw new Error("expected first attempt");
		await prisma.historySourceStatus.update({
			where: { instanceId: "source-stranded-backfill" },
			data: { collectHeadNext: false, nextBackfillPage: 7, activeCollectionPage: 7 },
		});
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second'), claimedAt = datetime(CURRENT_TIMESTAMP, '-301 seconds'), heartbeatAt = datetime(CURRENT_TIMESTAMP, '-301 seconds') WHERE userId = ?`,
			"owner-stranded-backfill",
		);
		await releaseHistoryCollectionLease(prisma, firstLease, { dialect: "sqlite" });
		const secondLease = await acquireHistoryCollectionLease(prisma, "owner-stranded-backfill", {
			dialect: "sqlite",
		});
		if (!secondLease) throw new Error("expected replacement lease");
		const second = await beginHistorySourceAttempt(
			prisma,
			{
				userId: "owner-stranded-backfill",
				instanceId: "source-stranded-backfill",
				leaseClaim: secondLease,
			},
			{ dialect: "sqlite" },
		);
		expect(second).toMatchObject({ phase: "backfill", collectionPage: 7, backfillPage: 7 });
		expect(await readStatus(prisma, "source-stranded-backfill")).toMatchObject({
			collectHeadNext: false,
			nextBackfillPage: 7,
			activeCollectionPage: 7,
		});
	});

	it("replaces a stranded marker only after a new lease", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-reclaim", "source-reclaim");
		const firstLease = await acquireHistoryCollectionLease(prisma, "owner-reclaim", {
			dialect: "sqlite",
		});
		if (!firstLease) throw new Error("expected first lease");
		const first = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-reclaim", instanceId: "source-reclaim", leaseClaim: firstLease },
			{ dialect: "sqlite" },
		);
		if (!first) throw new Error("expected first attempt");
		expect(
			await beginHistorySourceAttempt(
				prisma,
				{ userId: "owner-reclaim", instanceId: "source-reclaim", leaseClaim: firstLease },
				{ dialect: "sqlite" },
			),
		).toBeNull();
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second'),
			 claimedAt = datetime(CURRENT_TIMESTAMP, '-301 seconds'), heartbeatAt = datetime(CURRENT_TIMESTAMP, '-301 seconds')
			 WHERE userId = ?`,
			"owner-reclaim",
		);
		expect(await releaseHistoryCollectionLease(prisma, firstLease, { dialect: "sqlite" })).toBe(
			true,
		);
		const secondLease = await acquireHistoryCollectionLease(prisma, "owner-reclaim", {
			dialect: "sqlite",
		});
		if (!secondLease) throw new Error("expected replacement lease");
		const second = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-reclaim", instanceId: "source-reclaim", leaseClaim: secondLease },
			{ dialect: "sqlite" },
		);
		expect(second).not.toBeNull();
		expect(second).toMatchObject({ phase: "head", collectionPage: 1, backfillPage: 2 });
		expect(second?.resultMarker).not.toBe(first.resultMarker);
	});

	it("does not recover a persisted future attempt or change its status", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-future-recovery", "source-future-recovery");
		const firstLease = await acquireHistoryCollectionLease(prisma, "owner-future-recovery", {
			dialect: "sqlite",
		});
		if (!firstLease) throw new Error("expected first lease");
		const first = await beginHistorySourceAttempt(
			prisma,
			{
				userId: "owner-future-recovery",
				instanceId: "source-future-recovery",
				leaseClaim: firstLease,
			},
			{ dialect: "sqlite" },
		);
		if (!first) throw new Error("expected first attempt");
		await prisma.$executeRawUnsafe(
			"UPDATE history_source_statuses SET lastAttemptAt = datetime(CURRENT_TIMESTAMP, '+1 day') WHERE instanceId = ?",
			"source-future-recovery",
		);
		const before = await readStatus(prisma, "source-future-recovery");
		await prisma.$executeRawUnsafe(
			"UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second'), claimedAt = datetime(CURRENT_TIMESTAMP, '-301 seconds'), heartbeatAt = datetime(CURRENT_TIMESTAMP, '-301 seconds') WHERE userId = ?",
			"owner-future-recovery",
		);
		await releaseHistoryCollectionLease(prisma, firstLease, { dialect: "sqlite" });
		const replacementLease = await acquireHistoryCollectionLease(prisma, "owner-future-recovery", {
			dialect: "sqlite",
		});
		if (!replacementLease) throw new Error("expected replacement lease");
		expect(
			await beginHistorySourceAttempt(
				prisma,
				{
					userId: "owner-future-recovery",
					instanceId: "source-future-recovery",
					leaseClaim: replacementLease,
				},
				{ dialect: "sqlite" },
			),
		).toBeNull();
		expect(await readStatus(prisma, "source-future-recovery")).toEqual(before);
	});

	it.each([
		["wrong owner", { userId: "other-owner" }],
		["wrong instance", { instanceId: "missing-source" }],
		["wrong claim owner", { leaseClaim: { userId: "other-owner", claimToken: "bad" } }],
	])("fails closed for %s begin authority", async (_name, override) => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-authority", "source-authority");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-authority", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const result = await beginHistorySourceAttempt(
			prisma,
			{
				userId: "owner-authority",
				instanceId: "source-authority",
				leaseClaim: lease,
				...override,
			} as never,
			{ dialect: "sqlite" },
		);
		expect(result).toBeNull();
	});

	it.each([
		[
			"malformed marker",
			{
				lastAttemptAt: "2026-09-03T00:00:00.000Z",
				lastAttemptResult: "in_progress:v1:bad:marker",
				lastAttemptReason: null,
			},
		],
		[
			"malformed marker hex",
			{
				lastAttemptAt: "2026-09-03T00:00:00.000Z",
				lastAttemptResult: `in_progress:v1:${"G".repeat(64)}:${randomUUID()}`,
				lastAttemptReason: null,
			},
		],
		[
			"inconsistent reason",
			{
				lastAttemptAt: "2026-09-03T00:00:00.000Z",
				lastAttemptResult: "success",
				lastAttemptReason: "provider-limit",
			},
		],
		[
			"inconsistent time",
			{ lastAttemptAt: null, lastAttemptResult: "success", lastAttemptReason: null },
		],
		[
			"generation mismatch",
			{
				connectionGeneration: 2,
				lastAttemptAt: "2026-09-03T00:00:00.000Z",
				lastAttemptResult: "success",
				lastAttemptReason: null,
			},
		],
	])("leaves %s source state unchanged and fails closed", async (_name, override) => {
		const statusOverride = override as {
			connectionGeneration?: number;
			lastAttemptAt: string | null;
			lastAttemptResult: string;
			lastAttemptReason: string | null;
		};
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-malformed", "source-malformed");
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "source-malformed",
				connectionGeneration: statusOverride.connectionGeneration ?? 3,
				lastAttemptAt: statusOverride.lastAttemptAt ? new Date(statusOverride.lastAttemptAt) : null,
				lastAttemptResult: statusOverride.lastAttemptResult,
				lastAttemptReason: statusOverride.lastAttemptReason,
			},
		});
		const before = await readStatus(prisma, "source-malformed");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-malformed", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		expect(
			await beginHistorySourceAttempt(
				prisma,
				{ userId: "owner-malformed", instanceId: "source-malformed", leaseClaim: lease },
				{ dialect: "sqlite" },
			),
		).toBeNull();
		expect(await readStatus(prisma, "source-malformed")).toEqual(before);
	});

	it.each([-1, 2_147_483_648, 1.5])(
		"rejects malformed publication revision %s before beginning an attempt",
		async (publicationRevision) => {
			const { prisma } = await createDatabase();
			await createUserAndInstance(prisma, "owner-revision-invalid", "source-revision-invalid");
			await prisma.historySourceStatus.create({
				data: { instanceId: "source-revision-invalid", connectionGeneration: 3 },
			});
			await prisma.$executeRawUnsafe(
				"UPDATE history_source_statuses SET publicationRevision = ? WHERE instanceId = ?",
				publicationRevision,
				"source-revision-invalid",
			);
			const lease = await acquireHistoryCollectionLease(prisma, "owner-revision-invalid", {
				dialect: "sqlite",
			});
			if (!lease) throw new Error("expected lease");
			expect(
				await beginHistorySourceAttempt(
					prisma,
					{
						userId: "owner-revision-invalid",
						instanceId: "source-revision-invalid",
						leaseClaim: lease,
					},
					{ dialect: "sqlite" },
				),
			).toBeNull();
		},
	);

	it("preserves a seeded nonzero revision through prepared-to-started", async () => {
		const { prisma } = await createDatabase();
		const fixture = await createPreparedRevisionFixture(prisma, "started");
		await setPublicationRevision(prisma, fixture.instanceId, 41);
		const result = await markHistorySourceAttemptProviderStarted(prisma, {
			...fixture.attempt,
			leaseClaim: fixture.lease,
		});
		expect(result.kind).toBe("started");
		expect(await readPublicationRevision(prisma, fixture.instanceId)).toBe(41);
	});

	it("preserves a seeded nonzero revision through prepared-to-deferred", async () => {
		const { prisma } = await createDatabase();
		const fixture = await createPreparedRevisionFixture(prisma, "deferred");
		await setPublicationRevision(prisma, fixture.instanceId, 42);
		expect(
			await deferHistorySourceAttemptBeforeProvider(prisma, {
				...fixture.attempt,
				leaseClaim: fixture.lease,
			}),
		).toBe("recorded");
		expect(await readPublicationRevision(prisma, fixture.instanceId)).toBe(42);
	});

	it("preserves a seeded nonzero revision through started generic failure", async () => {
		const { prisma } = await createDatabase();
		const fixture = await createStartedRevisionFixture(prisma, "failure");
		await setPublicationRevision(prisma, fixture.instanceId, 43);
		expect(
			await finishHistorySourceAttemptFailure(prisma, {
				...fixture.attempt,
				leaseClaim: fixture.lease,
				reason: "provider-limit",
			}),
		).toBe("recorded");
		expect(await readPublicationRevision(prisma, fixture.instanceId)).toBe(43);
	});

	it("denies disabled, non-History, unsafe-generation, and missing sources", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-source-matrix", "source-disabled", {
			enabled: false,
		});
		await createUserAndInstance(prisma, "owner-source-matrix", "source-non-history", {
			service: "PLEX",
		});
		await createUserAndInstance(prisma, "owner-source-matrix", "source-unsafe-generation", {
			connectionGeneration: -1,
		});
		const lease = await acquireHistoryCollectionLease(prisma, "owner-source-matrix", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		for (const instanceId of [
			"source-disabled",
			"source-non-history",
			"source-unsafe-generation",
			"source-missing",
		]) {
			expect(
				await beginHistorySourceAttempt(
					prisma,
					{ userId: "owner-source-matrix", instanceId, leaseClaim: lease },
					{ dialect: "sqlite" },
				),
			).toBeNull();
		}
	});

	it("preserves publication, retention, and observations on begin", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-preserve", "source-preserve");
		await prisma.historyObservation.create({
			data: {
				id: "observation-preserved",
				instanceId: "source-preserve",
				connectionGeneration: 3,
				providerEventId: 7,
				eventAt: new Date("2026-09-03T00:00:00Z"),
				eventTypeKey: "download",
				searchText: "synthetic",
				normalizedPayload: "{}",
				firstObservedAt: new Date("2026-09-03T00:00:00Z"),
				lastObservedAt: new Date("2026-09-03T00:00:00Z"),
			},
		});
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "source-preserve",
				connectionGeneration: 3,
				publishedAt: new Date("2026-09-02T00:00:00Z"),
				publicationMetadata: '{"private":"no"}',
				retainedObservationCount: 1,
				retentionEpoch: 4,
			},
		});
		await prisma.$executeRawUnsafe(
			"UPDATE history_source_statuses SET publicationRevision = ? WHERE instanceId = ?",
			13,
			"source-preserve",
		);
		const beforeStatus = await readStatus(prisma, "source-preserve");
		const beforeObservation = await prisma.historyObservation.findUnique({
			where: { id: "observation-preserved" },
		});
		const lease = await acquireHistoryCollectionLease(prisma, "owner-preserve", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-preserve", instanceId: "source-preserve", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(await readStatus(prisma, "source-preserve")).toMatchObject({
			publicationMetadata: '{"private":"no"}',
			retainedObservationCount: 1,
			retentionEpoch: 4,
			publicationRevision: 13,
		});
		expect((await readStatus(prisma, "source-preserve")).publishedAt).toEqual(
			beforeStatus.publishedAt,
		);
		expect((await readStatus(prisma, "source-preserve")).retainedObservationCount).toBe(
			beforeStatus.retainedObservationCount,
		);
		expect((await readStatus(prisma, "source-preserve")).retentionEpoch).toBe(
			beforeStatus.retentionEpoch,
		);
		expect(
			await prisma.historyObservation.count({ where: { instanceId: "source-preserve" } }),
		).toBe(1);
		expect(
			await prisma.historyObservation.findUnique({ where: { id: "observation-preserved" } }),
		).toEqual(beforeObservation);
	});

	it("records an allowlisted first-page failure without erasing prior rows", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-failure", "source-failure");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-failure", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-failure", instanceId: "source-failure", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...attempt, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "provider-limit" },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		expect(await readStatus(prisma, "source-failure")).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptReason: "provider-limit",
			collectHeadNext: false,
			nextBackfillPage: 2,
			activeCollectionPage: null,
		});
	});

	it("preserves prior publication and observations when recording failure", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-failure-prior", "source-failure-prior");
		await prisma.historyObservation.create({
			data: {
				id: "failure-prior-observation",
				instanceId: "source-failure-prior",
				connectionGeneration: 3,
				providerEventId: 10,
				eventAt: new Date("2026-09-02T00:00:00Z"),
				eventTypeKey: "grab",
				searchText: "synthetic",
				normalizedPayload: '{"ok":true}',
				firstObservedAt: new Date("2026-09-02T00:00:00Z"),
				lastObservedAt: new Date("2026-09-02T00:00:00Z"),
			},
		});
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "source-failure-prior",
				connectionGeneration: 3,
				publishedAt: new Date("2026-09-02T01:00:00Z"),
				publicationMetadata: '{"version":1}',
				retainedObservationCount: 1,
				retentionEpoch: 9,
			},
		});
		const beforeStatus = await readStatus(prisma, "source-failure-prior");
		const beforeObservation = await prisma.historyObservation.findUnique({
			where: { id: "failure-prior-observation" },
		});
		const lease = await acquireHistoryCollectionLease(prisma, "owner-failure-prior", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-failure-prior", instanceId: "source-failure-prior", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...attempt, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "rows-inconsistent" },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		const afterStatus = await readStatus(prisma, "source-failure-prior");
		expect(afterStatus.publishedAt).toEqual(beforeStatus.publishedAt);
		expect(afterStatus.publicationMetadata).toBe(beforeStatus.publicationMetadata);
		expect(afterStatus.retainedObservationCount).toBe(beforeStatus.retainedObservationCount);
		expect(afterStatus.retentionEpoch).toBe(beforeStatus.retentionEpoch);
		expect(
			await prisma.historyObservation.findUnique({ where: { id: "failure-prior-observation" } }),
		).toEqual(beforeObservation);
	});

	it("keeps a no-publication failure at null publication and zero retained rows", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-failure-empty", "source-failure-empty");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-failure-empty", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-failure-empty", instanceId: "source-failure-empty", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...attempt, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "provider-unavailable" },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		expect(await readStatus(prisma, "source-failure-empty")).toMatchObject({
			publishedAt: null,
			publicationMetadata: null,
			retainedObservationCount: 0,
			retentionEpoch: 0,
			lastAttemptResult: "error",
			lastAttemptReason: "provider-unavailable",
		});
	});

	it("returns superseded for an older marker and never overwrites a newer attempt", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-superseded", "source-superseded");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-superseded", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const older = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-superseded", instanceId: "source-superseded", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!older) throw new Error("expected attempt");
		await prisma.$executeRawUnsafe(
			"UPDATE history_source_statuses SET lastAttemptAt = CURRENT_TIMESTAMP, lastAttemptResult = ? WHERE instanceId = ?",
			`in_progress:v1:${"b".repeat(64)}:${randomUUID()}`,
			"source-superseded",
		);
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...older, leaseClaim: lease, reason: "unknown-failure" },
				{ dialect: "sqlite" },
			),
		).toBe("superseded");
	});

	it("returns superseded for every valid stale owner, source, and lease authority", async () => {
		const run = async (
			mutate: (ctx: {
				prisma: PrismaClient;
				attempt: HistorySourceAttempt;
				lease: NonNullable<Awaited<ReturnType<typeof acquireHistoryCollectionLease>>>;
				instanceId: string;
			}) => Promise<{ input: never; options?: { dialect: "sqlite" } }>,
		) => {
			const { prisma } = await createDatabase();
			await createUserAndInstance(prisma, "owner-stale", "source-stale");
			const lease = await acquireHistoryCollectionLease(prisma, "owner-stale", {
				dialect: "sqlite",
			});
			if (!lease) throw new Error("expected lease");
			const attempt = await beginHistorySourceAttempt(
				prisma,
				{ userId: "owner-stale", instanceId: "source-stale", leaseClaim: lease },
				{ dialect: "sqlite" },
			);
			if (!attempt) throw new Error("expected attempt");
			const started = await markHistorySourceAttemptProviderStarted(
				prisma,
				{ ...attempt, leaseClaim: lease },
				{ dialect: "sqlite" },
			);
			if (started.kind !== "started") throw new Error("expected started attempt");
			const result = await mutate({
				prisma,
				attempt: started.attempt,
				lease,
				instanceId: "source-stale",
			});
			expect(
				await finishHistorySourceAttemptFailure(
					prisma,
					result.input,
					result.options ?? { dialect: "sqlite" },
				),
			).toBe("superseded");
		};
		await run(async ({ prisma, attempt }) => {
			await createUserAndInstance(prisma, "other-owner", "other-source");
			const otherLease = await acquireHistoryCollectionLease(prisma, "other-owner", {
				dialect: "sqlite",
			});
			if (!otherLease) throw new Error("expected other lease");
			return {
				input: {
					...attempt,
					userId: "other-owner",
					leaseClaim: otherLease,
					resultMarker: `in_progress:v1:${createHash("sha256").update(otherLease.claimToken).digest("hex")}:${randomUUID()}`,
					reason: "provider-limit",
				} as never,
			};
		});
		await run(async ({ attempt, lease }) => ({
			input: {
				...attempt,
				leaseClaim: { userId: lease.userId, claimToken: "replacement-claim" },
				resultMarker: `in_progress:v1:${createHash("sha256").update("replacement-claim").digest("hex")}:${randomUUID()}`,
				reason: "provider-limit",
			} as never,
		}));
		await run(async ({ attempt, lease }) => ({
			input: {
				...attempt,
				connectionGeneration: attempt.connectionGeneration + 1,
				leaseClaim: lease,
				reason: "provider-limit",
			} as never,
		}));
		await run(async ({ attempt, lease }) => ({
			input: {
				...attempt,
				attemptedAt: new Date("2026-01-01T00:00:00Z"),
				leaseClaim: lease,
				reason: "provider-limit",
			} as never,
		}));
		await run(async ({ attempt, lease }) => ({
			input: {
				...attempt,
				resultMarker: `in_progress:v1:${createHash("sha256").update(lease.claimToken).digest("hex")}:${randomUUID()}`,
				leaseClaim: lease,
				reason: "provider-limit",
			} as never,
		}));
		await run(async ({ prisma, attempt, lease, instanceId }) => {
			await prisma.serviceInstance.update({ where: { id: instanceId }, data: { enabled: false } });
			return { input: { ...attempt, leaseClaim: lease, reason: "provider-limit" } as never };
		});
		await run(async ({ prisma, attempt, lease, instanceId }) => {
			await prisma.serviceInstance.update({
				where: { id: instanceId },
				data: { service: "PLEX" as never },
			});
			return { input: { ...attempt, leaseClaim: lease, reason: "provider-limit" } as never };
		});
		await run(async ({ prisma, attempt, lease }) => {
			await prisma.$executeRawUnsafe(
				"UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second') WHERE userId = ?",
				lease.userId,
			);
			return { input: { ...attempt, leaseClaim: lease, reason: "provider-limit" } as never };
		});
		await run(async ({ prisma, attempt, lease }) => {
			await prisma.$executeRawUnsafe(
				"UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second'), claimedAt = datetime(CURRENT_TIMESTAMP, '-301 seconds'), heartbeatAt = datetime(CURRENT_TIMESTAMP, '-301 seconds') WHERE userId = ?",
				lease.userId,
			);
			const replacement = await acquireHistoryCollectionLease(prisma, lease.userId, {
				dialect: "sqlite",
			});
			if (!replacement) throw new Error("expected replacement");
			return { input: { ...attempt, leaseClaim: lease, reason: "provider-limit" } as never };
		});
	}, 90_000);

	it("does not expose a direct success transaction API", async () => {
		const source = await import("../history-source-attempt.js");
		expect("finishHistorySourceAttemptInTransaction" in source).toBe(false);
	});

	it("distinguishes sequential same-second attempts and denies a stale finish", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-sequential", "source-sequential");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-sequential", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const first = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-sequential", instanceId: "source-sequential", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!first) throw new Error("expected first attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...first, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "unknown-failure" },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		const second = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-sequential", instanceId: "source-sequential", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!second) throw new Error("expected second attempt");
		expect(second.resultMarker).not.toBe(first.resultMarker);
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...started.attempt, leaseClaim: lease, reason: "provider-limit" },
				{ dialect: "sqlite" },
			),
		).toBe("superseded");
		expect(await readStatus(prisma, "source-sequential")).toMatchObject({
			lastAttemptResult: second.resultMarker,
			lastAttemptReason: null,
		});
	});

	it("rejects malformed IDs, markers, future dates, and token-like reasons without writes", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-input", "source-input");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-input", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const beforeInvalidBegin = await readStatus(prisma, "source-input");
		for (const userId of ["\u0000bad", "x".repeat(257)]) {
			expect(
				await beginHistorySourceAttempt(
					prisma,
					{ userId, instanceId: "source-input", leaseClaim: lease },
					{ dialect: "sqlite" },
				),
			).toBeNull();
		}
		for (const instanceId of ["\u0000bad", "x".repeat(257)]) {
			expect(
				await beginHistorySourceAttempt(
					prisma,
					{ userId: "owner-input", instanceId, leaseClaim: lease },
					{ dialect: "sqlite" },
				),
			).toBeNull();
		}
		expect(await readStatus(prisma, "source-input")).toEqual(beforeInvalidBegin);
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-input", instanceId: "source-input", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		for (const marker of [
			"bad",
			`in_progress:v1:${"a".repeat(64)}:${"x".repeat(200)}`,
			`in_progress:v1:${"a".repeat(65)}:${randomUUID()}`,
		]) {
			expect(
				await finishHistorySourceAttemptFailure(
					prisma,
					{
						...attempt,
						resultMarker: marker,
						leaseClaim: lease,
						reason: "provider-limit",
					} as never,
					{ dialect: "sqlite" },
				),
			).toBe("failed");
		}
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{
					...attempt,
					leaseClaim: lease,
					reason: "private https://provider.invalid/token",
				} as never,
				{ dialect: "sqlite" },
			),
		).toBe("failed");
		const beforeInvalidDates = await readStatus(prisma, "source-input");
		for (const attemptedAt of [new Date("not-a-date"), new Date("2999-01-01T00:00:00.000Z")]) {
			expect(
				await finishHistorySourceAttemptFailure(
					prisma,
					{ ...attempt, attemptedAt, leaseClaim: lease, reason: "provider-limit" },
					{ dialect: "sqlite" },
				),
			).toBe("failed");
		}
		expect(await readStatus(prisma, "source-input")).toEqual(beforeInvalidDates);
	});

	it("rolls back source status and every lease field when the final fence is lost", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-final-fence", "source-final-fence");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-final-fence", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const beginProxy = withFinalFenceMiss(prisma);
		const beforeLease = await readLease(prisma, "owner-final-fence");
		expect(
			await beginHistorySourceAttempt(
				beginProxy,
				{ userId: "owner-final-fence", instanceId: "source-final-fence", leaseClaim: lease },
				{ dialect: "sqlite" },
			),
		).toBeNull();
		expect(await readStatus(prisma, "source-final-fence")).toBeNull();
		expect(await readLease(prisma, "owner-final-fence")).toEqual(beforeLease);
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-final-fence", instanceId: "source-final-fence", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...attempt, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		const beforeFinishLease = await readLease(prisma, "owner-final-fence");
		const beforeFinishStatus = await readStatus(prisma, "source-final-fence");
		expect(
			await finishHistorySourceAttemptFailure(
				withFinalFenceMiss(prisma),
				{ ...started.attempt, leaseClaim: lease, reason: "provider-limit" },
				{ dialect: "sqlite" },
			),
		).toBe("superseded");
		expect(await readStatus(prisma, "source-final-fence")).toEqual(beforeFinishStatus);
		expect(await readLease(prisma, "owner-final-fence")).toEqual(beforeFinishLease);
	});

	it("replays the complete begin action and never reports exhausted or arbitrary failures as success", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-retry", "source-retry");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-retry", { dialect: "sqlite" });
		if (!lease) throw new Error("expected lease");
		const replayCalls: number[] = [];
		const replayed = withTransactionFailures(prisma, [{ code: "P2034" }], replayCalls);
		const attempt = await beginHistorySourceAttempt(
			replayed,
			{ userId: "owner-retry", instanceId: "source-retry", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		expect(attempt?.resultMarker).toMatch(/^in_progress:v2:prepared:/);
		expect(replayCalls).toEqual([1, 2]);
		expect(await readStatus(prisma, "source-retry")).toMatchObject({
			lastAttemptResult: attempt?.resultMarker,
		});

		await createUserAndInstance(prisma, "owner-exhausted", "source-exhausted");
		const exhaustedLease = await acquireHistoryCollectionLease(prisma, "owner-exhausted", {
			dialect: "sqlite",
		});
		if (!exhaustedLease) throw new Error("expected lease");
		const exhaustedCalls: number[] = [];
		await expect(
			beginHistorySourceAttempt(
				withTransactionFailures(
					prisma,
					[{ code: "P2034" }, { code: "P2034" }, { code: "P2034" }],
					exhaustedCalls,
				),
				{ userId: "owner-exhausted", instanceId: "source-exhausted", leaseClaim: exhaustedLease },
				{ dialect: "sqlite" },
			),
		).rejects.toThrow("History collection lease database operation failed");
		expect(exhaustedCalls).toEqual([1, 2, 3]);
		expect(await readStatus(prisma, "source-exhausted")).toBeNull();

		const raw =
			"owner-arbitrary source-arbitrary private-lease-token private-marker raw database value";
		await createUserAndInstance(prisma, "owner-arbitrary", "source-arbitrary");
		const arbitraryLease = await acquireHistoryCollectionLease(prisma, "owner-arbitrary", {
			dialect: "sqlite",
		});
		if (!arbitraryLease) throw new Error("expected lease");
		const arbitraryCalls: number[] = [];
		const beginFailure = await beginHistorySourceAttempt(
			withTransactionFailures(prisma, [new Error(raw)], arbitraryCalls),
			{ userId: "owner-arbitrary", instanceId: "source-arbitrary", leaseClaim: arbitraryLease },
			{ dialect: "sqlite" },
		).catch((error: unknown) => error);
		expect(String(beginFailure)).toContain("History collection lease database operation failed");
		expect(String(beginFailure)).not.toContain(raw);
		expect(beginFailure).not.toHaveProperty("code", raw);
		expect(arbitraryCalls).toEqual([1]);
		const arbitraryAttempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-arbitrary", instanceId: "source-arbitrary", leaseClaim: arbitraryLease },
			{ dialect: "sqlite" },
		);
		if (!arbitraryAttempt) throw new Error("expected attempt");
		const beforeStatus = await readStatus(prisma, "source-arbitrary");
		const finishResult = await finishHistorySourceAttemptFailure(
			withTransactionFailures(prisma, [new Error(raw)]),
			{ ...arbitraryAttempt, leaseClaim: arbitraryLease, reason: "unknown-failure" },
			{ dialect: "sqlite" },
		);
		expect(String(finishResult)).not.toContain(raw);
		expect(finishResult).toBe("failed");
		expect(await readStatus(prisma, "source-arbitrary")).toEqual(beforeStatus);
	});

	it("retries a finish CAS conflict and rolls back exhausted finish conflicts", async () => {
		const { prisma } = await createDatabase();
		await createUserAndInstance(prisma, "owner-finish-retry", "source-finish-retry");
		const lease = await acquireHistoryCollectionLease(prisma, "owner-finish-retry", {
			dialect: "sqlite",
		});
		if (!lease) throw new Error("expected lease");
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId: "owner-finish-retry", instanceId: "source-finish-retry", leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (!attempt) throw new Error("expected attempt");
		const started = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...attempt, leaseClaim: lease },
			{ dialect: "sqlite" },
		);
		if (started.kind !== "started") throw new Error("expected started attempt");
		const replayCalls: number[] = [];
		expect(
			await finishHistorySourceAttemptFailure(
				withFinishCasFailures(prisma, 1, replayCalls),
				{ ...started.attempt, leaseClaim: lease, reason: "provider-limit" },
				{ dialect: "sqlite" },
			),
		).toBe("recorded");
		expect(replayCalls).toEqual([1, 2]);
		expect(await readStatus(prisma, "source-finish-retry")).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptReason: "provider-limit",
		});

		await createUserAndInstance(prisma, "owner-finish-exhausted", "source-finish-exhausted");
		const exhaustedLease = await acquireHistoryCollectionLease(prisma, "owner-finish-exhausted", {
			dialect: "sqlite",
		});
		if (!exhaustedLease) throw new Error("expected lease");
		const exhaustedAttempt = await beginHistorySourceAttempt(
			prisma,
			{
				userId: "owner-finish-exhausted",
				instanceId: "source-finish-exhausted",
				leaseClaim: exhaustedLease,
			},
			{ dialect: "sqlite" },
		);
		if (!exhaustedAttempt) throw new Error("expected attempt");
		const exhaustedStarted = await markHistorySourceAttemptProviderStarted(
			prisma,
			{ ...exhaustedAttempt, leaseClaim: exhaustedLease },
			{ dialect: "sqlite" },
		);
		if (exhaustedStarted.kind !== "started") throw new Error("expected started attempt");
		const beforeStatus = await readStatus(prisma, "source-finish-exhausted");
		const beforeLease = await readLease(prisma, "owner-finish-exhausted");
		const exhaustedCalls: number[] = [];
		expect(
			await finishHistorySourceAttemptFailure(
				withFinishCasFailures(prisma, 3, exhaustedCalls),
				{ ...exhaustedStarted.attempt, leaseClaim: exhaustedLease, reason: "provider-limit" },
				{ dialect: "sqlite" },
			),
		).toBe("failed");
		expect(exhaustedCalls).toEqual([1, 2, 3]);
		expect(await readStatus(prisma, "source-finish-exhausted")).toEqual(beforeStatus);
		expect(await readLease(prisma, "owner-finish-exhausted")).toEqual(beforeLease);
	});

	it("exports only the bounded operational failure vocabulary", () => {
		expect(HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS).toEqual([
			"provider-unavailable",
			"provider-limit",
			"rows-inconsistent",
			"receipt-invalid",
			"unknown-failure",
		]);
	});
});

const postgresUrl = process.env.HISTORY_LEASE_POSTGRES_URL ?? "";
const postgresDescribe = isGuardedPostgresUrl(postgresUrl) ? describe : describe.skip;

postgresDescribe("guarded disposable PostgreSQL History source attempts", () => {
	it("excludes same-lease begin, replaces a stranded attempt, and records an exact failure", async () => {
		const { clients, prisma } = await createPostgresDatabase(2);
		const userId = `pg-attempt-${randomUUID()}`;
		const instanceId = `pg-source-${randomUUID()}`;
		postgresUsers.push({ prisma, userId });
		await createUserAndInstance(prisma, userId, instanceId);
		const lease = await acquireHistoryCollectionLease(prisma, userId, { dialect: "postgresql" });
		if (!lease) throw new Error("expected lease");
		const results = await Promise.all(
			clients.map(
				async (client) =>
					await beginHistorySourceAttempt(
						client,
						{ userId, instanceId, leaseClaim: lease },
						{ dialect: "postgresql" },
					),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		const first = results.find(Boolean);
		if (!first) throw new Error("expected attempt");
		await prisma.$executeRawUnsafe(
			'UPDATE "history_collection_leases" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\', "claimedAt" = CURRENT_TIMESTAMP - INTERVAL \'301 seconds\', "heartbeatAt" = CURRENT_TIMESTAMP - INTERVAL \'301 seconds\' WHERE "userId" = $1',
			userId,
		);
		expect(await releaseHistoryCollectionLease(prisma, lease, { dialect: "postgresql" })).toBe(
			true,
		);
		const replacement = await acquireHistoryCollectionLease(prisma, userId, {
			dialect: "postgresql",
		});
		if (!replacement) throw new Error("expected replacement lease");
		const second = await beginHistorySourceAttempt(
			prisma,
			{ userId, instanceId, leaseClaim: replacement },
			{ dialect: "postgresql" },
		);
		expect(second?.resultMarker).not.toBe(first.resultMarker);
		if (!second) throw new Error("expected replacement attempt");
		expect(
			await finishHistorySourceAttemptFailure(
				prisma,
				{ ...second, leaseClaim: replacement, reason: "provider-limit" },
				{ dialect: "postgresql" },
			),
		).toBe("recorded");
		expect(await readStatus(prisma, instanceId)).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptReason: "provider-limit",
		});
	});

	it("rolls back PostgreSQL source status on a final fence miss", async () => {
		const { prisma } = await createPostgresDatabase();
		const userId = `pg-fence-${randomUUID()}`;
		const instanceId = `pg-source-${randomUUID()}`;
		postgresUsers.push({ prisma, userId });
		await createUserAndInstance(prisma, userId, instanceId);
		const lease = await acquireHistoryCollectionLease(prisma, userId, { dialect: "postgresql" });
		if (!lease) throw new Error("expected lease");
		const before = await readStatus(prisma, instanceId);
		expect(
			await beginHistorySourceAttempt(
				withFinalFenceMiss(prisma),
				{ userId, instanceId, leaseClaim: lease },
				{ dialect: "postgresql" },
			),
		).toBeNull();
		expect(await readStatus(prisma, instanceId)).toEqual(before);
		const attempt = await beginHistorySourceAttempt(
			prisma,
			{ userId, instanceId, leaseClaim: lease },
			{ dialect: "postgresql" },
		);
		if (!attempt) throw new Error("expected attempt");
		const beforeFinish = await readStatus(prisma, instanceId);
		expect(
			await finishHistorySourceAttemptFailure(
				withFinalFenceMiss(prisma),
				{ ...attempt, leaseClaim: lease, reason: "provider-limit" },
				{ dialect: "postgresql" },
			),
		).toBe("superseded");
		expect(await readStatus(prisma, instanceId)).toEqual(beforeFinish);
	});
});

async function createDatabase(
	clientCount = 1,
): Promise<{ clients: PrismaClient[]; prisma: PrismaClient }> {
	const directory = mkdtempSync(join(tmpdir(), "history-source-attempt-"));
	const sqlitePath = join(directory, "history.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", databasePath], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` },
		stdio: "pipe",
	});
	const clients = Array.from(
		{ length: clientCount },
		() =>
			new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlitePath, timeout: 5_000 }) }),
	);
	await Promise.all(clients.map(async (client) => await client.$connect()));
	databases.push({ clients, directory });
	return { clients, prisma: clients[0]! };
}

function withTransactionFailures(
	prisma: PrismaClient,
	failures: unknown[],
	callbackCalls: number[] = [],
): PrismaClient {
	let index = 0;
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) => {
			return await prisma.$transaction(async (tx) => {
				callbackCalls.push(callbackCalls.length + 1);
				const result = await action(tx);
				if (index < failures.length) throw failures[index++];
				return result;
			}, options);
		},
	} as unknown as PrismaClient;
}

function withFinalFenceMiss(prisma: PrismaClient): PrismaClient {
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prisma.$transaction(async (tx) => {
				let executeCount = 0;
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "$executeRawUnsafe") return Reflect.get(target, property, receiver);
						return async (...args: unknown[]) => {
							executeCount += 1;
							if (executeCount === 2) return 0;
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

function withPostWriteReadMismatch(prisma: PrismaClient): PrismaClient {
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prisma.$transaction(async (tx) => {
				let reads = 0;
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "historySourceStatus") return Reflect.get(target, property, receiver);
						return new Proxy(target.historySourceStatus, {
							get(model, modelProperty, modelReceiver) {
								if (modelProperty !== "findUnique")
									return Reflect.get(model, modelProperty, modelReceiver);
								return async (...args: unknown[]) => {
									const value = await model.findUnique(
										...(args as Parameters<typeof model.findUnique>),
									);
									reads += 1;
									if (reads === 2 && value) {
										return { ...value, nextBackfillPage: Number(value.nextBackfillPage) + 1 };
									}
									return value;
								};
							},
						});
					},
				});
				return await action(proxy);
			}, options),
	} as unknown as PrismaClient;
}

function withFinishCasFailures(
	prisma: PrismaClient,
	failureCount: number,
	callbackCalls: number[],
): PrismaClient {
	let updateCalls = 0;
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) =>
			await prisma.$transaction(async (tx) => {
				callbackCalls.push(callbackCalls.length + 1);
				const proxy = new Proxy(tx, {
					get(target, property, receiver) {
						if (property !== "historySourceStatus") {
							return Reflect.get(target, property, receiver);
						}
						return new Proxy(target.historySourceStatus, {
							get(model, modelProperty, modelReceiver) {
								if (modelProperty !== "updateMany") {
									return Reflect.get(model, modelProperty, modelReceiver);
								}
								return async (...args: unknown[]) => {
									const result = await model.updateMany(
										...(args as Parameters<typeof model.updateMany>),
									);
									updateCalls += 1;
									if (updateCalls <= failureCount) throw { code: "P2034" };
									return result;
								};
							},
						});
					},
				});
				return await action(proxy);
			}, options),
	} as unknown as PrismaClient;
}

async function createUserAndInstance(
	prisma: PrismaClient,
	userId: string,
	instanceId: string,
	overrides: { enabled?: boolean; service?: string; connectionGeneration?: number } = {},
): Promise<void> {
	await prisma.user.upsert({
		where: { id: userId },
		create: { id: userId, username: userId, hashedPassword: "synthetic" },
		update: {},
	});
	await prisma.serviceInstance.create({
		data: {
			id: instanceId,
			userId,
			service: (overrides.service ?? "SONARR") as never,
			label: instanceId,
			baseUrl: "http://provider.invalid",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			enabled: overrides.enabled ?? true,
			connectionGeneration: overrides.connectionGeneration ?? 3,
		},
	});
}

type RevisionAttemptFixture = {
	prisma: PrismaClient;
	userId: string;
	instanceId: string;
	lease: { userId: string; claimToken: string };
	attempt: HistorySourceProviderPreparedAttempt;
};

async function createPreparedRevisionFixture(
	prisma: PrismaClient,
	name: string,
): Promise<RevisionAttemptFixture> {
	const userId = `owner-revision-${name}`;
	const instanceId = `source-revision-${name}`;
	await createUserAndInstance(prisma, userId, instanceId);
	const lease = await acquireHistoryCollectionLease(prisma, userId, { dialect: "sqlite" });
	if (!lease) throw new Error("expected lease");
	const attempt = await beginHistorySourceAttempt(
		prisma,
		{ userId, instanceId, leaseClaim: lease },
		{ dialect: "sqlite" },
	);
	if (!attempt) throw new Error("expected prepared attempt");
	return { prisma, userId, instanceId, lease, attempt };
}

async function createStartedRevisionFixture(
	prisma: PrismaClient,
	name: string,
): Promise<
	Omit<RevisionAttemptFixture, "attempt"> & { attempt: HistorySourceProviderStartedAttempt }
> {
	const fixture = await createPreparedRevisionFixture(prisma, name);
	const started = await markHistorySourceAttemptProviderStarted(prisma, {
		...fixture.attempt,
		leaseClaim: fixture.lease,
	});
	if (started.kind !== "started") throw new Error("expected started attempt");
	return { ...fixture, attempt: started.attempt };
}

async function setPublicationRevision(
	prisma: PrismaClient,
	instanceId: string,
	revision: number,
): Promise<void> {
	await prisma.$executeRawUnsafe(
		"UPDATE history_source_statuses SET publicationRevision = ? WHERE instanceId = ?",
		revision,
		instanceId,
	);
}

async function readPublicationRevision(prisma: PrismaClient, instanceId: string): Promise<number> {
	const rows = await prisma.$queryRawUnsafe<Array<{ publicationRevision: number }>>(
		"SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?",
		instanceId,
	);
	const revision = rows[0]?.publicationRevision;
	if (typeof revision !== "number") throw new Error("expected publication revision");
	return revision;
}

async function readStatus(
	prisma: PrismaClient,
	instanceId: string,
): Promise<Record<string, unknown>> {
	return (await prisma.historySourceStatus.findUnique({
		where: { instanceId },
	})) as unknown as Record<string, unknown>;
}

async function readLease(prisma: PrismaClient, userId: string): Promise<Record<string, unknown>> {
	return (await prisma.historyCollectionLease.findUnique({
		where: { userId },
	})) as unknown as Record<string, unknown>;
}

async function createPostgresDatabase(
	clientCount = 1,
): Promise<{ clients: PrismaClient[]; prisma: PrismaClient }> {
	const clients = await Promise.all(
		Array.from({ length: clientCount }, async () => await createTestPgClient(postgresUrl)),
	);
	postgresCleanups.push(
		async () =>
			await Promise.all(clients.map(async ({ cleanup }) => await cleanup())).then(() => undefined),
	);
	return { clients: clients.map(({ prisma }) => prisma), prisma: clients[0]!.prisma };
}

function isGuardedPostgresUrl(value: string): boolean {
	if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
	try {
		return new URL(value).pathname === "/history_lease_test";
	} catch {
		return false;
	}
}
