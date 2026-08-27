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
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
} from "../../services/provider-identity-guard.js";
import { refreshTautulliCache } from "../../tautulli/tautulli-cache-refresher.js";
import type { TautulliClient } from "../../tautulli/tautulli-client.js";
import { refreshPlexCache } from "../plex-cache-refresher.js";
import type { PlexClient, PlexLibraryItem } from "../plex-client.js";
import { encodeAuthoritativePlexGenerationMetadata } from "../plex-generation-metadata.js";
import {
	calculatePlexGenerationTargetDigest,
	type PlexGenerationTarget,
} from "../plex-generation-target-ledger.js";
import { prefetchPlexData } from "../../library-cleanup/cleanup-executor.js";
import type { CleanupExecutorDeps } from "../../library-cleanup/types.js";

const publication = vi.hoisted(() => ({
	plexClient: undefined as PlexClient | undefined,
	jellyfinClient: undefined as JellyfinClient | undefined,
	tautulliClient: undefined as TautulliClient | undefined,
}));

vi.mock("../plex-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plex-client.js")>();
	return {
		...actual,
		PlexClient: class {
			constructor() {
				if (!publication.plexClient) throw new Error("Plex heap client was not configured");
				Object.assign(this, publication.plexClient);
			}
		},
	};
});

vi.mock("../../utils/delay.js", () => ({ delay: vi.fn(async () => {}) }));

vi.mock("../../jellyfin/jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../jellyfin/jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.jellyfinClient) {
					throw new Error("Jellyfin heap client was not configured");
				}
				Object.assign(this, publication.jellyfinClient);
			}
		},
	};
});

vi.mock("../../tautulli/tautulli-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tautulli/tautulli-client.js")>();
	return {
		...actual,
		TautulliClient: class {
			constructor() {
				if (!publication.tautulliClient) {
					throw new Error("Tautulli heap client was not configured");
				}
				Object.assign(this, publication.tautulliClient);
			}
		},
	};
});

vi.mock("../../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: vi.fn(
			async (
				prisma: PrismaClient,
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
				options: unknown,
			) => {
				const snapshot = await collect();
				return await prisma.$transaction(
					async (tx) => await publish(tx, snapshot),
					options as never,
				);
			},
		),
	};
});

vi.mock("../plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plex-authority-service.js")>();
	const repository = await import("../plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			constructor(
				private readonly deps: {
					prisma: Parameters<typeof repository.scanInstancePolicyEvidence>[0];
				},
			) {}

			async readInstance(input: Parameters<typeof repository.scanInstancePolicyEvidence>[1]) {
				return await repository.scanInstancePolicyEvidence(this.deps.prisma, input);
			}

			async scanInstancePolicy(input: Parameters<typeof repository.scanInstancePolicyEvidence>[1]) {
				return await repository.scanInstancePolicyEvidence(this.deps.prisma, input);
			}

			async scanInstanceExactPolicy(
				input: Parameters<typeof repository.scanInstancePolicyEvidence>[1],
			) {
				return await new actual.PlexAuthorityService({
					prisma: this.deps.prisma as never,
					log: silentLog,
				}).scanInstanceExactPolicyPersisted(input);
			}

			async scanInstanceExactPolicyPersisted(
				input: Parameters<typeof repository.scanInstancePolicyEvidence>[1],
			) {
				return await this.scanInstanceExactPolicy(input);
			}
		},
	};
});

const RUN_HEAP_TESTS = process.env.TEST_HEAP === "true";
const MIB = 1024 * 1024;
const PLEX_ITEMS = 15_000;
const JELLYFIN_ITEMS = 12_000;
const TAUTULLI_ITEMS = 20_000;
const PLEX_POLICY_READ_ITEMS_PER_INSTANCE = 10_000;
const PLEX_POLICY_READ_INSTANCES = ["heap-read-plex-a", "heap-read-plex-b"] as const;

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
		let plexPublicationInstance: OwnedProviderPublicationSnapshot;
		let jellyfinClient: JellyfinClient;
		let tautulliClient: TautulliClient;

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
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						enabled: true,
						connectionGeneration: 0,
						expectedIdentity: "plex-a",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityGeneration: 0,
						identityVerifiedAt: new Date("2020-01-01T00:00:00.000Z"),
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
					{
						id: "heap-tautulli",
						userId: "heap-user",
						service: "TAUTULLI",
						label: "Heap Tautulli",
						baseUrl: "http://tautulli.invalid",
						encryptedApiKey: "x",
						encryptionIv: "y",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						enabled: true,
						connectionGeneration: 0,
						expectedIdentity: "plex-a",
						identityKind: "TAUTULLI_PMS_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityGeneration: 0,
						identityVerifiedAt: new Date("2020-01-01T00:00:00.000Z"),
					},
				],
			});
			const persistedPlex = await prisma.serviceInstance.findUniqueOrThrow({
				where: { id: "heap-plex" },
			});
			plexPublicationInstance = {
				...createProviderPublicationAuthority(persistedPlex),
				apiKey: "token",
				httpAuthHeaders: {},
				label: persistedPlex.label,
			};

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
				getActivities: vi.fn().mockResolvedValue([]),
				getLibrarySettlementSections: vi.fn().mockResolvedValue([
					{
						key: "1",
						title: "Movies",
						type: "movie",
						uuid: "movies-uuid",
						refreshing: false,
						scannedAt: 1,
						updatedAt: 1,
					},
				]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue(plexItems),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
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

			const tautulliCatalog = Array.from({ length: TAUTULLI_ITEMS }, (_, index) => ({
				section_id: "1",
				rating_key: `tautulli-${index}`,
				media_type: "movie",
				play_count: index % 2,
				last_played: index % 2 === 0 ? 1_700_000_000 + index : null,
			}));
			const tautulliHistory = Array.from({ length: 201 }, (_, index) => ({
				row_id: index + 1,
				rating_key: `tautulli-${index}`,
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: `Tautulli Movie ${index}`,
				grandparent_title: "",
				media_type: "movie",
				user: "Alice",
				date: 1_700_000_000 + index,
				play_count: 1,
			}));
			tautulliClient = {
				getLibraries: vi.fn().mockResolvedValue([
					{
						section_id: "1",
						section_name: "Movies",
						section_type: "movie",
						count: String(TAUTULLI_ITEMS),
					},
				]),
				refreshLibraryMediaInfo: vi.fn().mockResolvedValue(undefined),
				getLibraryMediaInfo: vi.fn(
					async ({ start, length }: { start: number; length: number }) => ({
						data: tautulliCatalog.slice(start, start + length),
						recordsFiltered: tautulliCatalog.length,
						recordsTotal: tautulliCatalog.length,
						last_refreshed: 1_777_000_100,
					}),
				),
				getHistory: vi.fn(async ({ start, length }: { start: number; length: number }) => ({
					data: tautulliHistory.slice(start, start + length),
					recordsFiltered: tautulliHistory.length,
					recordsTotal: tautulliHistory.length,
				})),
				getMetadata: vi.fn(async (ratingKey: string) => ({
					rating_key: ratingKey,
					section_id: "1",
					guids: [`tmdb://${300_000 + Number(ratingKey.replace("tautulli-", ""))}`],
					media_type: "movie",
					guid: `plex://movie/${ratingKey}`,
					title: ratingKey,
				})),
			} as unknown as TautulliClient;
		}, 120_000);

		afterAll(async () => {
			await prisma.$disconnect();
		});

		async function refreshPlexAndAssert(): Promise<void> {
			publication.plexClient = plexClient;
			const sectionCallsBefore = vi.mocked(plexClient.getLibrarySections).mock.calls.length;
			const itemCallsBefore = vi.mocked(plexClient.getLibraryItems).mock.calls.length;
			const plex = await refreshPlexCache({
				prisma,
				instance: plexPublicationInstance,
				log: silentLog,
			});
			expect(plex).toMatchObject({ complete: true, errors: 0, upserted: PLEX_ITEMS });
			expect(plex.superseded).not.toBe(true);
			expect(vi.mocked(plexClient.getLibrarySections).mock.calls.length).toBeGreaterThan(
				sectionCallsBefore,
			);
			expect(vi.mocked(plexClient.getLibraryItems).mock.calls.length).toBeGreaterThan(
				itemCallsBefore,
			);
			expect(
				await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: "heap-plex", cacheType: "plex" } },
				}),
			).toMatchObject({
				lastResult: "success",
				lastAttemptResult: "success",
				itemCount: PLEX_ITEMS,
				connectionGeneration: plexPublicationInstance.connectionGeneration,
				identityGeneration: plexPublicationInstance.identityGeneration,
			});
		}

		async function refreshJellyfinAndAssert(): Promise<void> {
			publication.jellyfinClient = jellyfinClient;
			const jellyfin = await refreshJellyfinCache({
				prisma,
				instance: {
					id: "heap-emby",
					userId: "heap-user",
					service: "EMBY",
					label: "Heap Emby",
					baseUrl: "http://emby.invalid",
					apiKey: "token",
					httpAuthHeaders: {},
					enabled: true,
					encryptedApiKey: "x",
					encryptionIv: "y",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					expectedIdentity: "emby-a",
					identityStatus: "VERIFIED",
					connectionGeneration: 0,
					identityGeneration: 0,
				},
				log: silentLog,
			});
			expect(jellyfin).toMatchObject({ complete: true, errors: 0, upserted: JELLYFIN_ITEMS });
		}

		async function refreshTautulli(): Promise<Awaited<ReturnType<typeof refreshTautulliCache>>> {
			publication.tautulliClient = tautulliClient;
			return await refreshTautulliCache({
				prisma,
				instance: {
					id: "heap-tautulli",
					userId: "heap-user",
					service: "TAUTULLI",
					label: "Heap Tautulli",
					baseUrl: "http://tautulli.invalid",
					apiKey: "token",
					httpAuthHeaders: {},
					enabled: true,
					encryptedApiKey: "x",
					encryptionIv: "y",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					expectedIdentity: "plex-a",
					identityStatus: "VERIFIED",
					connectionGeneration: 0,
					identityGeneration: 0,
				},
				log: silentLog,
			});
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

		it("bounds a deterministic 20,000-target Tautulli exact publication", async () => {
			const baseline = collectHeap();
			let peak = baseline;
			const sample = setInterval(() => {
				peak = Math.max(peak, process.memoryUsage().heapUsed);
			}, 5);
			let result: Awaited<ReturnType<typeof refreshTautulliCache>>;
			try {
				result = await refreshTautulli();
			} finally {
				clearInterval(sample);
				peak = Math.max(peak, process.memoryUsage().heapUsed);
			}
			const retained = collectHeap();
			const catalogRequests = vi.mocked(tautulliClient.getLibraryMediaInfo).mock.calls.length;
			const metadataRequests = vi.mocked(tautulliClient.getMetadata).mock.calls.length;
			reportHeap(
				`Tautulli exact publication: targets=${TAUTULLI_ITEMS} catalogRequests=${catalogRequests} metadataRequests=${metadataRequests} peakGrowth=${((peak - baseline) / MIB).toFixed(1)} MB retainedGrowth=${((retained - baseline) / MIB).toFixed(1)} MB`,
			);
			expect(result).toMatchObject({ complete: true, errors: 0, upserted: TAUTULLI_ITEMS });
			expect(catalogRequests).toBe(Math.ceil(TAUTULLI_ITEMS / 250) * 2);
			expect(metadataRequests).toBe(TAUTULLI_ITEMS * 2);
			expect(
				await prisma.tautulliGenerationObservation.count({
					where: { instanceId: "heap-tautulli" },
				}),
			).toBe(TAUTULLI_ITEMS);
			expect(await prisma.tautulliCache.count({ where: { instanceId: "heap-tautulli" } })).toBe(
				TAUTULLI_ITEMS,
			);
			expect(peak - baseline).toBeLessThan(350 * MIB);
			expect(retained - baseline).toBeLessThan(125 * MIB);
		}, 180_000);

		it("bounds the production-shaped full-library policy read", async () => {
			await prisma.user.create({
				data: { id: "heap-read-user", username: "heap-read-user", hashedPassword: "hash" },
			});
			const completedAt = new Date();
			for (const [instanceIndex, instanceId] of PLEX_POLICY_READ_INSTANCES.entries()) {
				const generationId = `generation-${instanceId}`;
				const targets: PlexGenerationTarget[] = [];
				await prisma.serviceInstance.create({
					data: {
						id: instanceId,
						userId: "heap-read-user",
						service: "PLEX",
						label: `Heap Read Plex ${instanceIndex + 1}`,
						baseUrl: `http://${instanceId}.invalid`,
						encryptedApiKey: "x",
						encryptionIv: "y",
						enabled: true,
						connectionGeneration: 4,
						expectedIdentity: `plex-read-${instanceIndex + 1}`,
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityStatus: "VERIFIED",
						identityGeneration: 9,
						identityVerifiedAt: completedAt,
					},
				});
				for (let start = 0; start < PLEX_POLICY_READ_ITEMS_PER_INSTANCE; start += 250) {
					const rows = Array.from({ length: 250 }, (_, offset) => {
						const index = start + offset;
						const unique = `${instanceIndex}-${String(index).padStart(5, "0")}`;
						return {
							id: `${instanceId}-${String(index).padStart(5, "0")}`,
							instanceId,
							tmdbId: instanceIndex * PLEX_POLICY_READ_ITEMS_PER_INSTANCE + index + 1,
							mediaType: "movie",
							sectionId: `section-${index % 4}`,
							sectionTitle: `Movies ${index % 4}`,
							title: `${unique}-${"t".repeat(480)}`,
							ratingKey: `${unique}-${"r".repeat(480)}`,
							thumb: `/library/${unique}/${"p".repeat(480)}`,
							lastWatchedAt: index % 3 === 0 ? completedAt : null,
							watchCount: index % 6,
							watchedByUsers: JSON.stringify([`user-${index % 8}`]),
							onDeck: index % 11 === 0,
							userRating: index % 10,
							collections: JSON.stringify([`Collection ${index % 20}`]),
							labels: JSON.stringify([`Label ${index % 10}`]),
							addedAt: completedAt,
							connectionGeneration: 4,
							identityGeneration: 9,
						};
					});
					await prisma.plexCache.createMany({ data: rows });
					const ledgerRows = rows.map((row) => ({
						instanceId,
						generationId,
						sectionId: row.sectionId,
						sectionUuid: `${row.sectionId}-uuid`,
						mediaType: "movie" as const,
						tmdbId: row.tmdbId,
						tvdbId: null,
						ratingKey: row.ratingKey,
					}));
					targets.push(...ledgerRows);
					await prisma.plexGenerationTarget.createMany({ data: ledgerRows });
				}
				const targetLedger = {
					targetLedgerVersion: 1 as const,
					targetCount: targets.length,
					targetDigest: calculatePlexGenerationTargetDigest({
						instanceId,
						generationId,
						connectionGeneration: 4,
						identityGeneration: 9,
						targets,
					}),
				};
				await prisma.cacheRefreshStatus.create({
					data: {
						instanceId,
						cacheType: "plex",
						lastRefreshedAt: completedAt,
						lastResult: "success",
						itemCount: PLEX_POLICY_READ_ITEMS_PER_INSTANCE,
						generationId,
						generationMetadata: encodeAuthoritativePlexGenerationMetadata({
							sections: Array.from({ length: 4 }, (_, section) => ({
								key: `section-${section}`,
								uuid: `section-${section}-uuid`,
								title: `Movies ${section}`,
								type: "movie" as const,
								refreshing: false as const,
								scannedAt: 1,
								updatedAt: 1,
							})),
							itemCount: PLEX_POLICY_READ_ITEMS_PER_INSTANCE,
							canonicalizationVersion: 1,
							roots: Array.from({ length: 4 }, (_, section) => ({
								sectionKey: `section-${section}`,
								domain: "membership" as const,
								digest: "a".repeat(64),
							})),
							targetLedger,
						}),
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
						connectionGeneration: 4,
						identityGeneration: 9,
					},
				});
			}

			const selectedFields: Array<Record<string, boolean>> = [];
			const batchSizes: number[] = [];
			let readCalls = 0;
			let observedPeak = 0;
			const readPrisma = {
				serviceInstance: prisma.serviceInstance,
				cacheRefreshStatus: prisma.cacheRefreshStatus,
				plexGenerationTarget: prisma.plexGenerationTarget,
				plexCache: {
					findMany: async (args: Parameters<typeof prisma.plexCache.findMany>[0]) => {
						const rows = await prisma.plexCache.findMany(args as never);
						readCalls += 1;
						selectedFields.push((args?.select ?? {}) as Record<string, boolean>);
						batchSizes.push(rows.length);
						if (readCalls % 10 === 0) observedPeak = Math.max(observedPeak, collectHeap());
						return rows;
					},
					count: async (args: Parameters<typeof prisma.plexCache.count>[0]) =>
						await prisma.plexCache.count(args),
				},
			} as unknown as CleanupExecutorDeps["prisma"];

			const baseline = collectHeap();
			observedPeak = baseline;
			let policyMap = await prefetchPlexData(
				{ prisma: readPrisma, log: silentLog } as CleanupExecutorDeps,
				"heap-read-user",
			);
			const afterFirstLoad = collectHeap();
			const logicalMapCount = policyMap?.size ?? 0;
			policyMap = undefined;
			const afterFirstRelease = collectHeap();
			for (let cycle = 0; cycle < 2; cycle++) {
				policyMap = await prefetchPlexData(
					{ prisma: readPrisma, log: silentLog } as CleanupExecutorDeps,
					"heap-read-user",
				);
				expect(policyMap?.size).toBe(20_000);
				policyMap = undefined;
				collectHeap();
			}
			const afterRepeatedRelease = collectHeap();
			reportHeap(
				`Plex policy read heap: rows=20000 map=${logicalMapCount} baseline=${(
					baseline / MIB
				).toFixed(1)}MB peak=${(observedPeak / MIB).toFixed(1)}MB postLoad=${(
					afterFirstLoad / MIB
				).toFixed(1)}MB postRelease=${(afterFirstRelease / MIB).toFixed(1)}MB repeatedRelease=${(
					afterRepeatedRelease / MIB
				).toFixed(1)}MB queries=${readCalls}`,
			);

			expect(logicalMapCount).toBe(20_000);
			expect(Math.max(...batchSizes)).toBeLessThanOrEqual(500);
			expect(selectedFields).not.toHaveLength(0);
			for (const select of selectedFields) {
				expect(select).not.toHaveProperty("title");
				expect(select).toHaveProperty("ratingKey", true);
				expect(select).not.toHaveProperty("thumb");
			}
			expect(afterRepeatedRelease - afterFirstRelease).toBeLessThan(16 * MIB);
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
				publication.plexClient = plexClient;
				const sectionCallsBefore = vi.mocked(plexClient.getLibrarySections).mock.calls.length;
				const itemCallsBefore = vi.mocked(plexClient.getLibraryItems).mock.calls.length;
				const result = await refreshPlexCache({
					prisma,
					instance: plexPublicationInstance,
					log: silentLog,
				});
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(result.superseded).not.toBe(true);
				expect(result.errorMessages.join(" ")).toMatch(
					/Atomic Plex cache publication failed:.*constraint/is,
				);
				expect(vi.mocked(plexClient.getLibrarySections).mock.calls.length).toBeGreaterThan(
					sectionCallsBefore,
				);
				expect(vi.mocked(plexClient.getLibraryItems).mock.calls.length).toBeGreaterThan(
					itemCallsBefore,
				);
				const rows = await prisma.plexCache.findMany({ where: { instanceId: "heap-plex" } });
				expect(rows).toEqual([
					expect.objectContaining({ title: "Preserved Plex generation", ratingKey: "old-plex" }),
				]);
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_plex_second_chunk");
			}
		}, 120_000);

		it("rolls back Plex rows when the success-status write fails", async () => {
			await prisma.plexCache.deleteMany({ where: { instanceId: "heap-plex" } });
			await prisma.plexCache.create({
				data: {
					instanceId: "heap-plex",
					tmdbId: 100_000,
					mediaType: "movie",
					sectionId: "1",
					sectionTitle: "Movies",
					title: "Preserved before status failure",
					ratingKey: "old-status-plex",
					watchedByUsers: "[]",
					collections: "[]",
					labels: "[]",
				},
			});
			const previousStatusAt = new Date("2026-01-01T00:00:00.000Z");
			await prisma.cacheRefreshStatus.upsert({
				where: { instanceId_cacheType: { instanceId: "heap-plex", cacheType: "plex" } },
				create: {
					instanceId: "heap-plex",
					cacheType: "plex",
					lastRefreshedAt: previousStatusAt,
					lastResult: "success",
					itemCount: 1,
				},
				update: {
					lastRefreshedAt: previousStatusAt,
					lastResult: "success",
					itemCount: 1,
				},
			});
			await prisma.$executeRawUnsafe(`
				CREATE TRIGGER fail_plex_success_status
				BEFORE UPDATE ON cache_refresh_status
				WHEN NEW.instanceId = 'heap-plex'
					AND NEW.cacheType = 'plex'
					AND NEW.lastResult = 'success'
					AND NEW.lastAttemptResult = 'success'
				BEGIN
					SELECT RAISE(ABORT, 'injected Plex status failure');
				END
			`);

			try {
				publication.plexClient = plexClient;
				const sectionCallsBefore = vi.mocked(plexClient.getLibrarySections).mock.calls.length;
				const itemCallsBefore = vi.mocked(plexClient.getLibraryItems).mock.calls.length;
				const result = await refreshPlexCache({
					prisma,
					instance: plexPublicationInstance,
					log: silentLog,
				});
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(result.superseded).not.toBe(true);
				expect(result.errorMessages.join(" ")).toMatch(
					/Atomic Plex cache publication failed:.*constraint/is,
				);
				expect(vi.mocked(plexClient.getLibrarySections).mock.calls.length).toBeGreaterThan(
					sectionCallsBefore,
				);
				expect(vi.mocked(plexClient.getLibraryItems).mock.calls.length).toBeGreaterThan(
					itemCallsBefore,
				);
				const rows = await prisma.plexCache.findMany({ where: { instanceId: "heap-plex" } });
				expect(rows).toEqual([
					expect.objectContaining({
						title: "Preserved before status failure",
						ratingKey: "old-status-plex",
					}),
				]);
				expect(
					await prisma.cacheRefreshStatus.findUnique({
						where: { instanceId_cacheType: { instanceId: "heap-plex", cacheType: "plex" } },
					}),
				).toEqual(
					expect.objectContaining({
						lastRefreshedAt: previousStatusAt,
						lastResult: "success",
						lastAttemptResult: "error",
						itemCount: 1,
					}),
				);
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_plex_success_status");
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
				publication.jellyfinClient = jellyfinClient;
				const result = await refreshJellyfinCache({
					prisma,
					instance: {
						id: "heap-emby",
						userId: "heap-user",
						service: "EMBY",
						label: "Heap Emby",
						baseUrl: "http://emby.invalid",
						apiKey: "token",
						httpAuthHeaders: {},
						enabled: true,
						encryptedApiKey: "x",
						encryptionIv: "y",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						expectedIdentity: "emby-a",
						identityStatus: "VERIFIED",
						connectionGeneration: 0,
						identityGeneration: 0,
					},
					log: silentLog,
				});
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

		it("rolls back Tautulli deletion and earlier chunks when a later chunk fails", async () => {
			await prisma.tautulliCache.deleteMany({ where: { instanceId: "heap-tautulli" } });
			await prisma.tautulliCache.create({
				data: {
					instanceId: "heap-tautulli",
					tmdbId: 1,
					mediaType: "movie",
					lastWatchedAt: new Date("2025-01-01T00:00:00.000Z"),
					watchCount: 1,
					watchedByUsers: "[]",
				},
			});
			await prisma.$executeRawUnsafe(`
				CREATE TRIGGER fail_tautulli_second_chunk
				BEFORE INSERT ON tautulli_cache
				WHEN NEW.tmdbId = 300100
				BEGIN
					SELECT RAISE(ABORT, 'injected Tautulli second chunk failure');
				END
			`);

			try {
				const result = await refreshTautulli();
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(
					await prisma.tautulliCache.findMany({ where: { instanceId: "heap-tautulli" } }),
				).toEqual([expect.objectContaining({ tmdbId: 1, watchCount: 1 })]);
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_tautulli_second_chunk");
			}
		}, 120_000);

		it("rolls back Tautulli rows when the success-status write fails", async () => {
			await prisma.tautulliCache.deleteMany({ where: { instanceId: "heap-tautulli" } });
			await prisma.tautulliCache.create({
				data: {
					instanceId: "heap-tautulli",
					tmdbId: 2,
					mediaType: "movie",
					lastWatchedAt: new Date("2025-01-01T00:00:00.000Z"),
					watchCount: 1,
					watchedByUsers: "[]",
				},
			});
			const previousStatusAt = new Date("2026-01-01T00:00:00.000Z");
			await prisma.cacheRefreshStatus.upsert({
				where: {
					instanceId_cacheType: { instanceId: "heap-tautulli", cacheType: "tautulli" },
				},
				create: {
					instanceId: "heap-tautulli",
					cacheType: "tautulli",
					lastRefreshedAt: previousStatusAt,
					lastResult: "success",
					itemCount: 1,
				},
				update: { lastRefreshedAt: previousStatusAt, lastResult: "success", itemCount: 1 },
			});
			await prisma.$executeRawUnsafe(`
				CREATE TRIGGER fail_tautulli_success_status
				BEFORE UPDATE ON cache_refresh_status
				WHEN NEW.instanceId = 'heap-tautulli' AND NEW.cacheType = 'tautulli'
				BEGIN
					SELECT RAISE(ABORT, 'injected Tautulli status failure');
				END
			`);

			try {
				const result = await refreshTautulli();
				expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
				expect(
					await prisma.tautulliCache.findMany({ where: { instanceId: "heap-tautulli" } }),
				).toEqual([expect.objectContaining({ tmdbId: 2, watchCount: 1 })]);
				expect(
					await prisma.cacheRefreshStatus.findUnique({
						where: {
							instanceId_cacheType: {
								instanceId: "heap-tautulli",
								cacheType: "tautulli",
							},
						},
					}),
				).toEqual(expect.objectContaining({ lastRefreshedAt: previousStatusAt, itemCount: 1 }));
			} finally {
				await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_tautulli_success_status");
			}
		}, 120_000);
	},
);
