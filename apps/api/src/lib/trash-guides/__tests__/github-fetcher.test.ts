/**
 * Tests for TrashGitHubFetcher URL construction.
 *
 * GitHub raw content URLs require the canonical `refs/heads/{branch}` path
 * — the legacy `…/{branch}/…` form returns 404 for many repos (issue #406).
 * These tests pin the URL shape for both the default TRaSH-Guides repo and
 * for custom forks/branches so the regression cannot recur.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrashGitHubFetcher } from "../github-fetcher.js";

type FetchSpy = ReturnType<typeof vi.fn>;

function buildJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("TrashGitHubFetcher URL construction (issue #406)", () => {
	let fetchSpy: FetchSpy;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("uses refs/heads/{branch} for the default-repo metadata URL", async () => {
		fetchSpy.mockResolvedValueOnce(buildJsonResponse({ version: "1.0.0" }));

		const fetcher = new TrashGitHubFetcher();
		await fetcher.fetchMetadata();

		expect(fetchSpy).toHaveBeenCalledOnce();
		const requestedUrl = fetchSpy.mock.calls[0]?.[0];
		expect(requestedUrl).toBe(
			"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/metadata.json",
		);
	});

	it("uses refs/heads/{branch} for custom fork metadata URLs", async () => {
		fetchSpy.mockResolvedValueOnce(buildJsonResponse({ version: "1.0.0" }));

		const fetcher = new TrashGitHubFetcher({
			repoConfig: { owner: "catchra", name: "TRaSH-Guides", branch: "main" },
		});
		await fetcher.fetchMetadata();

		const requestedUrl = fetchSpy.mock.calls[0]?.[0];
		expect(requestedUrl).toBe(
			"https://raw.githubusercontent.com/catchra/TRaSH-Guides/refs/heads/main/metadata.json",
		);
	});

	it("discovers config files via api.github.com and fetches each via refs/heads raw URL", async () => {
		// 1st call: discovery → GitHub Contents API directory listing
		fetchSpy.mockResolvedValueOnce(
			buildJsonResponse([
				{ name: "1080p.json", type: "file" },
				{ name: "2160p.json", type: "file" },
			]),
		);
		// 2nd & 3rd calls: per-file raw fetches. We return invalid bodies so
		// validateAndCollect logs+drops them; this test only cares about URLs.
		fetchSpy.mockResolvedValueOnce(buildJsonResponse({}));
		fetchSpy.mockResolvedValueOnce(buildJsonResponse({}));

		const fetcher = new TrashGitHubFetcher();
		await fetcher.fetchCustomFormats("RADARR");

		const calls = fetchSpy.mock.calls.map((call) => call[0] as string);
		expect(calls[0]).toBe(
			"https://api.github.com/repos/TRaSH-Guides/Guides/contents/docs/json/radarr/cf",
		);
		expect(calls[1]).toBe(
			"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/docs/json/radarr/cf/1080p.json",
		);
		expect(calls[2]).toBe(
			"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/docs/json/radarr/cf/2160p.json",
		);
	});
});
