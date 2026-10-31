import { describe, expect, it, vi } from "vitest";
import {
	classifyImportCommand,
	importCommandFingerprint,
	readImportCommandOutcome,
} from "../manual-import-command.js";

const files = [{ path: "/fixture/movie.mkv", downloadId: "fixture-download", movieId: 10 }];
const fingerprint = importCommandFingerprint(files)!;
const started = new Date("2026-09-30T12:00:00Z");
const command = {
	id: 7,
	name: "ManualImport",
	status: "completed",
	result: "successful",
	body: { files },
};
const imported = {
	id: 1,
	eventType: "downloadFolderImported",
	downloadId: "fixture-download",
	movieId: 10,
	date: "2026-09-30T12:01:00Z",
	data: { droppedPath: "/fixture/movie.mkv", fileId: "21" },
};
const page = (records: unknown[]) => ({
	page: 1,
	pageSize: 1000,
	totalRecords: records.length,
	records,
});

describe("manual import command receipts", () => {
	it.each([
		{
			media: { seriesId: 11, episodeIds: [12] },
			want: "v1:3dfc02a1f3002d0288877115b023a59441af2b9bcc8851947671aaa4d03e9f06",
		},
		{
			media: { movieId: 21 },
			want: "v1:3eeabe1f036ff738cbef7f7d11abf577f2ab5cec16d86dbd6afab7877b69430d",
		},
		{
			media: { artistId: 31, albumId: 32 },
			want: "v1:3cdb7e71ed77b57450ab2876ce231e33a4e39a6864cf7af9a0a1e640315c28e9",
		},
		{
			media: { authorId: 41, bookId: 42 },
			want: "v1:53de3774fd457e08ca6b292665e2c23b72f2e1807abcc8942b7ac42e7647b987",
		},
	])("retains the literal historical absent/null-edition command binding %#", ({ media, want }) => {
		const file = { path: "/old/file", downloadId: "old-source", ...media };
		expect(importCommandFingerprint([file])).toBe(want);
		expect(importCommandFingerprint([{ ...file, foreignEditionId: null }])).toBe(want);
	});
	it.each(["", " edition", "edition ", "x".repeat(1025), 1])(
		"rejects malformed non-null command edition %#",
		(foreignEditionId) => {
			expect(importCommandFingerprint([{ ...files[0], foreignEditionId }])).toBeNull();
		},
	);
	it("binds the exact Readarr edition in terminal command receipts", () => {
		const submitted = [
			{
				path: "/fixture/book.epub",
				downloadId: "source",
				authorId: 10,
				bookId: 20,
				foreignEditionId: "edition-1",
			},
		];
		const expected = importCommandFingerprint(submitted);
		const altered = [{ ...submitted[0], foreignEditionId: "edition-2" }];
		expect(importCommandFingerprint(altered)).not.toBe(expected);
		expect(classifyImportCommand({ ...command, body: { files: altered } }, expected).state).toBe(
			"unknown",
		);
		expect(classifyImportCommand({ ...command, body: { files: submitted } }, expected).state).toBe(
			"completed",
		);
	});
	it.each([
		{
			service: "lidarr",
			eventType: "trackFileImported",
			media: { artistId: 10, albumId: 20 },
			path: "/fixture/track.flac",
		},
		{
			service: "readarr",
			eventType: "bookFileImported",
			media: { authorId: 10, bookId: 20 },
			path: "/fixture/book.epub",
		},
	])(
		"verifies $service's exact file-import event, not a generic download event",
		async ({ service, eventType, media, path }) => {
			const submitted = [{ path, downloadId: "fixture-download", ...media }];
			const record = {
				...imported,
				movieId: undefined,
				...media,
				eventType,
				data: { droppedPath: path, fileId: "21" },
			};
			const get = vi
				.fn()
				.mockResolvedValueOnce({ ...command, body: { files: submitted } })
				.mockResolvedValueOnce(page([record]));
			expect(
				(
					await readImportCommandOutcome(
						{ get } as never,
						service,
						7,
						importCommandFingerprint(submitted),
						started,
					)
				).state,
			).toBe("completed");
			get
				.mockResolvedValueOnce({ ...command, body: { files: submitted } })
				.mockResolvedValueOnce(page([{ ...record, eventType: "downloadImported" }]));
			expect(
				(
					await readImportCommandOutcome(
						{ get } as never,
						service,
						7,
						importCommandFingerprint(submitted),
						started,
					)
				).state,
			).toBe("unknown");
		},
	);
	it.each(["queued", "started"])("never treats %s as import completion", (status) => {
		expect(classifyImportCommand({ ...command, status }, fingerprint)).toEqual({
			commandId: 7,
			state: "pending",
		});
	});
	it.each([
		{ ...command, id: 8 },
		{ ...command, name: "Rescan" },
		{ ...command, body: {} },
		{ ...command, body: { files: [{ ...files[0], movieId: 11 }] } },
		{ ...command, result: "unknown" },
	])("rejects a mismatched or uncertain terminal receipt", (receipt) => {
		expect(classifyImportCommand(receipt, fingerprint, 7).state).toBe("unknown");
	});
	it("fingerprints the unordered exact target set without storing paths", () => {
		const second = { ...files[0], path: "/fixture/second.mkv", movieId: 11 };
		expect(importCommandFingerprint([files[0], second])).toBe(
			importCommandFingerprint([second, files[0]]),
		);
		expect(fingerprint).toMatch(/^v1:[a-f0-9]{64}$/);
		expect(importCommandFingerprint([{ ...files[0], downloadId: "" }])).toBeNull();
	});
	it("does not count a successful command without positive file-import history", async () => {
		const get = vi.fn().mockResolvedValueOnce(command).mockResolvedValueOnce(page([]));
		expect(
			(await readImportCommandOutcome({ get } as never, "radarr", 7, fingerprint, started)).state,
		).toBe("unknown");
	});
	it.each([
		{ ...imported, downloadId: "foreign" },
		{ ...imported, movieId: 11 },
		{ ...imported, date: "2026-09-30T11:59:00Z" },
		{ ...imported, eventType: "grabbed" },
		{ ...imported, data: { droppedPath: "/fixture/other.mkv", fileId: "21" } },
		{ ...imported, data: { droppedPath: "/fixture/movie.mkv" } },
	])("rejects stale, foreign, incomplete, or mismatched positive history", async (record) => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(command)
			.mockResolvedValueOnce(page([record]));
		expect(
			(await readImportCommandOutcome({ get } as never, "radarr", 7, fingerprint, started)).state,
		).toBe("unknown");
	});
	it("confirms every requested file against current positive history", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(command)
			.mockResolvedValueOnce(page([imported]));
		expect(
			await readImportCommandOutcome({ get } as never, "radarr", 7, fingerprint, started),
		).toEqual({ commandId: 7, state: "completed" });
		expect(get).toHaveBeenCalledWith(
			"/api/v3/history",
			expect.objectContaining({ downloadId: "fixture-download", pageSize: 1000 }),
		);
	});
	it("requires every episode of a compound Sonarr file", async () => {
		const episodeFiles = [
			{
				path: "/fixture/compound.mkv",
				downloadId: "fixture-download",
				seriesId: 10,
				episodeIds: [1, 2],
			},
		];
		const history = [1, 2].map((episodeId) => ({
			...imported,
			movieId: undefined,
			seriesId: 10,
			episodeId,
			data: { droppedPath: "/fixture/compound.mkv", fileId: "21" },
		}));
		const get = vi
			.fn()
			.mockResolvedValueOnce({ ...command, body: { files: episodeFiles } })
			.mockResolvedValueOnce(page(history.slice(0, 1)));
		expect(
			(
				await readImportCommandOutcome(
					{ get } as never,
					"sonarr",
					7,
					importCommandFingerprint(episodeFiles),
					started,
				)
			).state,
		).toBe("unknown");
		get
			.mockResolvedValueOnce({ ...command, body: { files: episodeFiles } })
			.mockResolvedValueOnce(page(history));
		expect(
			(
				await readImportCommandOutcome(
					{ get } as never,
					"sonarr",
					7,
					importCommandFingerprint(episodeFiles),
					started,
				)
			).state,
		).toBe("completed");
	});
	it("retains unknown outcome on provider read failure", async () => {
		const get = vi.fn().mockRejectedValue(new Error("fixture provider unavailable"));
		expect(
			await readImportCommandOutcome({ get } as never, "radarr", 7, fingerprint, started),
		).toEqual({ commandId: 7, state: "unknown" });
	});
	it("recovers a lost POST acknowledgement from one exact recent command", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce([{ ...command, queued: "2026-09-30T12:00:01Z" }])
			.mockResolvedValueOnce(command)
			.mockResolvedValueOnce(page([imported]));
		expect(
			await readImportCommandOutcome({ get } as never, "radarr", null, fingerprint, started),
		).toEqual({ commandId: 7, state: "completed" });
	});
	it.each([
		{ commands: [] },
		{ commands: [{ ...command, queued: "2026-09-30T11:59:00Z" }] },
		{
			commands: [
				{ ...command, queued: "2026-09-30T12:00:01Z" },
				{ ...command, id: 8, queued: "2026-09-30T12:00:02Z" },
			],
		},
	])("does not infer submission absence or choose an ambiguous command", async ({ commands }) => {
		const get = vi.fn().mockResolvedValue(commands);
		expect(
			(await readImportCommandOutcome({ get } as never, "radarr", null, fingerprint, started))
				.state,
		).toBe("unknown");
		expect(get).toHaveBeenCalledOnce();
	});
});
