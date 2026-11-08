import { setImmediate as turn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { readOwnedNativeWatchCoverage } from "../jellyfin-native-watch-coverage.js";
import { emptyNativeWatchProjectionDiagnostics } from "../jellyfin-native-watch-projection.js";

const observedAt = new Date("2026-10-19T12:00:00Z");
const diagnostic = JSON.stringify({
	version: 1,
	...emptyNativeWatchProjectionDiagnostics(),
	changedObservationCoordinates: 3,
	collectUnits: 1,
	verifyUnits: 1,
	collectStageRows: 10,
	verifyStageRows: 10,
	expectedCountsMatch: true,
	excludedRows: 0,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture() {
	const instance = {
		identityStatus: "VERIFIED",
		expectedIdentity: "private-server",
		connectionGeneration: 1,
		identityGeneration: 2,
	};
	const status = {
		lastResult: "success",
		generationId: "generation-new",
		connectionGeneration: 1,
		identityGeneration: 2,
		lastAttemptResult: "success",
	};
	const pointer = {
		activeRunId: "new",
		activeCacheGenerationId: "generation-new",
		activeObservedAt: observedAt,
		activeExpectedScopeCount: 8,
		connectionGeneration: 1,
		identityGeneration: 2,
	};
	const receipts = Array.from({ length: 8 }, (_, i) => ({
		runId: "new",
		userKeyDigest: `private-user-${i}`,
		libraryId: "private-library",
		exact: i !== 0,
		expectedRawCount: 10,
		observedRawCount: 10,
		contentFingerprint: "a".repeat(64),
		observedAt,
		connectionGeneration: 1,
		identityGeneration: 2,
		diagnosticsJson:
			i === 0
				? diagnostic
				: diagnostic.replace(
						'"changedObservationCoordinates":3',
						'"changedObservationCoordinates":0',
					),
	}));
	const tx = {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(instance),
		},
		jellyfinNativeWatchPublication: { findUnique: vi.fn().mockResolvedValue(pointer) },
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue(status),
		},
		jellyfinNativeWatchScopeReceipt: { findMany: vi.fn().mockResolvedValue(receipts) },
		providerObservationRun: { findMany: vi.fn().mockResolvedValue([]) },
	};
	const prisma = { $transaction: (fn: (value: typeof tx) => unknown) => fn(tx) };
	return { tx, prisma: prisma as never, receipts, pointer, instance, status };
}
describe("owned recorded native watch coverage", () => {
	it("starts pointer and status reads together only after verified ownership resolves", async () => {
		const { prisma, tx, pointer, instance, status } = fixture();
		const ownership = deferred<typeof instance>();
		const pointerRead = deferred<typeof pointer>();
		const statusRead = deferred<typeof status>();
		const started: string[] = [];
		tx.serviceInstance.findFirst.mockReturnValueOnce(ownership.promise);
		tx.jellyfinNativeWatchPublication.findUnique.mockImplementationOnce(() => {
			started.push("pointer");
			return pointerRead.promise;
		});
		tx.cacheRefreshStatus.findUnique.mockImplementationOnce(() => {
			started.push("status");
			return statusRead.promise;
		});
		const reading = readOwnedNativeWatchCoverage(prisma, {
			userId: "owner",
			instanceId: "instance",
		});
		expect(started).toEqual([]);
		ownership.resolve(instance);
		await turn();
		const startedWhilePointerPending = [...started];
		pointerRead.resolve(pointer);
		statusRead.resolve(status);
		expect(await reading).toMatchObject({
			status: "available",
			expectedScopes: 8,
			verifiedScopes: 7,
			incompleteScopes: 1,
			reasonCodes: ["changed-observations", "coverage-incomplete"],
			refreshPhase: "idle",
		});
		expect(startedWhilePointerPending).toEqual(["pointer", "status"]);
	});
	it("starts receipt and active-run reads together after publication validation", async () => {
		const { prisma, tx, receipts, status } = fixture();
		const statusRead = deferred<typeof status>();
		const receiptRead = deferred<typeof receipts>();
		const runs = [
			{
				state: "running",
				completedUnits: 0,
				totalUnits: 2,
				units: [{ phase: "collect", state: "pending" }],
			},
		];
		const runRead = deferred<typeof runs>();
		const started: string[] = [];
		tx.cacheRefreshStatus.findUnique.mockReturnValueOnce(statusRead.promise);
		tx.jellyfinNativeWatchScopeReceipt.findMany.mockImplementationOnce(() => {
			started.push("receipts");
			return receiptRead.promise;
		});
		tx.providerObservationRun.findMany.mockImplementationOnce(() => {
			started.push("runs");
			return runRead.promise;
		});
		const reading = readOwnedNativeWatchCoverage(prisma, {
			userId: "owner",
			instanceId: "instance",
		});
		await turn();
		expect(started).toEqual([]);
		statusRead.resolve(status);
		await turn();
		const startedWhileReceiptsPending = [...started];
		receiptRead.resolve(receipts);
		runRead.resolve(runs);
		expect(await reading).toMatchObject({
			status: "available",
			expectedScopes: 8,
			verifiedScopes: 7,
			incompleteScopes: 1,
			reasonCodes: ["changed-observations", "coverage-incomplete"],
			refreshPhase: "collecting",
		});
		expect(startedWhileReceiptsPending).toEqual(["receipts", "runs"]);
	});
	it.each(["receipts", "runs"] as const)(
		"rechecks a replaced publication after both reads when %s finishes last",
		async (last) => {
			const { prisma, tx, pointer, receipts } = fixture();
			const receiptRead = deferred<typeof receipts>();
			const runRead = deferred<never[]>();
			let latest = pointer;
			const rechecks: string[] = [];
			tx.jellyfinNativeWatchPublication.findUnique
				.mockResolvedValueOnce(pointer)
				.mockImplementationOnce(() => {
					rechecks.push("recheck");
					return Promise.resolve(latest);
				});
			tx.jellyfinNativeWatchScopeReceipt.findMany.mockReturnValueOnce(receiptRead.promise);
			tx.providerObservationRun.findMany.mockReturnValueOnce(runRead.promise);
			const reading = readOwnedNativeWatchCoverage(prisma, {
				userId: "owner",
				instanceId: "instance",
			});
			await turn();
			if (last === "receipts") runRead.resolve([]);
			else receiptRead.resolve(receipts);
			await turn();
			const rechecksBeforeBothComplete = [...rechecks];
			latest = { ...pointer, activeRunId: "replacement" };
			if (last === "receipts") receiptRead.resolve(receipts);
			else runRead.resolve([]);
			expect(await reading).toEqual({ status: "unavailable", reason: "snapshot-changed" });
			expect(rechecksBeforeBothComplete).toEqual([]);
		},
	);
	it("reports seven of eight exact scopes with changed observations, exposing no private keys or new freshness authority", async () => {
		const { tx, prisma } = fixture();
		const result = await readOwnedNativeWatchCoverage(prisma, {
			userId: "owner",
			instanceId: "instance",
		});
		expect(result).toEqual({
			status: "available",
			observedAt: observedAt.toISOString(),
			expectedScopes: 8,
			verifiedScopes: 7,
			incompleteScopes: 1,
			diagnosticStatus: "recorded",
			reasonCodes: ["changed-observations", "coverage-incomplete"],
			refreshPhase: "idle",
		});
		expect(JSON.stringify(result)).not.toMatch(/private|userKey|libraryId|freshness/);
		expect(tx.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ userId: "owner", enabled: true }),
			}),
		);
		expect(tx.jellyfinNativeWatchScopeReceipt.findMany).toHaveBeenCalledWith({
			where: { instanceId: "instance", runId: "new", instance: { userId: "owner", enabled: true } },
			take: 9,
		});
	});
	it.each([null, "{", JSON.stringify({ forged: "private" }), " ".repeat(2049)])(
		"leaves counts unchanged for unavailable diagnostics %#",
		async (json) => {
			const { prisma, receipts } = fixture();
			receipts[0]!.diagnosticsJson = json as never;
			expect(
				await readOwnedNativeWatchCoverage(prisma, { userId: "owner", instanceId: "instance" }),
			).toMatchObject({
				status: "available",
				verifiedScopes: 7,
				incompleteScopes: 1,
				diagnosticStatus: "unavailable",
				reasonCodes: ["coverage-incomplete", "diagnostics-unavailable"],
			});
		},
	);
	it.each([
		"not-owned",
		"identity-changed",
		"no-publication",
		"snapshot-changed",
		"malformed-publication",
	] as const)("fails closed on %s", async (reason) => {
		const { prisma, tx, receipts, pointer } = fixture();
		if (reason === "not-owned") tx.serviceInstance.findFirst.mockResolvedValue(null);
		if (reason === "identity-changed")
			tx.serviceInstance.findFirst.mockResolvedValue({ identityStatus: "MISMATCH" });
		if (reason === "no-publication")
			tx.jellyfinNativeWatchPublication.findUnique.mockResolvedValue(null);
		if (reason === "snapshot-changed")
			tx.jellyfinNativeWatchPublication.findUnique.mockResolvedValueOnce({
				...pointer,
				activeRunId: "old",
				activeCacheGenerationId: "old",
			});
		if (reason === "malformed-publication") receipts[0]!.identityGeneration = 99;
		expect(
			await readOwnedNativeWatchCoverage(prisma, { userId: "other", instanceId: "instance" }),
		).toEqual({ status: "unavailable", reason });
	});
	it("discards a publication replaced during the read", async () => {
		const { prisma, tx, pointer } = fixture();
		tx.jellyfinNativeWatchPublication.findUnique
			.mockResolvedValueOnce(pointer)
			.mockResolvedValueOnce({ ...pointer, activeRunId: "replacement" });
		expect(
			await readOwnedNativeWatchCoverage(prisma, { userId: "owner", instanceId: "instance" }),
		).toEqual({ status: "unavailable", reason: "snapshot-changed" });
	});
	it("does not certify incomplete scopes from forged zero rejection counters", async () => {
		const { prisma, receipts } = fixture();
		receipts[0]!.diagnosticsJson = diagnostic.replace(
			'"changedObservationCoordinates":3',
			'"changedObservationCoordinates":0',
		);
		expect(
			await readOwnedNativeWatchCoverage(prisma, { userId: "owner", instanceId: "instance" }),
		).toMatchObject({
			status: "available",
			verifiedScopes: 7,
			incompleteScopes: 1,
			reasonCodes: ["coverage-incomplete"],
		});
	});
	it.each([
		[
			"collecting",
			{
				state: "running",
				completedUnits: 0,
				totalUnits: 2,
				units: [{ phase: "collect", state: "pending" }],
			},
		],
		[
			"verifying",
			{
				state: "running",
				completedUnits: 1,
				totalUnits: 2,
				units: [
					{ phase: "collect", state: "complete" },
					{ phase: "verify", state: "pending" },
				],
			},
		],
		["finalizing", { state: "running", completedUnits: 2, totalUnits: 2, units: [] }],
		["failed", { state: "failed", completedUnits: 1, totalUnits: 2, units: [] }],
	] as const)("reports canonical %s work", async (phase, run) => {
		const { prisma, tx } = fixture();
		tx.providerObservationRun.findMany.mockResolvedValue([run]);
		expect(
			await readOwnedNativeWatchCoverage(prisma, { userId: "owner", instanceId: "instance" }),
		).toMatchObject({ refreshPhase: phase });
	});
	it.each(["in_progress", "in_progress:12345678-1234-4123-8123-123456789abc"])(
		"does not declare outer refresh discovery idle for %s before run creation",
		async (marker) => {
			const { prisma, tx } = fixture();
			tx.cacheRefreshStatus.findUnique.mockResolvedValue({
				lastResult: "success",
				generationId: "generation-new",
				connectionGeneration: 1,
				identityGeneration: 2,
				lastAttemptResult: marker,
			});
			expect(
				await readOwnedNativeWatchCoverage(prisma, { userId: "owner", instanceId: "instance" }),
			).toMatchObject({
				status: "available",
				verifiedScopes: 7,
				incompleteScopes: 1,
				refreshPhase: "unknown",
			});
		},
	);
});
