import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	normalizeDownloadId,
	partitionByGatedHashes,
	resolveQuiAwareGateReasons,
} from "../qui-gate.js";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../qui/torrent-observation-repository.js", () => ({
	readQuiTorrentObservations: read,
}));

describe("normalizeDownloadId", () => {
	it("lowercases a valid 40-hex SHA-1 hash", () => {
		expect(normalizeDownloadId("ABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(
			"abcdef1234567890abcdef1234567890abcdef12",
		);
	});

	it("accepts 64-hex SHA-256 hashes (v2 torrents)", () => {
		const hash = "a".repeat(64);
		expect(normalizeDownloadId(hash)).toBe(hash);
	});

	it("rejects strings that aren't hex of the right length", () => {
		expect(normalizeDownloadId("not-a-hash")).toBeNull();
		expect(normalizeDownloadId("123")).toBeNull();
		expect(normalizeDownloadId("a".repeat(39))).toBeNull(); // 39 chars
		expect(normalizeDownloadId("a".repeat(41))).toBeNull();
		expect(normalizeDownloadId("a".repeat(63))).toBeNull();
		expect(normalizeDownloadId("a".repeat(65))).toBeNull(); // 65 chars
	});

	it("rejects NZB-style and magnet-style IDs", () => {
		// SABnzbd / NZBGet IDs
		expect(normalizeDownloadId("SABnzbd_nzo_abc123")).toBeNull();
		// Magnet URIs
		expect(normalizeDownloadId("magnet:?xt=urn:btih:abc")).toBeNull();
	});

	it("returns null for non-string inputs", () => {
		expect(normalizeDownloadId(undefined)).toBeNull();
		expect(normalizeDownloadId(null)).toBeNull();
		expect(normalizeDownloadId(123)).toBeNull();
		expect(normalizeDownloadId({})).toBeNull();
	});
});

describe("partitionByGatedHashes", () => {
	it("returns empty set when no hashes are gated", () => {
		const map = new Map([["item-1", "aaaa"]]);
		const gated = new Set<string>();
		expect(partitionByGatedHashes(map, gated).gatedItemIds.size).toBe(0);
	});

	it("returns item ids whose hash is in the gated set", () => {
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "bbbb"],
			["item-3", "cccc"],
		]);
		const gated = new Set(["aaaa", "cccc"]);
		const result = partitionByGatedHashes(map, gated);
		expect(Array.from(result.gatedItemIds).sort()).toEqual(["item-1", "item-3"]);
	});

	it("handles the same hash mapped to multiple items (deduplicated download)", () => {
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "aaaa"],
		]);
		const gated = new Set(["aaaa"]);
		expect(Array.from(partitionByGatedHashes(map, gated).gatedItemIds).sort()).toEqual([
			"item-1",
			"item-2",
		]);
	});
});

describe("resolveQuiAwareGateReasons authoritative repository INPUT contracts", () => {
	const prisma = {} as PrismaClient,
		now = new Date("2026-08-03T16:00:00Z"),
		h = "a".repeat(40),
		other = "b".repeat(64);
	beforeEach(() => read.mockReset());
	const available = (rows: Map<string, { state: string; ratio: number | null }>) => ({
		status: "available",
		generation: "input",
		observedAt: now,
		rows,
	});
	it("does not read for an empty candidate map", async () => {
		expect(await resolveQuiAwareGateReasons(prisma, "owner", new Map(), now)).toEqual(new Map());
		expect(read).not.toHaveBeenCalled();
	});
	it("passes exact owner, deduplicated hashes and clock to the typed authority", async () => {
		read.mockResolvedValue(available(new Map()));
		await resolveQuiAwareGateReasons(
			prisma,
			"owner",
			new Map([
				["1", h],
				["2", h],
			]),
			now,
		);
		expect(read).toHaveBeenCalledExactlyOnceWith(prisma, "owner", [h], now);
	});
	it("protects paused/error but allows active and complete missing-hash absence", async () => {
		read.mockResolvedValue(
			available(
				new Map([
					[h, { state: "paused", ratio: 0 }],
					[other, { state: "error", ratio: null }],
				]),
			),
		);
		expect(
			await resolveQuiAwareGateReasons(
				prisma,
				"owner",
				new Map([
					["1", h],
					["2", other],
					["3", "c".repeat(40)],
				]),
				now,
			),
		).toEqual(
			new Map([
				["1", "paused_or_error"],
				["2", "paused_or_error"],
			]),
		);
		read.mockResolvedValue(available(new Map([[h, { state: "seeding", ratio: 1 }]])));
		expect(await resolveQuiAwareGateReasons(prisma, "owner", new Map([["1", h]]), now)).toEqual(
			new Map(),
		);
	});
	it.each([
		"missing",
		"incomplete",
		"stale",
		"future",
		"topology-changed",
		"generation-count-changed",
	])("protects every candidate when repository reports %s authority unavailable", async () => {
		read.mockResolvedValue({ status: "unavailable" });
		expect(
			await resolveQuiAwareGateReasons(
				prisma,
				"owner",
				new Map([
					["1", h],
					["2", other],
				]),
				now,
			),
		).toEqual(
			new Map([
				["1", "evidence_unavailable"],
				["2", "evidence_unavailable"],
			]),
		);
	});
	it("preserves optional behavior when no qUI source is enabled", async () => {
		read.mockResolvedValue({ status: "not_configured" });
		expect(await resolveQuiAwareGateReasons(prisma, "owner", new Map([["1", h]]), now)).toEqual(
			new Map(),
		);
	});
	it("treats unknown as unavailable only for that hash, preserving known unrelated usability", async () => {
		read.mockResolvedValue(
			available(
				new Map([
					[h, { state: "unknown", ratio: null }],
					[other, { state: "seeding", ratio: 1 }],
				]),
			),
		);
		expect(
			await resolveQuiAwareGateReasons(
				prisma,
				"owner",
				new Map([
					["unknown", h],
					["known", other],
				]),
				now,
			),
		).toEqual(new Map([["unknown", "evidence_unavailable"]]));
	});
});
