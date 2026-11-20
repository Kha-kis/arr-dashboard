import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import {
	withCleanupMaintenanceGuard,
	withExclusiveCleanupOperationGuard,
} from "../../../library-cleanup/cleanup-maintenance-gate.js";
import { IMPORT_OBSERVATION_FAILURE, ImportOperationScheduler } from "../scheduler.js";

const mocks = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock("../reconciliation.js", () => ({ reconcileTrackedImport: mocks.observe }));

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let sequence = 0;
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-scheduler-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${databasePath}`);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner-a", username: "synthetic-a" },
			{ id: "owner-b", username: "synthetic-b" },
		],
	});
	sequence = 0;
	vi.clearAllMocks();
	mocks.observe.mockImplementation(async (_context, userId: string, id: string) => {
		await prisma.arrImportOperation.updateMany({
			where: { userId, id },
			data: { lastCheckedAt: new Date(), nextCheckAt: new Date(Date.now() + 60_000) },
		});
		return "observed";
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function operation(
	instanceId = "instance-a",
	userId = "owner-a",
	data: Record<string, unknown> = {},
) {
	const index = ++sequence;
	await prisma.serviceInstance.upsert({
		where: { id: instanceId },
		create: {
			id: instanceId,
			userId,
			service: "RADARR",
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
		update: {},
	});
	return prisma.arrImportOperation.create({
		data: {
			id: `operation-${index}`,
			userId,
			instanceId,
			originalInstanceId: instanceId,
			connectionFingerprint: "synthetic-binding",
			service: "RADARR",
			origin: "manual",
			mode: "Move",
			idempotencyKey: `intent-${index}`,
			requestFingerprint: "synthetic-request",
			commandFingerprint: "synthetic-command",
			encryptedSources: "private-sentinel-cipher",
			sourcesEncryptionIv: "private-sentinel-iv",
			selectedFileCount: 1,
			state: "pending",
			preparationExpiresAt: new Date(Date.now() - 10_000),
			submissionStartedAt: new Date(Date.now() - 15_000),
			createdAt: new Date(Date.now() - 20_000 + index),
			...data,
		},
	});
}

function scheduler(trackTick = vi.fn(async (fn: () => Promise<void>) => fn())) {
	const createClient = vi.fn(() => {
		throw new Error("Selection tests must not construct a provider client");
	});
	return {
		worker: new ImportOperationScheduler(
			{ prisma, encryptor: { decrypt: vi.fn(), encrypt: vi.fn() }, createClient },
			log as never,
			{ trackTick: trackTick as never },
		),
		trackTick,
		createClient,
	};
}

describe("bounded import scheduler on real SQLite", () => {
	it("selects one operation per owned connection, not one raw capped list", async () => {
		for (let index = 0; index < 40; index++) await operation();
		await operation("instance-b");
		await operation("instance-c", "owner-b");
		const { worker } = scheduler();
		await worker.tick();
		expect(mocks.observe.mock.calls.map(([, owner, id]) => [owner, id])).toEqual([
			["owner-a", "operation-1"],
			["owner-a", "operation-41"],
			["owner-b", "operation-42"],
		]);
		const projection = vi.spyOn(prisma.arrImportOperation, "findFirst");
		await worker.tick();
		for (const [args] of projection.mock.calls) {
			expect(args?.where).toMatchObject({ userId: expect.any(String) });
			expect(args?.select).toEqual({ id: true, state: true });
		}
	});

	it("rotates a bounded connection page and wraps instead of starving later connections", async () => {
		for (let index = 0; index < 7; index++) {
			await operation(`instance-${index}`);
			await operation(`instance-${index}`);
		}
		const { worker } = scheduler();
		await worker.tick();
		expect(mocks.observe).toHaveBeenCalledTimes(4);
		await worker.tick();
		expect(mocks.observe).toHaveBeenCalledTimes(7);
		await worker.tick();
		expect(mocks.observe).toHaveBeenCalledTimes(11);
		expect(mocks.observe.mock.calls.map(([, , id]) => id)).toEqual([
			"operation-1",
			"operation-3",
			"operation-5",
			"operation-7",
			"operation-9",
			"operation-11",
			"operation-13",
			"operation-2",
			"operation-4",
			"operation-6",
			"operation-8",
		]);
	});

	it("skips not-due, live or malformed leases and unsupported states", async () => {
		await operation("future", "owner-a", { nextCheckAt: new Date(Date.now() + 60_000) });
		await operation("live", "owner-a", {
			reconcileToken: "live",
			reconcileExpiresAt: new Date(Date.now() + 60_000),
		});
		await operation("malformed", "owner-a", { reconcileToken: "orphan", reconcileExpiresAt: null });
		await operation("completed", "owner-a", { state: "completed" });
		await operation("future-state", "owner-a", { state: "future-state" });
		await operation("never-started", "owner-a", { submissionStartedAt: null });
		const due = await operation("expired", "owner-b", {
			reconcileToken: "expired",
			reconcileExpiresAt: new Date(Date.now() - 1000),
		});
		await scheduler().worker.tick();
		expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "owner-b", due.id);
	});

	it("atomically cancels only expired, proved-unsubmitted preparations and retains history", async () => {
		const expired = await operation("expired", "owner-a", {
			state: "preparing",
			submissionStartedAt: null,
		});
		await prisma.arrImportSourceClaim.create({
			data: { userId: "owner-a", downloadKey: "synthetic-source", activeOperationId: expired.id },
		});
		const live = await operation("live", "owner-a", {
			state: "preparing",
			submissionStartedAt: null,
			preparationExpiresAt: new Date(Date.now() + 60_000),
		});
		const marked = await operation("marked", "owner-a", { state: "preparing" });
		await scheduler().worker.tick();
		expect(mocks.observe).not.toHaveBeenCalled();
		expect(
			await prisma.arrImportOperation.findFirst({ where: { userId: "owner-a", id: expired.id } }),
		).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
		expect(
			await prisma.arrImportSourceClaim.findFirst({ where: { userId: "owner-a" } }),
		).toMatchObject({ activeOperationId: null });
		for (const id of [live.id, marked.id]) {
			expect(
				await prisma.arrImportOperation.findFirst({ where: { userId: "owner-a", id } }),
			).toMatchObject({ state: "preparing" });
		}
	});

	it("isolates provider failures, rotates the failed connection and reports only a generic error", async () => {
		const first = await operation();
		const second = await operation("instance-b");
		mocks.observe.mockRejectedValueOnce(new Error("private-sentinel-path-token-title"));
		await expect(scheduler().worker.tick()).rejects.toThrow(IMPORT_OBSERVATION_FAILURE);
		expect(mocks.observe.mock.calls.map(([, , id]) => id)).toEqual([first.id, second.id]);
		expect(
			JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
		).not.toContain("private-sentinel");
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({ failedCount: 1 }),
			expect.any(String),
		);
	});

	it("holds one in-flight tick, waits on stop and starts no further connections", async () => {
		await operation();
		await operation("instance-b");
		let release!: () => void;
		const pending = new Promise<string>((resolve) => {
			release = () => resolve("observed");
		});
		mocks.observe.mockReturnValueOnce(pending);
		const { worker, trackTick } = scheduler();
		const first = worker.tick();
		await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledOnce());
		const second = worker.tick();
		let stopped = false;
		const stop = worker.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		expect(trackTick).toHaveBeenCalledOnce();
		await expect(withExclusiveCleanupOperationGuard(async () => undefined)).rejects.toThrow();
		release();
		await Promise.all([first, second, stop]);
		expect(stopped).toBe(true);
		expect(mocks.observe).toHaveBeenCalledOnce();
		await worker.tick();
		expect(mocks.observe).toHaveBeenCalledOnce();
		await withExclusiveCleanupOperationGuard(async () => undefined);
	});

	it("a fresh scheduler resumes persisted due work after reconnect without submitting", async () => {
		const due = await operation();
		await prisma.$disconnect();
		await prisma.$connect();
		const { worker, createClient } = scheduler();
		await worker.tick();
		expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "owner-a", due.id);
		expect(createClient).not.toHaveBeenCalled();
	});

	it("honors maintenance before any selection or recovery writes", async () => {
		await operation("expired", "owner-a", { state: "preparing", submissionStartedAt: null });
		const query = vi.spyOn(prisma.arrImportOperation, "groupBy");
		await withCleanupMaintenanceGuard(async () => {
			await expect(scheduler().worker.tick()).rejects.toThrow();
		});
		expect(query).not.toHaveBeenCalled();
		expect(mocks.observe).not.toHaveBeenCalled();
	});
});
