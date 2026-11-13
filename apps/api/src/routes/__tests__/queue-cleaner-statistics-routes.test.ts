import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerQueueCleanerRoutes } from "../queue-cleaner.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

vi.mock("../../lib/queue-cleaner/scheduler.js", () => ({
	getQueueCleanerScheduler: vi.fn(),
}));

async function readStatistics(
	now: Date,
	runs: Array<{ at: Date; itemsCleaned: number; itemsWarned?: number }>,
) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	const instance = {
		id: "arr-fixture",
		userId: "user-1",
		service: "SONARR",
		label: "Synthetic Sonarr",
		queueCleanerConfig: null,
	};
	const entry = {
		instanceId: instance.id,
		instance,
		itemsSkipped: 0,
		itemsWarned: 0,
		status: "completed",
		durationMs: 1000,
		cleanedItems: null,
		isDryRun: false,
	};
	const logRead = vi.fn().mockResolvedValue(
		runs.map(({ at, itemsCleaned, itemsWarned = 0 }, i) => ({
			...entry,
			id: String(i),
			startedAt: at,
			itemsCleaned,
			itemsWarned,
		})),
	);
	const app = Fastify();
	try {
		app.decorate("prisma", {
			queueCleanerLog: { findMany: logRead },
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
		} as never);
		app.decorate("queueCleanerEnabled", true);
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		await app.register(registerQueueCleanerRoutes);
		await app.ready();
		const response = await createInjectAuthenticated(app)("GET", "/queue-cleaner/statistics");
		expect(response.statusCode).toBe(200);
		expect(logRead).toHaveBeenCalledOnce();
		expect(logRead.mock.calls[0]?.[0]).toMatchObject({
			where: { instance: { userId: instance.userId } },
		});
		return response.json();
	} finally {
		await app.close();
		vi.useRealTimers();
	}
}

it("includes completed runs from today in the newest weekly statistics bucket", async () => {
	const body = await readStatistics(new Date(2026, 10, 12, 18), [
		{ at: new Date(2026, 10, 12, 12), itemsCleaned: 5 },
		{ at: new Date(2026, 10, 11, 12), itemsCleaned: 2, itemsWarned: 1 },
	]);

	expect(body.totals).toMatchObject({ itemsCleaned: 7, totalRuns: 2 });
	expect(body.weekly[3]).toEqual({
		period: "Week 4",
		itemsCleaned: 7,
		itemsWarned: 1,
		runsCompleted: 2,
	});
});

it("separates the calendar day boundaries across the four retained weeks", async () => {
	const body = await readStatistics(new Date(2026, 2, 14, 18), [
		{ at: new Date(2026, 2, 15, 12), itemsCleaned: 32 },
		{ at: new Date(2026, 2, 8, 12), itemsCleaned: 1 },
		{ at: new Date(2026, 2, 7, 12), itemsCleaned: 2 },
		{ at: new Date(2026, 1, 15, 12), itemsCleaned: 4 },
		{ at: new Date(2026, 1, 14, 12), itemsCleaned: 8 },
	]);
	expect(body.weekly).toEqual([
		{ period: "Week 1", itemsCleaned: 4, itemsWarned: 0, runsCompleted: 1 },
		{ period: "Week 2", itemsCleaned: 0, itemsWarned: 0, runsCompleted: 0 },
		{ period: "Week 3", itemsCleaned: 2, itemsWarned: 0, runsCompleted: 1 },
		{ period: "Week 4", itemsCleaned: 1, itemsWarned: 0, runsCompleted: 1 },
	]);
});

it("includes early runs on the first retained day when today skipped midnight", async () => {
	const body = await readStatistics(new Date(2026, 8, 6, 18), [
		{ at: new Date(2026, 7, 10, 0, 30), itemsCleaned: 3 },
		{ at: new Date(2026, 7, 9, 23, 30), itemsCleaned: 9 },
	]);
	expect(body.weekly[0]).toEqual({
		period: "Week 1",
		itemsCleaned: 3,
		itemsWarned: 0,
		runsCompleted: 1,
	});
});
