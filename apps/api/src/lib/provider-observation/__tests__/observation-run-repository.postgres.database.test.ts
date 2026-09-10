import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileInterruptedProviderCacheRefreshAttempts } from "../../services/provider-cache-status.js";
import {
	advanceObservationUnit,
	claimObservationUnit,
	completeObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	invalidateObservationRuns,
	recoverAbandonedObservationRuns,
} from "../observation-run-repository.js";

const configuredUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
let parsedUrl: URL | undefined;
try {
	if (configuredUrl) parsedUrl = new URL(configuredUrl);
} catch {
	parsedUrl = undefined;
}
const loopbackDisposable =
	parsedUrl !== undefined &&
	["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) &&
	parsedUrl.pathname.length > 1;
const pgDescribe = integrationEnabled && loopbackDisposable ? describe : describe.skip;

function postgresSchemaSource(source: string, schema: string): string {
	const lines = source
		.replace('provider = "sqlite"', `provider = "postgresql"\n  schemas = ["${schema}"]`)
		.replace('output   = "../src/generated/prisma"', 'output   = "./generated"')
		.split("\n");
	const output: string[] = [];
	let block: "model" | "enum" | null = null;
	let depth = 0;
	for (const line of lines) {
		const declaration = /^(model|enum)\s+\w+\s*\{/.exec(line);
		if (declaration) {
			block = declaration[1] as "model" | "enum";
			depth = 1;
			output.push(line);
			continue;
		}
		if (block && line.trim() === "}" && depth === 1) {
			output.push(`  @@schema("${schema}")`);
			output.push(line);
			block = null;
			continue;
		}
		if (block) depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		output.push(line);
	}
	return output.join("\n");
}

pgDescribe("provider observation PostgreSQL CAS parity", () => {
	let adminPool: Pool | undefined;
	let schemaName: string | undefined;
	let schemaUrl: string | undefined;
	let schemaDirectory: string | undefined;
	let PrismaClientConstructor: any;
	const clients: Array<{ $disconnect: () => Promise<void> }> = [];
	const pools: Pool[] = [];

	beforeAll(async () => {
		if (!configuredUrl || !parsedUrl) return;
		schemaName = `task4_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
		adminPool = new Pool({ connectionString: configuredUrl });
		await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
		const url = new URL(configuredUrl);
		url.searchParams.set("schema", schemaName);
		url.searchParams.set("options", `-c search_path=${schemaName}`);
		schemaUrl = url.toString();
		schemaDirectory = mkdtempSync(join(tmpdir(), "task4-pg-schema-"));
		const schemaPath = join(schemaDirectory, "schema.prisma");
		writeFileSync(
			schemaPath,
			postgresSchemaSource(
				readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8"),
				schemaName,
			),
		);
		execFileSync("pnpm", ["exec", "prisma", "generate", "--schema", schemaPath], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: schemaUrl },
			stdio: "ignore",
		});
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: schemaUrl },
			stdio: "pipe",
		});
		const generated = await import(
			/* @vite-ignore */ pathToFileURL(join(schemaDirectory, "generated/client.js")).href
		);
		PrismaClientConstructor = generated.PrismaClient;
	});

	afterAll(async () => {
		await Promise.allSettled(clients.map((client) => client.$disconnect()));
		await Promise.allSettled(pools.map((pool) => pool.end()));
		if (adminPool && schemaName) {
			await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => undefined);
			await adminPool.end().catch(() => undefined);
		}
		if (schemaDirectory) rmSync(schemaDirectory, { recursive: true, force: true });
	});

	it("reserves one identical claim and rejects stale and repeated finalizers", async () => {
		if (!schemaUrl) return;
		const makeClient = () => {
			const pool = new Pool({ connectionString: schemaUrl });
			pools.push(pool);
			const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
			clients.push(client);
			return client;
		};
		const first = makeClient();
		const second = makeClient();
		const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
		const userId = `pg-user-${suffix}`;
		const instanceId = `pg-observation-${suffix}`;
		await first.user.create({ data: { id: userId, username: `pg-${suffix}` } });
		await first.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "PLEX",
				label: "pg-observation",
				baseUrl: "http://127.0.0.1:32400",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		const authority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId,
			parentGenerationId: "parent",
			targetDigest: "a".repeat(64),
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		const run = await createOrLoadObservationRun(first, {
			authority,
			units: [
				{
					ordinal: 0,
					scopeKey: "pg",
					scopeDigest: "b".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const now = new Date("2026-09-06T00:00:00.000Z");
		const claims = await Promise.all([
			claimObservationUnit(first, { runId: run.id, now }),
			claimObservationUnit(second, { runId: run.id, now }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const claim = claims.find(Boolean)!;
		expect(
			await completeObservationUnit(second, {
				claim: { ...claim, claimToken: "stale" },
				expectedRawCount: 1,
				observedRawCount: 1,
			}),
		).toBe(false);
		expect(
			await completeObservationUnit(first, { claim, expectedRawCount: 1, observedRawCount: 1 }),
		).toBe(true);
		expect(
			await completeObservationUnit(first, { claim, expectedRawCount: 1, observedRawCount: 1 }),
		).toBe(false);
	});

	it("enforces one live unit, whole-run retry gates, lease renewal, and exact counters", async () => {
		if (!schemaUrl) return;
		const pool = new Pool({ connectionString: schemaUrl });
		pools.push(pool);
		const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
		clients.push(client);
		const suffix = `${Date.now()}_multi`;
		const userId = `pg-user-${suffix}`;
		const instanceId = `pg-observation-${suffix}`;
		await client.user.create({ data: { id: userId, username: `pg-${suffix}` } });
		await client.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "PLEX",
				label: "pg",
				baseUrl: "http://127.0.0.1:32400",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: 4,
				identityGeneration: 5,
			},
		});
		const authority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId,
			parentGenerationId: "parent",
			targetDigest: "a".repeat(64),
			connectionGeneration: 4,
			identityGeneration: 5,
		};
		const runUnits = [
			{
				ordinal: 0,
				scopeKey: "one",
				scopeDigest: "b".repeat(64),
				phase: "collect" as const,
				expectedTargets: 2,
			},
			{
				ordinal: 1,
				scopeKey: "two",
				scopeDigest: "c".repeat(64),
				phase: "collect" as const,
				expectedTargets: 3,
			},
		];
		const run = await createOrLoadObservationRun(client, { authority, units: runUnits });
		const now = new Date("2026-09-06T00:00:00.000Z");
		const first = await claimObservationUnit(client, { runId: run.id, now });
		expect(first?.scopeKey).toBe("one");
		expect(await claimObservationUnit(client, { runId: run.id, now })).toBeNull();
		const renewedAt = new Date(now.getTime() + 10_000);
		expect(
			await advanceObservationUnit(client, {
				claim: first!,
				cursor: 1,
				expectedRawCount: 2,
				observedRawCount: 1,
				now: renewedAt,
			}),
		).toBe(true);
		expect(
			await claimObservationUnit(client, {
				runId: run.id,
				now: new Date(now.getTime() + 60_000 * 60),
			}),
		).toBeNull();
		const renewed = await claimObservationUnit(client, {
			runId: run.id,
			now: new Date(renewedAt.getTime() + 60 * 60 * 1000),
		});
		expect(renewed?.scopeKey).toBe("one");
		expect(
			await failObservationUnit(client, {
				claim: first!,
				reasonCode: "provider-unavailable",
				now: renewedAt,
			}),
		).toBe(false);
		let failedClaim = renewed;
		let failureNow = new Date(renewedAt.getTime() + 60 * 60 * 1000);
		for (const delay of [30_000, 120_000, 600_000]) {
			expect(
				await failObservationUnit(client, {
					claim: failedClaim!,
					reasonCode: "provider-unavailable",
					now: failureNow,
				}),
			).toBe(true);
			const due = new Date(failureNow.getTime() + delay);
			expect(
				await claimObservationUnit(client, { runId: run.id, now: new Date(due.getTime() - 1) }),
			).toBeNull();
			failureNow = due;
			failedClaim = await claimObservationUnit(client, { runId: run.id, now: failureNow });
			expect(failedClaim?.unitId).toBe(renewed?.unitId);
		}
		expect(
			await failObservationUnit(client, {
				claim: failedClaim!,
				reasonCode: "provider-unavailable",
				now: failureNow,
			}),
		).toBe(true);
		expect(await claimObservationUnit(client, { runId: run.id, now: failureNow })).toBeNull();
		await createOrLoadObservationRun(client, { authority, units: runUnits, resumeFailed: true });
		const resumed = await claimObservationUnit(client, { runId: run.id, now: failureNow });
		expect(resumed?.scopeKey).toBe("one");
		expect(
			await completeObservationUnit(client, {
				claim: resumed!,
				expectedRawCount: 2,
				observedRawCount: 1,
			}),
		).toBe(true);
		const second = await claimObservationUnit(client, {
			runId: run.id,
			now: failureNow,
		});
		expect(
			await completeObservationUnit(client, {
				claim: second!,
				expectedRawCount: 3,
				observedRawCount: 3,
			}),
		).toBe(true);
		expect(await client.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{ completedUnits: 2, completedWork: 5, state: "complete", activeSlotKey: null },
		);
	});

	it("requires a bound outer marker to recover an inherited claim while preserving progress", async () => {
		if (!schemaUrl) return;
		const pool = new Pool({ connectionString: schemaUrl });
		pools.push(pool);
		const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
		clients.push(client);
		const suffix = `${Date.now()}_recovery`;
		const userId = `pg-user-${suffix}`;
		const instanceId = `pg-observation-${suffix}`;
		await client.user.create({ data: { id: userId, username: `pg-${suffix}` } });
		await client.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "PLEX",
				label: "pg",
				baseUrl: "http://127.0.0.1:32400",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: 6,
				identityGeneration: 7,
			},
		});
		const authority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId,
			parentGenerationId: "parent",
			targetDigest: "a".repeat(64),
			connectionGeneration: 6,
			identityGeneration: 7,
		};
		const run = await createOrLoadObservationRun(client, {
			authority,
			units: [
				{
					ordinal: 0,
					scopeKey: "recovery",
					scopeDigest: "b".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const started = new Date("2026-09-06T00:00:00.000Z");
		const claim = await claimObservationUnit(client, { runId: run.id, now: started });
		await client.providerObservationUnit.update({
			where: { id: claim!.unitId },
			data: { cursor: 8, expectedRawCount: 4, observedRawCount: 3, attemptCount: 2 },
		});
		await client.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				showTmdbId: 1,
				parentRatingKey: "parent",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "recovery",
				title: "Episode",
				watched: false,
				watchedByUsers: "[]",
				watchCount: 0,
				refreshedAt: started,
				sourceFingerprint: "recovery-fingerprint",
			},
		});
		await expect(recoverAbandonedObservationRuns(client)).rejects.toThrow(
			"unmatched provider observation claim",
		);
		await expect(reconcileInterruptedProviderCacheRefreshAttempts(client)).rejects.toThrow(
			"unmatched inherited claim",
		);
		expect(
			await client.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }),
		).toMatchObject({
			state: "running",
			claimToken: claim!.claimToken,
			cursor: 8,
			expectedRawCount: 4,
			observedRawCount: 3,
			attemptCount: 2,
		});
		expect(await client.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		const marker = "in_progress:00000000-0000-4000-8000-000000000001";
		await client.cacheRefreshStatus.create({
			data: {
				instanceId,
				cacheType: "plex_episode",
				lastRefreshedAt: started,
				lastResult: "success",
				itemCount: 7,
				generationId: "published-generation",
				lastAttemptAt: started,
				lastAttemptResult: marker,
				connectionGeneration: 6,
				identityGeneration: 7,
			},
		});
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(1);
		const recoveredStatus = await client.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId, cacheType: "plex_episode" } },
		});
		expect(recoveredStatus).toMatchObject({
			lastResult: "success",
			itemCount: 7,
			generationId: "published-generation",
		});
		expect(recoveredStatus.lastAttemptResult).toMatch(/^in_progress:/);
		expect(recoveredStatus.lastAttemptResult).not.toBe(marker);
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(0);
		expect(await recoverAbandonedObservationRuns(client)).toBe(0);
		expect(
			await client.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }),
		).toMatchObject({
			state: "pending",
			claimToken: null,
			cursor: 8,
			expectedRawCount: 4,
			observedRawCount: 3,
			attemptCount: 2,
			nextAttemptAt: null,
		});
		expect(await client.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
	});

	it("preserves restart-bound episode work through pending and backoff states", async () => {
		if (!schemaUrl) return;
		const pool = new Pool({ connectionString: schemaUrl });
		pools.push(pool);
		const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
		clients.push(client);
		const suffix = `${Date.now()}_attempt_recovery`;
		const userId = `pg-user-${suffix}`;
		const instanceId = `pg-observation-${suffix}`;
		await client.user.create({ data: { id: userId, username: `pg-${suffix}` } });
		await client.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "PLEX",
				label: "pg",
				baseUrl: "http://127.0.0.1:32400",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: 8,
				identityGeneration: 9,
			},
		});
		const run = await createOrLoadObservationRun(client, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId,
				parentGenerationId: "parent",
				targetDigest: "a".repeat(64),
				connectionGeneration: 8,
				identityGeneration: 9,
			},
			units: [
				{
					ordinal: 0,
					scopeKey: "restart",
					scopeDigest: "b".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const unit = await client.providerObservationUnit.findFirstOrThrow({
			where: { runId: run.id },
		});
		await client.cacheRefreshStatus.create({
			data: {
				instanceId,
				cacheType: "plex_episode",
				lastRefreshedAt: new Date("2026-09-06T00:00:00.000Z"),
				lastResult: "error",
				itemCount: 0,
				lastAttemptAt: new Date("2026-09-06T00:00:00.000Z"),
				lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000001",
				connectionGeneration: 8,
				identityGeneration: 9,
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
				data: { state: "complete", completedAt: new Date() },
			}),
			client.providerObservationRun.update({
				where: { id: run.id },
				data: {
					state: "complete",
					activeSlotKey: null,
					completedUnits: 1,
					completedWork: 1,
					completedAt: new Date(),
				},
			}),
		]);
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(client)).toBe(1);
		await expect(
			client.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId, cacheType: "plex_episode" } },
			}),
		).resolves.toMatchObject({
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "unknown-failure",
		});
	});

	it("fences stale generations and removes both staging tables on invalidation", async () => {
		if (!schemaUrl) return;
		const pool = new Pool({ connectionString: schemaUrl });
		pools.push(pool);
		const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
		clients.push(client);
		const suffix = `${Date.now()}_fence`;
		const userId = `pg-user-${suffix}`;
		const instanceId = `pg-observation-${suffix}`;
		await client.user.create({ data: { id: userId, username: `pg-${suffix}` } });
		await client.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "PLEX",
				label: "pg",
				baseUrl: "http://127.0.0.1:32400",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		});
		const authority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId,
			parentGenerationId: "parent",
			targetDigest: "a".repeat(64),
			connectionGeneration: 2,
			identityGeneration: 3,
		};
		const run = await createOrLoadObservationRun(client, {
			authority,
			units: [
				{
					ordinal: 0,
					scopeKey: "one",
					scopeDigest: "b".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
			],
		});
		const claim = await claimObservationUnit(client, {
			runId: run.id,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		const at = new Date("2026-09-06T00:00:00.000Z");
		await client.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				showTmdbId: 1,
				parentRatingKey: "parent",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "ep",
				title: "Episode",
				watched: true,
				watchedByUsers: "[]",
				watchCount: 1,
				refreshedAt: at,
				sourceFingerprint: "fp",
			},
		});
		await client.jellyfinEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				userKeyDigest: "user",
				pass: "collect",
				jellyfinId: "jelly",
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Episode",
				played: true,
				playCount: 1,
				lastPlayedAt: at,
				userName: "user",
			},
		});
		await client.serviceInstance.update({
			where: { id: instanceId },
			data: { connectionGeneration: 8 },
		});
		await expect(
			createOrLoadObservationRun(client, {
				authority,
				units: [
					{
						ordinal: 0,
						scopeKey: "two",
						scopeDigest: "c".repeat(64),
						phase: "collect",
						expectedTargets: 1,
					},
				],
			}),
		).rejects.toThrow();
		expect(await invalidateObservationRuns(client, { instanceId })).toBe(1);
		expect(await client.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
		expect(await client.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			0,
		);
	});
});
