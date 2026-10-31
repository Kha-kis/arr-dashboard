import type { ManualImportCandidate } from "@arr/shared";
import type { RadarrClient } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	autoImportByDownloadIdWithSdk,
	collectAutoManualImportFiles,
	ManualImportIdentityError,
} from "../manual-import-utils.js";

const candidate: ManualImportCandidate = {
	service: "radarr",
	id: 1,
	path: "/fixture/item.mkv",
	movie: { id: 10 },
	downloadId: "requested-download",
};

describe("automatic import download authority", () => {
	it("reports a queued command as pending rather than completed import", async () => {
		const client = {
			manualImport: { get: vi.fn().mockResolvedValue([candidate]) },
			post: vi.fn().mockResolvedValue({ id: 7, name: "ManualImport", status: "queued" }),
		} as unknown as RadarrClient;
		expect(
			await autoImportByDownloadIdWithSdk(client, "radarr", "requested-download", {
				expectedMedia: { movieId: 10 },
			}),
		).toMatchObject({ commandId: 7, state: "pending" });
	});

	it("classifies a POST transport failure as an uncertain submission, not a known rejection", async () => {
		const client = {
			manualImport: { get: vi.fn().mockResolvedValue([candidate]) },
			post: vi.fn().mockRejectedValue(new Error("fixture timeout after acceptance")),
		} as unknown as RadarrClient;
		await expect(
			autoImportByDownloadIdWithSdk(client, "radarr", "requested-download", {
				expectedMedia: { movieId: 10 },
			}),
		).rejects.toMatchObject({ name: "ManualImportSubmissionUnknownError" });
	});
	it.each([undefined, "", "different-download"])(
		"rejects absent or mismatched provider download identity (%s)",
		(downloadId) => {
			const result = collectAutoManualImportFiles(
				"radarr",
				[{ ...candidate, downloadId }],
				"requested-download",
			);
			expect(result.files).toHaveLength(0);
			expect(result.skipped[0]).toContain("identifier");
		},
	);

	it("keeps only candidates explicitly belonging to the requested download", () => {
		const result = collectAutoManualImportFiles(
			"radarr",
			[candidate, { ...candidate, id: 2, path: "/fixture/other.mkv", downloadId: "foreign" }],
			"requested-download",
		);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]).toMatchObject({
			downloadId: "requested-download",
			path: "/fixture/item.mkv",
		});
		expect(result.skipped).toHaveLength(1);
	});

	it("allows only a valid torrent hash's case-normalized equivalent", () => {
		const result = collectAutoManualImportFiles(
			"radarr",
			[{ ...candidate, downloadId: "A".repeat(40) }],
			"a".repeat(40),
		);
		expect(result.files).toHaveLength(1);
	});

	it.each([{}, { movieId: 11 }])(
		"rejects unverified/mismatched current queue media mapping (%j)",
		(expectedMedia) => {
			const result = collectAutoManualImportFiles(
				"radarr",
				[candidate],
				"requested-download",
				expectedMedia,
			);
			expect(result.files).toHaveLength(0);
			expect(result.skipped[0]).toContain("mapping");
		},
	);

	it("accepts a provider candidate matching the verified current media mapping", () => {
		const result = collectAutoManualImportFiles("radarr", [candidate], "requested-download", {
			movieId: 10,
		});
		expect(result.files).toHaveLength(1);
	});

	it("accepts a compound Sonarr file containing the verified queue episode", () => {
		const compound: ManualImportCandidate = {
			service: "sonarr",
			id: 1,
			path: "/fixture/compound.mkv",
			downloadId: "requested-download",
			series: { id: 10 },
			seasonNumber: 1,
			episodes: [
				{ id: 101, seasonNumber: 1 },
				{ id: 102, seasonNumber: 1 },
			],
		};
		expect(
			collectAutoManualImportFiles("sonarr", [compound], "requested-download", {
				seriesId: 10,
				episodeId: 101,
			}).files,
		).toHaveLength(1);
		expect(
			collectAutoManualImportFiles("sonarr", [compound], "requested-download", {
				seriesId: 10,
				episodeId: 103,
			}).files,
		).toHaveLength(0);
	});

	it("matches a Sonarr season pack by verified series/season when no episode ID exists", () => {
		const pack: ManualImportCandidate = {
			service: "sonarr",
			id: 1,
			path: "/fixture/season.mkv",
			downloadId: "requested-download",
			series: { id: 10 },
			seasonNumber: 1,
			episodes: [
				{ id: 101, seasonNumber: 1 },
				{ id: 102, seasonNumber: 1 },
			],
		};
		expect(
			collectAutoManualImportFiles("sonarr", [pack], "requested-download", {
				seriesId: 10,
				episodeId: null,
				seasonNumber: 1,
			}).files,
		).toHaveLength(1);
		expect(
			collectAutoManualImportFiles("sonarr", [pack], "requested-download", {
				seriesId: 10,
				episodeId: null,
				seasonNumber: 2,
			}).files,
		).toHaveLength(0);
	});

	it.each([undefined, "foreign-download"])(
		"does not submit a command for identity-invalid provider candidates (%s)",
		async (downloadId) => {
			const post = vi.fn();
			const client = {
				manualImport: { get: vi.fn().mockResolvedValue([{ ...candidate, downloadId }]) },
				post,
			} as unknown as RadarrClient;
			await expect(
				autoImportByDownloadIdWithSdk(client, "radarr", "requested-download", {
					expectedMedia: { movieId: 10 },
				}),
			).rejects.toBeInstanceOf(ManualImportIdentityError);
			expect(post).not.toHaveBeenCalled();
		},
	);

	it("revalidates queue authority after provider file enumeration and before submission", async () => {
		const post = vi.fn();
		const client = {
			manualImport: { get: vi.fn().mockResolvedValue([candidate]) },
			post,
		} as unknown as RadarrClient;
		const beforeSubmit = vi.fn().mockRejectedValue(new ManualImportIdentityError());
		await expect(
			autoImportByDownloadIdWithSdk(client, "radarr", "requested-download", {
				expectedMedia: { movieId: 10 },
				beforeSubmit,
			}),
		).rejects.toBeInstanceOf(ManualImportIdentityError);
		expect(beforeSubmit).toHaveBeenCalledOnce();
		expect(post).not.toHaveBeenCalled();
	});

	it("submits only after matching download/media identity and the current authority check", async () => {
		const events: string[] = [];
		const post = vi.fn(async () => {
			events.push("command");
		});
		const client = {
			manualImport: { get: vi.fn().mockResolvedValue([candidate]) },
			post,
		} as unknown as RadarrClient;
		await autoImportByDownloadIdWithSdk(client, "radarr", "requested-download", {
			expectedMedia: { movieId: 10 },
			beforeSubmit: async () => {
				events.push("authority");
			},
		});
		expect(events).toEqual(["authority", "command"]);
		expect(post).toHaveBeenCalledWith(
			"/api/v3/command",
			expect.objectContaining({
				name: "ManualImport",
				files: [expect.objectContaining({ movieId: 10, downloadId: "requested-download" })],
			}),
		);
	});
});
