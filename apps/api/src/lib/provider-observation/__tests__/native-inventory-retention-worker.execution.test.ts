import { once } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	prune: vi.fn(),
	running: false,
	starting: false,
	writeIntent: false,
	clientError: undefined as unknown,
}));
vi.mock("../../backup/restore-runtime-admission.js", () => ({
	openRestoreRuntimeWorker: mocks.open,
}));
vi.mock("../../backup/restore-runtime-client.js", () => ({
	createRuntimePrismaClient: (_runtime: unknown, options: { sqliteTransactionIntent?: string }) => {
		if (mocks.clientError) throw mocks.clientError;
		mocks.writeIntent = options.sqliteTransactionIntent === "write";
		return { prisma: { synthetic: true } };
	},
}));
vi.mock("../native-inventory-retention.js", () => ({
	pruneNativeInventoryRetentionSlice: mocks.prune,
}));

import { executeNativeInventoryRetentionSlice } from "../native-inventory-retention-worker.js";
import {
	createNativeInventoryRetentionWorker,
	nativeInventoryRetentionWorkerUrl,
} from "../native-inventory-retention-worker-transport.js";

const payload = {
	databaseUrl: "file:/synthetic/fixture.db",
	cutoff: new Date("2026-10-01T00:00:00Z"),
	rowLimit: 500,
	scanLimit: 10,
	cursor: { id: "synthetic-cursor" },
	runtimeBinding: { record: { phase: "running" } },
};
const slice = { deletedRows: 2, deletedRuns: 1, scannedRuns: 1, nextCursor: null, hasMore: false };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.running = false;
	mocks.starting = false;
	mocks.writeIntent = false;
	mocks.clientError = undefined;
	mocks.open.mockResolvedValue({
		close: mocks.close,
		runOperation: async (operation: () => Promise<unknown>) => {
			mocks.running = true;
			return operation();
		},
		runStarting: async (operation: () => Promise<unknown>) => {
			mocks.starting = true;
			return operation();
		},
	});
	mocks.close.mockResolvedValue(undefined);
	mocks.prune.mockImplementation(async () => {
		if (!mocks.writeIntent || (!mocks.running && !mocks.starting))
			throw new Error("Missing mutation admission");
		return slice;
	});
});

describe("native retention follower execution", () => {
	it("posts sanitized runtime-open provenance from the real source worker before physical exit", async () => {
		// An incomplete binding is refused before filesystem/client admission.
		const worker = createNativeInventoryRetentionWorker(
			nativeInventoryRetentionWorkerUrl(),
			payload as never,
			[],
		);
		worker.stdout?.resume();
		worker.stderr?.resume();
		try {
			const message = once(worker, "message");
			const exit = once(worker, "exit");
			expect(await message).toEqual([
				{ status: "failed", failurePhase: "runtime-open", failureCode: "unknown" },
			]);
			expect(await exit).toEqual([0]);
		} finally {
			await worker.terminate();
		}
	});
	it("opens a write-intent client under its follower ticket and preserves the bounded slice", async () => {
		expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({
			status: "completed",
			...slice,
		});
		expect(mocks.prune).toHaveBeenCalledWith({ synthetic: true }, payload.cutoff, {
			rowLimit: 500,
			scanLimit: 10,
			cursor: payload.cursor,
			signal: undefined,
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("supports the existing starting-runtime worker admission", async () => {
		expect(
			await executeNativeInventoryRetentionSlice({
				...payload,
				runtimeBinding: { record: { phase: "starting" } },
			}),
		).toEqual({ status: "completed", ...slice });
		expect(mocks.starting).toBe(true);
		expect(mocks.running).toBe(false);
	});
	it("pre-abort and invalid requests perform no follower admission or writes", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(
			await executeNativeInventoryRetentionSlice(payload, { signal: controller.signal }),
		).toEqual({ status: "cancelled" });
		expect(await executeNativeInventoryRetentionSlice({ ...payload, rowLimit: 501 })).toEqual({
			status: "failed",
		});
		expect(mocks.open).not.toHaveBeenCalled();
		expect(mocks.prune).not.toHaveBeenCalled();
	});
	it("cancellation at follower admission closes without entering mutation", async () => {
		const controller = new AbortController();
		const actualOpen = mocks.open.getMockImplementation()!;
		mocks.open.mockImplementationOnce(async () => {
			const runtime = await actualOpen();
			controller.abort();
			return runtime;
		});
		expect(
			await executeNativeInventoryRetentionSlice(payload, { signal: controller.signal }),
		).toEqual({ status: "cancelled" });
		expect(mocks.prune).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("preserves completed accounting when cancellation occurs inside entered work", async () => {
		const controller = new AbortController();
		mocks.prune.mockImplementationOnce(async () => {
			controller.abort();
			return slice;
		});
		expect(
			await executeNativeInventoryRetentionSlice(payload, { signal: controller.signal }),
		).toEqual({ status: "completed", ...slice });
	});
	it("retains provisional success until runtime physical closure finishes", async () => {
		let release!: () => void;
		mocks.close.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		let settled = false;
		const pending = executeNativeInventoryRetentionSlice(payload).finally(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		release();
		expect(await pending).toEqual({ status: "completed", ...slice });
	});
	it("sanitizes database failures and still closes the follower", async () => {
		mocks.prune.mockRejectedValueOnce(new Error("synthetic-private-database-error"));
		expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({
			status: "failed",
			failurePhase: "retention",
			failureCode: "unknown",
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it.each(["runtime-open", "client-create", "retention"])(
		"reports only the fixed %s phase and code",
		async (phase) => {
			const error = Object.assign(new Error("synthetic-private-error"), {
				code: "P2028",
				cause: "synthetic-private-cause",
			});
			if (phase === "runtime-open") mocks.open.mockRejectedValueOnce(error);
			if (phase === "client-create") mocks.clientError = error;
			if (phase === "retention") mocks.prune.mockRejectedValueOnce(error);
			expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({
				status: "failed",
				failurePhase: phase,
				failureCode: "P2028",
			});
		},
	);
	it("does not read error getters or inherit a private error code", async () => {
		const getter = vi.fn(() => {
			throw new Error("synthetic-private-getter");
		});
		mocks.prune.mockRejectedValueOnce(Object.defineProperty({}, "code", { get: getter }));
		expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({
			status: "failed",
			failurePhase: "retention",
			failureCode: "unknown",
		});
		expect(getter).not.toHaveBeenCalled();
		mocks.prune.mockRejectedValueOnce(Object.create({ code: "SQLITE_BUSY" }));
		expect(await executeNativeInventoryRetentionSlice(payload)).toMatchObject({
			failureCode: "unknown",
		});
	});
	it.each([
		"P1008",
		"P2024",
		"P2028",
		"P2034",
		"SQLITE_BUSY",
		"SQLITE_BUSY_SNAPSHOT",
		"SQLITE_LOCKED",
		"synthetic-private-code",
	])("projects only known own error code %s", async (code) => {
		mocks.prune.mockRejectedValueOnce({ code });
		expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({
			status: "failed",
			failurePhase: "retention",
			failureCode: code === "synthetic-private-code" ? "unknown" : code,
		});
	});
	it("preserves the retention failure when physical closure also fails and still rejects", async () => {
		mocks.prune.mockRejectedValueOnce({ code: "P2028", message: "synthetic-private-error" });
		mocks.close.mockRejectedValueOnce({ code: "SQLITE_BUSY", message: "synthetic-private-close" });
		await expect(executeNativeInventoryRetentionSlice(payload)).rejects.toMatchObject({
			failurePhase: "retention",
			failureCode: "P2028",
			message: "Native inventory retention worker failed",
		});
	});
	it("does not turn failed physical closure into successful accounting", async () => {
		mocks.close.mockRejectedValueOnce(new Error("synthetic-close-refused"));
		await expect(executeNativeInventoryRetentionSlice(payload)).rejects.toMatchObject({
			failurePhase: "runtime-close",
			failureCode: "unknown",
			message: "Native inventory retention worker failed",
		});
	});
});
