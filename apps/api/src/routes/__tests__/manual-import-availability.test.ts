import type { RadarrClient } from "arr-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchManualImportCandidatesWithSdk,
	setManualImportLogger,
} from "../manual-import-utils.js";

const candidate = {
	id: 1,
	path: "/fixture/private-title.mkv",
	downloadId: "fixture-download",
	movie: { id: 10, title: "fixture-private-title" },
};

function clientReturning(value: unknown): RadarrClient {
	return { manualImport: { get: async () => value } } as unknown as RadarrClient;
}

afterEach(() => {
	vi.unstubAllEnvs();
	setManualImportLogger({ warn: () => {}, debug: () => {} });
});

describe("manual import candidate availability and privacy", () => {
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"%s preserves valid/empty responses and rejects malformed evidence at its SDK boundary",
		async (service) => {
			const read = vi.fn();
			const client = (service === "sonarr" || service === "radarr"
				? { manualImport: { get: read } }
				: { get: read }) as unknown as Parameters<typeof fetchManualImportCandidatesWithSdk>[0];
			read.mockResolvedValueOnce([candidate]);
			const rows = await fetchManualImportCandidatesWithSdk(client, service, {
				downloadId: "fixture-download",
				filterExistingFiles: false,
			});
			expect(rows).toMatchObject([
				{ service, path: candidate.path, downloadId: "fixture-download" },
			]);
			if (service === "lidarr" || service === "readarr") {
				expect(read).toHaveBeenCalledWith("/api/v1/manualimport", {
					downloadId: "fixture-download",
					filterExistingFiles: false,
				});
			} else {
				expect(read).toHaveBeenCalledWith(
					expect.objectContaining({
						downloadId: "fixture-download",
						filterExistingFiles: false,
					}),
				);
			}
			read.mockResolvedValueOnce([]);
			await expect(fetchManualImportCandidatesWithSdk(client, service, {})).resolves.toEqual([]);
			read.mockResolvedValueOnce({ privateBody: "fixture-private-body" });
			await expect(fetchManualImportCandidatesWithSdk(client, service, {})).rejects.toMatchObject({
				statusCode: 502,
			});
			read.mockResolvedValueOnce([candidate, { id: 2 }]);
			await expect(fetchManualImportCandidatesWithSdk(client, service, {})).rejects.toMatchObject({
				statusCode: 502,
			});
		},
	);

	it.each([null, {}, { records: [] }, "fixture-private-provider-body"])(
		"does not interpret a malformed response as a healthy empty inventory (%j)",
		async (value) => {
			await expect(
				fetchManualImportCandidatesWithSdk(clientReturning(value), "radarr", {}),
			).rejects.toMatchObject({ statusCode: 502 });
		},
	);

	it("returns a genuinely empty provider inventory", async () => {
		await expect(
			fetchManualImportCandidatesWithSdk(clientReturning([]), "radarr", {}),
		).resolves.toEqual([]);
	});

	it("does not publish a reduced candidate list when one provider row cannot be represented", async () => {
		await expect(
			fetchManualImportCandidatesWithSdk(
				clientReturning([candidate, { ...candidate, id: { private: "fixture-private-id" } }]),
				"radarr",
				{},
			),
		).rejects.toMatchObject({ statusCode: 502 });
	});

	it("does not expose provider error text in a public fetch error", async () => {
		const client = {
			manualImport: {
				get: async () => {
					throw new Error("fixture-secret https://fixture.invalid/private?apiKey=fixture-key");
				},
			},
		} as unknown as RadarrClient;
		let caught: unknown;
		try {
			await fetchManualImportCandidatesWithSdk(client, "radarr", {});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 502 });
		expect(String(caught)).not.toMatch(/fixture-secret|fixture-key|fixture.invalid/);
	});

	it("keeps validation logs generic rather than writing a candidate path or schema payload", async () => {
		const warn = vi.fn();
		setManualImportLogger({ warn, debug: vi.fn() });
		await fetchManualImportCandidatesWithSdk(
			clientReturning([{ ...candidate, id: { private: "fixture-private-id" } }]),
			"radarr",
			{},
		).catch(() => {});
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-title|private-id|\/fixture\//);
	});

	it("never logs invalid raw identifiers even when debug normalization is enabled", async () => {
		vi.stubEnv("DEBUG_MANUAL_IMPORT", "1");
		const debug = vi.fn();
		setManualImportLogger({ warn: vi.fn(), debug });
		await fetchManualImportCandidatesWithSdk(
			clientReturning([{ ...candidate, movie: { id: "fixture-private-invalid-id" } }]),
			"radarr",
			{},
		);
		expect(debug).toHaveBeenCalled();
		expect(JSON.stringify(debug.mock.calls)).not.toContain("fixture-private-invalid-id");
	});
});
