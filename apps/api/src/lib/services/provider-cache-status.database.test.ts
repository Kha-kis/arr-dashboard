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
import { createPlexTargetLedgerBinding } from "../plex/plex-generation-target-ledger.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
} from "../provider-observation/observation-run-repository.js";
import {
	readOwnedTautulliCacheAuthority,
	readUserSelectedTautulliCache,
} from "../tautulli/tautulli-cache-authority.js";
import {
	beginPlexCacheRefreshAttempt,
	beginProviderCacheRefreshAttempt,
	claimProviderCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	finishProviderCacheRefreshAttemptFailure,
	reconcileInterruptedProviderCacheRefreshAttempts,
} from "./provider-cache-status.js";
import type { ProviderPublicationAuthority } from "./provider-identity-guard.js";

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

async function exerciseTautulliSelectedReadQuarantine(client: PrismaClient): Promise<void> {
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

	let selectedRowsRead = false;
	const reader = client.$extends({
		query: {
			tautulliCache: {
				async findMany({ args, query }) {
					selectedRowsRead = true;
					return await query(args);
				},
			},
		},
	});

	const result = await readUserSelectedTautulliCache(reader as never, {
		userId: tautulliAuthority.userId,
		targets: [{ tmdbId: 42, mediaType: "movie" }],
		now: publishedAt,
	});
	expect(result).toEqual({
		configured: true,
		available: false,
		reasonCodes: ["provider_completion_unverifiable"],
		rows: [],
	});
	expect(selectedRowsRead).toBe(false);
	expect(await client.tautulliCache.count({ where: { instanceId: tautulliAuthority.id } })).toBe(1);
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
	expect(result?.available).toBe(false);
	expect(result?.cachedItems).toBeNull();
	expect(result?.reasonCodes.length).toBeGreaterThan(0);
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

async function exerciseRecoverableEpisodeAttempt(
	client: PrismaClient,
	episodeAuthority: ProviderPublicationAuthority,
): Promise<void> {
	const run = await createOrLoadObservationRun(client, {
		authority: {
			provider: "plex_episode",
			cacheType: "plex_episode",
			instanceId: episodeAuthority.id,
			parentGenerationId: "parent-generation",
			targetDigest: "d".repeat(64),
			connectionGeneration: episodeAuthority.connectionGeneration,
			identityGeneration: episodeAuthority.identityGeneration,
		},
		units: [
			{
				ordinal: 0,
				scopeKey: "scope:one",
				scopeDigest: "e".repeat(64),
				phase: "collect",
				expectedTargets: 1,
			},
		],
	});
	const unit = await client.providerObservationUnit.findFirstOrThrow({
		where: { runId: run.id },
	});
	const marker = "in_progress:00000000-0000-4000-8000-000000000001";
	await client.cacheRefreshStatus.create({
		data: {
			instanceId: episodeAuthority.id,
			cacheType: "plex_episode",
			lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
			lastResult: "error",
			itemCount: 0,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: marker,
			connectionGeneration: episodeAuthority.connectionGeneration,
			identityGeneration: episodeAuthority.identityGeneration,
		},
	});

	expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(0);
	await client.$transaction([
		client.providerObservationUnit.update({
			where: { id: unit.id },
			data: {
				state: "failed",
				attemptCount: 1,
				nextAttemptAt: new Date("2026-09-09T00:00:00.000Z"),
				lastReasonCode: "provider-unavailable",
			},
		}),
		client.providerObservationRun.update({
			where: { id: run.id },
			data: {
				state: "failed",
				nextAttemptAt: new Date("2026-09-09T00:00:00.000Z"),
				lastReasonCode: "provider-unavailable",
			},
		}),
	]);
	expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(0);
	await client.$transaction([
		client.providerObservationUnit.update({
			where: { id: unit.id },
			data: { attemptCount: 4, nextAttemptAt: null },
		}),
		client.providerObservationRun.update({
			where: { id: run.id },
			data: { nextAttemptAt: null },
		}),
	]);
	expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(0);
	await client.$transaction([
		client.providerObservationUnit.update({
			where: { id: unit.id },
			data: { state: "complete", nextAttemptAt: null, completedAt: new Date() },
		}),
		client.providerObservationRun.update({
			where: { id: run.id },
			data: {
				state: "complete",
				activeSlotKey: null,
				completedUnits: 1,
				completedWork: 1,
				nextAttemptAt: null,
				completedAt: new Date(),
			},
		}),
	]);
	expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(1);
	await expect(
		client.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: {
					instanceId: episodeAuthority.id,
					cacheType: "plex_episode",
				},
			},
		}),
	).resolves.toMatchObject({
		lastAttemptResult: "error",
		lastAttemptErrorMessage: "unknown-failure",
	});
}

describe("provider cache status SQLite takeover contract", () => {
	it("atomically rotates the outer marker before releasing its inherited unit claim", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		const run = await createOrLoadObservationRun(client, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId: authority.id,
				parentGenerationId: "parent-generation",
				targetDigest: "d".repeat(64),
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
			units: [
				{
					ordinal: 0,
					scopeKey: "scope:one",
					scopeDigest: "e".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const started = new Date("2026-08-20T11:00:00.000Z");
		const claim = await claimObservationUnit(client, {
			runId: run.id,
			now: started,
			claimToken: "inherited-unit-token",
		});
		expect(claim).not.toBeNull();
		const marker = "in_progress:00000000-0000-4000-8000-000000000001";
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex_episode",
				lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
				lastResult: "success",
				itemCount: 7,
				generationId: "published-generation",
				generationMetadata: "published-metadata",
				lastAttemptAt: started,
				lastAttemptResult: marker,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});

		expect(
			await reconcileInterruptedProviderCacheRefreshAttempts(client, {
				now: () => new Date("2026-08-20T12:00:00.000Z"),
			}),
		).toBe(1);
		const status = await client.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
		});
		expect(status).toMatchObject({
			lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
			lastResult: "success",
			itemCount: 7,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
		});
		expect(status.lastAttemptResult).toMatch(/^in_progress:/);
		expect(status.lastAttemptResult).not.toBe(marker);
		expect(
			await client.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({ state: "pending", claimToken: null, cursor: 0, attemptCount: 0 });
	}, 30_000);

	it("refuses a missing outer marker without releasing an inherited unit claim", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		const run = await createOrLoadObservationRun(client, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId: authority.id,
				parentGenerationId: "parent-generation",
				targetDigest: "d".repeat(64),
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
			units: [
				{
					ordinal: 0,
					scopeKey: "scope:one",
					scopeDigest: "e".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const claim = await claimObservationUnit(client, {
			runId: run.id,
			now: new Date("2026-08-20T11:00:00.000Z"),
			claimToken: "inherited-unit-token",
		});
		expect(claim).not.toBeNull();
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex_episode",
				lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
				lastResult: "success",
				itemCount: 7,
				generationId: "published-generation",
				generationMetadata: "published-metadata",
				lastAttemptAt: null,
				lastAttemptResult: null,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});

		await expect(reconcileInterruptedProviderCacheRefreshAttempts(client)).rejects.toThrow(
			"unmatched inherited claim",
		);
		expect(
			await client.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({ state: "running", claimToken: claim!.claimToken });
		expect(
			await client.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" },
				},
			}),
		).toMatchObject({ lastAttemptAt: null, lastAttemptResult: null });
	}, 30_000);

	it("rolls back the marker rotation when the exact unit CAS loses", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		const run = await createOrLoadObservationRun(client, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId: authority.id,
				parentGenerationId: "parent-generation",
				targetDigest: "d".repeat(64),
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
			units: [
				{
					ordinal: 0,
					scopeKey: "scope:one",
					scopeDigest: "e".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const started = new Date("2026-08-20T11:00:00.000Z");
		const claim = await claimObservationUnit(client, {
			runId: run.id,
			now: started,
			claimToken: "inherited-unit-token",
		});
		expect(claim).not.toBeNull();
		const marker = "in_progress:00000000-0000-4000-8000-000000000001";
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex_episode",
				lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
				lastResult: "success",
				itemCount: 7,
				generationId: "published-generation",
				generationMetadata: "published-metadata",
				lastAttemptAt: started,
				lastAttemptResult: marker,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});
		const failingClient = client.$extends({
			query: {
				providerObservationUnit: {
					async updateMany({ args, query }) {
						if (args.where?.claimToken === claim!.claimToken) return { count: 0 };
						return await query(args);
					},
				},
			},
		});

		await expect(
			reconcileInterruptedProviderCacheRefreshAttempts(failingClient as never, {
				now: () => new Date("2026-08-20T12:00:00.000Z"),
			}),
		).rejects.toThrow("claim CAS lost");
		expect(
			await client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
			}),
		).toMatchObject({ lastAttemptAt: started, lastAttemptResult: marker });
		expect(
			await client.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({ state: "running", claimToken: claim!.claimToken });
	}, 30_000);

	it("reclaims a null-timestamp in-progress marker while preserving the published generation", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex_episode",
				lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
				lastResult: "success",
				itemCount: 7,
				generationId: "published-generation",
				generationMetadata: "published-metadata",
				lastAttemptAt: null,
				lastAttemptResult: "in_progress:legacy",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});

		const claim = await claimProviderCacheRefreshAttempt(client, "plex_episode", authority, {
			now: () => new Date("2026-08-20T12:00:00.000Z"),
		});

		expect(claim).toMatchObject({
			status: "acquired",
			attempt: { resultMarker: expect.stringMatching(/^in_progress:/) },
		});
		await expect(
			client.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" },
				},
			}),
		).resolves.toMatchObject({
			lastResult: "success",
			itemCount: 7,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
			lastAttemptResult: expect.stringMatching(/^in_progress:/),
		});
	}, 30_000);

	it("retains a bound episode attempt across pending and failed runs, then settles terminal work", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		await exerciseRecoverableEpisodeAttempt(client, authority);
	}, 30_000);

	it("recovers an inherited claim idempotently while preserving the publication", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		const publishedAt = new Date("2026-08-20T10:00:00.000Z");
		const attemptedAt = new Date("2026-08-20T11:00:00.000Z");
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex",
				lastRefreshedAt: publishedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 7,
				generationId: "published-generation",
				generationMetadata: "published-metadata",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000001",
				lastAttemptErrorMessage: null,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});

		expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(1);
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(0);
		await expect(
			client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
			}),
		).resolves.toMatchObject({
			lastResult: "success",
			itemCount: 7,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "unknown-failure",
		});
	}, 30_000);

	it("never opens a selected-row read for configured Tautulli evidence", async () => {
		const client = await createDatabase();
		await exerciseTautulliSelectedReadQuarantine(client);
	}, 30_000);

	it("serializes an attempt claim at the Tautulli status-to-count boundary", async () => {
		const client = await createDatabase();
		const writer = await createDatabasePeer(client);
		await exerciseConcurrentTautulliAuthoritySnapshot(client, writer);
	}, 30_000);

	it("converges simultaneous first claims on one absent status", async () => {
		const client = await createDatabase();
		const peer = await createDatabasePeer(client);
		await seedAuthority(client);
		await client.libraryCleanupConfig.create({ data: { userId: authority.userId } });

		const claims = await Promise.all([
			claimProviderCacheRefreshAttempt(client, "plex", authority),
			claimProviderCacheRefreshAttempt(peer, "plex", authority),
		]);

		expect(claims.filter((claim) => claim.status === "acquired")).toHaveLength(1);
		expect(claims.filter((claim) => claim.status === "already-running")).toHaveLength(1);
		expect(claims.some((claim) => claim.status === "superseded")).toBe(false);
	}, 30_000);

	it("keeps an existing claim unavailable and prevents a second claim", async () => {
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

		const secondClaim = await claimProviderCacheRefreshAttempt(
			client,
			"tautulli",
			tautulliAuthority,
		);
		expect(secondClaim).toEqual({ status: "already-running", attempt: attemptA });

		expect(
			await finishProviderCacheRefreshAttemptFailure(
				client,
				"tautulli",
				"provider_response_invalid",
				tautulliAuthority,
				attemptA!,
				log,
			),
		).toBe("recorded");
		await expect(
			readOwnedTautulliCacheAuthority(client, {
				userId: tautulliAuthority.userId,
				instanceId: tautulliAuthority.id,
			}),
		).resolves.toMatchObject({
			available: false,
			state: "failed_unavailable",
			reasonCodes: ["refresh_failed", "provider_response_invalid"],
			cachedItems: null,
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
		).resolves.toMatchObject({ lastResult: "error", lastAttemptResult: "error" });
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
				lastErrorMessage: "provider cache refresh has not published a generation",
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
		const completedAt = new Date(attemptB!.attemptedAt.getTime() + 1_000);
		const replacementTargets = [
			{
				instanceId: authority.id,
				generationId: "replacement-generation",
				sectionId: "movies",
				sectionUuid: "movies-uuid",
				mediaType: "movie" as const,
				tmdbId: 2,
				tvdbId: null,
				ratingKey: "replacement",
			},
		];
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
				targets: replacementTargets,
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
					targetLedger: createPlexTargetLedgerBinding({
						instanceId: authority.id,
						generationId: "replacement-generation",
						connectionGeneration: authority.connectionGeneration,
						identityGeneration: authority.identityGeneration,
						targets: replacementTargets,
					}),
					partialReasons: [],
					coverageReceipt: {
						version: 1,
						provider: "plex",
						attemptStartedAt: attemptB!.attemptedAt.toISOString(),
						observedAt: completedAt.toISOString(),
						evidence: "complete",
						units: [
							{
								scopeKey: "section:movies",
								expectedRawCount: 1,
								pagesAttempted: 1,
								pagesCompleted: 1,
								rawObserved: 1,
								sourceBindings: 1,
								canonicalEntities: 1,
								acceptedSkips: [],
								fatalCount: 0,
							},
						],
					},
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

	it("rolls back V5 status, cache rows, and target ledger when replacement target insertion aborts", async () => {
		const client = await createDatabase();
		await seedAuthority(client);
		const priorCompletedAt = new Date("2026-09-02T11:59:00.000Z");
		const priorTargets = [
			{
				instanceId: authority.id,
				generationId: "prior-generation",
				sectionId: "movies",
				sectionUuid: "movies-uuid",
				mediaType: "movie" as const,
				tmdbId: 1,
				tvdbId: null,
				ratingKey: "prior-rating",
			},
		];
		const priorMetadata = encodeAuthoritativePlexGenerationMetadata({
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
			targetLedger: createPlexTargetLedgerBinding({
				instanceId: authority.id,
				generationId: "prior-generation",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				targets: priorTargets,
			}),
			partialReasons: [],
			coverageReceipt: {
				version: 1,
				provider: "plex",
				attemptStartedAt: priorCompletedAt.toISOString(),
				observedAt: priorCompletedAt.toISOString(),
				evidence: "complete",
				units: [
					{
						scopeKey: "section:movies",
						expectedRawCount: 1,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved: 1,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [],
						fatalCount: 0,
					},
				],
			},
		});
		await client.cacheRefreshStatus.create({
			data: {
				instanceId: authority.id,
				cacheType: "plex",
				lastRefreshedAt: priorCompletedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 1,
				generationId: "prior-generation",
				generationMetadata: priorMetadata,
				lastAttemptAt: priorCompletedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
		});
		await client.plexCache.create({
			data: {
				id: "prior-row",
				instanceId: authority.id,
				tmdbId: 1,
				mediaType: "movie",
				sectionId: "movies",
				sectionTitle: "Movies",
				title: "Prior",
				ratingKey: "prior-rating",
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
		});
		await client.plexGenerationTarget.createMany({ data: priorTargets });

		const attempt = await beginPlexCacheRefreshAttempt(client, "plex", authority);
		expect(attempt).not.toBeNull();
		const rollbackSnapshot = {
			status: await client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
			}),
			cacheRows: await client.plexCache.findMany({
				where: { instanceId: authority.id },
				orderBy: { id: "asc" },
			}),
			targetRows: await client.plexGenerationTarget.findMany({
				where: { instanceId: authority.id },
				orderBy: { id: "asc" },
			}),
		};
		const replacementCompletedAt = new Date(attempt!.attemptedAt.getTime() + 1_000);
		const replacementTargets = [
			{
				instanceId: authority.id,
				generationId: "replacement-generation",
				sectionId: "movies",
				sectionUuid: "movies-uuid",
				mediaType: "movie" as const,
				tmdbId: 2,
				tvdbId: null,
				ratingKey: "replacement-rating",
			},
		];
		const replacementMetadata = encodeAuthoritativePlexGenerationMetadata({
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
			targetLedger: createPlexTargetLedgerBinding({
				instanceId: authority.id,
				generationId: "replacement-generation",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				targets: replacementTargets,
			}),
			partialReasons: [],
			coverageReceipt: {
				version: 1,
				provider: "plex",
				attemptStartedAt: attempt!.attemptedAt.toISOString(),
				observedAt: replacementCompletedAt.toISOString(),
				evidence: "complete",
				units: [
					{
						scopeKey: "section:movies",
						expectedRawCount: 1,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved: 1,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [],
						fatalCount: 0,
					},
				],
			},
		});
		await client.$executeRawUnsafe(
			"CREATE TRIGGER fail_replacement_target BEFORE INSERT ON plex_generation_targets WHEN NEW.ratingKey = 'replacement-rating' BEGIN SELECT RAISE(ABORT, 'replacement target rejected'); END",
		);
		try {
			await expect(
				client.$transaction(async (tx) => {
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
								ratingKey: "replacement-rating",
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
						completedAt: replacementCompletedAt,
						generationId: "replacement-generation",
						generationMetadata: replacementMetadata,
						targets: replacementTargets,
						attempt: attempt!,
					});
				}),
			).rejects.toThrow();
		} finally {
			await client.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_replacement_target");
		}
		expect({
			status: await client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex" } },
			}),
			cacheRows: await client.plexCache.findMany({
				where: { instanceId: authority.id },
				orderBy: { id: "asc" },
			}),
			targetRows: await client.plexGenerationTarget.findMany({
				where: { instanceId: authority.id },
				orderBy: { id: "asc" },
			}),
		}).toEqual(rollbackSnapshot);
	}, 30_000);
});

describe("provider cache status PostgreSQL Serializable snapshot contract", () => {
	it.runIf(Boolean(process.env.TAUTULLI_AUTHORITY_POSTGRES_URL))(
		"never opens a selected-row read for configured Tautulli evidence",
		async () => {
			const connectionString = process.env.TAUTULLI_AUTHORITY_POSTGRES_URL!;
			if (new URL(connectionString).pathname !== "/tautulli_authority_test") {
				throw new Error(
					"TAUTULLI_AUTHORITY_POSTGRES_URL must target the disposable tautulli_authority_test database",
				);
			}
			const reader = await createTestPgClient(connectionString);
			try {
				await exerciseTautulliSelectedReadQuarantine(reader.prisma);
			} finally {
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
