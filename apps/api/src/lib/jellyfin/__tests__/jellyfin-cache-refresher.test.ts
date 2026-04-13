/**
 * Jellyfin Cache Refresher Tests
 *
 * Validates the aggregation logic inside refreshJellyfinCache, with a focus
 * on the partially-watched series fix: lastWatchedAt should be set whenever
 * lastPlayedDate is present, even if item.played === false.
 */

import { describe, expect, it, vi } from "vitest";
import { refreshJellyfinCache } from "../jellyfin-cache-refresher.js";
import type { JellyfinClient, JellyfinItem, JellyfinLibrary, JellyfinUser } from "../jellyfin-client.js";
import type { FastifyBaseLogger } from "fastify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeSeriesItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
	return {
		id: "jf-series-1",
		name: "Amadeus",
		type: "Series",
		tmdbId: 99999,
		played: false,
		playCount: 0,
		lastPlayedDate: null,
		isFavorite: false,
		imageTags: {},
		...overrides,
	};
}

const oneUser: JellyfinUser[] = [{ id: "user-1", name: "Alice" }];
const oneLibrary: JellyfinLibrary[] = [{ id: "lib-1", name: "TV Shows", collectionType: "tvshows" }];

/**
 * Build a minimal mock JellyfinClient that serves the given library items.
 */
function makeMockClient(items: JellyfinItem[]): JellyfinClient {
	return {
		getUsers: vi.fn().mockResolvedValue(oneUser),
		getLibraries: vi.fn().mockResolvedValue(oneLibrary),
		getLibraryItems: vi.fn().mockResolvedValue(items),
		getResumeItems: vi.fn().mockResolvedValue([]),
		getNextUp: vi.fn().mockResolvedValue([]),
	} as unknown as JellyfinClient;
}

/**
 * Build a minimal Prisma stub that captures upsert payloads.
 */
function makeMockPrisma() {
	const upserts: unknown[] = [];
	const stub = {
		jellyfinCache: {
			upsert: vi.fn((args: unknown) => {
				upserts.push(args);
				return Promise.resolve({});
			}),
		},
		$transaction: vi.fn(async (ops: unknown[]) => {
			for (const op of ops) await op;
		}),
	};
	return { stub, upserts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshJellyfinCache — lastWatchedAt aggregation", () => {
	it("sets lastWatchedAt for a fully-watched series (item.played === true)", async () => {
		const item = makeSeriesItem({
			played: true,
			playCount: 2,
			lastPlayedDate: "2024-05-10T20:00:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-05-10T20:00:00Z"));
	});

	it("sets lastWatchedAt for a partially-watched series (played=false, lastPlayedDate set)", async () => {
		// This is the regression case: user watched 2/5 episodes but not all.
		// Jellyfin marks the Series item as played=false, but still sets lastPlayedDate.
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: "2024-06-15T18:30:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null; watchCount: number } }).create;
		// lastWatchedAt must be set so the episode-cache refresher picks up this series
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-15T18:30:00Z"));
		// watchCount stays 0 — the series wasn't fully watched
		expect(payload.watchCount).toBe(0);
	});

	it("leaves lastWatchedAt null when neither played nor lastPlayedDate is set", async () => {
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: null,
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toBeNull();
	});

	it("picks the most recent lastPlayedDate across multiple users for the same series", async () => {
		// Simulate the per-user iteration: same series returned for two users with
		// different lastPlayedDate values — we want the latest date to win.
		const olderItem = makeSeriesItem({ lastPlayedDate: "2024-03-01T10:00:00Z" });
		const newerItem = makeSeriesItem({ lastPlayedDate: "2024-06-20T22:00:00Z" });

		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];

		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			// First call (Alice) returns older, second call (Bob) returns newer
			getLibraryItems: vi.fn()
				.mockResolvedValueOnce([olderItem])
				.mockResolvedValueOnce([newerItem]),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;

		const { stub, upserts } = makeMockPrisma();
		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-20T22:00:00Z"));
	});
});
