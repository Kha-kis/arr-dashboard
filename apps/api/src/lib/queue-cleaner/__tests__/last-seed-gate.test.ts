import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { partitionByReferencedHashes, resolveLibraryReferencedItemIds } from "../last-seed-gate.js";

describe("partitionByReferencedHashes", () => {
	it("returns empty set when no hashes are referenced", () => {
		const map = new Map([["item-1", "aaaa"]]);
		const referenced = new Set<string>();
		expect(partitionByReferencedHashes(map, referenced).protectedItemIds.size).toBe(0);
	});

	it("returns item ids whose hash is in the referenced set", () => {
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "bbbb"],
			["item-3", "cccc"],
		]);
		const referenced = new Set(["aaaa", "cccc"]);
		const result = partitionByReferencedHashes(map, referenced);
		expect(Array.from(result.protectedItemIds).sort()).toEqual(["item-1", "item-3"]);
	});

	it("handles the same hash mapped to multiple items (deduplicated download)", () => {
		const map = new Map([
			["item-1", "aaaa"],
			["item-2", "aaaa"],
		]);
		const referenced = new Set(["aaaa"]);
		expect(
			Array.from(partitionByReferencedHashes(map, referenced).protectedItemIds).sort(),
		).toEqual(["item-1", "item-2"]);
	});
});

describe("resolveLibraryReferencedItemIds", () => {
	function mockPrisma(args: {
		libraryRows?: Array<{ infoHash: string | null }>;
		episodeRows?: Array<{ infoHash: string | null }>;
		libraryThrows?: boolean;
		episodeThrows?: boolean;
	}): PrismaClient {
		return {
			libraryCache: {
				findMany: vi.fn().mockImplementation(() => {
					if (args.libraryThrows) throw new Error("library DB error");
					return Promise.resolve(args.libraryRows ?? []);
				}),
			},
			episodeFileCache: {
				findMany: vi.fn().mockImplementation(() => {
					if (args.episodeThrows) throw new Error("episode DB error");
					return Promise.resolve(args.episodeRows ?? []);
				}),
			},
		} as unknown as PrismaClient;
	}

	it("returns empty set when no items have hashes (no qui correlation possible)", async () => {
		const prisma = mockPrisma({});
		const result = await resolveLibraryReferencedItemIds(prisma, "user-1", new Map());
		expect(result.size).toBe(0);
		// Skips the DB entirely on empty input.
		expect((prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		expect((prisma.episodeFileCache.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			0,
		);
	});

	it("protects items whose hash appears in LibraryCache (movie / artist case)", async () => {
		const prisma = mockPrisma({ libraryRows: [{ infoHash: "aaaa" }, { infoHash: "cccc" }] });
		const result = await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
				["item-3", "cccc"],
			]),
		);
		expect(Array.from(result).sort()).toEqual(["item-1", "item-3"]);
	});

	it("protects items whose hash appears in EpisodeFileCache (series case)", async () => {
		const prisma = mockPrisma({ episodeRows: [{ infoHash: "bbbb" }] });
		const result = await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
			]),
		);
		expect(Array.from(result)).toEqual(["item-2"]);
	});

	it("unions LibraryCache + EpisodeFileCache references (cross-source coverage)", async () => {
		// A torrent might appear in both caches simultaneously if e.g. the
		// EpisodeFileCache row was populated AND the LibraryCache series row
		// shares the hash for legacy reasons. Either source counts as a
		// protection signal.
		const prisma = mockPrisma({
			libraryRows: [{ infoHash: "aaaa" }],
			episodeRows: [{ infoHash: "bbbb" }, { infoHash: "aaaa" }],
		});
		const result = await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
				["item-3", "cccc"],
			]),
		);
		expect(Array.from(result).sort()).toEqual(["item-1", "item-2"]);
	});

	it("filters by userId via instance relation, requires hasFile=true for LibraryCache", async () => {
		const libFindMany = vi.fn().mockResolvedValue([]);
		const epFindMany = vi.fn().mockResolvedValue([]);
		const prisma = {
			libraryCache: { findMany: libFindMany },
			episodeFileCache: { findMany: epFindMany },
		} as unknown as PrismaClient;

		await resolveLibraryReferencedItemIds(prisma, "user-1", new Map([["item-1", "aaaa"]]));

		// LibraryCache query: instance ownership + hasFile=true guard so we
		// don't protect torrents whose *arr row exists but has no file (e.g.
		// just-imported placeholder rows or items where the file was
		// deleted out-of-band).
		const libArgs = libFindMany.mock.calls[0]?.[0];
		expect(libArgs.where.instance).toEqual({ userId: "user-1" });
		expect(libArgs.where).not.toHaveProperty("userId");
		expect(libArgs.where.hasFile).toBe(true);
		expect(libArgs.where.infoHash.in).toEqual(["aaaa"]);

		// EpisodeFileCache doesn't have a hasFile column — the row's
		// existence implies a file on disk.
		const epArgs = epFindMany.mock.calls[0]?.[0];
		expect(epArgs.where.instance).toEqual({ userId: "user-1" });
		expect(epArgs.where).not.toHaveProperty("hasFile");
		expect(epArgs.where.infoHash.in).toEqual(["aaaa"]);
	});

	it("deduplicates hashes before the DB query", async () => {
		const libFindMany = vi.fn().mockResolvedValue([]);
		const epFindMany = vi.fn().mockResolvedValue([]);
		const prisma = {
			libraryCache: { findMany: libFindMany },
			episodeFileCache: { findMany: epFindMany },
		} as unknown as PrismaClient;

		await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "aaaa"],
			]),
		);
		expect(libFindMany.mock.calls[0]?.[0].where.infoHash.in).toEqual(["aaaa"]);
		expect(epFindMany.mock.calls[0]?.[0].where.infoHash.in).toEqual(["aaaa"]);
	});

	// ── Fail-closed behavior ──────────────────────────────────────────
	// Asymmetric error policy vs qui-gate.ts: any DB error here is
	// treated as "we don't know, so protect everything." Data loss is
	// irrecoverable; cleanup latency is not.

	it("fails CLOSED when LibraryCache query throws — protects all hashed candidates", async () => {
		const prisma = mockPrisma({ libraryThrows: true });
		const result = await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
			]),
		);
		expect(Array.from(result).sort()).toEqual(["item-1", "item-2"]);
	});

	it("fails CLOSED when EpisodeFileCache query throws — protects all hashed candidates", async () => {
		const prisma = mockPrisma({ episodeThrows: true });
		const result = await resolveLibraryReferencedItemIds(
			prisma,
			"user-1",
			new Map([
				["item-1", "aaaa"],
				["item-2", "bbbb"],
			]),
		);
		expect(Array.from(result).sort()).toEqual(["item-1", "item-2"]);
	});
});
