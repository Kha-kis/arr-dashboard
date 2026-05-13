/**
 * Tests for TrashGitHubFetcher URL construction.
 *
 * GitHub raw content URLs require the canonical `refs/heads/{branch}` path
 * — the legacy `…/{branch}/…` form returns 404 for many repos (issue #406).
 * These tests pin the URL shape for both the default TRaSH-Guides repo and
 * for custom forks/branches so the regression cannot recur.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFingerprints } from "../../validation/schema-fingerprint.js";
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

/*
 * `fetchNamingData` records a schema fingerprint for each service. The fix
 * keys those fingerprints by service ("radarrNamingPresets" vs
 * "sonarrNamingPresets") because the two services ship genuinely different
 * shapes — Radarr returns { folder, file } while Sonarr returns { season,
 * series, episodes }. Sharing a single "namingPresets" category caused the
 * registry baseline to oscillate every refresh cycle and produced false
 * intermittent-drift signals in Settings → System → Schema Drift.
 *
 * Pinning the per-service category names here makes regressions show up as
 * an obvious assertion failure rather than as cosmetic UI noise the user
 * has to spot.
 */
describe("TrashGitHubFetcher.fetchNamingData — per-service fingerprint categories", () => {
	let fetchSpy: FetchSpy;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		// The schemaFingerprints registry is a process-global singleton; clear
		// it so prior tests can't leak state into these assertions.
		schemaFingerprints.reset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		schemaFingerprints.reset();
	});

	const RADARR_NAMING = {
		folder: { "TRaSH Recommended": "{Movie CleanTitle} ({Release Year})" },
		file: { "TRaSH Recommended": "{Movie CleanTitle}" },
	};
	const SONARR_NAMING = {
		season: { Default: "Season {season:00}" },
		series: { Default: "{Series TitleYear}" },
		episodes: {
			standard: { Default: "{Series TitleYear} - S{season:00}E{episode:00}" },
			daily: { Default: "{Series TitleYear} - {Air-Date}" },
			anime: { Default: "{Series TitleYear} - S{season:00}E{episode:00}" },
		},
	};

	async function primeBothServices(fetcher: TrashGitHubFetcher) {
		// RADARR: directory listing + one file
		fetchSpy.mockResolvedValueOnce(
			buildJsonResponse([{ name: "radarr-naming.json", type: "file" }]),
		);
		fetchSpy.mockResolvedValueOnce(buildJsonResponse(RADARR_NAMING));
		await fetcher.fetchNamingData("RADARR");

		// SONARR: directory listing + one file
		fetchSpy.mockResolvedValueOnce(
			buildJsonResponse([{ name: "sonarr-naming.json", type: "file" }]),
		);
		fetchSpy.mockResolvedValueOnce(buildJsonResponse(SONARR_NAMING));
		await fetcher.fetchNamingData("SONARR");
	}

	it("records separate fingerprint categories for RADARR and SONARR", async () => {
		const fetcher = new TrashGitHubFetcher();
		await primeBothServices(fetcher);

		const categories = schemaFingerprints.getByIntegration("trash-guides");
		expect(categories.radarrNamingPresets).toBeDefined();
		expect(categories.sonarrNamingPresets).toBeDefined();
		// The legacy shared key must not be used — that's the regression
		// guard. If a future refactor reverts to "namingPresets", this
		// assertion catches it.
		expect(categories.namingPresets).toBeUndefined();
	});

	it("does not report drift on first observation for either service", async () => {
		const fetcher = new TrashGitHubFetcher();
		await primeBothServices(fetcher);

		const categories = schemaFingerprints.getByIntegration("trash-guides");
		// Before the fix: SONARR's first call landed against RADARR's baseline
		// and reported folder/file as missing + season/series/episodes as new.
		// After the fix: each service has its own baseline, so neither shows
		// drift on first observation.
		expect(categories.radarrNamingPresets?.drift.hasDrift).toBe(false);
		expect(categories.sonarrNamingPresets?.drift.hasDrift).toBe(false);
	});

	it("each baseline contains only the fields from its own service shape", async () => {
		const fetcher = new TrashGitHubFetcher();
		await primeBothServices(fetcher);

		const categories = schemaFingerprints.getByIntegration("trash-guides");
		expect(categories.radarrNamingPresets?.baseline.fields).toEqual(["_service", "file", "folder"]);
		// The schemas attach a `_service` discriminant via `.transform()`, so
		// the fingerprint also sees it — included in the assertion so the
		// expected shape is explicit.
		expect(categories.sonarrNamingPresets?.baseline.fields).toEqual([
			"_service",
			"episodes",
			"season",
			"series",
		]);
	});
});
