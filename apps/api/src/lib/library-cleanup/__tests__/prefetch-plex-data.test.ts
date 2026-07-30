/**
 * Cross-batch Map merge test for `prefetchPlexData` — pins the v2.18.4
 * cursor-pagination behavior. Distinct from the auto-tag pagination test
 * because the prefetcher *aggregates* across batches (same `mediaType:tmdbId`
 * appearing in batch 1 and batch 2 must merge into one map entry with summed
 * watchCount, deduped watchedByUsers, and union'd collections/labels).
 *
 * Without this test, a refactor that reset the map per batch (or used
 * `new Map()` inside the loop) would silently drop watch data and the
 * auto-tag test wouldn't catch it.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { plexConnectionFingerprint } from "../../plex/service-instance-fingerprint.js";
import {
	prefetchFreshPlexEpisodeWatchData,
	prefetchPlexData,
} from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

function makePlexRow(overrides: {
	id: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle?: string;
	watchCount?: number;
	watchedByUsers?: string[];
	collections?: string[];
	labels?: string[];
	lastWatchedAt?: Date | null;
	addedAt?: Date | null;
	onDeck?: boolean;
	userRating?: number | null;
}) {
	return {
		id: overrides.id,
		tmdbId: overrides.tmdbId,
		mediaType: overrides.mediaType,
		sectionId: overrides.sectionId,
		sectionTitle: overrides.sectionTitle ?? `Section ${overrides.sectionId}`,
		lastWatchedAt: overrides.lastWatchedAt ?? null,
		watchCount: overrides.watchCount ?? 0,
		watchedByUsers: JSON.stringify(overrides.watchedByUsers ?? []),
		onDeck: overrides.onDeck ?? false,
		userRating: overrides.userRating ?? null,
		collections: JSON.stringify(overrides.collections ?? []),
		labels: JSON.stringify(overrides.labels ?? []),
		addedAt: overrides.addedAt ?? null,
	};
}

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

describe("prefetchPlexData — cross-batch Map merge (v2.18.4 OOM fix)", () => {
	it("merges watch data when the same tmdbId appears across two batches", async () => {
		// Batch 1: 500 unique rows (forces a second findMany call). Last row is
		// movie tmdbId=42 in section "lib-1" with one user watch.
		const batch1 = Array.from({ length: 499 }, (_, i) =>
			makePlexRow({
				id: `pc-${i}`,
				tmdbId: 1000 + i,
				mediaType: "movie",
				sectionId: "lib-1",
			}),
		);
		batch1.push(
			makePlexRow({
				id: `pc-499`, // last id in batch — used as cursor for batch 2
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "lib-1",
				watchCount: 3,
				watchedByUsers: ["alice"],
				collections: ["Marvel"],
				labels: ["favorite"],
				lastWatchedAt: new Date("2026-01-01"),
			}),
		);

		// Batch 2: same tmdbId=42 in a different section "lib-2" with another user.
		// The cross-batch merge must (a) push a second `sections` entry,
		// (b) sum watchCount → 5, (c) dedupe watchedByUsers, (d) union
		// collections + labels, (e) take the latest lastWatchedAt.
		const batch2 = [
			makePlexRow({
				id: `pc-extra`,
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "lib-2",
				watchCount: 2,
				watchedByUsers: ["bob"],
				collections: ["Action"],
				labels: ["favorite"],
				lastWatchedAt: new Date("2026-02-01"),
			}),
		];

		const findManySpy = vi.fn().mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2);

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ id: "plex-inst-1" }]),
			},
			plexCache: { findMany: findManySpy },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		// Two findMany calls — pagination must have continued past batch 1.
		expect(findManySpy).toHaveBeenCalledTimes(2);

		// Single merged entry for movie:42 — NOT two separate entries.
		const merged = map?.get("movie:42");
		expect(merged).toBeDefined();
		expect(merged?.watchCount).toBe(5); // 3 + 2 across batches
		expect(merged?.watchedByUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(merged?.watchedByUsers).toHaveLength(2); // deduped
		expect(merged?.collections).toEqual(expect.arrayContaining(["Marvel", "Action"]));
		expect(merged?.labels).toEqual(["favorite"]); // deduped union
		expect(merged?.sections).toHaveLength(2); // one section per batch
		expect(merged?.lastWatchedAt?.toISOString()).toBe(new Date("2026-02-01").toISOString());
	});

	it("returns undefined when no Plex instances are configured", async () => {
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
			plexCache: { findMany: vi.fn() },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");
		expect(map).toBeUndefined();
	});

	it("terminates after a single short batch (no extra findMany call)", async () => {
		const findManySpy = vi
			.fn()
			.mockResolvedValueOnce([
				makePlexRow({ id: "pc-1", tmdbId: 1, mediaType: "movie", sectionId: "lib-1" }),
			]);

		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([{ id: "plex-inst-1" }]) },
			plexCache: { findMany: findManySpy },
		} as unknown as CleanupExecutorDeps["prisma"];

		const map = await prefetchPlexData({ prisma, log } as never, "user-1");

		expect(findManySpy).toHaveBeenCalledTimes(1);
		expect(map?.size).toBe(1);
	});
});

describe("prefetchFreshPlexEpisodeWatchData", () => {
	it("ignores fresh-looking evidence produced by the pre-repoint Plex connection", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://new-plex.internal:32400",
			encryptedApiKey: "new-encrypted-token",
			encryptionIv: "new-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			updatedAt: new Date("2026-07-30T11:30:00.000Z"),
		};
		const oldFingerprint = plexConnectionFingerprint({
			...currentInstance,
			baseUrl: "http://old-plex.internal:32400",
			encryptedApiKey: "old-encrypted-token",
			encryptionIv: "old-iv",
		} as never);
		const prisma = {
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 1,
						lastWatchedAt: now,
						watchedByUsers: "[]",
						ratingKey: "episode-123",
						// This timestamp is after the repoint. It models an old
						// in-flight refresh committing after settings changed.
						refreshedAt: new Date("2026-07-30T11:45:00.000Z"),
						sourceFingerprint: oldFingerprint,
					},
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result).toEqual(new Map());
		expect(warnings).toContainEqual(expect.stringContaining("stale Plex episode watch"));
	});

	it("accepts fresh episode evidence bound to the current Plex connection", async () => {
		const now = new Date("2026-07-30T12:00:00.000Z");
		const warnings: string[] = [];
		const currentInstance = {
			id: "plex-inst-1",
			service: "PLEX",
			enabled: true,
			baseUrl: "http://plex.internal:32400",
			encryptedApiKey: "encrypted-token",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			updatedAt: new Date("2026-07-30T10:00:00.000Z"),
		};
		const prisma = {
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-inst-1",
						showTmdbId: 42,
						seasonNumber: 1,
						episodeNumber: 2,
						watchCount: 3,
						lastWatchedAt: now,
						watchedByUsers: '["Viewer"]',
						ratingKey: "episode-123",
						refreshedAt: new Date("2026-07-30T11:45:00.000Z"),
						sourceFingerprint: plexConnectionFingerprint(currentInstance as never),
					},
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		const result = await prefetchFreshPlexEpisodeWatchData(
			{ prisma, log } as CleanupExecutorDeps,
			[currentInstance] as never,
			now,
			warnings,
		);

		expect(result.get("42:1:2")).toEqual([
			expect.objectContaining({
				plexInstanceId: "plex-inst-1",
				ratingKey: "episode-123",
				watchCount: 3,
			}),
		]);
		expect(warnings).toEqual([]);
	});
});
