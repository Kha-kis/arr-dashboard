/**
 * Unit tests for notification log retention cleanup.
 *
 * Validates single-pass and batched purge operations.
 */

import { describe, it, expect, vi } from "vitest";
import { purgeOldLogs, purgeOldLogsBatched } from "../log-retention.js";

function createMockPrisma(
	deleteCount: number,
	findBatches?: Array<Array<{ id: string }>>,
) {
	const findManyFn = vi.fn();
	if (findBatches) {
		for (const batch of findBatches) {
			findManyFn.mockResolvedValueOnce(batch);
		}
	}
	return {
		notificationLog: {
			deleteMany: vi.fn().mockResolvedValue({ count: deleteCount }),
			findMany: findManyFn,
		},
	} as any;
}

describe("purgeOldLogs", () => {
	it("deletes logs older than retention period", async () => {
		const prisma = createMockPrisma(5);
		const before = new Date();

		await purgeOldLogs(prisma, 30);

		expect(prisma.notificationLog.deleteMany).toHaveBeenCalledTimes(1);
		const where = prisma.notificationLog.deleteMany.mock.calls[0]![0].where;
		const cutoff = where.sentAt.lt as Date;

		// Cutoff should be approximately 30 days ago
		const expectedCutoff = new Date(before);
		expectedCutoff.setDate(expectedCutoff.getDate() - 30);
		const diffMs = Math.abs(cutoff.getTime() - expectedCutoff.getTime());
		expect(diffMs).toBeLessThan(1000);
	});

	it("returns count of deleted rows", async () => {
		const prisma = createMockPrisma(42);
		const result = await purgeOldLogs(prisma, 30);
		expect(result).toBe(42);
	});
});

describe("purgeOldLogsBatched", () => {
	it("deletes in batches", async () => {
		// Use 1000-length batches to simulate BATCH_SIZE being fully filled,
		// so the loop continues to the next iteration.
		const batch1 = Array.from({ length: 1000 }, (_, i) => ({ id: `log-a-${i}` }));
		const batch2 = Array.from({ length: 2 }, (_, i) => ({ id: `log-b-${i}` }));
		const prisma = createMockPrisma(0, [batch1, batch2]);

		prisma.notificationLog.deleteMany
			.mockResolvedValueOnce({ count: 1000 })
			.mockResolvedValueOnce({ count: 2 });

		await purgeOldLogsBatched(prisma, 30);

		// batch1 is full (1000) so loop continues; batch2 < 1000 so loop stops
		expect(prisma.notificationLog.deleteMany).toHaveBeenCalledTimes(2);
		expect(prisma.notificationLog.findMany).toHaveBeenCalledTimes(2);
	});

	it("returns total deleted count across batches", async () => {
		const batch1 = Array.from({ length: 1000 }, (_, i) => ({ id: `log-a-${i}` }));
		const batch2 = Array.from({ length: 2 }, (_, i) => ({ id: `log-b-${i}` }));
		const prisma = createMockPrisma(0, [batch1, batch2]);

		prisma.notificationLog.deleteMany
			.mockResolvedValueOnce({ count: 1000 })
			.mockResolvedValueOnce({ count: 2 });

		const result = await purgeOldLogsBatched(prisma, 30);

		// totalDeleted uses batch.length (findMany results), not deleteMany count
		expect(result).toBe(1002);
	});

	it("stops when no more rows found", async () => {
		const prisma = createMockPrisma(0, [[]]);

		const result = await purgeOldLogsBatched(prisma, 30);

		expect(result).toBe(0);
		expect(prisma.notificationLog.findMany).toHaveBeenCalledTimes(1);
		expect(prisma.notificationLog.deleteMany).not.toHaveBeenCalled();
	});
});
