import { AsyncResource } from "node:async_hooks";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardStatisticsResponse } from "@arr/shared";
import { SonarrClient } from "arr-sdk";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../../routes/__tests__/test-helpers.js";
import { statisticsRoutes } from "../../../routes/dashboard/statistics-routes.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import type { Prisma, PrismaClient } from "../../prisma.js";
import { emptySonarrStatistics } from "../dashboard-statistics.js";
import * as refresh from "../dashboard-statistics-refresh.js";
import * as snapshot from "../dashboard-statistics-snapshot.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../dashboard-statistics.js", async (original) => ({
	...(await original<typeof import("../dashboard-statistics.js")>()),
	fetchSonarrStatisticsWithSdk: transport.fetch,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
	transport.fetch.mockReset();
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "dashboard-wal-conflict-"));
	chmodSync(directory, 0o700);
	const path = join(directory, "test.db");
	new Database(path).close();
	chmodSync(path, 0o600);
	const url = `file:${path}`;
	await synchronizeRuntimeSchema(url);
	const writer = new Database(path, { timeout: 0 });
	writer.pragma("journal_mode=WAL");
	const runtime = await openRestoreRuntime({ databaseUrl: url });
	await runtime.bindDestination("synthetic-dashboard");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime);
	const prisma = native.prisma;
	cleanup.push(async () => {
		if (writer.inTransaction) writer.exec("ROLLBACK");
		await runtime.drain();
		await native.close();
		await runtime.close();
		writer.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const source = await runtime.runOperation(async () => {
		await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
		return prisma.serviceInstance.create({
			data: {
				id: "source",
				userId: "owner",
				service: "SONARR",
				label: "Synthetic",
				baseUrl: "https://example.invalid",
				encryptedApiKey: "test",
				encryptionIv: "test",
			},
		});
	});
	const fingerprint = snapshot.fingerprintDashboardSources([source]);
	const now = new Date();
	const observedAt = new Date(now.getTime() - 16 * 60_000);
	const payload: DashboardStatisticsResponse = {
		sonarr: {
			instances: [
				{
					instanceId: "source",
					instanceName: "Synthetic",
					data: { ...emptySonarrStatistics, totalSeries: 17 },
					error: false,
				},
			],
		},
		radarr: { instances: [] },
		prowlarr: { instances: [] },
		lidarr: { instances: [] },
		readarr: { instances: [] },
	};
	await runtime.runOperation(() =>
		prisma.dashboardStatisticsSnapshot.create({
			data: {
				userId: "owner",
				sourceFingerprint: fingerprint,
				result: "complete",
				payload: JSON.stringify(payload),
				observedAt,
			},
		}),
	);
	const run = <T>(work: () => Promise<T>) => runtime.runOperation(work);
	return { prisma, writer, runtime, run, now, observedAt, fingerprint, payload };
}

/** Hold a real competing writer before reservation; never manufacture a Prisma error. */
function raceWrite(prisma: PrismaClient, writer: Database.Database, initiallyArmed = true) {
	let armed = initiallyArmed;
	const errors: unknown[] = [];
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (this === writer || this.name !== writer.name || sql !== "BEGIN") return statement;
		for (const method of ["run", "all"] as const) {
			const invoke = statement[method];
			Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
				const result = Reflect.apply(invoke, this, args);
				if (armed) {
					armed = false;
					writer.exec("BEGIN IMMEDIATE");
				}
				return result;
			});
		}
		return statement;
	});
	const raced = new Proxy(prisma, {
		get(target, property, receiver) {
			if (property !== "$transaction") return Reflect.get(target, property, receiver);
			return async (body: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
				try {
					return await target.$transaction(body);
				} catch (error) {
					errors.push(error);
					throw error;
				}
			};
		},
	});
	return {
		prisma: raced,
		errors,
		arm: () => {
			armed = true;
		},
		release: () => {
			if (writer.inTransaction) writer.exec("ROLLBACK");
		},
	};
}

describe("Dashboard refresh real WAL contention", { timeout: 30_000 }, () => {
	it("keeps scheduled renewal alive after one real writer refusal and publishes beyond the initial lease", async () => {
		const f = await fixture();
		const raced = raceWrite(f.prisma, f.writer, false);
		vi.useFakeTimers({
			toFake: ["Date", "setImmediate", "clearImmediate", "setInterval", "clearInterval"],
		});
		vi.setSystemTime(f.now);
		// Fake timer invocation must preserve Node's real registration-time async
		// context; otherwise the guarded client correctly rejects a ticketless callback.
		const fakeSetInterval = globalThis.setInterval;
		const interval = vi
			.spyOn(globalThis, "setInterval")
			.mockImplementation((callback, delay, ...args) =>
				fakeSetInterval(AsyncResource.bind(callback), delay, ...args),
			);
		const renew = vi.spyOn(snapshot, "renewDashboardRefreshClaim");
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let collecting = false;
		try {
			expect(
				await f.run(() =>
					refresh.requestDashboardStatisticsRefresh(
						{ prisma: raced.prisma } as never,
						"owner",
						f.fingerprint,
						{ warn() {} } as never,
						async () => {
							collecting = true;
							await held;
							return {
								data: {
									...f.payload,
									sonarr: {
										instances: [
											{
												instanceId: "source",
												instanceName: "Synthetic",
												data: { ...emptySonarrStatistics, totalSeries: 18 },
											},
										],
									},
								},
								partial: false,
							};
						},
					),
				),
			).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(collecting).toBe(true);
			const initial = await f.run(() =>
				f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
			);
			expect(initial.leaseUntil!.getTime()).toBe(f.now.getTime() + 120_000);
			raced.arm();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(renew).toHaveBeenCalled();
			await Promise.allSettled([renew.mock.results[0]!.value]);
			expect(raced.errors).toHaveLength(1);
			expect(raced.errors[0]).toMatchObject({ code: "P1008" });
			raced.release();
			for (let tick = 0; tick < 4; tick++) {
				await vi.advanceTimersByTimeAsync(30_000);
				await Promise.allSettled(renew.mock.results.map((result) => result.value));
				// Join the real asynchronous native queue between clock steps.
				await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				);
			}
			const live = await f.run(() =>
				f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
			);
			expect(live.claimToken).toBe(initial.claimToken);
			expect(live.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
			release();
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(async () => {
				const row = await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				);
				expect(row.claimToken).toBeNull();
				expect(JSON.parse(row.payload!).sonarr.instances[0].data.totalSeries).toBe(18);
				expect(row.observedAt!.getTime()).toBeGreaterThan(f.now.getTime());
			});
		} finally {
			raced.release();
			release();
			await vi.advanceTimersByTimeAsync(0);
			renew.mockRestore();
			interval.mockRestore();
			vi.useRealTimers();
		}
	});
	it("refuses the failed claim, preserves published data, and permits a fresh independent claim", async () => {
		const f = await fixture();
		const raced = raceWrite(f.prisma, f.writer);
		await expect(
			f.run(() =>
				snapshot.claimDashboardRefresh(raced.prisma, "owner", f.fingerprint, "loser", f.now),
			),
		).resolves.toBe(false);
		expect(raced.errors).toHaveLength(1);
		expect(raced.errors[0]).toMatchObject({ code: "P1008" });
		const read = await f.run(() =>
			snapshot.readDashboardSnapshot(f.prisma, "owner", f.fingerprint, f.now),
		);
		expect(read).toEqual({
			availability: "last-known",
			observedAt: f.observedAt,
			data: f.payload,
			refreshDue: true,
		});
		expect(
			(
				await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				)
			).claimToken,
		).toBeNull();
		raced.release();
		expect(
			await f.run(() =>
				snapshot.claimDashboardRefresh(f.prisma, "owner", f.fingerprint, "fresh", f.now),
			),
		).toBe(true);
		expect(
			(
				await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				)
			).claimToken,
		).toBe("fresh");
	});

	it.each([true, false])(
		"serves honest cached availability and recovers on the next request (published: %s)",
		async (published) => {
			const f = await fixture();
			const queued = vi.spyOn(refresh, "queueDashboardStatisticsRefresh");
			if (!published)
				await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.update({
						where: { userId: "owner" },
						data: { sourceFingerprint: null, payload: null, observedAt: null, result: null },
					}),
				);
			const raced = raceWrite(f.prisma, f.writer);
			const app = Fastify({ logger: false });
			cleanup.push(() => app.close());
			setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
			registerTestErrorHandler(app);
			app.decorate("prisma", raced.prisma);
			app.decorate("arrClientFactory", {
				create: () => Object.create(SonarrClient.prototype),
			} as never);
			app.addHook("preHandler", async (request, reply) => {
				if (!request.currentUser) return reply.status(401).send({ error: "Unauthorized" });
			});
			await app.register(statisticsRoutes);
			await app.ready();
			transport.fetch.mockResolvedValue({ ...emptySonarrStatistics, totalSeries: 18 });
			const inject = createInjectAuthenticated(app);
			const first = await f.run(() => inject("GET", "/dashboard/statistics/snapshot"));
			await expect(queued.mock.results[0]!.value).resolves.toBe(false);
			expect(raced.errors[0]).toMatchObject({ code: "P1008" });
			expect(first.statusCode).toBe(200);
			expect(first.json()).toMatchObject(
				published
					? {
							availability: "last-known",
							observedAt: f.observedAt.toISOString(),
							data: { sonarr: { instances: [{ data: { totalSeries: 17 } }] } },
						}
					: { availability: "unavailable", observedAt: null, data: null },
			);
			expect(transport.fetch).not.toHaveBeenCalled();
			raced.release();
			const next = await f.run(() => inject("GET", "/dashboard/statistics/snapshot"));
			expect(next.statusCode).toBe(200);
			expect(next.json().availability).toBe(published ? "last-known" : "unavailable");
			await vi.waitFor(async () => {
				const row = await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				);
				expect(row.claimToken).toBeNull();
				expect(row.observedAt!.getTime()).toBeGreaterThan(f.observedAt.getTime());
			});
			const recovered = await f.run(() => inject("GET", "/dashboard/statistics/snapshot"));
			expect(recovered.statusCode).toBe(200);
			expect(recovered.json()).toMatchObject({
				availability: "current",
				data: { sonarr: { instances: [{ data: { totalSeries: 18 } }] } },
			});
		},
	);

	it.each(["renew", "publish"] as const)(
		"rolls back a refused %s and preserves its exact live claim for an independent retry",
		async (phase) => {
			const f = await fixture();
			expect(
				await f.run(() =>
					snapshot.claimDashboardRefresh(f.prisma, "owner", f.fingerprint, "live", f.now),
				),
			).toBe(true);
			const before = await f.run(() =>
				f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
			);
			const raced = raceWrite(f.prisma, f.writer);
			const later = new Date(f.now.getTime() + 1000);
			const attempt = (prisma: PrismaClient) =>
				phase === "renew"
					? snapshot.renewDashboardRefreshClaim(prisma, "owner", f.fingerprint, "live", later)
					: snapshot.publishDashboardSnapshot(
							prisma,
							"owner",
							f.fingerprint,
							"live",
							later,
							f.payload,
							"complete",
							later,
						);
			if (phase === "renew") {
				await expect(f.run(() => attempt(raced.prisma))).rejects.toMatchObject({ code: "P1008" });
			} else {
				await expect(f.run(() => attempt(raced.prisma))).resolves.toBe(false);
			}
			expect(raced.errors).toHaveLength(1);
			expect(raced.errors[0]).toMatchObject({ code: "P1008" });
			expect(
				await f.run(() =>
					f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
				),
			).toEqual(before);
			raced.release();
			expect(await f.run(() => attempt(f.prisma))).toBe(true);
		},
	);

	it("does not hide a real non-contention constraint failure", async () => {
		const f = await fixture();
		const before = await f.run(() =>
			f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
		);
		f.writer.exec(`CREATE TRIGGER reject_snapshot_update BEFORE UPDATE ON "dashboard_statistics_snapshots"
   BEGIN SELECT RAISE(ABORT, 'synthetic constraint refusal'); END`);
		await expect(
			f.run(() =>
				snapshot.claimDashboardRefresh(f.prisma, "owner", f.fingerprint, "rejected", f.now),
			),
		).rejects.toBeInstanceOf(Error);
		expect(
			await f.run(() =>
				f.prisma.dashboardStatisticsSnapshot.findUniqueOrThrow({ where: { userId: "owner" } }),
			),
		).toEqual(before);
	});
});
