/**
 * Unit tests for notification delivery statistics.
 *
 * Validates totals, success rate, per-channel/per-event aggregation,
 * and daily trend computation.
 */

import { describe, it, expect, vi } from "vitest";
import { getDeliveryStatistics } from "../statistics.js";

function createMockPrisma(
	logs: Array<{
		channelId: string;
		channelType: string;
		eventType: string;
		status: string;
		sentAt: Date;
	}>,
) {
	return {
		notificationLog: {
			findMany: vi.fn().mockResolvedValue(logs),
		},
	} as any;
}

describe("getDeliveryStatistics", () => {
	it("returns zero totals when no channel IDs provided", async () => {
		const prisma = createMockPrisma([]);
		const result = await getDeliveryStatistics(prisma, [], 7);

		expect(result.totals).toEqual(
			expect.objectContaining({
				sent: 0,
				failed: 0,
				deadLetter: 0,
				total: 0,
			}),
		);
		expect(result.perChannel).toEqual([]);
		expect(result.perEventType).toEqual([]);
		expect(result.dailyTrend).toEqual([]);
		// Should not call findMany at all
		expect(prisma.notificationLog.findMany).not.toHaveBeenCalled();
	});

	it("returns zero totals when no logs exist", async () => {
		const prisma = createMockPrisma([]);
		const result = await getDeliveryStatistics(prisma, ["ch-1"], 7);

		expect(result.totals.sent).toBe(0);
		expect(result.totals.failed).toBe(0);
		expect(result.totals.total).toBe(0);
		expect(result.totals.successRate).toBe(100);
	});

	it("correctly counts sent/failed/dead_letter totals", async () => {
		const now = new Date();
		const prisma = createMockPrisma([
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_FAILED", status: "failed", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "BACKUP_COMPLETED", status: "dead_letter", sentAt: now },
		]);

		const result = await getDeliveryStatistics(prisma, ["ch-1"], 7);

		expect(result.totals.sent).toBe(2);
		expect(result.totals.failed).toBe(1);
		expect(result.totals.deadLetter).toBe(1);
		expect(result.totals.total).toBe(4);
	});

	it("calculates success rate as percentage", async () => {
		const now = new Date();
		const prisma = createMockPrisma([
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "failed", sentAt: now },
		]);

		const result = await getDeliveryStatistics(prisma, ["ch-1"], 7);

		// 3 sent out of 4 total = 75%
		expect(result.totals.successRate).toBe(75);
	});

	it("aggregates per-channel statistics", async () => {
		const now = new Date();
		const prisma = createMockPrisma([
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "failed", sentAt: now },
			{ channelId: "ch-2", channelType: "telegram", eventType: "E1", status: "sent", sentAt: now },
			{ channelId: "ch-2", channelType: "telegram", eventType: "E1", status: "sent", sentAt: now },
		]);

		const result = await getDeliveryStatistics(prisma, ["ch-1", "ch-2"], 7);

		expect(result.perChannel).toHaveLength(2);

		const ch1 = result.perChannel.find((c) => c.channelId === "ch-1");
		expect(ch1).toBeDefined();
		expect(ch1!.channelType).toBe("discord");
		expect(ch1!.sent).toBe(1);
		expect(ch1!.failed).toBe(1);
		expect(ch1!.successRate).toBe(50);

		const ch2 = result.perChannel.find((c) => c.channelId === "ch-2");
		expect(ch2).toBeDefined();
		expect(ch2!.channelType).toBe("telegram");
		expect(ch2!.sent).toBe(2);
		expect(ch2!.failed).toBe(0);
		expect(ch2!.successRate).toBe(100);
	});

	it("aggregates per-event-type counts sorted by frequency", async () => {
		const now = new Date();
		const prisma = createMockPrisma([
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "BACKUP_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "BACKUP_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "BACKUP_COMPLETED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_FAILED", status: "sent", sentAt: now },
			{ channelId: "ch-1", channelType: "discord", eventType: "HUNT_FAILED", status: "sent", sentAt: now },
		]);

		const result = await getDeliveryStatistics(prisma, ["ch-1"], 7);

		expect(result.perEventType).toHaveLength(3);
		// Sorted by count descending
		expect(result.perEventType[0]!.eventType).toBe("BACKUP_COMPLETED");
		expect(result.perEventType[0]!.count).toBe(3);
		expect(result.perEventType[1]!.eventType).toBe("HUNT_FAILED");
		expect(result.perEventType[1]!.count).toBe(2);
		expect(result.perEventType[2]!.eventType).toBe("HUNT_COMPLETED");
		expect(result.perEventType[2]!.count).toBe(1);
	});

	it("builds daily trend sorted chronologically", async () => {
		const day1 = new Date("2026-03-01T10:00:00Z");
		const day2 = new Date("2026-03-02T14:00:00Z");
		const day3 = new Date("2026-03-03T08:00:00Z");

		const prisma = createMockPrisma([
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: day3 },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: day1 },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "failed", sentAt: day1 },
			{ channelId: "ch-1", channelType: "discord", eventType: "E1", status: "sent", sentAt: day2 },
		]);

		const result = await getDeliveryStatistics(prisma, ["ch-1"], 7);

		expect(result.dailyTrend).toHaveLength(3);
		// Sorted chronologically
		expect(result.dailyTrend[0]!.date).toBe("2026-03-01");
		expect(result.dailyTrend[0]!.sent).toBe(1);
		expect(result.dailyTrend[0]!.failed).toBe(1);
		expect(result.dailyTrend[1]!.date).toBe("2026-03-02");
		expect(result.dailyTrend[1]!.sent).toBe(1);
		expect(result.dailyTrend[1]!.failed).toBe(0);
		expect(result.dailyTrend[2]!.date).toBe("2026-03-03");
		expect(result.dailyTrend[2]!.sent).toBe(1);
		expect(result.dailyTrend[2]!.failed).toBe(0);
	});
});
