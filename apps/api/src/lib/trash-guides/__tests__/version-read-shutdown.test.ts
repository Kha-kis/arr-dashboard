import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVersionTracker } from "../version-tracker.js";
import { UpdateScheduler } from "../update-scheduler.js";

const commit = {
	sha: "synthetic",
	commit: {
		author: { name: "Synthetic", email: "synthetic@example.invalid", date: "2026-10-21T00:00:00Z" },
		message: "Synthetic",
	},
	html_url: "https://example.invalid/synthetic",
};
const version = {
	commitHash: "synthetic",
	commitDate: "2026-10-21T00:00:00Z",
	commitMessage: "Synthetic",
	commitUrl: "https://example.invalid/synthetic",
};
let fetchSignals: AbortSignal[] = [];
const schedulers: UpdateScheduler[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	fetchSignals = [];
});
afterEach(async () => {
	await vi.runAllTimersAsync();
	await Promise.all(schedulers.splice(0).map((s) => s.shutdown()));
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function flush() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}
function holdFetch() {
	vi.stubGlobal(
		"fetch",
		(_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init.signal!;
				fetchSignals.push(signal);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	);
}
function scheduler(tracker = createVersionTracker()) {
	const cache = vi.fn().mockResolvedValue({ refreshed: 0, failed: 0, errors: [] }),
		notify = vi.fn().mockResolvedValue(undefined),
		s = new UpdateScheduler(
			{ enabled: true, intervalHours: 12 },
			{ refreshAllCaches: cache } as never,
			tracker,
			{ trashTemplate: { count: async () => 0 } } as never,
			{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			undefined,
			{ notifyFn: notify },
		);
	schedulers.push(s);
	return { s, cache, notify };
}
describe("TRaSH read-only version cancellation", () => {
	it("refuses an already-cancelled read before issuing any GET", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(JSON.stringify(commit));
		});
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown");
		controller.abort(reason);
		const result = await createVersionTracker()
			.getLatestCommit({ signal: controller.signal })
			.catch((e) => e);
		expect(calls).toBe(0);
		expect(result).toBe(reason);
	});
	it("cancels and joins a response body already being read", async () => {
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown");
		let body!: ReadableStreamDefaultController<Uint8Array>;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const signal = init.signal!;
			fetchSignals.push(signal);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						body = c;
						signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
					},
				}),
			);
		});
		const outcome = createVersionTracker()
			.getLatestCommit({ signal: controller.signal })
			.catch((e) => e);
		try {
			await flush();
			controller.abort(reason);
			await flush();
			expect(fetchSignals[0]?.aborted).toBe(true);
			expect(await outcome).toBe(reason);
		} finally {
			try {
				body.close();
			} catch {}
			await outcome;
		}
	});
	it("aborts an actual held metadata GET without retrying shutdown", async () => {
		holdFetch();
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown"),
			outcome = createVersionTracker()
				.getLatestCommit({ signal: controller.signal })
				.catch((e) => e);
		await flush();
		expect(fetchSignals).toHaveLength(1);
		controller.abort(reason);
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		expect(await outcome).toBe(reason);
		await vi.runAllTimersAsync();
		expect(fetchSignals).toHaveLength(1);
	});
	it("stops retry backoff before a later GET can start", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw Error("synthetic offline");
		});
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown"),
			outcome = createVersionTracker()
				.getLatestCommit({ signal: controller.signal })
				.catch((e) => e);
		await flush();
		expect(calls).toBe(1);
		controller.abort(reason);
		await vi.runAllTimersAsync();
		expect(calls).toBe(1);
		expect(await outcome).toBe(reason);
	});
	it("joins the actual scheduler read cancellation without starting cache work or recording success", async () => {
		holdFetch();
		const { s, cache, notify } = scheduler();
		s.start();
		await flush();
		expect(fetchSignals).toHaveLength(1);
		const closing = s.shutdown();
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		await closing;
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckAt).toBeUndefined();
		expect(s.getStats().lastCheckResult).toBeUndefined();
		expect(s.getStats().nextCheckAt).toBeUndefined();
	});
	it("rejects a manually accepted cancelled read rather than reporting success", async () => {
		holdFetch();
		const { s, cache, notify } = scheduler(),
			outcome = s.triggerCheck().catch((e) => e);
		await flush();
		expect(fetchSignals).toHaveLength(1);
		const closing = s.shutdown();
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		await closing;
		expect(await outcome).toBeInstanceOf(Error);
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckResult).toBeUndefined();
	});
	it("retains ordinary retry recovery without a shutdown signal", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			if (++calls < 3) throw Error("synthetic offline");
			return new Response(JSON.stringify(commit));
		});
		const outcome = createVersionTracker().getLatestCommit();
		await vi.runAllTimersAsync();
		await expect(outcome).resolves.toEqual(version);
		expect(calls).toBe(3);
	});
	it("still joins a metadata dependency that ignores cancellation and prevents later writes", async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const { s, cache, notify } = scheduler({
			getLatestCommit: async () => {
				await held;
				return version;
			},
		} as never);
		s.start();
		await flush();
		let closed = false;
		const closing = s.shutdown().then(() => {
			closed = true;
		});
		await flush();
		expect(closed).toBe(false);
		release();
		await closing;
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckResult).toBeUndefined();
	});
	it("preserves ordinary successful metadata reads when no cancellation is requested", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(commit), { status: 200 }));
		await expect(createVersionTracker().getLatestCommit()).resolves.toEqual(version);
	});
});
