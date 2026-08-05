import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	normalizeDownloadId,
	partitionByGatedHashes,
	resolveQuiAwareGateReasons,
} from "../qui-gate.js";

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

describe("resolveQuiAwareGateReasons", () => {
	const NOW = new Date("2026-08-03T16:00:00.000Z");
	const FRESH = new Date("2026-08-03T15:50:00.000Z");

	function mockPrisma(
		rows: Array<{
			infoHash: string | null;
			torrentState: string | null;
			torrentSyncedAt: Date | null;
		}>,
		enabledQui = true,
	): PrismaClient {
		return {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(enabledQui ? { id: "qui-1" } : null),
			},
			libraryCache: {
				findMany: vi.fn().mockResolvedValue(rows),
			},
		} as unknown as PrismaClient;
	}

	it("returns empty set when no items have hashes (no qui correlation possible)", async () => {
		const prisma = mockPrisma([]);
		const result = await resolveQuiAwareGateReasons(prisma, "user-1", new Map(), NOW);
		expect(result.size).toBe(0);
		// Should not even hit the DB for an empty map.
		expect((prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
	});

	it("returns gated item ids when their hashes match gated rows", async () => {
		const prisma = mockPrisma([
			{ infoHash: "aaaa", torrentState: "paused", torrentSyncedAt: FRESH },
			{ infoHash: "cccc", torrentState: "error", torrentSyncedAt: FRESH },
		]);
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "bbbb"],
			["item-3", "cccc"],
		]);
		const result = await resolveQuiAwareGateReasons(prisma, "user-1", map, NOW);
		expect([...result.entries()].sort()).toEqual([
			["item-1", "paused_or_error"],
			["item-2", "evidence_unavailable"],
			["item-3", "paused_or_error"],
		]);
	});

	it("fails closed when qUI has no cache row for any requested hash", async () => {
		const result = await resolveQuiAwareGateReasons(
			mockPrisma([]),
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
			]),
			NOW,
		);
		expect([...result.entries()].sort()).toEqual([
			["item-1", "evidence_unavailable"],
			["item-2", "evidence_unavailable"],
		]);
	});

	it("filters cache rows by userId through the instance relation", async () => {
		const findMany = vi.fn().mockResolvedValue([]);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue({ id: "qui-1" }) },
			libraryCache: { findMany },
		} as unknown as PrismaClient;

		await resolveQuiAwareGateReasons(prisma, "user-1", new Map([["item-1", "aaaa"]]), NOW);
		const callArgs = findMany.mock.calls[0]?.[0];
		// Ownership flows through `instance.userId` — `LibraryCache` has no
		// direct `userId` column. An earlier version of this gate used
		// `where: { userId, ... }` which raised PrismaClientValidationError
		// at runtime; the surrounding try/catch in the route swallowed it
		// and the feature was silently inert in production. Lock the
		// relation-traversal shape so a regression can't silently re-emerge.
		expect(callArgs.where.instance).toEqual({ userId: "user-1" });
		expect(callArgs.where).not.toHaveProperty("userId");
		expect(callArgs.where.infoHash.in).toEqual(["aaaa"]);
		expect(callArgs.select).toEqual({
			infoHash: true,
			torrentState: true,
			torrentSyncedAt: true,
		});
	});

	it("returns no reason for a fresh active state or an explicit fresh null state", async () => {
		const prisma = mockPrisma([
			{ infoHash: "aaaa", torrentState: "seeding", torrentSyncedAt: FRESH },
			{ infoHash: "bbbb", torrentState: null, torrentSyncedAt: FRESH },
		]);
		const result = await resolveQuiAwareGateReasons(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
			]),
			NOW,
		);
		expect(result.size).toBe(0);
	});

	it.each([
		["invalidated", null],
		["stale", new Date("2026-08-03T15:20:00.000Z")],
	] as const)("fails closed when correlated qUI evidence is %s", async (_label, observedAt) => {
		const prisma = mockPrisma([
			{ infoHash: "aaaa", torrentState: null, torrentSyncedAt: observedAt },
		]);
		const result = await resolveQuiAwareGateReasons(
			prisma,
			"user-1",
			new Map([["item-1", "aaaa"]]),
			NOW,
		);
		expect(result.get("item-1")).toBe("evidence_unavailable");
	});

	it.each(["stale-first", "fresh-first"] as const)(
		"keeps duplicate mixed-age evidence unavailable regardless of row order (%s)",
		async (order) => {
			const stale = {
				infoHash: "aaaa",
				torrentState: "seeding",
				torrentSyncedAt: new Date("2026-08-03T15:20:00.000Z"),
			};
			const fresh = {
				infoHash: "aaaa",
				torrentState: null,
				torrentSyncedAt: FRESH,
			};
			const rows = order === "stale-first" ? [stale, fresh] : [fresh, stale];
			const result = await resolveQuiAwareGateReasons(
				mockPrisma(rows),
				"user-1",
				new Map([["item-1", "aaaa"]]),
				NOW,
			);
			expect(result.get("item-1")).toBe("evidence_unavailable");
		},
	);

	it("preserves original strike behavior when no qUI is enabled", async () => {
		const prisma = mockPrisma(
			[{ infoHash: "aaaa", torrentState: null, torrentSyncedAt: null }],
			false,
		);
		const result = await resolveQuiAwareGateReasons(
			prisma,
			"user-1",
			new Map([["item-1", "aaaa"]]),
			NOW,
		);
		expect(result.size).toBe(0);
		expect(prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it("deduplicates hashes before the DB query (multiple queue items, one torrent)", async () => {
		const findMany = vi
			.fn()
			.mockResolvedValue([{ infoHash: "aaaa", torrentState: "paused", torrentSyncedAt: FRESH }]);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue({ id: "qui-1" }) },
			libraryCache: { findMany },
		} as unknown as PrismaClient;

		await resolveQuiAwareGateReasons(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "aaaa"],
			]),
			NOW,
		);
		expect(findMany.mock.calls[0]?.[0].where.infoHash.in).toEqual(["aaaa"]);
	});
});
