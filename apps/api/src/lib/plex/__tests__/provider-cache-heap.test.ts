/**
 * Production-shaped heap regression for issue #694.
 *
 * Opt in with TEST_HEAP=true and run Node with --expose-gc. The reporter's
 * v2.23.0 process retained roughly 550 MB immediately after publishing a
 * 15k-row Plex cache and 12k-row Emby cache. This exercises the current
 * replacement-publication path against real SQLite/Prisma instead of mocks.
 */

import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { refreshJellyfinCache } from "../../jellyfin/jellyfin-cache-refresher.js";
import type { JellyfinClient, JellyfinItem } from "../../jellyfin/jellyfin-client.js";
import type { PrismaClient } from "../../prisma.js";
import { refreshPlexCache } from "../plex-cache-refresher.js";
import type { PlexClient, PlexLibraryItem } from "../plex-client.js";

const RUN_HEAP_TESTS = process.env.TEST_HEAP === "true";
const MIB = 1024 * 1024;
const PLEX_ITEMS = 15_000;
const JELLYFIN_ITEMS = 12_000;

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function collectHeap(): number {
	if (!global.gc) throw new Error("Run this heap test with Node --expose-gc");
	global.gc();
	global.gc();
	return process.memoryUsage().heapUsed;
}

function reportHeap(message: string): void {
	process.stdout.write(`${message}\n`);
}

(RUN_HEAP_TESTS ? describe : describe.skip)(
	"provider cache publication heap (TEST_HEAP=true)",
	() => {
		let prisma: PrismaClient;
		let plexClient: PlexClient;
		let jellyfinClient: JellyfinClient;

		beforeAll(async () => {
			const testDb = process.env.PROVIDER_CACHE_TEST_DB_PATH;
			if (!testDb) throw new Error("Run this test through pnpm test:provider-cache-heap");
			prisma = createTestPrismaClient(testDb);

			await prisma.user.create({ data: { id: "heap-user", username: "heap-user" } });
			await prisma.serviceInstance.createMany({
				data: [
					{
						id: "heap-plex",
						userId: "heap-user",
						service: "PLEX",
						label: "Heap Plex",
						baseUrl: "http://plex.invalid",
						encryptedApiKey: "x",
						encryptionIv: "y",
					},
					{
						id: "heap-emby",
						userId: "heap-user",
						service: "EMBY",
						label: "Heap Emby",
						baseUrl: "http://emby.invalid",
						encryptedApiKey: "x",
						encryptionIv: "y",
					},
				],
			});

			const plexItems: PlexLibraryItem[] = Array.from({ length: PLEX_ITEMS }, (_, index) => ({
				ratingKey: `plex-${index}`,
				title: `Plex Movie ${index}`,
				type: "movie",
				Guid: [{ id: `tmdb://${100_000 + index}` }],
				Collection: [{ tag: `Collection ${index % 20}` }],
				Label: [{ tag: `Label ${index % 10}` }],
				addedAt: 1_700_000_000 + index,
				thumb: `/library/metadata/${index}/thumb`,
			}));
			plexClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue(plexItems),
				getHistory: vi.fn().mockResolvedValue([]),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;

			const jellyfinItems: JellyfinItem[] = Array.from({ length: JELLYFIN_ITEMS }, (_, index) => ({
				id: `emby-${index}`,
				name: `Emby Movie ${index}`,
				type: "Movie",
				tmdbId: 200_000 + index,
				played: index % 3 === 0,
				playCount: index % 3 === 0 ? 1 : 0,
				lastPlayedDate: index % 3 === 0 ? "2026-01-01T00:00:00Z" : null,
				isFavorite: index % 11 === 0,
				dateCreated: "2025-01-01T00:00:00Z",
				imageTags: { Primary: `image-${index}` },
			}));
			jellyfinClient = {
				getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
				getLibraries: vi
					.fn()
					.mockResolvedValue([{ id: "movies", name: "Movies", collectionType: "movies" }]),
				getLibraryItems: vi.fn().mockResolvedValue(jellyfinItems),
				getResumeItems: vi.fn().mockResolvedValue([]),
				getNextUp: vi.fn().mockResolvedValue([]),
			} as unknown as JellyfinClient;
		}, 120_000);

		afterAll(async () => {
			await prisma.$disconnect();
		});

		async function refreshPlexAndAssert(): Promise<void> {
			const plex = await refreshPlexCache(plexClient, prisma, "heap-plex", silentLog, undefined);
			expect(plex).toMatchObject({ complete: true, errors: 0, upserted: PLEX_ITEMS });
		}

		async function refreshJellyfinAndAssert(): Promise<void> {
			const jellyfin = await refreshJellyfinCache(jellyfinClient, prisma, "heap-emby", silentLog);
			expect(jellyfin).toMatchObject({ complete: true, errors: 0, upserted: JELLYFIN_ITEMS });
		}

		async function refreshBoth(): Promise<void> {
			await refreshPlexAndAssert();
			await refreshJellyfinAndAssert();
		}

		it("does not retain the v2.23.0 post-refresh heap spike", async () => {
			const baseline = collectHeap();
			reportHeap(`Provider cache baseline heap: ${(baseline / MIB).toFixed(1)} MB`);

			await refreshPlexAndAssert();
			const afterPlex = collectHeap();
			reportHeap(`Provider cache heap after Plex publication: ${(afterPlex / MIB).toFixed(1)} MB`);

			await refreshJellyfinAndAssert();
			const afterFirst = collectHeap();
			const firstGrowth = afterFirst - baseline;
			reportHeap(
				`Provider cache heap growth after first publication: ${(firstGrowth / MIB).toFixed(1)} MB`,
			);

			for (let cycle = 0; cycle < 3; cycle++) await refreshBoth();
			const afterRepeated = collectHeap();
			const repeatedGrowth = afterRepeated - afterFirst;
			reportHeap(
				`Provider cache heap growth after three more publications: ${(repeatedGrowth / MIB).toFixed(1)} MB`,
			);
			// The attached #694 log retained ~552 MB. Allow normal Prisma/V8 warmup,
			// while failing far below the production regression.
			expect(firstGrowth).toBeLessThan(100 * MIB);
			expect(repeatedGrowth).toBeLessThan(50 * MIB);
		}, 180_000);

		it("rolls back Plex deletion and earlier chunks when a later chunk fails", async () => {
			await prisma.plexCache.deleteMany({ where: { instanceId: "heap-plex" } });
			await prisma.plexCache.create({
				data: {
					instanceId: "heap-plex",
					tmdbId: 100_000,
					mediaType: "movie",
					sectionId: "1",
					sectionTitle: "Movies",
					title: "Preserved Plex generation",
					ratingKey: "old-plex",
					watchedByUsers: "[]",
					collections: "[]",
					labels: "[]",
				},
			});
			await prisma.$executeRawUnsafe(`
				CREATE TRIGGER fail_plex_second_chunk
				BEFORE INSERT ON plex_cache
				WHEN NEW.ratingKey = 'plex-100'
				BEGIN
					SELECT RAISE(ABORT, 'injected Plex second chunk failure');
				END
			`);

			try {
				const result = await refreshPlexCache(
					plexClient,
					prisma,
					"heap-plex",
					silentLog,
					undefined,
				);
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(result.errorMessages.join(" ")).toMatch(
					/Atomic Plex cache publication failed:.*constraint/is,
				);
				expect(await prisma.plexCache.findMany({ where: { instanceId: "heap-plex" } })).toEqual([
					expect.objectContaining({ title: "Preserved Plex generation", ratingKey: "old-plex" }),
				]);
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_plex_second_chunk");
			}
		}, 120_000);

		it("rolls back Jellyfin deletion and earlier chunks when a later chunk fails", async () => {
			await prisma.jellyfinCache.deleteMany({ where: { instanceId: "heap-emby" } });
			await prisma.jellyfinCache.create({
				data: {
					instanceId: "heap-emby",
					tmdbId: 200_000,
					mediaType: "movie",
					libraryId: "movies",
					libraryName: "Movies",
					title: "Preserved Emby generation",
					jellyfinId: "old-emby",
					watchedByUsers: "[]",
					collections: "[]",
				},
			});
			await prisma.$executeRawUnsafe(`
				CREATE TRIGGER fail_jellyfin_second_chunk
				BEFORE INSERT ON jellyfin_cache
				WHEN NEW.jellyfinId = 'emby-100'
				BEGIN
					SELECT RAISE(ABORT, 'injected Jellyfin second chunk failure');
				END
			`);

			try {
				const result = await refreshJellyfinCache(jellyfinClient, prisma, "heap-emby", silentLog);
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(result.errorMessages.join(" ")).toMatch(
					/Atomic cache publication failed:.*constraint/is,
				);
				expect(await prisma.jellyfinCache.findMany({ where: { instanceId: "heap-emby" } })).toEqual(
					[expect.objectContaining({ title: "Preserved Emby generation", jellyfinId: "old-emby" })],
				);
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_jellyfin_second_chunk");
			}
		}, 120_000);
	},
);
