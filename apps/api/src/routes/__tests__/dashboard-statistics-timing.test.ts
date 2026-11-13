import { SonarrClient } from "arr-sdk";
import Fastify, { type FastifyBaseLogger, LogController } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsOptions } from "../../lib/statistics/dashboard-statistics.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({ fetchSonarr: vi.fn() }));

vi.mock("../../lib/statistics/dashboard-statistics.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/statistics/dashboard-statistics.js")>();
	return { ...actual, fetchSonarrStatisticsWithSdk: mocks.fetchSonarr };
});

vi.mock("../../lib/arr/library-stream.js", () => ({
	streamLibraryItems: async function* () {
		yield {};
	},
}));

import { emptySonarrStatistics } from "../../lib/statistics/dashboard-statistics.js";
import { collectDashboardStatistics } from "../dashboard/statistics-routes.js";

describe("Dashboard statistics provider timing", () => {
	let app: ReturnType<typeof Fastify>;
	let logLines: string[];

	beforeEach(async () => {
		logLines = [];
		mocks.fetchSonarr.mockReset().mockResolvedValue(emptySonarrStatistics);
		const log = pino(
			{ level: "info", base: null, timestamp: false },
			{ write: (line: string) => logLines.push(line) },
		) as unknown as FastifyBaseLogger;
		app = Fastify({
			loggerInstance: log,
			logController: new LogController({ disableRequestLogging: true }),
		});
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "synthetic-instance",
						userId: "user-1",
						service: "SONARR",
						label: "synthetic-label",
						baseUrl: "https://synthetic.invalid",
						externalUrl: null,
						storageGroupId: null,
						enabled: true,
					},
				]),
			},
		} as never);
		app.decorate("arrClientFactory", {
			create: () => Object.create(SonarrClient.prototype) as SonarrClient,
		} as never);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("records a generic provider duration without instance details", async () => {
		await collectDashboardStatistics(app, "user-1", app.log);
		const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const timings = records.filter(
			(record) => record.category === "dashboard-statistics-provider-timing",
		);
		expect(timings).toHaveLength(1);
		expect(timings[0]).toMatchObject({ service: "sonarr" });
		expect(typeof timings[0]?.durationMs).toBe("number");
		expect(timings[0]).not.toHaveProperty("instanceId");
		expect(timings[0]).not.toHaveProperty("baseUrl");
		expect(timings[0]).not.toHaveProperty("instanceName");
	});

	it("records the bulk stream phase without private instance details", async () => {
		mocks.fetchSonarr.mockImplementation(async (...args: unknown[]) => {
			const options = args[5] as StatsOptions;
			for await (const _item of options.streamItems?.() ?? []) {
				// Consume the production wrapper; item contents are irrelevant to timing.
			}
			return emptySonarrStatistics;
		});
		await collectDashboardStatistics(app, "user-1", app.log);
		const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const timings = records.filter(
			(record) => record.category === "dashboard-statistics-stream-timing",
		);
		expect(timings).toHaveLength(1);
		expect(timings[0]).toMatchObject({ service: "sonarr" });
		expect(typeof timings[0]?.durationMs).toBe("number");
		expect(timings[0]).not.toHaveProperty("instanceId");
		expect(timings[0]).not.toHaveProperty("baseUrl");
		expect(timings[0]).not.toHaveProperty("instanceName");
	});

	it("marks failed provider data unavailable and excludes it from the aggregate", async () => {
		mocks.fetchSonarr.mockImplementation(async (...args: unknown[]) => {
			const options = args[5] as StatsOptions;
			options.markIncomplete?.("ancillary");
			return emptySonarrStatistics;
		});
		const { data: payload, partial } = await collectDashboardStatistics(app, "user-1", app.log);
		expect(partial).toBe(true);
		expect(payload.sonarr.instances[0]?.error).toBe(true);
		expect(payload.sonarr.aggregate).toBeUndefined();
	});

	it("does not publish a complete aggregate when another instance still responds", async () => {
		vi.spyOn(app.prisma.serviceInstance, "findMany").mockResolvedValue([
			{
				id: "synthetic-unavailable",
				userId: "user-1",
				service: "SONARR",
				label: "Synthetic unavailable",
				baseUrl: "https://synthetic.invalid",
				externalUrl: null,
				storageGroupId: "shared-synthetic-group",
				enabled: true,
			},
			{
				id: "synthetic-healthy",
				userId: "user-1",
				service: "SONARR",
				label: "Synthetic healthy",
				baseUrl: "https://synthetic.invalid",
				externalUrl: null,
				storageGroupId: "shared-synthetic-group",
				enabled: true,
			},
		] as never);
		mocks.fetchSonarr.mockImplementation(async (...args: unknown[]) => {
			if (args[1] === "synthetic-unavailable") {
				(args[5] as StatsOptions).markIncomplete?.("stream");
				return emptySonarrStatistics;
			}
			return { ...emptySonarrStatistics, totalSeries: 7 };
		});
		const { data: payload, partial } = await collectDashboardStatistics(app, "user-1", app.log);
		expect(partial).toBe(true);
		expect(payload.sonarr.instances.map((entry) => entry.error ?? false)).toEqual([true, false]);
		expect(payload.sonarr.instances[1]?.data.totalSeries).toBe(7);
		expect(payload.sonarr.aggregate).toBeUndefined();
	});

	it("marks client-construction failure as partial rather than dropping a configured source", async () => {
		vi.spyOn(app.arrClientFactory, "create").mockImplementation(() => {
			throw new Error("Synthetic client unavailable");
		});
		const { data, partial } = await collectDashboardStatistics(app, "user-1", app.log);
		expect(partial).toBe(true);
		expect(data.sonarr.instances).toHaveLength(1);
		expect(data.sonarr.instances[0]?.error).toBe(true);
		expect(data.sonarr.aggregate).toBeUndefined();
	});
});
