import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createTestPgClient } from "../__tests__/test-prisma.js";
import { publishAuthoritativePlexCacheGeneration } from "../plex/plex-cache-storage.js";
import {
	encodeAuthoritativePlexGenerationMetadata,
	evaluatePlexMutationAuthority,
} from "../plex/plex-generation-metadata.js";
import {
	beginProviderCacheRefreshAttempt,
	beginPlexCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
	finishPlexCacheRefreshAttemptFailure,
} from "./provider-cache-status.js";
import type { ProviderPublicationAuthority } from "./provider-identity-guard.js";
import { clearDurableProviderCacheState } from "./service-identity-lifecycle.js";
import {
	readOwnedTautulliCacheAuthority,
	readUserSelectedTautulliCache,
} from "../tautulli/tautulli-cache-authority.js";

const apiRoot = join(process.cwd());
const log = { warn: vi.fn() };
const databases: Array<{
	clients: PrismaClient[];
	directory: string;
	databasePath: string;
}> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		await rm(directory, { recursive: true, force: true });
	}
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
	databases.push({ clients: [client], directory, databasePath });
	return client;
}

async function createDatabasePeer(client: PrismaClient): Promise<PrismaClient> {
	const database = databases.find((entry) => entry.clients.includes(client));
	if (!database) throw new Error("SQLite test database is not registered");
	const peer = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: database.databasePath, timeout: 1_000 }),
	});
	await peer.$connect();
	database.clients.push(peer);
	return peer;
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

const tautulliAuthority: ProviderPublicationAuthority = {
	...authority,
	id: "tautulli-1",
	service: "TAUTULLI",
	baseUrl: "https://tautulli.invalid",
	expectedIdentity: "plex-machine-a",
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

async function exerciseConcurrentTautulliSnapshot(
	client: PrismaClient,
	writer: PrismaClient,
): Promise<void> {
	const publishedAt = new Date("2026-08-28T12:00:00.000Z");
	await client.user.create({
		data: { id: tautulliAuthority.userId, username: "tautulli-snapshot", hashedPassword: "hash" },
	});
	await client.serviceInstance.create({
		data: {
			...tautulliAuthority,
			label: "Tautulli",
			identityKind: "TAUTULLI_PMS_IDENTIFIER",
			identityVerifiedAt: publishedAt,
		},
	});
	await client.cacheRefreshStatus.create({
		data: {
			instanceId: tautulliAuthority.id,
			cacheType: "tautulli",
			lastRefreshedAt: publishedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 1,
			lastAttemptAt: publishedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: tautulliAuthority.connectionGeneration,
			identityGeneration: tautulliAuthority.identityGeneration,
		},
	});
	await client.tautulliCache.create({
		data: {
			id: "tautulli-current-row",
			instanceId: tautulliAuthority.id,
			tmdbId: 42,
			mediaType: "movie",
			lastWatchedAt: publishedAt,
			watchCount: 3,
			watchedByUsers: "[]",
			connectionGeneration: tautulliAuthority.connectionGeneration,
			identityGeneration: tautulliAuthority.identityGeneration,
		},
	});

	let selectedReadReached!: () => void;
	const atSelectedRead = new Promise<void>((resolve) => {
		selectedReadReached = resolve;
	});
	let releaseSelectedRead!: () => void;
	const selectedReadRelease = new Promise<void>((resolve) => {
		releaseSelectedRead = resolve;
	});
	const reader = client.$extends({
		query: {
			tautulliCache: {
				async findMany({ args, query }) {
					selectedReadReached();
					await selectedReadRelease;
					return await query(args);
				},
			},
		},
	});

	const read = readUserSelectedTautulliCache(reader as never, {
		userId: tautulliAuthority.userId,
		targets: [{ tmdbId: 42, mediaType: "movie" }],
		now: publishedAt,
	});
	await atSelectedRead;
	const reset = writer.$transaction(
		async (tx) => {
			await tx.serviceInstance.update({
				where: { id: tautulliAuthority.id },
				data: { connectionGeneration: { increment: 1 } },
			});
			await clearDurableProviderCacheState(tx, tautulliAuthority.id);
		},
		{ isolationLevel: "Serializable" },
	);
	releaseSelectedRead();

	const [result] = await Promise.all([read, reset]);
	expect(result.available && result.rows.length === 0).toBe(false);
	if (result.available) {
		expect(result).toMatchObject({
			configured: true,
			reasonCodes: [],
			rows: [{ id: "tautulli-current-row", tmdbId: 42, watchCount: 3 }],
		});
	} else {
		expect(result.reasonCodes.length).toBeGreaterThan(0);
	}
	await expect(
		writer.serviceInstance.findUniqueOrThrow({ where: { id: tautulliAuthority.id } }),
	).resolves.toMatchObject({ connectionGeneration: 5 });
	expect(
		await writer.cacheRefreshStatus.count({ where: { instanceId: tautulliAuthority.id } }),
	).toBe(0);
	expect(await writer.tautulliCache.count({ where: { instanceId: tautulliAuthority.id } })).toBe(0);
}

async function exerciseConcurrentTautulliAuthoritySnapshot(
	client: PrismaClient,
	writer: PrismaClient,
): Promise<void> {
	const publishedAt = new Date("2026-08-28T12:00:00.000Z");
	const snapshotAuthority: ProviderPublicationAuthority = {
		...tautulliAuthority,
		id: "tautulli-authority-snapshot",
		userId: "tautulli-authority-user",
	};
	await client.user.create({
		data: { id: snapshotAuthority.userId, username: "tautulli-authority", hashedPassword: "hash" },
	});
	await client.serviceInstance.create({
		data: {
			...snapshotAuthority,
			label: "Tautulli authority",
			identityKind: "TAUTULLI_PMS_IDENTIFIER",
			identityVerifiedAt: publishedAt,
		},
	});
	await client.cacheRefreshStatus.create({
		data: {
			instanceId: snapshotAuthority.id,
			cacheType: "tautulli",
			lastRefreshedAt: publishedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 1,
			lastAttemptAt: publishedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: snapshotAuthority.connectionGeneration,
			identityGeneration: snapshotAuthority.identityGeneration,
		},
	});
	await client.tautulliCache.create({
		data: {
			id: "tautulli-authority-row",
			instanceId: snapshotAuthority.id,
			tmdbId: 84,
			mediaType: "movie",
			lastWatchedAt: publishedAt,
			watchCount: 4,
			watchedByUsers: "[]",
			connectionGeneration: snapshotAuthority.connectionGeneration,
			identityGeneration: snapshotAuthority.identityGeneration,
		},
	});

	let statusReadReached!: () => void;
	const atStatusRead = new Promise<void>((resolve) => {
		statusReadReached = resolve;
	});
	let releaseStatusRead!: () => void;
	const statusReadRelease = new Promise<void>((resolve) => {
		releaseStatusRead = resolve;
	});
	const reader = client.$extends({
		query: {
			cacheRefreshStatus: {
				async findFirst({ args, query }) {
					const result = await query(args);
					statusReadReached();
					await statusReadRelease;
					return result;
				},
			},
		},
	});

	const read = readOwnedTautulliCacheAuthority(reader as never, {
		userId: snapshotAuthority.userId,
		instanceId: snapshotAuthority.id,
		now: publishedAt,
	});
	await atStatusRead;
	const claim = beginProviderCacheRefreshAttempt(writer, "tautulli", snapshotAuthority);
	releaseStatusRead();

	const [result, attempt] = await Promise.all([read, claim]);
	expect(attempt).not.toBeNull();
	expect(result).not.toBeNull();
	expect(result?.available && result.cachedItems === 0).toBe(false);
	if (result?.available) {
		expect(result).toMatchObject({
			state: "healthy_complete",
			reasonCodes: [],
			cachedItems: 1,
		});
	} else {
		expect(result?.cachedItems).toBeNull();
		expect(result?.reasonCodes.length).toBeGreaterThan(0);
	}
	await expect(
		writer.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: {
					instanceId: snapshotAuthority.id,
					cacheType: "tautulli",
				},
			},
		}),
	).resolves.toMatchObject({ lastAttemptResult: expect.stringMatching(/^in_progress:/) });
}

describe("provider cache status SQLite takeover contract", () => {
	it("serializes a lifecycle clear at the Tautulli validation-to-row-read boundary", async () => {
		const client = await createDatabase();
		const writer = await createDatabasePeer(client);
		await exerciseConcurrentTautulliSnapshot(client, writer);
	}, 30_000);

	it("serializes an attempt claim at the Tautulli status-to-count boundary", async () => {
		const client = await createDatabase();
		const writer = await createDatabasePeer(client);
		await exerciseConcurrentTautulliAuthoritySnapshot(client, writer);
	}, 30_000);

	it("keeps overlap A unavailable, publishes B, and prevents A from finishing over B", async () => {
		const client = await createDatabase();
		await client.user.create({
			data: { id: tautulliAuthority.userId, username: "tautulli-status", hashedPassword: "hash" },
		});
		await client.serviceInstance.create({
			data: {
				...tautulliAuthority,
				label: "Tautulli",
				identityKind: "TAUTULLI_PMS_IDENTIFIER",
				identityVerifiedAt: new Date("2026-08-28T10:00:00.000Z"),
			},
		});

		const attemptA = await beginProviderCacheRefreshAttempt(client, "tautulli", tautulliAuthority);
		expect(attemptA).not.toBeNull();
		await expect(
			readOwnedTautulliCacheAuthority(client, {
				userId: tautulliAuthority.userId,
				instanceId: tautulliAuthority.id,
			}),
		).resolves.toMatchObject({ available: false, state: "in_progress" });

		const attemptB = await beginProviderCacheRefreshAttempt(client, "tautulli", tautulliAuthority);
		expect(attemptB?.resultMarker).not.toBe(attemptA?.resultMarker);
		const completedAt = new Date();
		await client.$transaction(async (tx) => {
			const claimed = await tx.cacheRefreshStatus.updateMany({
				where: {
					instanceId: tautulliAuthority.id,
					cacheType: "tautulli",
					lastAttemptAt: attemptB!.attemptedAt,
					lastAttemptResult: attemptB!.resultMarker,
					connectionGeneration: tautulliAuthority.connectionGeneration,
					identityGeneration: tautulliAuthority.identityGeneration,
				},
				data: {
					lastRefreshedAt: completedAt,
					lastResult: "success",
					lastErrorMessage: null,
					itemCount: 1,
					lastAttemptAt: completedAt,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
				},
			});
			expect(claimed.count).toBe(1);
			await tx.tautulliCache.create({
				data: {
					instanceId: tautulliAuthority.id,
					tmdbId: 42,
					mediaType: "movie",
					lastWatchedAt: completedAt,
					watchCount: 3,
					watchedByUsers: "[]",
					connectionGeneration: tautulliAuthority.connectionGeneration,
					identityGeneration: tautulliAuthority.identityGeneration,
				},
			});
		});

		expect(
			await finishProviderCacheRefreshAttemptFailure(
				client,
				"tautulli",
				"provider_response_invalid",
				tautulliAuthority,
				attemptA!,
				log,
			),
		).toBe("superseded");
		await expect(
			readOwnedTautulliCacheAuthority(client, {
				userId: tautulliAuthority.userId,
				instanceId: tautulliAuthority.id,
				now: completedAt,
			}),
		).resolves.toMatchObject({
			available: true,
			state: "healthy_complete",
			cachedItems: 1,
		});
		await expect(
			client.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: {
						instanceId: tautulliAuthority.id,
						cacheType: "tautulli",
					},
				},
			}),
		).resolves.toMatchObject({ lastResult: "success", lastAttemptResult: "success" });
	}, 30_000);

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
				targets: [
					{
						instanceId: authority.id,
						generationId: "replacement-generation",
						sectionId: "movies",
						sectionUuid: "movies-uuid",
						mediaType: "movie",
						tmdbId: 2,
						tvdbId: null,
						ratingKey: "replacement",
					},
				],
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

describe("provider cache status PostgreSQL Serializable snapshot contract", () => {
	it.runIf(Boolean(process.env.TAUTULLI_AUTHORITY_POSTGRES_URL))(
		"serializes the same lifecycle clear without a mixed selected-cache snapshot",
		async () => {
			const connectionString = process.env.TAUTULLI_AUTHORITY_POSTGRES_URL!;
			if (new URL(connectionString).pathname !== "/tautulli_authority_test") {
				throw new Error(
					"TAUTULLI_AUTHORITY_POSTGRES_URL must target the disposable tautulli_authority_test database",
				);
			}
			const reader = await createTestPgClient(connectionString);
			const writer = await createTestPgClient(connectionString);
			try {
				await exerciseConcurrentTautulliSnapshot(reader.prisma, writer.prisma);
			} finally {
				await writer.cleanup();
				await reader.cleanup();
			}
		},
		30_000,
	);

	it.runIf(Boolean(process.env.TAUTULLI_AUTHORITY_POSTGRES_URL))(
		"serializes an attempt claim without a mixed authority projection",
		async () => {
			const connectionString = process.env.TAUTULLI_AUTHORITY_POSTGRES_URL!;
			if (new URL(connectionString).pathname !== "/tautulli_authority_test") {
				throw new Error(
					"TAUTULLI_AUTHORITY_POSTGRES_URL must target the disposable tautulli_authority_test database",
				);
			}
			const reader = await createTestPgClient(connectionString);
			const writer = await createTestPgClient(connectionString);
			try {
				await exerciseConcurrentTautulliAuthoritySnapshot(reader.prisma, writer.prisma);
			} finally {
				await writer.cleanup();
				await reader.cleanup();
			}
		},
		30_000,
	);
});
