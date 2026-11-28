import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
} from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { synchronizeSqliteRuntimeSchema } from "../../lib/backup/runtime-schema-sqlite.js";
import { IMPORT_OBSERVATION_INTERVAL_MS } from "../../lib/arr/import-operations/scheduler.js";
import { JOB_ID, KNOWN_JOBS } from "../../lib/scheduler-registry/job-definitions.js";
import importOperationSchedulerPlugin from "../import-operation-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import { installRuntimeFixture } from "./runtime-fixture.js";

const mocks = vi.hoisted(() => ({ observe: vi.fn() }));
const apps: FastifyInstance[] = [];
vi.mock("../../lib/arr/import-operations/reconciliation.js", () => ({
	reconcileTrackedImport: mocks.observe,
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.observe.mockResolvedValue("observed");
});
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function appFixture(hasWork = false, bootstrap = false) {
	if (bootstrap) {
		vi.useRealTimers();
		vi.useFakeTimers({
			toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
	}
	const app = Fastify({ logger: false });
	apps.push(app);
	if (bootstrap) {
		const directory = mkdtempSync(join(tmpdir(), "import-bootstrap-"));
		chmodSync(directory, 0o700);
		const databaseUrl = `file:${join(directory, "fixture.db")}`;
		await synchronizeSqliteRuntimeSchema(databaseUrl);
		const runtime = await openRestoreRuntime({ databaseUrl });
		app.decorate("restoreRuntime", runtime);
		app.addHook("onClose", async () => {
			await runtime.close();
			rmSync(directory, { recursive: true, force: true });
		});
		await runtime.bindDestination("synthetic-import-bootstrap");
	} else await installRuntimeFixture(app);
	const groupBy = vi
		.fn()
		.mockResolvedValue(hasWork ? [{ userId: "owner", originalInstanceId: "connection" }] : []);
	app.decorate("prisma", {
		$queryRaw: vi.fn().mockResolvedValue([]),
		arrImportOperation: {
			groupBy,
			findFirst: vi.fn().mockResolvedValue({ id: "operation", state: "pending" }),
		},
	} as never);
	app.decorate("encryptor", {} as never);
	app.decorate("arrClientFactory", {} as never);
	for (const name of ["prisma", "security", "arr-client"])
		await app.register(fp(async () => undefined, { name }));
	let initialized: ReturnType<typeof vi.fn> | undefined;
	if (bootstrap) {
		registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
		await app.after();
		const registered: FastifyPluginAsync[] = [];
		registerSchedulers({
			register: (plugin: FastifyPluginAsync) => registered.push(plugin),
		} as never);
		const selected = registered.filter(
			(plugin) =>
				Reflect.get(plugin, Symbol.for("fastify.display-name")) === "import-operation-scheduler",
		);
		expect(selected).toHaveLength(1);
		app.register(selected[0]!);
		// Install the observer after plugin initialization, but before queued
		// readiness/activation. Do not await register and boot the app early.
		app.register(
			fp(
				async (scope) => {
					const start = scope.importOperationScheduler.start.bind(scope.importOperationScheduler);
					initialized = vi.spyOn(scope.importOperationScheduler, "start").mockImplementation(() => {
						getRestoreRuntimeClientContext(scope.restoreRuntime).assertTicket();
						start();
					});
				},
				{
					name: "synthetic-import-bootstrap-observer",
					dependencies: ["import-operation-scheduler"],
				},
			),
		);
		registerRestoreRuntimeActivation(app);
	} else {
		await app.register(schedulerRegistryPlugin);
		await app.register(importOperationSchedulerPlugin);
	}
	await app.ready();
	return { app, groupBy, initialized };
}

describe("registered import observer lifecycle", () => {
	it("has one serial job and is included in the existing scheduler bootstrap", async () => {
		expect(KNOWN_JOBS.filter((job) => job.id === JOB_ID.arrImportObservation)).toEqual([
			expect.objectContaining({
				concurrency: "serial",
				intervalMs: IMPORT_OBSERVATION_INTERVAL_MS,
			}),
		]);
		const { app, groupBy, initialized } = await appFixture(false, true);
		expect(initialized).toHaveBeenCalledOnce();
		const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
		const ticks: Promise<unknown>[] = [];
		vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
			const task = track(...args);
			if (args[0] === JOB_ID.arrImportObservation) ticks.push(task);
			return task;
		});
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS);
		expect(ticks).toHaveLength(1);
		await ticks[0];
		expect(groupBy).toHaveBeenCalledOnce();
		expect(app.schedulerRegistry.getStatus(JOB_ID.arrImportObservation)).toMatchObject({
			totalRuns: 1,
			totalFailures: 0,
			state: "idle",
		});
		await app.close();
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS);
		expect(groupBy).toHaveBeenCalledOnce();
	});

	it("wakes after five seconds, tracks ticks and cancels timers on close", async () => {
		const { app, groupBy } = await appFixture();
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS - 1);
		expect(groupBy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(groupBy).toHaveBeenCalledOnce();
		expect(app.schedulerRegistry.getStatus(JOB_ID.arrImportObservation)).toMatchObject({
			totalRuns: 1,
			state: "idle",
		});
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS);
		expect(groupBy).toHaveBeenCalledTimes(2);
		await app.close();
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS * 2);
		expect(groupBy).toHaveBeenCalledTimes(2);
	});

	it("does not query if closed before the startup timer", async () => {
		const { app, groupBy } = await appFixture();
		await app.close();
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS * 2);
		expect(groupBy).not.toHaveBeenCalled();
	});

	it("keeps close pending until the active observer settles and never starts a second tick", async () => {
		let release!: () => void;
		mocks.observe.mockReturnValue(
			new Promise((resolve) => {
				release = () => resolve("observed");
			}),
		);
		const { app, groupBy } = await appFixture(true);
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS);
		expect(mocks.observe).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS * 2);
		expect(groupBy).toHaveBeenCalledOnce();
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		await closing;
		await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS * 2);
		expect(groupBy).toHaveBeenCalledOnce();
	});

	it("does not publish private database errors in the scheduler status", async () => {
		const { app, groupBy } = await appFixture();
		try {
			groupBy.mockRejectedValue(new Error("private-sentinel-credentials-and-path"));
			await vi.advanceTimersByTimeAsync(IMPORT_OBSERVATION_INTERVAL_MS);
			expect(app.schedulerRegistry.getStatus(JOB_ID.arrImportObservation)).toMatchObject({
				totalFailures: 1,
				lastError: "Import observation is unavailable",
			});
			expect(JSON.stringify(app.schedulerRegistry.list())).not.toContain("private-sentinel");
		} finally {
			await app.close();
		}
	});
});
