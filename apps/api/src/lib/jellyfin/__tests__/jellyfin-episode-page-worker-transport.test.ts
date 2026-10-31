import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runJellyfinEpisodePageWorker } from "../jellyfin-episode-page-worker-transport.js";

const input = {
	baseUrl: "http://synthetic.invalid",
	apiKey: "SECRET_SENTINEL",
	httpAuthHeaders: { Authorization: "AUTH_SENTINEL" },
	userId: "USER_SENTINEL",
	libraryId: "LIBRARY_SENTINEL",
	startIndex: 2,
	limit: 2,
};
const page = {
	startIndex: 2,
	totalRecordCount: 3,
	items: [{ id: "episode-3", type: "Episode", excludedReason: "missing-episode-metadata" }],
};

class PageWorker extends EventEmitter {
	terminate = vi.fn<() => Promise<number>>().mockResolvedValue(1);
	stdout = { resume: vi.fn() };
	stderr = { resume: vi.fn() };
}

function invocation(worker = new PageWorker()) {
	let settled = false;
	const pending = runJellyfinEpisodePageWorker(input, {
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

describe("episode page worker physical closure", () => {
	it("refuses pre-aborted page work before spawning", async () => {
		const controller = new AbortController();
		controller.abort(new Error("SECRET_SENTINEL"));
		const createWorker = vi.fn(() => new PageWorker());
		// If a worker is incorrectly created, physically finish it even on RED.
		const outcome = runJellyfinEpisodePageWorker(input, {
			signal: controller.signal,
			createWorker,
		}).catch((error) => error);
		await Promise.resolve();
		for (const worker of createWorker.mock.results.map((result) => result.value))
			worker.emit("exit", 0);
		expect(await outcome).toMatchObject({ category: "cancelled" });
		expect(createWorker).not.toHaveBeenCalled();
	});

	it.each(["resolve", "reject", "throw"] as const)(
		"joins aborted page work when termination will %s",
		async (stop) => {
			const controller = new AbortController(),
				worker = new PageWorker();
			if (stop === "reject") worker.terminate.mockRejectedValue(new Error("SECRET_SENTINEL"));
			if (stop === "throw")
				worker.terminate.mockImplementation(() => {
					throw new Error("SECRET_SENTINEL");
				});
			let settled = false;
			const outcome = runJellyfinEpisodePageWorker(input, {
				signal: controller.signal,
				createWorker: () => worker,
			})
				.catch((error) => error)
				.finally(() => {
					settled = true;
				});
			controller.abort(new Error("SECRET_SENTINEL"));
			await Promise.resolve();
			const requested = worker.terminate.mock.calls.length;
			const prematurelySettled = settled;
			worker.emit("exit", 1);
			expect(await outcome).toMatchObject({ category: "cancelled" });
			expect(requested).toBe(1);
			expect(prematurelySettled).toBe(false);
		},
	);

	it("cancels a provisional page and retains ownership until the still-live worker exits", async () => {
		const controller = new AbortController(),
			worker = new PageWorker();
		let settled = false;
		const outcome = runJellyfinEpisodePageWorker(input, {
			signal: controller.signal,
			createWorker: () => worker,
		})
			.catch((error) => error)
			.finally(() => {
				settled = true;
			});
		worker.emit("message", { status: "page", page });
		controller.abort(new Error("SECRET_SENTINEL"));
		await Promise.resolve();
		const requested = worker.terminate.mock.calls.length;
		const prematurelySettled = settled;
		worker.emit("exit", 0);
		expect(await outcome).toMatchObject({ category: "cancelled" });
		expect(requested).toBe(1);
		expect(worker.terminate).toHaveBeenCalledOnce();
		expect(prematurelySettled).toBe(false);
	});

	it("retains an already exited successful page after abort", async () => {
		const controller = new AbortController(),
			worker = new PageWorker();
		const outcome = runJellyfinEpisodePageWorker(input, {
			signal: controller.signal,
			createWorker: () => worker,
		});
		worker.emit("message", { status: "page", page });
		worker.emit("exit", 0);
		controller.abort();
		await expect(outcome).resolves.toEqual(page);
		expect(worker.terminate).not.toHaveBeenCalled();
	});
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
			worker.emit("message", { status: "page", page });
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
		run.worker.emit("message", { status: "page", page });
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
		run.worker.emit("message", { status: "page", page });
		await vi.advanceTimersByTimeAsync(100);
		expect(run.settled()).toBe(false);
		expect(run.worker.terminate).toHaveBeenCalledOnce();
		run.worker.emit("exit", 0);
		expect(await run.outcome).toMatchObject({ error: { category: "worker-timeout" } });
	});

	it("includes synchronous worker startup in the independent budget", async () => {
		vi.useFakeTimers();
		const worker = new PageWorker();
		const outcome = runJellyfinEpisodePageWorker(input, {
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
		[
			"duplicate success",
			[
				{ status: "page", page },
				{ status: "page", page },
			],
			0,
		],
		[
			"failure then success",
			[
				{ status: "failed", category: "provider-unavailable" },
				{ status: "page", page },
			],
			0,
		],
		[
			"malformed then success",
			[
				{ status: "page", page: { ...page, startIndex: 0 } },
				{ status: "page", page },
			],
			0,
		],
		["zero exit without result", [], 0],
		["nonzero exit with success", [{ status: "page", page }], 1],
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
		run.worker.emit("message", { status: "page", page });
		run.worker.emit("exit", 0);
		expect(await run.outcome).toMatchObject({ error: { category: "worker-failed" } });
	});
});
