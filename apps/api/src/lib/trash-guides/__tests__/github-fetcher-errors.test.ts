/**
 * Tests for TrashGitHubFetcher error-message diagnosability.
 *
 * Issue #406 was hard to triage because the failure messages omitted the
 * URL being fetched, and the discovery error named the raw URL while the
 * actual fetch was to api.github.com. These tests pin the diagnostic
 * content of those error sites so the regression cannot recur silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrashGitHubFetcher } from "../github-fetcher.js";

type FetchSpy = ReturnType<typeof vi.fn>;

interface CapturedLogEntry {
	level: "error" | "warn";
	mergeObject: unknown;
	message: string;
}

function buildJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
		statusText: status === 404 ? "Not Found" : "OK",
	});
}

function createCapturingLogger(captured: CapturedLogEntry[]) {
	const capture =
		(level: "error" | "warn") =>
		(...args: unknown[]) => {
			// Pino convention: log.error(mergeObject, message) OR log.error(message).
			if (typeof args[0] === "string") {
				captured.push({ level, mergeObject: undefined, message: args[0] });
			} else {
				captured.push({
					level,
					mergeObject: args[0],
					message: typeof args[1] === "string" ? args[1] : "",
				});
			}
		};
	return {
		debug: () => {},
		info: () => {},
		warn: capture("warn"),
		error: capture("error"),
		fatal: () => {},
		trace: () => {},
		silent: () => {},
		child: () => createCapturingLogger(captured),
		level: "error",
		bindings: () => ({}),
		flush: () => {},
		isLevelEnabled: () => true,
	};
}

describe("TrashGitHubFetcher error diagnosability (issue #406 follow-up)", () => {
	let fetchSpy: FetchSpy;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("includes the metadata URL and HTTP status in fetchMetadata errors", async () => {
		// 404 short-circuits fetchWithRetry's retry loop (only 5xx is retried),
		// so the response is returned immediately and the !response.ok branch
		// in fetchMetadata is what throws.
		fetchSpy.mockResolvedValue(buildJsonResponse({}, 404));

		const fetcher = new TrashGitHubFetcher({ logger: createCapturingLogger([]) as any });

		await expect(fetcher.fetchMetadata()).rejects.toThrow(/metadata\.json/);
		await expect(fetcher.fetchMetadata()).rejects.toThrow(/404/);
	});

	it("includes the failing URL in fetchWithRetry attempt logs", async () => {
		const captured: CapturedLogEntry[] = [];
		const logger = createCapturingLogger(captured) as any;
		fetchSpy.mockRejectedValue(
			new TypeError("fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com"),
		);

		const fetcher = new TrashGitHubFetcher({ logger });
		await expect(fetcher.fetchMetadata()).rejects.toThrow();

		const retryLogs = captured.filter((entry) => entry.message.includes("Fetch attempt"));
		expect(retryLogs.length).toBeGreaterThan(0);
		// Each retry log must name the URL — both in the message and in the
		// structured merge object so log scrapers can filter on it.
		for (const entry of retryLogs) {
			expect(entry.message).toMatch(/metadata\.json/);
			expect(entry.mergeObject).toMatchObject({
				url: expect.stringContaining("metadata.json"),
				attempt: expect.any(Number),
				retries: expect.any(Number),
			});
		}
	});

	it("names the api.github.com URL (not the raw URL) when discovery fails", async () => {
		const captured: CapturedLogEntry[] = [];
		const logger = createCapturingLogger(captured) as any;

		// All discovery attempts (and any retries within fetchWithRetry) reject.
		fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

		const fetcher = new TrashGitHubFetcher({ logger });
		await fetcher.fetchCustomFormats("RADARR");

		const discoveryError = captured.find(
			(entry) =>
				entry.level === "error" && entry.message.includes("Failed to discover config files"),
		);
		expect(discoveryError).toBeDefined();
		// The user-visible message must point at api.github.com (where the
		// fetch actually went), not at raw.githubusercontent.com.
		expect(discoveryError?.message).toContain("api.github.com");
		expect(discoveryError?.message).not.toContain("raw.githubusercontent.com");
		// The merge object should still carry the raw baseUrl for context,
		// alongside the apiUrl that failed.
		expect(discoveryError?.mergeObject).toMatchObject({
			apiUrl: expect.stringContaining("api.github.com"),
			baseUrl: expect.stringContaining("raw.githubusercontent.com"),
			err: expect.any(Error),
		});
	});
});

describe("strict include collection does not manufacture a complete empty result", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("rejects an unavailable include listing instead of accepting it as empty", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(buildJsonResponse({}, 404)));
		const fetcher = new TrashGitHubFetcher({
			strictContent: true,
			logger: createCapturingLogger([]) as any,
		});
		await expect(fetcher.fetchCFIncludes()).rejects.toThrow();
	});

	it("rejects a failed include after an earlier include succeeded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = new URL(input);
				if (url.hostname === "api.github.com")
					return buildJsonResponse([
						{ name: "apply-10000.md", type: "file" },
						{ name: "note-failure.md", type: "file" },
					]);
				return url.pathname.endsWith("note-failure.md")
					? buildJsonResponse({}, 404)
					: new Response("Synthetic include content");
			}),
		);
		const fetcher = new TrashGitHubFetcher({
			strictContent: true,
			logger: createCapturingLogger([]) as any,
		});
		await expect(fetcher.fetchCFIncludes()).rejects.toThrow();
	});

	it("rejects a malformed include listing", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(buildJsonResponse({ unexpected: true })));
		const fetcher = new TrashGitHubFetcher({
			strictContent: true,
			logger: createCapturingLogger([]) as any,
		});
		await expect(fetcher.fetchCFIncludes()).rejects.toThrow();
	});

	it("permits a valid empty include listing", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(buildJsonResponse([])));
		const fetcher = new TrashGitHubFetcher({
			strictContent: true,
			logger: createCapturingLogger([]) as any,
		});
		await expect(fetcher.fetchCFIncludes()).resolves.toEqual([]);
	});

	it("preserves explicitly lenient callers' unavailable-list compatibility", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(buildJsonResponse({}, 404)));
		const fetcher = new TrashGitHubFetcher({ logger: createCapturingLogger([]) as any });
		await expect(fetcher.fetchCFIncludes()).resolves.toEqual([]);
	});
});

describe("commit-addressed read cancellation", () => {
	const commitHash = "0123456789abcdef0123456789abcdef01234567";

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each(["call", "constructor"] as const)(
		"honors the %s signal during a proactive GitHub rate-limit wait",
		async (source) => {
			vi.useFakeTimers();
			vi.setSystemTime(
				new Date(source === "call" ? "2000-01-01T00:00:00Z" : "2000-01-02T00:00:00Z"),
			);
			const captured: CapturedLogEntry[] = [];
			const parent = new AbortController();
			const call = new AbortController();
			const reason = new Error("Synthetic cancellation");
			const fetcher = new TrashGitHubFetcher({
				signal: parent.signal,
				logger: createCapturingLogger(captured) as any,
			});
			const exhausted = buildJsonResponse([{ type: "file", name: "sample.json" }]);
			exhausted.headers.set("X-RateLimit-Limit", "60");
			exhausted.headers.set("X-RateLimit-Remaining", "1");
			exhausted.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + 3306));
			const fetchSpy = vi.fn().mockResolvedValue(buildJsonResponse({}, 404));
			fetchSpy.mockResolvedValueOnce(exhausted);
			vi.stubGlobal("fetch", fetchSpy);
			// A failed content GET leaves the listing's rate-limit metadata in place.
			await expect(
				fetcher.fetchConfigsAtCommit("RADARR", "CUSTOM_FORMATS", commitHash),
			).rejects.toThrow("HTTP 404");

			const settled = vi.fn();
			const blocked = fetcher
				.fetchConfigsAtCommit("SONARR", "CUSTOM_FORMATS", commitHash, { signal: call.signal })
				.then(settled, settled);
			try {
				expect(
					captured.some(({ message }) => message.startsWith("Proactive rate limit wait: 3306s")),
				).toBe(true);
				expect(fetchSpy).toHaveBeenCalledTimes(2);
				(source === "call" ? call : parent).abort(reason);
				await vi.advanceTimersByTimeAsync(0);
				expect(settled).toHaveBeenCalledExactlyOnceWith(reason);
				expect(fetchSpy).toHaveBeenCalledTimes(2);
			} finally {
				// Drain even on RED, and advance beyond the shared limit before the next case.
				await vi.advanceTimersByTimeAsync(3_308_000);
				await blocked;
			}
		},
	);

	it("joins a description GET that settles after another GET aborts", async () => {
		const controller = new AbortController();
		const reason = new Error("Synthetic cancellation");
		const fetcher = new TrashGitHubFetcher();
		let entered!: () => void;
		const secondReadStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, options: RequestInit) => {
				const url = new URL(input);
				if (url.hostname === "api.github.com") {
					return buildJsonResponse([
						{ type: "file", name: "aborts.md" },
						{ type: "file", name: "held.md" },
					]);
				}
				if (url.pathname.endsWith("/aborts.md")) {
					const signal = options.signal!;
					return new Promise<Response>((_, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				entered();
				await held;
				return new Response("# Synthetic description");
			}),
		);

		const settled = vi.fn();
		const read = fetcher
			.fetchConfigsAtCommit("RADARR", "CF_DESCRIPTIONS", commitHash, { signal: controller.signal })
			.then(settled, settled);
		await secondReadStarted;
		try {
			controller.abort(reason);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).not.toHaveBeenCalled();
		} finally {
			release();
			await read;
		}
		expect(settled).toHaveBeenCalledExactlyOnceWith(reason);
	});
});
