import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SonarrClient } from "arr-sdk";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { emptySonarrStatistics } from "../../lib/statistics/dashboard-statistics.js";
import { statisticsRoutes } from "../dashboard/statistics-routes.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({ fetchSonarr: vi.fn() }));
vi.mock("../../lib/statistics/dashboard-statistics.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/statistics/dashboard-statistics.js")>();
	return { ...actual, fetchSonarrStatisticsWithSdk: mocks.fetchSonarr };
});

describe("Dashboard statistics snapshot route", { timeout: 30_000 }, () => {
	const cleanup: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const task of cleanup.splice(0).reverse()) await task();
		mocks.fetchSonarr.mockReset();
	});

	async function setup() {
		const directory = mkdtempSync(join(tmpdir(), "dashboard-statistics-route-"));
		const dbPath = join(directory, "test.db");
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
			stdio: "ignore",
		});
		const prisma = createTestPrismaClient(dbPath);
		const app = Fastify({ logger: false });
		cleanup.push(async () => {
			await app.close();
			await prisma.$disconnect();
			rmSync(directory, { recursive: true, force: true });
		});
		await prisma.user.create({ data: { id: "user-1", username: "synthetic-owner" } });
		await prisma.serviceInstance.create({
			data: {
				userId: "user-1",
				service: "SONARR",
				label: "synthetic",
				baseUrl: "http://example.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		setupAuthInjection(app);
		app.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser) return reply.status(401).send({ error: "Unauthorized" });
		});
		registerTestErrorHandler(app);
		app.decorate("prisma", prisma as never);
		app.decorate("arrClientFactory", {
			create: () => Object.create(SonarrClient.prototype) as SonarrClient,
		} as never);
		await app.register(statisticsRoutes);
		await app.ready();
		return { app, prisma };
	}

	it("answers a cold GET while its provider read remains unresolved", async () => {
		const { app } = await setup();
		let releaseProvider = () => {};
		mocks.fetchSonarr.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseProvider = () => resolve(emptySonarrStatistics);
				}),
		);
		const pending = createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		const timeout = Symbol("provider-blocked");
		const timer = new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250));
		const outcome = await Promise.race([pending, timer]);
		releaseProvider();
		const settled = await pending;
		expect(outcome).not.toBe(timeout);
		expect(settled.statusCode).toBe(200);
		expect(settled.json()).toMatchObject({
			availability: "collecting",
			observedAt: null,
			data: null,
		});
	});

	it("serves a current hit, retains last-known during refresh, and coalesces repeat GETs", async () => {
		const { app, prisma } = await setup();
		mocks.fetchSonarr.mockResolvedValue(emptySonarrStatistics);
		const first = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(first.json().availability).toBe("collecting");
		await vi.waitFor(async () => {
			expect(
				(await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId: "user-1" } }))
					?.result,
			).toBe("complete");
		});
		const current = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(current.json()).toMatchObject({ availability: "current" });
		expect(current.json().data.sonarr.instances).toHaveLength(1);
		expect(mocks.fetchSonarr).toHaveBeenCalledTimes(1);

		await prisma.dashboardStatisticsSnapshot.update({
			where: { userId: "user-1" },
			data: { observedAt: new Date(Date.now() - 16 * 60_000) },
		});
		let releaseProvider = () => {};
		mocks.fetchSonarr.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseProvider = () => resolve(emptySonarrStatistics);
				}),
		);
		const stale = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		const again = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(stale.json()).toMatchObject({ availability: "last-known" });
		expect(again.json()).toMatchObject({ availability: "last-known" });
		await vi.waitFor(() => expect(mocks.fetchSonarr).toHaveBeenCalledTimes(2));
		releaseProvider();
		await vi.waitFor(async () => {
			const row = await prisma.dashboardStatisticsSnapshot.findUnique({
				where: { userId: "user-1" },
			});
			expect(row?.claimToken).toBeNull();
			expect(row?.observedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
		});
	});

	it("publishes provider-incomplete results only as partial", async () => {
		const { app, prisma } = await setup();
		mocks.fetchSonarr.mockImplementation(async (...args: unknown[]) => {
			const options = args[5] as { markIncomplete?: (phase: "ancillary") => void };
			options.markIncomplete?.("ancillary");
			return emptySonarrStatistics;
		});
		const first = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(first.json().availability).toBe("collecting");
		await vi.waitFor(async () => {
			expect(
				(await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId: "user-1" } }))
					?.result,
			).toBe("partial");
		});
		const partial = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(partial.json().availability).toBe("partial");
		expect(partial.json().data.sonarr.instances[0].error).toBe(true);
		expect(partial.json().data.sonarr).not.toHaveProperty("aggregate");
	});

	it("discards a collected result after a source configuration edit", async () => {
		const { app, prisma } = await setup();
		let releaseProvider = () => {};
		mocks.fetchSonarr.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseProvider = () => resolve(emptySonarrStatistics);
				}),
		);
		const first = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(first.json().availability).toBe("collecting");
		await vi.waitFor(() => expect(mocks.fetchSonarr).toHaveBeenCalledTimes(1));
		const source = await prisma.serviceInstance.findFirstOrThrow({ where: { userId: "user-1" } });
		await prisma.serviceInstance.update({
			where: { id: source.id },
			data: { updatedAt: new Date(source.updatedAt.getTime() + 1_000) },
		});
		releaseProvider();
		await vi.waitFor(async () => {
			const row = await prisma.dashboardStatisticsSnapshot.findUnique({
				where: { userId: "user-1" },
			});
			expect(row?.claimToken).toBeNull();
		});
		const row = await prisma.dashboardStatisticsSnapshot.findUnique({
			where: { userId: "user-1" },
		});
		expect(row?.payload).toBeNull();
		const next = await createInjectAuthenticated(app)("GET", "/dashboard/statistics/snapshot");
		expect(next.json().data).toBeNull();
		await vi.waitFor(() => expect(mocks.fetchSonarr).toHaveBeenCalledTimes(2));
		releaseProvider();
		await vi.waitFor(async () => {
			expect(
				(await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId: "user-1" } }))
					?.claimToken,
			).toBeNull();
		});
	});

	it("does not start a refresh for an unauthenticated request", async () => {
		const { app, prisma } = await setup();
		const denied = await app.inject({ method: "GET", url: "/dashboard/statistics/snapshot" });
		expect(denied.statusCode).toBe(401);
		expect(await prisma.dashboardStatisticsSnapshot.count()).toBe(0);
		expect(mocks.fetchSonarr).not.toHaveBeenCalled();
	});

	it("preserves the stable bare response on the legacy statistics path", async () => {
		const { app } = await setup();
		mocks.fetchSonarr.mockResolvedValue(emptySonarrStatistics);
		const response = await createInjectAuthenticated(app)("GET", "/dashboard/statistics");
		expect(response.statusCode).toBe(200);
		expect(response.json().sonarr.instances).toHaveLength(1);
		expect(response.json()).not.toHaveProperty("availability");
	});

	it("preserves legacy aggregate fields when a provider fails", async () => {
		const { app } = await setup();
		mocks.fetchSonarr.mockRejectedValue(new Error("synthetic provider unavailable"));
		const response = await createInjectAuthenticated(app)("GET", "/dashboard/statistics");
		expect(response.statusCode).toBe(200);
		expect(response.json().sonarr.instances[0]?.error).toBe(true);
		expect(typeof response.json().sonarr.aggregate?.totalSeries).toBe("number");
	});
});
