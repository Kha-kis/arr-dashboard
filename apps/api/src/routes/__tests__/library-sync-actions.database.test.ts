import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import { registerSyncRoutes } from "../library/sync-routes.js";
import { registerTestErrorHandler } from "./test-helpers.js";

// Only synthetic auth and scheduler dispatch are controlled seams. Route validation,
// execution-time owner lookup and settings persistence use the real native runtime.
const scheduler = vi.hoisted(() => ({
	active: new Set<string>(),
	triggerSync: vi.fn<(id: string) => Promise<unknown>>(),
}));
vi.mock("../../lib/library-sync/index.js", () => ({
	getLibrarySyncScheduler: () => ({
		isInstanceSyncing: (id: string) => scheduler.active.has(id),
		triggerSync: scheduler.triggerSync,
	}),
}));
describe("native Library sync POST/PATCH contracts", () => {
	let directory = "",
		database = "",
		ready = false;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>,
		native: ReturnType<typeof createRuntimePrismaClient>;
	const logs: Array<Record<string, unknown>> = [],
		records: unknown[] = [],
		jobs: Array<{
			id: string;
			resolve: () => void;
			reject: () => void;
			promise: Promise<unknown>;
			closed: boolean;
		}> = [];
	const app = Fastify({
		logger: {
			level: "error",
			stream: {
				write: (line: string) => {
					logs.push(JSON.parse(line));
				},
			},
		},
	});
	const run = <T>(action: () => Promise<T>) => runtime.runOperation(action);
	const snapshot = () =>
		run(async () => ({
			sources: await native.prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }),
			settings: await native.prisma.librarySyncStatus.findMany({ orderBy: { instanceId: "asc" } }),
			cache: await native.prisma.libraryCache.count(),
		}));
	async function request(
		method: "GET" | "POST" | "PATCH",
		id: string,
		payload?: Record<string, unknown>,
	) {
		const response = await run(() =>
			app.inject({
				method,
				url: id === "status" ? "/library/sync/status" : `/library/sync/${id}`,
				...(payload === undefined ? {} : { payload }),
			}),
		);
		records.push({
			method,
			id,
			payload,
			status: response.statusCode,
			body: response.json(),
			dispatches: scheduler.triggerSync.mock.calls.map(([value]) => value),
		});
		return response;
	}
	beforeAll(async () => {
		const base = process.env.ARR_LIBRARY_SYNC_ACTIONS_TEST_ROOT ?? tmpdir();
		await mkdir(base, { recursive: true });
		directory = await mkdtemp(join(base, "arr-library-sync-actions-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-library-sync-actions");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		const encryptor = new Encryptor("74".repeat(32));
		await run(async () => {
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "Synthetic" },
					{ id: "foreign", username: "Foreign" },
				],
			});
			for (const [id, userId, service] of [
				["owned", "owner", "RADARR"],
				["owned-new", "owner", "SONARR"],
				["foreign", "foreign", "RADARR"],
				["nonlibrary", "owner", "PROWLARR"],
			] as const) {
				const key = encryptor.encrypt("synthetic-key");
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId,
						service,
						label: "Synthetic",
						baseUrl: "http://127.0.0.1:1",
						enabled: true,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
			}
			await native.prisma.librarySyncStatus.create({
				data: {
					instanceId: "owned",
					lastFullSync: new Date("2026-10-20T12:00:00Z"),
					lastSyncDurationMs: 123,
					itemCount: 7,
					pollingEnabled: true,
					pollingIntervalMins: 15,
				},
			});
		});
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("dbProvider", "sqlite");
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner", username: "Synthetic" } as typeof request.currentUser;
		});
		registerTestErrorHandler(app);
		await app.register(registerSyncRoutes);
		await app.ready();
		ready = true;
	});
	beforeEach(() => {
		scheduler.active.clear();
		scheduler.triggerSync.mockReset();
		logs.length = 0;
		scheduler.triggerSync.mockImplementation((id) => {
			let resolve!: () => void, reject!: () => void;
			const promise = new Promise<void>((done, fail) => {
				resolve = done;
				reject = () => fail(new Error("Synthetic scheduler rejected"));
			});
			const job = {
				id,
				resolve,
				reject,
				promise: Promise.resolve<unknown>(undefined),
				closed: false,
			};
			scheduler.active.add(id);
			job.promise = promise.finally(() => {
				job.closed = true;
				scheduler.active.delete(id);
			});
			jobs.push(job);
			return job.promise;
		});
	});
	afterEach(async () => {
		for (const job of jobs) job.resolve();
		await Promise.allSettled(jobs.map((job) => job.promise));
		expect(jobs.every((job) => job.closed)).toBe(true);
		expect(scheduler.active.size).toBe(0);
	});
	it("L1 admits exactly the owned source asynchronously without claiming cache completion", async () => {
		const before = await snapshot();
		const response = await request("POST", "owned");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			success: true,
			message: "Sync started",
			instanceId: "owned",
		});
		expect(scheduler.triggerSync.mock.calls).toEqual([["owned"]]);
		expect(jobs.at(-1)?.closed).toBe(false);
		expect(await snapshot()).toEqual(before);
		const status = (await request("GET", "status"))
			.json()
			.instances.find((value: { instanceId: string }) => value.instanceId === "owned").syncStatus;
		expect(status).toMatchObject({
			lastFullSync: "2026-10-20T12:00:00.000Z",
			lastSyncDurationMs: 123,
			itemCount: 7,
			syncInProgress: true,
		});
	});
	it.each([
		["owned", 409],
		["foreign", 404],
		["missing", 404],
		["nonlibrary", 400],
	] as const)("L2 refuses %s with %s and zero dispatch/state writes", async (id, status) => {
		if (id === "owned") scheduler.active.add(id);
		const before = await snapshot();
		const response = await request("POST", id);
		expect(response.statusCode).toBe(status);
		expect(scheduler.triggerSync).not.toHaveBeenCalled();
		expect(await snapshot()).toEqual(before);
		scheduler.active.clear();
	});
	it("L3 handles rejected background dispatch separately from admission and remains retryable", async () => {
		const before = await snapshot();
		expect((await request("POST", "owned")).statusCode).toBe(200);
		const job = jobs.at(-1)!;
		job.reject();
		await Promise.allSettled([job.promise]);
		expect(logs.some((value) => value.msg === "Manual sync failed")).toBe(true);
		expect(await snapshot()).toEqual(before);
		expect(
			(await request("GET", "status"))
				.json()
				.instances.find((value: { instanceId: string }) => value.instanceId === "owned").syncStatus,
		).toMatchObject({
			itemCount: 7,
			lastFullSync: "2026-10-20T12:00:00.000Z",
			syncInProgress: false,
		});
		expect((await request("POST", "owned")).statusCode).toBe(200);
		expect(scheduler.triggerSync.mock.calls).toEqual([["owned"], ["owned"]]);
	});
	it("L4 creates settings, persists both interval boundaries and preserves omitted fields", async () => {
		expect(
			(
				await request("PATCH", "owned-new", { pollingEnabled: false, pollingIntervalMins: 5 })
			).json(),
		).toEqual({ success: true, settings: { pollingEnabled: false, pollingIntervalMins: 5 } });
		expect(
			await run(() =>
				native.prisma.librarySyncStatus.findUnique({ where: { instanceId: "owned-new" } }),
			),
		).toMatchObject({ pollingEnabled: false, pollingIntervalMins: 5 });
		expect(
			(await request("PATCH", "owned-new", { pollingIntervalMins: 1440 })).json().settings,
		).toEqual({ pollingEnabled: false, pollingIntervalMins: 1440 });
		expect((await request("PATCH", "owned-new", { pollingEnabled: true })).json().settings).toEqual(
			{ pollingEnabled: true, pollingIntervalMins: 1440 },
		);
		const read = (await request("GET", "status"))
			.json()
			.instances.find((value: { instanceId: string }) => value.instanceId === "owned-new");
		expect(read.syncStatus).toMatchObject({ pollingEnabled: true, pollingIntervalMins: 1440 });
		expect(scheduler.triggerSync).not.toHaveBeenCalled();
	});
	it("L4 permits settings on owned nonlibrary sources without inventing POST's service restriction", async () => {
		expect((await request("PATCH", "nonlibrary", {})).json()).toEqual({
			success: true,
			settings: { pollingEnabled: true, pollingIntervalMins: 15 },
		});
		expect(
			await run(() =>
				native.prisma.librarySyncStatus.findUnique({ where: { instanceId: "nonlibrary" } }),
			),
		).toMatchObject({ pollingEnabled: true, pollingIntervalMins: 15 });
		expect(scheduler.triggerSync).not.toHaveBeenCalled();
	});
	it.each([
		{ pollingIntervalMins: 4 },
		{ pollingIntervalMins: 1441 },
		{ pollingIntervalMins: 5.5 },
		{ pollingIntervalMins: "15" },
		{ pollingEnabled: "false" },
		{ pollingEnabled: 0 },
	])("L5 rejects invalid settings %j without writes", async (payload) => {
		const before = await snapshot();
		expect((await request("PATCH", "owned", payload)).statusCode).toBe(400);
		expect(await snapshot()).toEqual(before);
		expect(scheduler.triggerSync).not.toHaveBeenCalled();
	});
	it.each(["foreign", "missing"])("L5 refuses %s settings ownership without writes", async (id) => {
		const before = await snapshot();
		expect((await request("PATCH", id, { pollingEnabled: false })).statusCode).toBe(404);
		expect(await snapshot()).toEqual(before);
		expect(scheduler.triggerSync).not.toHaveBeenCalled();
	});
	it("L6 native upsert refusal is an honest failure and preserves persisted settings", async () => {
		const before = await snapshot(),
			fault = new Database(database);
		try {
			fault.exec(
				"CREATE TRIGGER fixture_reject_sync_settings BEFORE UPDATE ON library_sync_status WHEN OLD.instanceId = 'owned' BEGIN SELECT RAISE(ABORT, 'synthetic settings refusal'); END",
			);
		} finally {
			fault.close();
		}
		try {
			const response = await request("PATCH", "owned", {
				pollingEnabled: false,
				pollingIntervalMins: 5,
			});
			expect(response.statusCode).toBe(500);
			expect(response.json()).toEqual({ error: "Internal Server Error" });
			expect(await snapshot()).toEqual(before);
			expect(scheduler.triggerSync).not.toHaveBeenCalled();
		} finally {
			const cleanup = new Database(database);
			try {
				cleanup.exec("DROP TRIGGER fixture_reject_sync_settings");
			} finally {
				cleanup.close();
			}
		}
	});
	afterAll(async () => {
		for (const job of jobs) job.resolve();
		await Promise.allSettled(jobs.map((job) => job.promise));
		await app.close();
		await native?.close();
		await runtime?.close();
		try {
			if (!ready) return;
			const checks = [];
			for (const file of [
				database,
				`${database}.arr-restore-runtime/owner.sqlite3`,
				`${database}.arr-restore-runtime/operations.sqlite3`,
			]) {
				const db = new Database(file, { readonly: true, fileMustExist: true });
				try {
					const quick = db.pragma("quick_check"),
						fk = db.pragma("foreign_key_check");
					expect(quick).toEqual([{ quick_check: "ok" }]);
					expect(fk).toEqual([]);
					checks.push({ file, quick, fk });
				} finally {
					db.close();
				}
			}
			if (process.env.ARR_LIBRARY_SYNC_ACTIONS_EVIDENCE_ROOT)
				await writeFile(
					join(process.env.ARR_LIBRARY_SYNC_ACTIONS_EVIDENCE_ROOT, "native-library-sync.json"),
					JSON.stringify(
						{
							records,
							closure: {
								app: true,
								native: true,
								runtime: true,
								jobs: jobs.map((job) => ({ id: job.id, closed: job.closed })),
								active: scheduler.active.size,
								checks,
							},
						},
						null,
						2,
					) + "\n",
					{ flag: "wx", mode: 0o600 },
				);
		} finally {
			if (directory && !process.env.ARR_LIBRARY_SYNC_ACTIONS_EVIDENCE_ROOT)
				await rm(directory, { recursive: true });
		}
	});
});
