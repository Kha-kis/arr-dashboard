import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { publishAuthoritativePlexCacheGeneration } from "../../plex/plex-cache-storage.js";
import { encodeAuthoritativePlexGenerationMetadata } from "../../plex/plex-generation-metadata.js";
import { beginPlexCacheRefreshAttempt } from "../../services/provider-cache-status.js";
import type { ProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { buildEvalContextWithHealth } from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

const apiRoot = join(process.cwd());
const databases: Array<{ client: PrismaClient; directory: string }> = [];

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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function createDatabase(): Promise<{ client: PrismaClient; databasePath: string }> {
	const directory = await mkdtemp(join(tmpdir(), "plex-policy-snapshot-"));
	const databasePath = join(directory, "policy.db");
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
	return { client, databasePath };
}

async function seedAuthority(client: PrismaClient): Promise<void> {
	await client.user.create({
		data: { id: authority.userId, username: "policy-test", hashedPassword: "hash" },
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

async function publish(
	client: PrismaClient,
	generationId: string,
	tmdbId: number,
	watchCount: number,
) {
	const attempt = await beginPlexCacheRefreshAttempt(client, "plex", authority);
	expect(attempt).not.toBeNull();
	await client.$transaction(async (tx) => {
		await publishAuthoritativePlexCacheGeneration(tx, {
			instance: authority as never,
			rows: [
				{
					instanceId: authority.id,
					tmdbId,
					mediaType: "movie",
					sectionId: "movies",
					sectionTitle: "Movies",
					title: `Movie ${tmdbId}`,
					ratingKey: `rating-${tmdbId}`,
					lastWatchedAt: null,
					watchCount,
					watchedByUsers: "[]",
					onDeck: watchCount > 0,
					userRating: null,
					collections: "[]",
					labels: "[]",
					addedAt: null,
					thumb: null,
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
				},
			],
			completedAt: new Date(),
			generationId,
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
			attempt: attempt!,
		});
	});
}

afterEach(async () => {
	await Promise.all(
		databases.splice(0).map(async ({ client, directory }) => {
			await client.$disconnect();
			await rm(directory, { recursive: true, force: true });
		}),
	);
});

describe("Plex policy snapshot SQLite publication boundary", () => {
	it("withholds a configured policy when B publishes after A rows are read", async () => {
		const { client, databasePath } = await createDatabase();
		await seedAuthority(client);
		await publish(client, "plex-generation-a", 1, 0);

		const rowsRead = deferred<void>();
		const resumeRows = deferred<void>();
		const prisma = {
			serviceInstance: client.serviceInstance,
			cacheRefreshStatus: client.cacheRefreshStatus,
			plexCache: {
				findMany: async (...args: Parameters<typeof client.plexCache.findMany>) => {
					const rows = await client.plexCache.findMany(...args);
					rowsRead.resolve();
					await resumeRows.promise;
					return rows;
				},
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const evaluation = buildEvalContextWithHealth(
			{
				prisma,
				log: { info() {}, warn() {}, error() {} },
			} as unknown as CleanupExecutorDeps,
			authority.userId,
			[
				{
					enabled: true,
					ruleType: "age",
					parameters: JSON.stringify({ operator: "older_than", days: 30 }),
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies"]),
				},
			],
		);

		await rowsRead.promise;
		const publisher = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 1_000 }),
		});
		await publisher.$connect();
		try {
			await publish(publisher, "plex-generation-b", 2, 5);
		} finally {
			await publisher.$disconnect();
		}
		resumeRows.resolve();

		const result = await evaluation;
		expect(result.failedSources).toContain("plex");
		expect(result.ctx.plexMap).toBeUndefined();
		expect(result.ctx.plexSectionTitles).toBeUndefined();
		await expect(
			client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
			}),
		).resolves.toMatchObject({ generationId: "plex-generation-b", itemCount: 1 });
		await expect(
			client.plexCache.findMany({ where: { instanceId: authority.id } }),
		).resolves.toMatchObject([{ tmdbId: 2, watchCount: 5, onDeck: true }]);
	}, 30_000);
});
