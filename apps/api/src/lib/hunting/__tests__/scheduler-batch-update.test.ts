/**
 * Tests for HuntingScheduler batch update optimization
 *
 * Verifies that the API rate limit reset uses a single batch updateMany()
 * instead of individual updates in a loop (N+1 query fix).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

// We need to test the private processScheduledHunts method
// Import the singleton getter and access it for testing
import { getHuntingScheduler } from "../scheduler.js";

describe("HuntingScheduler - Batch Update Optimization", () => {
	let mockPrisma: {
		huntConfig: {
			updateMany: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
		};
		huntLog: {
			create: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
		};
	};

	let mockApp: Partial<FastifyInstance>;

	beforeEach(() => {
		// Reset mocks
		mockPrisma = {
			huntConfig: {
				updateMany: vi.fn().mockResolvedValue({ count: 2 }),
				findMany: vi.fn().mockResolvedValue([]),
				update: vi.fn(),
			},
			huntLog: {
				create: vi.fn(),
				update: vi.fn(),
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

		// Initialize scheduler with mock app
		getHuntingScheduler().initialize(mockApp as FastifyInstance);
	});

	afterEach(() => {
		// Stop scheduler if running
		getHuntingScheduler().stop();
		vi.clearAllMocks();
	});

	it("should use batch updateMany for API counter reset instead of individual updates", async () => {
		const now = new Date();
		const expiredResetTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

		// Mock configs with expired API counters
		const mockConfigs = [
			{
				id: "config-1",
				instanceId: "instance-1",
				huntMissingEnabled: true,
				huntUpgradesEnabled: false,
				apiCallsThisHour: 50, // Should be reset to 0
				apiCallsResetAt: expiredResetTime,
				hourlyApiCap: 100,
				missingIntervalMins: 60,
				lastMissingHunt: now, // Recently hunted, won't trigger new hunt
				instance: { id: "instance-1", label: "Test Sonarr" },
			},
			{
				id: "config-2",
				instanceId: "instance-2",
				huntMissingEnabled: false,
				huntUpgradesEnabled: true,
				apiCallsThisHour: 75, // Should be reset to 0
				apiCallsResetAt: expiredResetTime,
				hourlyApiCap: 100,
				upgradeIntervalMins: 120,
				lastUpgradeHunt: now, // Recently hunted, won't trigger new hunt
				instance: { id: "instance-2", label: "Test Radarr" },
			},
		];

		// Return fresh configs after updateMany (simulating reset)
		mockPrisma.huntConfig.findMany.mockResolvedValue(
			mockConfigs.map((c) => ({
				...c,
				apiCallsThisHour: 0, // Reset by updateMany
				apiCallsResetAt: expect.any(Date),
			})),
		);

		// Access private method using type assertion
		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		// Verify updateMany was called ONCE with correct batch parameters
		expect(mockPrisma.huntConfig.updateMany).toHaveBeenCalledTimes(1);
		expect(mockPrisma.huntConfig.updateMany).toHaveBeenCalledWith({
			where: {
				OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
				apiCallsResetAt: { lt: expect.any(Date) },
			},
			data: {
				apiCallsThisHour: 0,
				apiCallsResetAt: expect.any(Date),
			},
		});

		// Verify NO individual updates were called (the old N+1 pattern)
		expect(mockPrisma.huntConfig.update).not.toHaveBeenCalled();

		// Verify findMany was called after updateMany to get fresh data
		expect(mockPrisma.huntConfig.findMany).toHaveBeenCalledTimes(1);
	});

	it("should set new reset time to 1 hour from now", async () => {
		const beforeCall = Date.now();

		mockPrisma.huntConfig.findMany.mockResolvedValue([]);

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		const afterCall = Date.now();

		// Extract the reset time from the updateMany call
		const updateManyCall = mockPrisma.huntConfig.updateMany.mock.calls[0][0];
		const newResetAt = updateManyCall.data.apiCallsResetAt as Date;

		// New reset time should be ~1 hour from now
		const expectedMinTime = beforeCall + 60 * 60 * 1000;
		const expectedMaxTime = afterCall + 60 * 60 * 1000;

		expect(newResetAt.getTime()).toBeGreaterThanOrEqual(expectedMinTime);
		expect(newResetAt.getTime()).toBeLessThanOrEqual(expectedMaxTime);
	});

	it("should only reset configs that have expired apiCallsResetAt", async () => {
		mockPrisma.huntConfig.findMany.mockResolvedValue([]);

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		// Verify the where clause filters by apiCallsResetAt < now
		const updateManyCall = mockPrisma.huntConfig.updateMany.mock.calls[0][0];
		expect(updateManyCall.where.apiCallsResetAt).toEqual({
			lt: expect.any(Date),
		});

		// The lt (less than) date should be approximately "now"
		const filterDate = updateManyCall.where.apiCallsResetAt.lt as Date;
		expect(filterDate.getTime()).toBeCloseTo(Date.now(), -2); // Within ~100ms
	});

	it("should fetch configs after batch update to get fresh values", async () => {
		const callOrder: string[] = [];

		mockPrisma.huntConfig.updateMany.mockImplementation(async () => {
			callOrder.push("updateMany");
			return { count: 1 };
		});

		mockPrisma.huntConfig.findMany.mockImplementation(async () => {
			callOrder.push("findMany");
			return [];
		});

		const scheduler = getHuntingScheduler() as any;
		await scheduler.processScheduledHunts();

		// updateMany must be called BEFORE findMany
		expect(callOrder).toEqual(["updateMany", "findMany"]);
	});
});
