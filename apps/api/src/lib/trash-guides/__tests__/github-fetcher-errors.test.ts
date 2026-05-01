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
