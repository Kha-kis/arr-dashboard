import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { MessageChannel, Worker } from "node:worker_threads";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import * as retentionTransport from "../../lib/provider-observation/native-inventory-retention-worker-transport.js";
import { readNativeInventoryDisplayPage } from "../../lib/provider-observation/native-inventory.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import scheduler from "../native-inventory-scheduler.js";
import registry from "../scheduler-registry.js";

// Timer scheduling, retention workers, native runtime admission, the registry,
// and SQLite mutations remain real. One test holds only the worker's final exit.
const provider = vi.hoisted(() => ({ schedule: vi.fn(), work: vi.fn() }));
vi.mock("../../lib/provider-observation/native-inventory-job-orchestration.js", () => ({
	NATIVE_INVENTORY_REFRESH_INTERVAL_MS: 30 * 60_000,
	schedulePeriodicNativeInventoryWork: provider.schedule,
	runDueNativeInventoryWork: provider.work,
}));

const RETENTION_JOB = "native-inventory-retention";
const OLD = new Date("2026-10-10T06:00:00Z");
const NEWER = new Date("2026-10-11T06:00:00Z");
type Client = ReturnType<typeof createTestPrismaClient>;
let templateDirectory: string;
let template: string;
const releases: Array<() => void> = [];
const cleanup: Array<() => Promise<void>> = [];
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function until(condition: () => boolean, budget = 4_000) {
	const started = performance.now();
	while (!condition() && performance.now() - started < budget) await pause(5);
}
async function counts(prisma: Client) {
	return Promise.all([
		prisma.providerNativeInventoryStageItem.count(),
		prisma.providerNativeInventorySeenItem.count(),
		prisma.providerNativeInventoryPageReceipt.count(),
		prisma.providerNativeInventoryPass.count(),
		prisma.providerNativeInventoryRun.count(),
	]);
}
async function protectedRows(prisma: Client) {
	return Promise.all([
		prisma.user.findMany({ orderBy: { id: "asc" } }),
		prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }),
		prisma.providerNativeInventoryRun.findMany({
			where: { id: { not: "obsolete" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventoryPass.findMany({
			where: { runId: { not: "obsolete" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventoryStageItem.findMany({
			where: { passId: { not: "obsolete-pass" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventorySeenItem.findMany({
			where: { passId: { not: "obsolete-pass" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventoryPageReceipt.findMany({
			where: { passId: { not: "obsolete-pass" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventorySnapshot.findMany({ orderBy: { id: "asc" } }),
		prisma.providerNativeInventoryItem.findMany({ orderBy: { id: "asc" } }),
	]);
}
async function seed(prisma: Client, children: number) {
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	for (const id of ["drain", "published", "active", "latest", "positive"]) {
		await prisma.serviceInstance.create({
			data: {
				id,
				userId: "owner",
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "http://fixture.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
				connectionGeneration: 2,
				identityGeneration: 3,
				expectedIdentity: "synthetic-id",
				identityStatus: "VERIFIED",
				identityKind: "JELLYFIN_SERVER_ID",
				identityVerifiedAt: OLD,
			},
		});
	}
	for (const data of [
		{
			id: "obsolete",
			instanceId: "drain",
			workKey: "library",
			state: "incomplete",
			createdAt: OLD,
		},
		{
			id: "drain-latest",
			instanceId: "drain",
			workKey: "library",
			state: "pending",
			createdAt: NEWER,
		},
		{
			id: "published",
			instanceId: "published",
			workKey: "paired",
			state: "published",
			createdAt: OLD,
		},
		{
			id: "active",
			instanceId: "active",
			workKey: "library",
			state: "running",
			createdAt: OLD,
			activeSlotKey: "active",
			claimToken: "synthetic-claim",
			leaseUntil: NEWER,
		},
		{ id: "latest", instanceId: "latest", workKey: "library", state: "incomplete", createdAt: OLD },
		{
			id: "positive",
			instanceId: "positive",
			workKey: "episode",
			state: "incomplete",
			createdAt: OLD,
		},
		{
			id: "positive-latest",
			instanceId: "positive",
			workKey: "episode",
			state: "pending",
			createdAt: NEWER,
		},
	])
		await prisma.providerNativeInventoryRun.create({
			data: { ...data, updatedAt: OLD, connectionGeneration: 2, identityGeneration: 3 },
		});
	for (const [id, runId, ordinal] of [
		["obsolete-pass", "obsolete", 1],
		["published-one", "published", 1],
		["published-two", "published", 2],
		["active-pass", "active", 1],
		["latest-pass", "latest", 1],
		["positive-pass", "positive", 1],
	] as const) {
		const positive = id === "positive-pass";
		await prisma.providerNativeInventoryPass.create({
			data: {
				id,
				runId,
				ordinal,
				...(positive
					? {
							state: "complete",
							completedAt: OLD,
							episodeItemCount: 1,
							scopeManifest: '[{"domain":"episode","scopeKeys":["scope"]}]',
							scopeDigest: "a".repeat(64),
							comparisonDigest: "b".repeat(64),
						}
					: {}),
			},
		});
		if (runId !== "obsolete") {
			await prisma.providerNativeInventoryStageItem.create({
				data: {
					id: `${id}-item`,
					passId: id,
					domain: positive ? "episode" : "library",
					nativeId: "same-native-id",
					mediaType: positive ? "episode" : "movie",
					libraryIds: '["scope"]',
					...(positive ? { parentNativeId: "show", seasonNumber: 1, episodeNumber: 1 } : {}),
				},
			});
			await prisma.providerNativeInventorySeenItem.create({
				data: {
					id: `${id}-seen`,
					passId: id,
					domain: positive ? "episode" : "library",
					scopeKey: "scope",
					nativeId: "same-native-id",
				},
			});
		}
		await prisma.providerNativeInventoryPageReceipt.create({
			data: {
				id: `${id}-receipt`,
				passId: id,
				domain: "library",
				scopeKey: "scope",
				pageKey: "0",
				startIndex: 0,
				isLast: true,
				expectedRawCount: 1,
				rawCount: 1,
				rowCount: 1,
				contentHash: "b".repeat(64),
			},
		});
	}
	await prisma.providerNativeInventorySnapshot.create({
		data: {
			id: "published-head",
			instanceId: "published",
			domain: "library",
			publishedPassId: "published-two",
			connectionGeneration: 2,
			identityGeneration: 3,
			observedAt: OLD,
		},
	});
	await prisma.providerNativeInventoryItem.create({
		data: {
			id: "current",
			snapshotId: "published-head",
			nativeId: "same-native-id",
			mediaType: "movie",
			libraryIds: '["scope"]',
		},
	});
	for (let start = 0; start < children; start += 250) {
		const rows = Array.from({ length: Math.min(250, children - start) }, (_, i) => `${start + i}`);
		await prisma.providerNativeInventoryStageItem.createMany({
			data: rows.map((id) => ({
				id: `item-${id}`,
				passId: "obsolete-pass",
				domain: "library",
				nativeId: id,
				mediaType: "movie",
				libraryIds: '["scope"]',
			})),
		});
		await prisma.providerNativeInventorySeenItem.createMany({
			data: rows.map((id) => ({
				id: `seen-${id}`,
				passId: "obsolete-pass",
				domain: "library",
				scopeKey: "scope",
				nativeId: id,
			})),
		});
	}
}
async function fixture(
	journal: "delete" | "wal",
	children = 6_001,
	transactionGate?: ReturnType<typeof deferred>,
) {
	const directory = mkdtempSync(join(tmpdir(), "native-retention-clock-"));
	chmodSync(directory, 0o700);
	const path = join(directory, "fixture.db");
	copyFileSync(template, path);
	chmodSync(path, 0o600);
	const prisma = createTestPrismaClient(path);
	await prisma.$queryRawUnsafe(`PRAGMA journal_mode=${journal}`);
	await seed(prisma, children);
	const conserved = await protectedRows(prisma);
	const input = {
		userId: "owner",
		instanceId: "positive",
		domain: "episode" as const,
		now: new Date(),
	};
	const display = await readNativeInventoryDisplayPage(prisma, input);
	expect(display.status).toBe("available");
	const messages: Record<string, unknown>[] = [];
	const app = Fastify({
		logger: {
			stream: new Writable({
				write(chunk, _encoding, done) {
					messages.push(JSON.parse(String(chunk)));
					done();
				},
			}),
		},
	});
	const state = { workers: 0, liveWorkers: 0, teardown: false };
	const entered = deferred();
	if (transactionGate) {
		const run = retentionTransport.runNativeInventoryRetentionWorker;
		vi.spyOn(retentionTransport, "runNativeInventoryRetentionWorker").mockImplementation(
			(payload, options) =>
				run(payload, {
					...options,
					createWorker: (url, workerData, transferList) => {
						const { port1, port2 } = new MessageChannel();
						// Keep a real thread alive after its production result, without
						// delaying/altering SQL, runtime closure, or the result message.
						const bootstrap = `const { workerData } = require("node:worker_threads");
				const hold = setInterval(() => {}, 1000);
				workerData.exitGate.on("message", () => { clearInterval(hold); workerData.exitGate.close(); });
				(async () => { const { register } = await import("tsx/esm/api"); register();
				await import(${JSON.stringify(url.href)}); })().catch(() => { process.exitCode = 1; clearInterval(hold); workerData.exitGate.close(); });`;
						const worker = new Worker(bootstrap, {
							eval: true,
							execArgv: [],
							env: {},
							stdout: true,
							stderr: true,
							workerData: { ...workerData, exitGate: port2 },
							transferList: [...transferList, port2],
						});
						state.workers++;
						state.liveWorkers++;
						worker.on("message", () => entered.resolve());
						worker.once("exit", () => {
							state.liveWorkers--;
							expect(state.teardown).toBe(false);
							port1.close();
						});
						void transactionGate.promise.then(() => port1.postMessage("release"));
						return worker;
					},
				}),
		);
	}
	cleanup.push(async () => {
		await app.close();
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	});
	// The worker's runtime proof and application rows must name this same file.
	const runtime = await openRestoreRuntime({ databaseUrl: `file:${path}` });
	await runtime.bindDestination("synthetic-retention-destination");
	await runtime.activate();
	app.decorate("restoreRuntime", runtime);
	app.decorate("config", { DATABASE_URL: `file:${path}` } as never);
	app.addHook("onClose", async () => {
		await runtime.close();
	});
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.addHook("onClose", async () => {
					expect(state.liveWorkers).toBe(0);
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", {} as never);
			},
			{ name: "security" },
		),
	);
	await app.register(registry);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const timeouts = vi.spyOn(globalThis, "setTimeout"),
		intervals = vi.spyOn(globalThis, "setInterval");
	await app.register(scheduler);
	await app.ready();
	const startupIndex = timeouts.mock.calls.findIndex(([, ms]) => ms === 30_000);
	const start = () => {
		clearTimeout(timeouts.mock.results[startupIndex]?.value);
		const fn = timeouts.mock.calls[startupIndex]?.[0];
		if (typeof fn !== "function") throw new Error("Startup callback missing");
		fn();
	};
	const interval = () => {
		const fn = intervals.mock.calls.find(([, ms]) => ms === 5_000)?.[0];
		if (typeof fn !== "function") throw new Error("Retention interval missing");
		fn();
	};
	async function idle() {
		await until(
			() =>
				app.schedulerRegistry.getStatus(JOB_ID.nativeInventory)?.state === "idle" &&
				(!app.schedulerRegistry.getStatus(RETENTION_JOB) ||
					app.schedulerRegistry.getStatus(RETENTION_JOB)?.state === "idle"),
		);
	}
	async function drain() {
		for (let tick = 0; tick < 20; tick++) {
			await until(() => app.schedulerRegistry.getStatus(RETENTION_JOB)?.state === "idle", 10_000);
			expect(app.schedulerRegistry.getStatus(RETENTION_JOB)?.state).toBe("idle");
			if (!(await prisma.providerNativeInventoryRun.findUnique({ where: { id: "obsolete" } })))
				return;
			interval();
		}
		throw new Error("Synthetic retention did not drain within bounded ticks");
	}
	async function checkProtected() {
		expect(await protectedRows(prisma)).toEqual(conserved);
		expect(await readNativeInventoryDisplayPage(prisma, input)).toEqual(display);
		expect(await prisma.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
		expect(await prisma.$queryRawUnsafe("PRAGMA integrity_check")).toEqual([
			{ integrity_check: "ok" },
		]);
	}
	return { app, prisma, start, interval, idle, drain, checkProtected, messages, state, entered };
}
beforeAll(() => {
	templateDirectory = mkdtempSync(join(tmpdir(), "native-retention-template-"));
	template = join(templateDirectory, "template.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${template}` },
		stdio: "pipe",
	});
}, 30_000);
beforeEach(() => {
	provider.schedule.mockReset().mockResolvedValue(undefined);
	provider.work.mockReset().mockResolvedValue({ completed: 0 });
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(() => rmSync(templateDirectory, { recursive: true, force: true }));

describe("independent native retention with real SQLite and registry", () => {
	for (const journal of ["delete", "wal"] as const) {
		it(`${journal}: drains while an accepted provider tick remains held`, async () => {
			const providerGate = deferred(),
				providerEntered = deferred();
			provider.work.mockImplementation(async () => {
				providerEntered.resolve();
				await providerGate.promise;
				return { completed: 0 };
			});
			const f = await fixture(journal, 3);
			f.start();
			await providerEntered.promise;
			await until(() => f.messages.some((row) => row.category === "native-inventory-retention"));
			await f.drain();
			expect(f.app.schedulerRegistry.getStatus(JOB_ID.nativeInventory)?.state).toBe("running");
			expect(
				await f.prisma.providerNativeInventoryRun.findUnique({ where: { id: "obsolete" } }),
			).toBeNull();
			expect(f.app.schedulerRegistry.getStatus(RETENTION_JOB)).toMatchObject({
				concurrency: "serial",
				intervalMs: 5_000,
				totalRuns: 1,
				totalFailures: 0,
			});
			await f.checkProtected();
		});
		it(`${journal}: drains over ten thousand physical rows across bounded worker ticks`, async () => {
			const f = await fixture(journal),
				before = await counts(f.prisma);
			const started = performance.now();
			f.start();
			await f.drain();
			const elapsedMs = performance.now() - started;
			const after = await counts(f.prisma);
			expect(
				await f.prisma.providerNativeInventoryRun.findUnique({ where: { id: "obsolete" } }),
			).toBeNull();
			expect(before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0)).toBe(12_005);
			const receipts = f.messages.filter((row) => row.category === "native-inventory-retention");
			expect(receipts.reduce((sum, row) => sum + Number(row.deletedRows), 0)).toBe(12_005);
			expect(receipts.reduce((sum, row) => sum + Number(row.deletedRuns), 0)).toBe(1);
			process.stdout.write(
				`${JSON.stringify({
					category: "synthetic-retention-throughput",
					journal,
					deletedRows: 12_005,
					ticks: receipts.length,
					elapsedMs: Math.round(elapsedMs),
					rowsPerSecond: Math.round(12_005_000 / elapsedMs),
				})}\n`,
			);
			f.interval();
			await f.idle();
			expect(await counts(f.prisma)).toEqual(after);
			expect(
				f.messages.filter((row) => row.category === "native-inventory-retention").at(-1),
			).toMatchObject({ deletedRows: 0, deletedRuns: 0 });
			await f.checkProtected();
		}, 60_000);
	}
	it("records real SQLite rollback as a sanitized retention failure and retries honestly", async () => {
		const f = await fixture("delete", 3),
			before = await counts(f.prisma);
		await f.prisma.$executeRawUnsafe(`CREATE TRIGGER synthetic_retention_failure BEFORE DELETE ON provider_native_inventory_stage_items
			WHEN OLD.passId='obsolete-pass' BEGIN SELECT RAISE(ABORT, 'synthetic-private-retention-detail'); END`);
		f.start();
		await f.idle();
		// Fallback observes the old provider job's false-success ledger on RED.
		const status =
			f.app.schedulerRegistry.getStatus(RETENTION_JOB) ??
			f.app.schedulerRegistry.getStatus(JOB_ID.nativeInventory);
		expect(status).toMatchObject({
			totalFailures: 1,
			lastSuccessAt: null,
			lastError: "Native inventory retention failed",
		});
		expect(JSON.stringify(f.messages) + JSON.stringify(status)).not.toContain(
			"synthetic-private-retention-detail",
		);
		expect(await counts(f.prisma)).toEqual(before);
		await f.prisma.$executeRawUnsafe("DROP TRIGGER synthetic_retention_failure");
		f.interval();
		await f.idle();
		expect(f.app.schedulerRegistry.getStatus(RETENTION_JOB)).toMatchObject({
			totalRuns: 2,
			totalFailures: 1,
			consecutiveFailures: 0,
			lastError: null,
		});
		expect(
			await f.prisma.providerNativeInventoryRun.findUnique({ where: { id: "obsolete" } }),
		).toBeNull();
		await f.checkProtected();
	});
	it("serializes retention and physically joins both accepted promises before teardown", async () => {
		const transactionGate = deferred(),
			providerGate = deferred(),
			providerEntered = deferred();
		provider.work.mockImplementation(async () => {
			providerEntered.resolve();
			await providerGate.promise;
			return { completed: 0 };
		});
		const f = await fixture("wal", 3, transactionGate);
		f.start();
		await providerEntered.promise;
		await until(() => f.state.liveWorkers === 1);
		expect(f.state.liveWorkers).toBe(1);
		await f.entered.promise;
		f.interval();
		f.interval();
		await pause(10);
		expect(f.state.workers).toBe(1);
		await expect(
			f.app.schedulerRegistry.track(RETENTION_JOB, async () => "overlap"),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(withCleanupMaintenanceGuard(async () => "overlap")).rejects.toMatchObject({
			statusCode: 409,
		});
		let closed = false;
		const closing = f.app.close().then(() => {
			closed = true;
		});
		await pause(10);
		expect(closed).toBe(false);
		expect(f.state.teardown).toBe(false);
		providerGate.resolve();
		await pause(10);
		expect(closed).toBe(false);
		expect(f.state.teardown).toBe(false);
		transactionGate.resolve();
		await closing;
		expect(f.state.liveWorkers).toBe(0);
		expect(f.state.teardown).toBe(true);
		expect(await withCleanupMaintenanceGuard(async () => "idle")).toBe("idle");
		const workers = f.state.workers;
		f.interval();
		f.start();
		await pause(10);
		expect(f.state.workers).toBe(workers);
		await f.checkProtected();
	});
});
