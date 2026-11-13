import { EventEmitter } from "node:events";
import { describe, expect, it, vi, afterEach } from "vitest";
import { runJellyfinNativePageWorker } from "../jellyfin-native-page-worker-transport.js";

const input = {
	baseUrl: "http://synthetic.invalid",
	apiKey: "SECRET_SENTINEL",
	httpAuthHeaders: { Authorization: "AUTH_SENTINEL" },
	domain: "episode" as const,
	deadlineAt: Date.now() + 60_000,
	libraryId: "LIBRARY_SENTINEL",
	startIndex: 2,
	limit: 2,
};
const page = {
	status: "page",
	domain: "episode",
	startIndex: 2,
	totalRecordCount: 3,
	items: [{ id: "episode-3", type: "Episode", name: "Synthetic", seriesId: "series-1" }],
};

class PageWorker extends EventEmitter {
	terminate = vi.fn<() => Promise<number>>().mockResolvedValue(1);
	stdout = { resume: vi.fn() };
	stderr = { resume: vi.fn() };
}

function invocation(worker = new PageWorker()) {
	let settled = false;
	const pending = runJellyfinNativePageWorker(input, {
		createWorker: () => worker,
		timeoutMs: 100,
	});
	const outcome = pending.then(
		(value) => {
			settled = true;
			return { value };
		},
		(error: unknown) => {
			settled = true;
			return { error };
		},
	);
	return { worker, outcome, settled: () => settled };
}

afterEach(() => vi.useRealTimers());

describe("native page worker physical closure", () => {
	it("caps HTTP and physical budgets by the remaining slice, including startup", async () => {
		vi.useFakeTimers();
		const worker = new PageWorker();
		const createWorker = vi.fn((_url, data) => {
			expect(data.requestTimeoutMs).toBe(75);
			return worker;
		});
		const pending = runJellyfinNativePageWorker(
			{ ...input, deadlineAt: Date.now() + 75 },
			{ createWorker },
		).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(74);
		expect(worker.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(worker.terminate).toHaveBeenCalledOnce();
		worker.emit("exit", 1);
		expect(await pending).toMatchObject({ category: "worker-timeout" });
	});
	it("does not start work after the slice deadline", async () => {
		const createWorker = vi.fn();
		await expect(
			runJellyfinNativePageWorker({ ...input, deadlineAt: Date.now() - 1 }, { createWorker }),
		).resolves.toEqual({ status: "unavailable", reason: "deadline-exceeded" });
		expect(createWorker).not.toHaveBeenCalled();
	});
	it.each([{ timeoutMs: 20_001 }, { requestTimeoutMs: 15_001 }, { timeoutMs: 0 }])(
		"refuses increased or invalid policy budgets %j",
		async (options) => {
			const createWorker = vi.fn();
			await expect(
				runJellyfinNativePageWorker(input, { ...options, createWorker }),
			).rejects.toMatchObject({ category: "worker-failed" });
			expect(createWorker).not.toHaveBeenCalled();
		},
	);
	// Catches a Promise.race or terminate() receipt releasing an active claim.
	it.each(["resolve", "reject", "throw"] as const)(
		"holds timed-out work until exit when terminate will %s",
		async (stop) => {
			vi.useFakeTimers();
			const worker = new PageWorker();
			if (stop === "reject") worker.terminate.mockRejectedValue(new Error("SECRET_SENTINEL"));
			if (stop === "throw")
				worker.terminate.mockImplementation(() => {
					throw new Error("SECRET_SENTINEL");
				});
			const run = invocation(worker);
			await vi.advanceTimersByTimeAsync(100);
			expect(worker.terminate).toHaveBeenCalledTimes(1);
			expect(run.settled()).toBe(false);
			worker.emit("message", page);
			worker.emit("error", new Error("SECRET_SENTINEL"));
			await vi.advanceTimersByTimeAsync(100);
			expect(run.settled()).toBe(false);
			expect(worker.terminate).toHaveBeenCalledTimes(1);
			worker.emit("exit", 0);
			expect(await run.outcome).toMatchObject({
				error: { category: "worker-timeout", name: "TimeoutError" },
			});
		},
	);

	// Catches early staging after message, even when termination appears complete.
	it("returns exact normalized data only after a clean independent exit", async () => {
		vi.useFakeTimers();
		const run = invocation();
		run.worker.emit("message", page);
		await vi.advanceTimersByTimeAsync(50);
		expect(run.settled()).toBe(false);
		run.worker.emit("exit", 0);
		expect(await run.outcome).toEqual({ value: page });
		expect(run.worker.terminate).not.toHaveBeenCalled();
		expect(run.worker.stdout.resume).toHaveBeenCalledOnce();
		expect(run.worker.stderr.resume).toHaveBeenCalledOnce();
	});

	it("turns a provisional success into timeout when its worker does not exit", async () => {
		vi.useFakeTimers();
		const run = invocation();
		run.worker.emit("message", page);
		await vi.advanceTimersByTimeAsync(100);
		expect(run.settled()).toBe(false);
		expect(run.worker.terminate).toHaveBeenCalledOnce();
		run.worker.emit("exit", 0);
		expect(await run.outcome).toMatchObject({ error: { category: "worker-timeout" } });
	});

	it("includes synchronous worker startup in the independent budget", async () => {
		vi.useFakeTimers();
		const worker = new PageWorker();
		const outcome = runJellyfinNativePageWorker(input, {
			timeoutMs: 100,
			createWorker: () => {
				vi.advanceTimersByTime(101);
				return worker;
			},
		}).catch((error: unknown) => error);
		expect(worker.terminate).toHaveBeenCalledOnce();
		worker.emit("exit", 0);
		expect(await outcome).toMatchObject({ category: "worker-timeout" });
	});

	it("holds a pipe-drain failure until worker exit", async () => {
		const worker = new PageWorker();
		worker.stdout.resume.mockImplementation(() => {
			throw new Error("SECRET_SENTINEL");
		});
		const run = invocation(worker);
		await Promise.resolve();
		expect(run.settled()).toBe(false);
		expect(worker.terminate).toHaveBeenCalledOnce();
		worker.emit("exit", 0);
		expect(await run.outcome).toMatchObject({ error: { category: "worker-failed" } });
	});

	it.each([
		["duplicate success", [page, page], 0],
		["failure then success", [{ status: "failed", category: "provider-unavailable" }, page], 0],
		["malformed then success", [{ ...page, startIndex: 0 }, page], 0],
		["zero exit without result", [], 0],
		["nonzero exit with success", [page], 1],
	] as const)("refuses %s", async (_label, messages, code) => {
		const run = invocation();
		for (const message of messages) run.worker.emit("message", message);
		expect(run.settled()).toBe(false);
		run.worker.emit("exit", code);
		const result = await run.outcome;
		expect(result).toHaveProperty("error");
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
	});

	it("does not accept success after an error event", async () => {
		const run = invocation();
		run.worker.emit("error", Object.assign(new Error("SECRET_SENTINEL"), { cause: input }));
		run.worker.emit("message", page);
		run.worker.emit("exit", 0);
		expect(await run.outcome).toMatchObject({ error: { category: "worker-failed" } });
	});
});
