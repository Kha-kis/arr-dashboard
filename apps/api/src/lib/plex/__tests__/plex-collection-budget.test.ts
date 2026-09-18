import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";
import { collectWithinPlexBudget } from "../plex-collection-budget.js";

const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

describe("Plex canonical collection budget", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("bounds cumulative reads even when every request completes within its own timeout", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10_000));
			return new Response(
				JSON.stringify({ MediaContainer: { machineIdentifier: "synthetic", version: "1" } }),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetcher);
		const running = collectWithinPlexBudget(log, async (readContext) => {
			const client = new PlexClient(
				"http://synthetic.invalid",
				"synthetic",
				log,
				undefined,
				{},
				readContext,
			);
			for (let i = 0; i < 100; i++) await client.getIdentity();
			return "complete";
		});
		const assertion = expect(running).rejects.toThrow("canonical collection deadline exceeded");
		await vi.advanceTimersByTimeAsync(600_001);
		await assertion;
		const requestsAtExpiry = fetcher.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher.mock.calls.length).toBe(requestsAtExpiry);
		expect(requestsAtExpiry).toBeLessThan(100);
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "deadline-exceeded",
				lastRead: "identity",
				requests: requestsAtExpiry,
			}),
			expect.any(String),
		);
	});

	it("cancels the active transport and rejects even when collection swallows its abort", async () => {
		vi.useFakeTimers();
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise((_resolve, reject) => {
						options.signal!.addEventListener("abort", () => {
							aborted = true;
							reject(options.signal!.reason);
						});
					}),
			),
		);
		const running = collectWithinPlexBudget(log, async (readContext) => {
			const client = new PlexClient(
				"http://synthetic.invalid",
				"synthetic",
				log,
				900_000,
				{},
				readContext,
			);
			try {
				await client.getIdentity();
			} catch {
				return "partial";
			}
			return "complete";
		});
		const assertion = expect(running).rejects.toThrow("canonical collection deadline exceeded");
		await vi.advanceTimersByTimeAsync(600_001);
		await assertion;
		expect(aborted).toBe(true);
	});

	it("clears the deadline after success and after a collection error", async () => {
		vi.useFakeTimers();
		await expect(collectWithinPlexBudget(log, async () => "complete")).resolves.toBe("complete");
		await expect(
			collectWithinPlexBudget(log, async () => {
				throw new Error("synthetic failure");
			}),
		).rejects.toThrow("synthetic failure");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not send a later request using an expired collection context", async () => {
		const controller = new AbortController();
		controller.abort(new Error("expired"));
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const client = new PlexClient(
			"http://synthetic.invalid",
			"synthetic",
			log,
			undefined,
			{},
			{
				signal: controller.signal,
				onRequest: vi.fn(),
			},
		);
		await expect(client.getIdentity()).rejects.toThrow("expired");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
