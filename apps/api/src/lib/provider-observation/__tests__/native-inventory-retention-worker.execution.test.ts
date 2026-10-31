import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	prune: vi.fn(),
	running: false,
	starting: false,
	writeIntent: false,
}));
vi.mock("../../backup/restore-runtime-admission.js", () => ({
	openRestoreRuntimeWorker: mocks.open,
}));
vi.mock("../../backup/restore-runtime-client.js", () => ({
	createRuntimePrismaClient: (_runtime: unknown, options: { sqliteTransactionIntent?: string }) => {
		mocks.writeIntent = options.sqliteTransactionIntent === "write";
		return { prisma: { synthetic: true } };
	},
}));
vi.mock("../native-inventory-retention.js", () => ({
	pruneNativeInventoryRetentionSlice: mocks.prune,
}));

import { executeNativeInventoryRetentionSlice } from "../native-inventory-retention-worker.js";

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
		expect(await executeNativeInventoryRetentionSlice(payload)).toEqual({ status: "failed" });
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("does not turn failed physical closure into successful accounting", async () => {
		mocks.close.mockRejectedValueOnce(new Error("synthetic-close-refused"));
		await expect(executeNativeInventoryRetentionSlice(payload)).rejects.toThrow(
			"synthetic-close-refused",
		);
	});
});
