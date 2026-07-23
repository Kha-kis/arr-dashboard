import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../prisma.js";

const mocks = vi.hoisted(() => ({
	createQuiClient: vi.fn(),
	listQuiInstances: vi.fn(),
}));

vi.mock("../qui/client-factory.js", () => ({
	createQuiClient: mocks.createQuiClient,
}));

vi.mock("../qui/instance-helpers.js", () => ({
	listQuiInstances: mocks.listQuiInstances,
}));

import {
	createTorrentFilePolicyEvaluator,
	getFinalFileExtension,
	inspectTorrentFileNames,
	parseAllowedFileExtensions,
} from "./torrent-file-policy.js";

const HASH = "a".repeat(40);

function makeApp(): FastifyInstance {
	return {
		log: {
			warn: vi.fn(),
		},
	} as unknown as FastifyInstance;
}

function makeQuiInstance(): ServiceInstance {
	return {
		id: "qui-1",
		userId: "user-1",
		service: "QUI",
		enabled: true,
	} as ServiceInstance;
}

describe("torrent file policy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listQuiInstances.mockResolvedValue([makeQuiInstance()]);
	});

	it("canonicalizes case, optional dots, duplicates, and ordering", () => {
		expect(parseAllowedFileExtensions('[".MKV","srt","mkv","NFO"]')).toEqual({
			ok: true,
			extensions: ["mkv", "nfo", "srt"],
			serialized: '["mkv","nfo","srt"]',
		});
	});

	it.each([["not json"], ['{"mkv":true}'], ['["mkv.exe"]'], ['["../mkv"]'], ['[""]'], ["[42]"]])(
		"rejects unsafe or ambiguous allowlists: %s",
		(value) => {
			expect(parseAllowedFileExtensions(value).ok).toBe(false);
		},
	);

	it("rejects oversized allowlist JSON before parsing it", () => {
		expect(parseAllowedFileExtensions(`["${"a".repeat(5000)}"]`).ok).toBe(false);
	});

	it.each([
		["folder/Movie.MKV", "mkv"],
		["folder\\subtitle.en.SRT", "srt"],
		["movie.mkv.exe", "exe"],
		["README", "(no extension)"],
		[".env", "(no extension)"],
		["name.", "(no extension)"],
		[`name.${"x".repeat(1000)}`, "(invalid extension)"],
		["name.bad\nvalue", "(invalid extension)"],
	])("uses the exact final extension for %s", (name, expected) => {
		expect(getFinalFileExtension(name)).toBe(expected);
	});

	it("rejects a mixed expected/unexpected manifest as a whole-torrent violation", () => {
		const result = inspectTorrentFileNames(
			["Movie.mkv", "subs/Movie.srt", "extras/launcher.EXE"],
			new Set(["mkv", "srt"]),
		);

		expect(result).toEqual({
			status: "violation",
			offendingExtensions: ["exe"],
			reason: "Torrent contains file types outside the allowlist: .exe",
		});
	});

	it("accepts a manifest only when every final extension is allowed", () => {
		expect(
			inspectTorrentFileNames(
				["Movie.MKV", "subs/Movie.en.SRT", "metadata/movie.NFO"],
				new Set(["mkv", "nfo", "srt"]),
			),
		).toEqual({ status: "compliant" });
	});

	it("bounds and sanitizes attacker-controlled extension labels in reasons", () => {
		const result = inspectTorrentFileNames(
			[
				...Array.from({ length: 20 }, (_, index) => `file.bad${index}`),
				`file.${"x".repeat(1000)}`,
				"file.control\nsuffix",
			],
			new Set(["mkv"]),
		);

		expect(result.status).toBe("violation");
		if (result.status !== "violation") throw new Error("expected violation");
		expect(result.offendingExtensions).toHaveLength(10);
		expect(result.reason).toContain("and additional types");
		expect(result.reason).not.toContain("x".repeat(100));
		expect(result.reason).not.toContain("\n");
	});

	it("inspects every qui file entry, including priority-zero files", async () => {
		const getTorrentFiles = vi.fn().mockResolvedValue([
			{ index: 0, name: "Movie.mkv", size: 1, progress: 1, priority: 1 },
			{ index: 1, name: "payload.exe", size: 1, progress: 0, priority: 0 },
		]);
		mocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash: HASH, instanceId: 7 }),
			getTorrentFiles,
		});

		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const [result] = await evaluator.evaluateMany([
			{ protocol: "torrent", downloadId: HASH.toUpperCase() },
		]);

		expect(mocks.listQuiInstances).toHaveBeenCalledWith(expect.anything(), "user-1");
		expect(getTorrentFiles).toHaveBeenCalledWith(7, HASH, { refresh: true });
		expect(result?.status).toBe("violation");
	});

	it("defers instead of approving or deleting when metadata is empty", async () => {
		mocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash: HASH, instanceId: 7 }),
			getTorrentFiles: vi.fn().mockResolvedValue([]),
		});

		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const [result] = await evaluator.evaluateMany([{ protocol: "torrent", downloadId: HASH }]);

		expect(result).toEqual({
			status: "deferred",
			reason: "File allowlist check deferred because qui returned no torrent file metadata",
		});
	});

	it("defers when the user has no enabled qui instance", async () => {
		mocks.listQuiInstances.mockResolvedValue([]);

		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const [result] = await evaluator.evaluateMany([{ protocol: "torrent", downloadId: HASH }]);

		expect(result).toEqual({
			status: "deferred",
			reason: "File allowlist check deferred because no enabled qui instance is configured",
		});
		expect(mocks.createQuiClient).not.toHaveBeenCalled();
	});

	it("caches duplicate queue hashes within one cleaner run", async () => {
		const getTorrentByHash = vi.fn().mockResolvedValue({ hash: HASH, instanceId: 7 });
		const getTorrentFiles = vi
			.fn()
			.mockResolvedValue([{ index: 0, name: "Movie.mkv", size: 1, progress: 1, priority: 1 }]);
		mocks.createQuiClient.mockReturnValue({ getTorrentByHash, getTorrentFiles });

		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const results = await evaluator.evaluateMany([
			{ protocol: "torrent", downloadId: HASH },
			{ protocol: "torrent", downloadId: HASH.toUpperCase() },
		]);

		expect(results).toEqual([{ status: "compliant" }, { status: "compliant" }]);
		expect(getTorrentByHash).toHaveBeenCalledTimes(1);
		expect(getTorrentFiles).toHaveBeenCalledTimes(1);
	});

	it("inspects a hash-shaped download id when *arr omits the protocol", async () => {
		mocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash: HASH, instanceId: 7 }),
			getTorrentFiles: vi
				.fn()
				.mockResolvedValue([{ index: 0, name: "payload.exe", size: 1, progress: 0, priority: 0 }]),
		});

		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const [result] = await evaluator.evaluateMany([{ downloadId: HASH }]);

		expect(result?.status).toBe("violation");
	});

	it("does not inspect non-torrent queue items", async () => {
		const evaluator = createTorrentFilePolicyEvaluator(makeApp(), "user-1", ["mkv"]);
		const [result] = await evaluator.evaluateMany([{ protocol: "usenet", downloadId: HASH }]);

		expect(result).toEqual({ status: "not_applicable" });
		expect(mocks.listQuiInstances).not.toHaveBeenCalled();
	});
});
