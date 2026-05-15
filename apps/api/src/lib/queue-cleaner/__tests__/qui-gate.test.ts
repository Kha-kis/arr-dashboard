import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { normalizeDownloadId, partitionByGatedHashes, resolveGatedItemIds } from "../qui-gate.js";

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

describe("resolveGatedItemIds", () => {
	function mockPrisma(rows: Array<{ infoHash: string | null }>): PrismaClient {
		return {
			libraryCache: {
				findMany: vi.fn().mockResolvedValue(rows),
			},
		} as unknown as PrismaClient;
	}

	it("returns empty set when no items have hashes (no qui correlation possible)", async () => {
		const prisma = mockPrisma([]);
		const result = await resolveGatedItemIds(prisma, "user-1", new Map());
		expect(result.size).toBe(0);
		// Should not even hit the DB for an empty map.
		expect((prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
	});

	it("returns gated item ids when their hashes match gated rows", async () => {
		const prisma = mockPrisma([{ infoHash: "aaaa" }, { infoHash: "cccc" }]);
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "bbbb"],
			["item-3", "cccc"],
		]);
		const result = await resolveGatedItemIds(prisma, "user-1", map);
		expect(Array.from(result).sort()).toEqual(["item-1", "item-3"]);
	});

	it("filters by userId (via instance relation) and the gated states (paused/error)", async () => {
		const findMany = vi.fn().mockResolvedValue([]);
		const prisma = {
			libraryCache: { findMany },
		} as unknown as PrismaClient;

		await resolveGatedItemIds(prisma, "user-1", new Map([["item-1", "aaaa"]]));
		const callArgs = findMany.mock.calls[0]?.[0];
		// Ownership flows through `instance.userId` — `LibraryCache` has no
		// direct `userId` column. An earlier version of this gate used
		// `where: { userId, ... }` which raised PrismaClientValidationError
		// at runtime; the surrounding try/catch in the route swallowed it
		// and the feature was silently inert in production. Lock the
		// relation-traversal shape so a regression can't silently re-emerge.
		expect(callArgs.where.instance).toEqual({ userId: "user-1" });
		expect(callArgs.where).not.toHaveProperty("userId");
		expect(callArgs.where.torrentState.in).toEqual(["paused", "error"]);
		expect(callArgs.where.infoHash.in).toEqual(["aaaa"]);
	});

	it("returns empty set when qui has the hash but state is not gated", async () => {
		// LibraryCache row exists for the hash but its state isn't paused/error,
		// so the WHERE clause excludes it — findMany returns empty.
		const prisma = mockPrisma([]);
		const result = await resolveGatedItemIds(prisma, "user-1", new Map([["item-1", "aaaa"]]));
		expect(result.size).toBe(0);
	});

	it("deduplicates hashes before the DB query (multiple queue items, one torrent)", async () => {
		const findMany = vi.fn().mockResolvedValue([{ infoHash: "aaaa" }]);
		const prisma = {
			libraryCache: { findMany },
		} as unknown as PrismaClient;

		await resolveGatedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "aaaa"],
			]),
		);
		expect(findMany.mock.calls[0]?.[0].where.infoHash.in).toEqual(["aaaa"]);
	});
});
