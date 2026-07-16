import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RuntimeLeaseConflictError,
	RuntimeLeaseManager,
	type RuntimeLeaseStore,
} from "../runtime-lease.js";

function createStore(): RuntimeLeaseStore {
	return {
		runtimeLease: {
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			create: vi.fn().mockImplementation(async ({ data }) => data),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
}

const log = {
	warn: vi.fn(),
} as unknown as FastifyBaseLogger;

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("RuntimeLeaseManager", () => {
	it("creates the singleton lease when no row exists", async () => {
		const store = createStore();
		const now = new Date("2026-07-16T12:00:00.000Z");
		const lease = new RuntimeLeaseManager(store, log, {
			ownerId: "owner-a",
			now: () => now,
		});

		await lease.acquire();

		expect(store.runtimeLease.create).toHaveBeenCalledWith({
			data: {
				name: "active-api",
				ownerId: "owner-a",
				acquiredAt: now,
				heartbeatAt: now,
			},
		});
	});

	it("reclaims an expired lease atomically without creating a second row", async () => {
		const store = createStore();
		vi.mocked(store.runtimeLease.updateMany).mockResolvedValueOnce({ count: 1 });
		const now = new Date("2026-07-16T12:00:00.000Z");
		const lease = new RuntimeLeaseManager(store, log, {
			ownerId: "owner-b",
			ttlMs: 90_000,
			now: () => now,
		});

		await lease.acquire();

		expect(store.runtimeLease.updateMany).toHaveBeenCalledWith({
			where: {
				name: "active-api",
				OR: [{ ownerId: "owner-b" }, { heartbeatAt: { lt: new Date("2026-07-16T11:58:30.000Z") } }],
			},
			data: { ownerId: "owner-b", acquiredAt: now, heartbeatAt: now },
		});
		expect(store.runtimeLease.create).not.toHaveBeenCalled();
	});

	it("rejects a second live owner", async () => {
		const store = createStore();
		vi.mocked(store.runtimeLease.create).mockRejectedValueOnce({ code: "P2002" });
		const lease = new RuntimeLeaseManager(store, log, { ownerId: "owner-b" });

		await expect(lease.acquire()).rejects.toBeInstanceOf(RuntimeLeaseConflictError);
	});

	it("renews a held lease and releases only its own row", async () => {
		vi.useFakeTimers();
		const store = createStore();
		vi.mocked(store.runtimeLease.updateMany)
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });
		const lease = new RuntimeLeaseManager(store, log, {
			ownerId: "owner-a",
			heartbeatMs: 1_000,
		});
		await lease.acquire();
		lease.start(vi.fn());

		await vi.advanceTimersByTimeAsync(1_000);
		await lease.release();

		expect(store.runtimeLease.updateMany).toHaveBeenLastCalledWith({
			where: { name: "active-api", ownerId: "owner-a" },
			data: { heartbeatAt: expect.any(Date) },
		});
		expect(store.runtimeLease.deleteMany).toHaveBeenCalledWith({
			where: { name: "active-api", ownerId: "owner-a" },
		});
	});

	it("stops after bounded renewal failures before the lease can expire", async () => {
		vi.useFakeTimers();
		const store = createStore();
		vi.mocked(store.runtimeLease.updateMany)
			.mockResolvedValueOnce({ count: 0 })
			.mockRejectedValue(new Error("database unavailable"));
		const onLeaseLost = vi.fn();
		const lease = new RuntimeLeaseManager(store, log, {
			ownerId: "owner-a",
			heartbeatMs: 1_000,
			failureLimit: 3,
		});
		await lease.acquire();
		lease.start(onLeaseLost);

		await vi.advanceTimersByTimeAsync(3_000);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(onLeaseLost).toHaveBeenCalledTimes(1);
		expect(onLeaseLost).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Runtime lease could not be renewed after 3 attempts" }),
		);
	});
});
