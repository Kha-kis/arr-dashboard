import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.js";
import { publishAuthoritativePlexCacheGeneration } from "../plex/plex-cache-storage.js";
import {
	encodeAuthoritativePlexGenerationMetadata,
	evaluatePlexMutationAuthority,
} from "../plex/plex-generation-metadata.js";
import {
	beginPlexCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
} from "./provider-cache-status.js";
import type { ProviderPublicationAuthority } from "./provider-identity-guard.js";

const apiRoot = join(process.cwd());
const log = { warn: vi.fn() };
const databases: Array<{ client: PrismaClient; directory: string }> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		databases.splice(0).map(async ({ client, directory }) => {
			await client.$disconnect();
			await rm(directory, { recursive: true, force: true });
		}),
	);
});

async function createDatabase(): Promise<PrismaClient> {
	const directory = await mkdtemp(join(tmpdir(), "provider-cache-status-"));
	const databasePath = join(directory, "status.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: apiRoot,
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	const client = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 1_000 }),
	});
	await client.$connect();
	databases.push({ client, directory });
	return client;
}

const authority: ProviderPublicationAuthority = {
	id: "plex-1",
	userId: "user-1",
	service: "PLEX",
	baseUrl: "https://plex.invalid",
	enabled: true,
	encryptedApiKey: "encrypted-token",
	encryptionIv: "token-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "plex-machine-a",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};

type StatusGenerations = {
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

async function seedAuthority(client: PrismaClient): Promise<void> {
	await client.user.create({
		data: { id: authority.userId, username: "status-test", hashedPassword: "hash" },
	});
	await client.serviceInstance.create({
		data: {
			...authority,
			label: "Plex",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: new Date("2026-08-20T10:00:00.000Z"),
		},
	});
}

async function seedObsoleteStatus(
	client: PrismaClient,
	cacheType: "plex" | "plex_episode",
	generations: StatusGenerations = { connectionGeneration: 3, identityGeneration: 8 },
): Promise<void> {
	await client.cacheRefreshStatus.create({
		data: {
			id: `${cacheType}-status`,
			instanceId: authority.id,
			cacheType,
			lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 1,
			generationId: `${cacheType}-legacy-generation`,
			generationMetadata: "legacy-metadata",
			lastAttemptAt: new Date("2026-08-20T10:00:00.000Z"),
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: generations.connectionGeneration,
			identityGeneration: generations.identityGeneration,
		},
	});
}

describe("provider cache status SQLite takeover contract", () => {
	it.each([
		["plex", "null/null", { connectionGeneration: null, identityGeneration: null }],
		["plex_episode", "null/null", { connectionGeneration: null, identityGeneration: null }],
		["plex", "current/null", { connectionGeneration: 4, identityGeneration: null }],
		["plex_episode", "current/null", { connectionGeneration: 4, identityGeneration: null }],
		["plex", "null/current", { connectionGeneration: null, identityGeneration: 9 }],
		["plex_episode", "null/current", { connectionGeneration: null, identityGeneration: 9 }],
		["plex", "older connection", { connectionGeneration: 3, identityGeneration: 9 }],
		["plex_episode", "older connection", { connectionGeneration: 3, identityGeneration: 9 }],
		["plex", "older identity", { connectionGeneration: 4, identityGeneration: 8 }],
		["plex_episode", "older identity", { connectionGeneration: 4, identityGeneration: 8 }],
		["plex", "both older", { connectionGeneration: 3, identityGeneration: 8 }],
		["plex_episode", "both older", { connectionGeneration: 3, identityGeneration: 8 }],
	] as const)(
		"claims retained %s %s status exactly once and revokes its publication authority",
		async (cacheType, _shape, generations) => {
			const client = await createDatabase();
			await seedAuthority(client);
			await seedObsoleteStatus(client, cacheType, generations);
			if (cacheType === "plex") {
				await client.plexCache.create({
					data: {
						id: "legacy-plex-row",
						instanceId: authority.id,
						tmdbId: 1,
						mediaType: "movie",
						sectionId: "movies",
						sectionTitle: "Movies",
						title: "Legacy",
						ratingKey: "legacy",
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: "[]",
						onDeck: false,
						userRating: null,
						collections: "[]",
						labels: "[]",
						addedAt: null,
						thumb: null,
						connectionGeneration: generations.connectionGeneration,
						identityGeneration: generations.identityGeneration,
					},
				});
			} else {
				await client.plexEpisodeCache.create({
					data: {
						id: "legacy-episode-row",
						instanceId: authority.id,
						showTmdbId: 1,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "legacy-episode",
						title: "Legacy episode",
						watched: false,
						watchedByUsers: "[]",
						lastWatchedAt: null,
						watchCount: 0,
						refreshedAt: null,
						sourceFingerprint: null,
						connectionGeneration: generations.connectionGeneration,
						identityGeneration: generations.identityGeneration,
					},
				});
			}

			const attempt = await beginPlexCacheRefreshAttempt(client, cacheType, authority);
			const status = await client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType } },
			});

			expect(attempt?.resultMarker).toMatch(/^in_progress:/);
			expect(status).toMatchObject({
				lastResult: "error",
				lastErrorMessage: "Plex cache refresh has not published a generation",
				itemCount: 0,
				generationId: null,
				generationMetadata: null,
				lastAttemptResult: attempt?.resultMarker,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			});
			expect(status.lastRefreshedAt).toEqual(attempt?.attemptedAt);
			expect(status.id).toBe(`${cacheType}-status`);
			expect(
				await client.cacheRefreshStatus.count({
					where: { instanceId: authority.id, cacheType },
				}),
			).toBe(1);
			expect(
				cacheType === "plex"
					? await client.plexCache.count({ where: { instanceId: authority.id } })
					: await client.plexEpisodeCache.count({ where: { instanceId: authority.id } }),
			).toBe(1);
			if (cacheType === "plex") {
				await expect(
					client.plexCache.findUniqueOrThrow({ where: { id: "legacy-plex-row" } }),
				).resolves.toMatchObject({
					id: "legacy-plex-row",
					instanceId: authority.id,
					tmdbId: 1,
					mediaType: "movie",
					sectionId: "movies",
					sectionTitle: "Movies",
					title: "Legacy",
					ratingKey: "legacy",
					watchedByUsers: "[]",
					connectionGeneration: generations.connectionGeneration,
					identityGeneration: generations.identityGeneration,
				});
			} else {
				await expect(
					client.plexEpisodeCache.findUniqueOrThrow({ where: { id: "legacy-episode-row" } }),
				).resolves.toMatchObject({
					id: "legacy-episode-row",
					instanceId: authority.id,
					showTmdbId: 1,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "legacy-episode",
					title: "Legacy episode",
					watched: false,
					watchedByUsers: "[]",
					connectionGeneration: generations.connectionGeneration,
					identityGeneration: generations.identityGeneration,
				});
			}
		},
		30_000,
	);

	it("keeps rows unavailable after A fails, publishes B, and prevents A from finishing over B", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		await seedObsoleteStatus(client, "plex");
		await client.plexCache.create({
			data: {
				id: "legacy-plex-row",
				instanceId: authority.id,
				tmdbId: 1,
				mediaType: "movie",
				sectionId: "movies",
				sectionTitle: "Movies",
				title: "Legacy",
				ratingKey: "legacy",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 3,
				identityGeneration: 8,
			},
		});

		const attemptA = await beginPlexCacheRefreshAttempt(client, "plex", authority);
		expect(attemptA).not.toBeNull();
		expect(
			await finishPlexCacheRefreshAttemptFailure(
				client,
				"plex",
				"upstream unavailable",
				authority,
				attemptA!,
				log,
			),
		).toBe("recorded");
		const unavailable = await client.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
		});
		expect(evaluatePlexMutationAuthority(unavailable)).toMatchObject({ available: false });
		expect(await client.plexCache.count({ where: { instanceId: authority.id } })).toBe(1);

		const attemptB = await beginPlexCacheRefreshAttempt(client, "plex", authority);
		expect(attemptB).not.toBeNull();
		const completedAt = new Date("2026-08-20T12:00:00.000Z");
		await client.$transaction(async (tx) => {
			await publishAuthoritativePlexCacheGeneration(tx, {
				instance: authority as never,
				rows: [
					{
						instanceId: authority.id,
						tmdbId: 2,
						mediaType: "movie",
						sectionId: "movies",
						sectionTitle: "Movies",
						title: "Replacement",
						ratingKey: "replacement",
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: "[]",
						onDeck: false,
						userRating: null,
						collections: "[]",
						labels: "[]",
						addedAt: null,
						thumb: null,
						connectionGeneration: authority.connectionGeneration,
						identityGeneration: authority.identityGeneration,
					},
				],
				completedAt,
				generationId: "replacement-generation",
				generationMetadata: encodeAuthoritativePlexGenerationMetadata({
					sections: [
						{
							key: "movies",
							uuid: "movies-uuid",
							title: "Movies",
							type: "movie",
							refreshing: false,
							scannedAt: 1,
							updatedAt: 1,
						},
					],
					itemCount: 1,
					canonicalizationVersion: 1,
					roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
				}),
				attempt: attemptB!,
			});
		});
		const published = await client.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
		});
		expect(evaluatePlexMutationAuthority(published, { now: completedAt })).toMatchObject({
			available: true,
			generationId: "replacement-generation",
		});
		expect(await client.plexCache.findMany({ where: { instanceId: authority.id } })).toMatchObject([
			{ tmdbId: 2, connectionGeneration: 4, identityGeneration: 9 },
		]);
		expect(
			await finishPlexCacheRefreshAttemptFailure(
				client,
				"plex",
				"A cannot overwrite B",
				authority,
				attemptA!,
				log,
			),
		).toBe("superseded");
	}, 30_000);
});
