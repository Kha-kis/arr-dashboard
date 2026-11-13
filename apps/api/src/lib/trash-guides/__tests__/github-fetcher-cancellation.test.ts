import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashGitHubFetcher } from "../github-fetcher.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("opt-in GitHub fetch cancellation", () => {
	it("already-aborted caller sends no request or fallback empty publication", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const fetcher = new TrashGitHubFetcher({ signal: controller.signal });
		await expect(fetcher.fetchMetadata()).rejects.toMatchObject({ name: "AbortError" });
		await expect(fetcher.fetchConfigs("RADARR", "CUSTOM_FORMATS")).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(["headers", "body"] as const)(
		"aborts real loopback held %s consumption without retry and joins the connection",
		async (phase) => {
			const actualFetch = globalThis.fetch,
				entered = deferred(),
				headersSeen = deferred();
			let held: ServerResponse | undefined,
				requests = 0;
			const server = createServer((request, response) => {
				assert.equal(request.url, "/metadata");
				held = response;
				if (phase === "body") {
					response.writeHead(200, { "content-type": "application/json" });
					response.write('{"version":');
				}
				entered.resolve();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/metadata.json",
				);
				requests++;
				return actualFetch(`http://127.0.0.1:${address.port}/metadata`, init).then((response) => {
					headersSeen.resolve();
					return response;
				});
			});
			const controller = new AbortController();
			const task = new TrashGitHubFetcher({ signal: controller.signal }).fetchMetadata();
			const result = task.then(
				() => "fulfilled",
				(error) => error.name,
			);
			try {
				await entered.promise;
				if (phase === "body") {
					await headersSeen.promise;
					// Drain the header promise chain so fetchMetadata is consuming the
					// incomplete real HTTP body, not merely waiting for fetch headers.
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				controller.abort();
				expect(await result).toBe("AbortError");
				expect(requests).toBe(1);
			} finally {
				controller.abort();
				held?.end('"synthetic"}');
				await result;
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
			expect(server.listening).toBe(false);
		},
	);
	it.each(["retry", "reactive-rate", "proactive-rate"] as const)(
		"cancels joined %s wait with no next attempt or live timers",
		async (phase) => {
			vi.resetModules();
			const { TrashGitHubFetcher: FreshFetcher } = await import("../github-fetcher.js");
			vi.useFakeTimers();
			const waiting = deferred(),
				controller = new AbortController();
			let calls = 0;
			const reset = String(Math.floor(Date.now() / 1000) + 60);
			vi.stubGlobal("fetch", async () => {
				calls++;
				if (phase === "proactive-rate")
					return Response.json([], {
						headers: {
							"X-RateLimit-Limit": "60",
							"X-RateLimit-Remaining": "0",
							"X-RateLimit-Reset": reset,
						},
					});
				return new Response("Synthetic refusal", {
					status: phase === "retry" ? 503 : 429,
					headers: { "Retry-After": "60" },
				});
			});
			const logger = {
				info() {},
				error() {},
				warn(message: unknown) {
					if (
						String(message).includes(
							phase === "proactive-rate"
								? "Proactive"
								: phase === "retry"
									? "server error"
									: "rate limit hit",
						)
					)
						waiting.resolve();
				},
			};
			const fetcher = new FreshFetcher({ signal: controller.signal, retryDelay: 60_000, logger });
			if (phase === "proactive-rate") await fetcher.fetchConfigs("RADARR", "CUSTOM_FORMATS");
			const task =
				phase === "retry"
					? fetcher.fetchMetadata()
					: fetcher.fetchConfigs("RADARR", "CUSTOM_FORMATS");
			const result = task.then(
				() => "fulfilled",
				(error) => error.name,
			);
			await waiting.promise;
			// Let the logged branch enter its wait before aborting; do not advance it.
			await Promise.resolve();
			await Promise.resolve();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			controller.abort();
			expect(await result).toBe("AbortError");
			expect(calls).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("without a caller signal, ordinary success and server-error retry remain unchanged", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("Synthetic unavailable", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ version: "synthetic" }));
		vi.stubGlobal("fetch", fetch);
		await expect(new TrashGitHubFetcher({ retryDelay: 1 }).fetchMetadata()).resolves.toEqual({
			version: "synthetic",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
