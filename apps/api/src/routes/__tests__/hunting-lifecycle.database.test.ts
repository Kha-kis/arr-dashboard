import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import { getHuntingScheduler } from "../../lib/hunting/scheduler.js";
import { registerHuntingRoutes } from "../hunting.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

// SQLite/registered routes are real. Only session identity injection is synthetic.
describe("native Hunting lifecycle persistence", () => {
	const app = Fastify({ logger: false });
	let directory: string, database: string, selectedConfig: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const scheduler = getHuntingScheduler();
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "hunting-lifecycle-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-hunting-lifecycle");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", new Encryptor("47".repeat(32)));
		app.decorate("huntingSchedulerEnabled", true);
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(registerHuntingRoutes, { prefix: "/api" });
		await app.ready();
		await run(() => scheduler.initialize(app));
	});
	beforeEach(async () => {
		await run(async () => {
			await native.prisma.user.deleteMany();
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other", username: "synthetic-other" },
				],
			});
			for (const id of ["selected", "other-instance", "foreign"])
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "foreign" ? "other" : "owner",
						service: "RADARR",
						label: `Synthetic ${id}`,
						baseUrl: "http://unused.invalid",
						encryptedApiKey: "unused",
						encryptionIv: "unused",
					},
				});
			for (const id of ["other-instance", "foreign"])
				await native.prisma.huntConfig.create({ data: { id: `config-${id}`, instanceId: id } });
		});
		const created = await request("POST", "/api/hunting/configs", { instanceId: "selected" });
		expect(created.statusCode).toBe(201);
		selectedConfig = created.json().id;
		await run(async () => {
			for (const entry of [
				{ id: "selected-missing", configId: selectedConfig, huntType: "missing", mediaId: 10 },
				{ id: "selected-upgrade", configId: selectedConfig, huntType: "upgrade", mediaId: 11 },
				{
					id: "other-missing",
					configId: "config-other-instance",
					huntType: "missing",
					mediaId: 10,
				},
				{ id: "foreign-missing", configId: "config-foreign", huntType: "missing", mediaId: 10 },
			])
				await native.prisma.huntSearchHistory.create({
					data: {
						...entry,
						mediaType: "movie",
						title: `Synthetic ${entry.id}`,
						searchedAt: new Date(),
					},
				});
			for (const instanceId of ["selected", "other-instance", "foreign"])
				await native.prisma.huntLog.create({
					data: {
						instanceId,
						huntType: "missing",
						status: "completed",
						itemsSearched: 1,
						itemsFound: 0,
						searchedItems: '["Synthetic result"]',
						message: "Synthetic completed",
						completedAt: new Date(),
					},
				});
		});
	});
	afterAll(async () => {
		await scheduler.shutdown();
		await app.close();
		await native?.close();
		await runtime?.close();
		const checks = [];
		for (const file of [
			database,
			`${database}.arr-restore-runtime/owner.sqlite3`,
			`${database}.arr-restore-runtime/operations.sqlite3`,
		]) {
			if (!existsSync(file)) continue;
			const db = new Database(file, { readonly: true, fileMustExist: true });
			try {
				const quick = db.pragma("quick_check"),
					foreign = db.pragma("foreign_key_check");
				expect(quick).toEqual([{ quick_check: "ok" }]);
				expect(foreign).toEqual([]);
				checks.push({ file, quick, foreign });
			} finally {
				db.close();
				expect(db.open).toBe(false);
			}
		}
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "hunting-lifecycle-closure.json"),
				JSON.stringify({
					nativeClosed: true,
					runtimeClosed: true,
					schedulerStopped: !scheduler.isRunning(),
					checks,
				}),
			);
		await rm(directory, { recursive: true, force: true });
	});
	it("persists create/PATCH/readback and refuses a duplicate without changing other configs", async () => {
		const before = await run(() =>
			native.prisma.huntConfig.findMany({
				where: { instanceId: { not: "selected" } },
				orderBy: { id: "asc" },
			}),
		);
		const payload = {
			huntMissingEnabled: true,
			huntUpgradesEnabled: true,
			missingBatchSize: 2,
			missingIntervalMins: 60,
			upgradeBatchSize: 1,
			upgradeIntervalMins: 120,
			hourlyApiCap: 50,
			queueThreshold: 10,
			includeTags: "[3]",
			researchAfterDays: 14,
		};
		const patched = await request("PATCH", "/api/hunting/configs/selected", payload);
		expect(patched.statusCode).toBe(200);
		expect(patched.json()).toMatchObject({ instanceId: "selected", ...payload });
		const duplicate = await request("POST", "/api/hunting/configs", { instanceId: "selected" });
		expect(duplicate.statusCode).toBe(409);
		const read = await request("GET", "/api/hunting/configs");
		expect(read.statusCode).toBe(200);
		expect(
			read.json().configs.find((c: { instanceId: string }) => c.instanceId === "selected"),
		).toMatchObject(payload);
		expect(
			read
				.json()
				.instances.map((i: { id: string }) => i.id)
				.sort(),
		).toEqual(["other-instance", "selected"]);
		expect(
			await run(() => native.prisma.huntConfig.findUnique({ where: { instanceId: "selected" } })),
		).toMatchObject(payload);
		expect(
			await run(() =>
				native.prisma.huntConfig.findMany({
					where: { instanceId: { not: "selected" } },
					orderBy: { id: "asc" },
				}),
			),
		).toEqual(before);
	});
	it("reads scoped history/log/status counts while another instance and owner stay populated", async () => {
		const history = await request("GET", "/api/hunting/history/selected");
		expect(history.statusCode).toBe(200);
		expect(history.json()).toMatchObject({
			instanceId: "selected",
			stats: {
				totalSearched: 2,
				missingSearched: 1,
				upgradeSearched: 1,
				recentlySearched: 2,
				eligibleForResearch: 0,
			},
		});
		const logs = await request("GET", "/api/hunting/logs?instanceId=selected");
		expect(logs.json()).toMatchObject({
			totalCount: 1,
			logs: [{ instanceId: "selected", status: "completed", itemsSearched: 1, itemsGrabbed: 0 }],
		});
		const status = await request("GET", "/api/hunting/status");
		expect(status.json()).toMatchObject({ recentActivityCount: 2 });
		expect(
			status
				.json()
				.instances.map((i: { instanceId: string }) => i.instanceId)
				.sort(),
		).toEqual(["other-instance", "selected"]);
		expect((await request("GET", "/api/hunting/history/foreign")).statusCode).toBe(404);
		expect(await run(() => native.prisma.huntSearchHistory.count())).toBe(4);
	});
	it("resets only the selected hunt-type history and retains config, other type, instance and owner", async () => {
		const before = await run(() =>
			native.prisma.huntSearchHistory.findMany({
				where: { id: { not: "selected-missing" } },
				orderBy: { id: "asc" },
			}),
		);
		const reset = await request("DELETE", "/api/hunting/history/selected?huntType=missing");
		expect(reset.statusCode).toBe(200);
		expect(reset.json()).toMatchObject({ deleted: 1, huntType: "missing" });
		expect(
			await run(() => native.prisma.huntSearchHistory.findMany({ orderBy: { id: "asc" } })),
		).toEqual(before);
		expect((await request("GET", "/api/hunting/history/selected")).json().stats).toMatchObject({
			totalSearched: 1,
			missingSearched: 0,
			upgradeSearched: 1,
		});
		expect(await run(() => native.prisma.huntConfig.count())).toBe(3);
		expect((await request("DELETE", "/api/hunting/history/foreign")).statusCode).toBe(404);
		expect(await run(() => native.prisma.huntSearchHistory.count())).toBe(3);
	});
});
