/**
 * Tests for HuntingScheduler API counter reset behavior
 *
 * Verifies that the API rate limit reset correctly advances each config's
 * reset window independently, preserving hourly alignment and handling
 * long downtime gracefully.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { getHuntingScheduler } from "../scheduler.js";

describe("HuntingScheduler - API Counter Reset", () => {
	let mockPrisma: {
		huntConfig: {
			updateMany: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
		};
		huntLog: {
			create: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
	};

	let mockApp: Partial<FastifyInstance>;

	beforeEach(() => {
		mockPrisma = {
			huntConfig: {
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				findMany: vi.fn().mockResolvedValue([]),
				update: vi.fn().mockResolvedValue({}),
			},
			huntLog: {
				create: vi.fn(),
				update: vi.fn(),
				findMany: vi.fn().mockResolvedValue([]),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		};

		mockApp = {
			prisma: mockPrisma as any,
			log: {
				info: vi.fn(),
				debug: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
			} as any,
		};

		getHuntingScheduler().initialize(mockApp as FastifyInstance);
	});

	afterEach(() => {
		getHuntingScheduler().stop();
		vi.clearAllMocks();
	});

	it("should find expired configs and reset each individually to preserve window alignment", async () => {
		const now = new Date();
		const expiredResetTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

		const expiredConfigs = [
			{ id: "config-1", apiCallsResetAt: expiredResetTime },
			{ id: "config-2", apiCallsResetAt: expiredResetTime },
		];

		// First findMany: find expired configs for reset
		// Second findMany: get all enabled configs for scheduling
		mockPrisma.huntConfig.findMany
			.mockResolvedValueOnce(expiredConfigs)
			.mockResolvedValueOnce([]);

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		// Should find expired configs first
		expect(mockPrisma.huntConfig.findMany).toHaveBeenCalledWith({
			where: {
				OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
				apiCallsResetAt: { lt: expect.any(Date) },
			},
			select: { id: true, apiCallsResetAt: true },
		});

		// Should reset each config individually (preserving per-config window alignment)
		expect(mockPrisma.huntConfig.update).toHaveBeenCalledTimes(2);
		expect(mockPrisma.huntConfig.update).toHaveBeenCalledWith({
			where: { id: "config-1" },
			data: {
				apiCallsThisHour: 0,
				apiCallsResetAt: expect.any(Date),
			},
		});
		expect(mockPrisma.huntConfig.update).toHaveBeenCalledWith({
			where: { id: "config-2" },
			data: {
				apiCallsThisHour: 0,
				apiCallsResetAt: expect.any(Date),
			},
		});
	});

	it("should advance reset time by 1 hour from the original window, not from now", async () => {
		const now = new Date();
		// Expired 10 minutes ago — original reset was at now - 10min
		const originalResetAt = new Date(now.getTime() - 10 * 60 * 1000);

		mockPrisma.huntConfig.findMany
			.mockResolvedValueOnce([{ id: "config-1", apiCallsResetAt: originalResetAt }])
			.mockResolvedValueOnce([]);

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		const updateCall = mockPrisma.huntConfig.update.mock.calls[0]![0];
		const newResetAt = updateCall.data.apiCallsResetAt as Date;

		// Should advance from original: originalResetAt + 1h (which is now + 50min)
		const expectedResetAt = originalResetAt.getTime() + 60 * 60 * 1000;
		expect(newResetAt.getTime()).toBeCloseTo(expectedResetAt, -2);
	});

	it("should snap to now + 1h when advanced time is still in the past (long downtime)", async () => {
		const now = new Date();
		const beforeCall = Date.now();
		// Expired 3 hours ago — advancing by 1h would still be in the past
		const longExpiredResetAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

		mockPrisma.huntConfig.findMany
			.mockResolvedValueOnce([{ id: "config-1", apiCallsResetAt: longExpiredResetAt }])
			.mockResolvedValueOnce([]);

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		const afterCall = Date.now();
		const updateCall = mockPrisma.huntConfig.update.mock.calls[0]![0];
		const newResetAt = updateCall.data.apiCallsResetAt as Date;

		// Should snap to now + 1h since advanced time would still be in the past
		const expectedMinTime = beforeCall + 60 * 60 * 1000;
		const expectedMaxTime = afterCall + 60 * 60 * 1000;
		expect(newResetAt.getTime()).toBeGreaterThanOrEqual(expectedMinTime);
		expect(newResetAt.getTime()).toBeLessThanOrEqual(expectedMaxTime);
	});

	it("should fetch all enabled configs after reset for scheduling", async () => {
		const callOrder: string[] = [];

		// First findMany (expired configs) — track order
		mockPrisma.huntConfig.findMany.mockImplementation(async (args: any) => {
			if (args?.select) {
				callOrder.push("findExpired");
			} else {
				callOrder.push("findEnabled");
			}
			return [];
		});

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		// Expired config lookup must happen before enabled config fetch
		expect(callOrder).toEqual(["findExpired", "findEnabled"]);
	});
});
