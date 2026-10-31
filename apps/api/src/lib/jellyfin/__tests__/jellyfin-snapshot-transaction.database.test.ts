import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import {
	acquireJellyfinEpisodePreparation,
	prepareJellyfinEpisodeGeneration,
} from "../jellyfin-episode-generation-repository.js";
import { fingerprintJellyfinEpisodeRows } from "../jellyfin-generation-metadata.js";
import {
	JellyfinNativeWatchLeaseLostError,
	prepareNativeWatchGeneration,
} from "../jellyfin-native-watch-repository.js";

// The real native guard establishes a read snapshot before an application write.
// A second real WAL connection commits at that boundary; no DB result is mocked.
describe("guarded Jellyfin SQLite snapshot recovery", () => {
	let directory: string;
	let template: string;
	let path: string;
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let writer: Database.Database;
	let losses: number;
	let restorePrepare: (() => void) | undefined;
	const token = "owned-preparation-token";
	let now: Date;

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-jellyfin-snapshot-"));
		chmodSync(directory, 0o700);
		template = join(directory, "template.sqlite");
		const api = resolve(import.meta.dirname, "../../../..");
		const schema = join(directory, "schema.prisma");
		writeFileSync(
			schema,
			readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
				/generator client \{[\s\S]*?\}/,
				'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
			),
			{ mode: 0o600 },
		);
		const config = join(directory, "safe.config.ts");
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		await promisify(execFile)(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				`file:${template}`,
			],
			{
				cwd: directory,
				env: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					DATABASE_URL: `file:${template}`,
					CHECKPOINT_DISABLE: "1",
				},
				timeout: 60_000,
			},
		);
	}, 90_000);
	beforeEach(async () => {
		path = join(mkdtempSync(join(directory, "case-")), "main.sqlite");
		copyFileSync(template, path);
		chmodSync(path, 0o600);
		writer = new Database(path, { timeout: 0 });
		writer.pragma("journal_mode=WAL");
		writer.exec(
			"CREATE TABLE SnapshotProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);INSERT INTO SnapshotProbe VALUES(1,0)",
		);
		losses = 0;
		runtime = await openRestoreRuntime({
			databaseUrl: `file:${path}`,
			onUnavailable: () => {
				losses += 1;
			},
		});
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		now = new Date();
		await runtime.runIndependentOperation(async () => {
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other-owner", username: "synthetic-other-owner" },
				],
			});
			await native.prisma.serviceInstance.createMany({
				data: ["jf", "jf-other"].map((id) => ({
					id,
					userId: id === "jf" ? "owner" : "other-owner",
					service: "JELLYFIN" as const,
					label: "Synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "cipher",
					encryptionIv: "iv",
					identityStatus: "VERIFIED" as const,
					expectedIdentity: "shared-server",
					connectionGeneration: 1,
					identityGeneration: 1,
				})),
			});
			await native.prisma.providerObservationRun.create({
				data: {
					id: "new-run",
					instanceId: "jf",
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					authorityKey: "authority",
					activeSlotKey: "active",
					targetDigest: "digest",
					targetCount: 1,
					connectionGeneration: 1,
					identityGeneration: 1,
					state: "running",
					totalUnits: 2,
					completedUnits: 2,
					totalWork: 1,
					completedWork: 1,
				},
			});
			await native.prisma.cacheRefreshStatus.create({
				data: {
					instanceId: "jf",
					cacheType: "jellyfin_episode",
					lastRefreshedAt: now,
					lastResult: "success",
					generationId: "old-run",
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
			await native.prisma.jellyfinNativeWatchPublication.create({
				data: {
					instanceId: "jf",
					activeRunId: "old-run",
					activeCacheGenerationId: "old-run",
					activeObservedAt: now,
					activeExpectedScopeCount: 1,
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
			await native.prisma.jellyfinNativeWatchRow.create({
				data: {
					instanceId: "jf",
					runId: "old-run",
					userKeyDigest: "user-digest",
					libraryId: "library",
					jellyfinId: "old-episode",
					seriesId: "series",
					seasonNumber: 1,
					episodeNumber: 1,
					played: false,
					playCount: 0,
					lastPlayedAt: null,
					observedAt: now,
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
		});
	});
	afterEach(async () => {
		restorePrepare?.();
		restorePrepare = undefined;
		writer?.close();
		await native?.close();
		await runtime?.close();
	});
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	function interfere(sql = "", limit = 1) {
		let armed = false,
			commits = 0;
		const prepare = Database.prototype.prepare;
		Database.prototype.prepare = function (this: Database.Database, query: string) {
			const statement = prepare.call(this, query);
			if (
				this.name === path &&
				this.inTransaction &&
				/SELECT .*SqliteRestoreStorageBinding/.test(query)
			) {
				const all = statement.all;
				statement.all = function (...args: unknown[]) {
					const rows = Reflect.apply(all, this, args) as unknown[];
					if (armed && commits < limit) {
						armed = false;
						commits += 1;
						writer.exec(
							`BEGIN IMMEDIATE;UPDATE SnapshotProbe SET value=value+1 WHERE id=1;${sql}COMMIT;`,
						);
					}
					return rows;
				};
			}
			return statement;
		} as typeof Database.prototype.prepare;
		restorePrepare = () => {
			Database.prototype.prepare = prepare;
		};
		return {
			arm: () => {
				armed = true;
			},
			commits: () => commits,
		};
	}
	async function verifiedPreparation() {
		await native.prisma.jellyfinEpisodePreparation.create({
			data: {
				runId: "new-run",
				instanceId: "jf",
				generationId: "new-run",
				token,
				leaseExpiresAt: new Date(Date.now() + 300_000),
				state: "verified",
			},
		});
	}
	function competeAtEveryGuard() {
		let commits = 0,
			blocked = 0;
		const prepare = Database.prototype.prepare;
		Database.prototype.prepare = function (this: Database.Database, query: string) {
			const statement = prepare.call(this, query);
			if (
				this.name === path &&
				this.inTransaction &&
				query.includes("FROM SqliteRestoreStorageBinding")
			) {
				const all = statement.all;
				statement.all = function (...args: unknown[]) {
					const rows = Reflect.apply(all, this, args);
					try {
						writer.exec("BEGIN IMMEDIATE;UPDATE SnapshotProbe SET value=value+1 WHERE id=1;COMMIT");
						commits += 1;
					} catch (error) {
						if (writer.inTransaction) writer.exec("ROLLBACK");
						if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
							throw error;
						blocked += 1;
					}
					return rows;
				};
			}
			return statement;
		} as typeof Database.prototype.prepare;
		restorePrepare = () => {
			Database.prototype.prepare = prepare;
		};
		return { commits: () => commits, blocked: () => blocked };
	}
	function publication() {
		return {
			userId: "owner",
			instanceId: "jf",
			runId: "new-run",
			cacheGenerationId: "new-run",
			preparationToken: token,
			connectionGeneration: 1,
			identityGeneration: 1,
			observedAt: now,
			expectedScopeCount: 1,
			candidates: Array.from({ length: 500 }, (_, index) => ({
				userKeyDigest: "user-digest",
				libraryId: "library",
				jellyfinId: `episode-${index}`,
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: index + 1,
				played: false,
				playCount: 0,
				lastPlayedAt: null,
			})),
			receipts: [
				{
					userKeyDigest: "user-digest",
					libraryId: "library",
					expectedRawCount: 500,
					observedRawCount: 500,
					exact: true,
					contentFingerprint: "a".repeat(64),
				},
			],
		};
	}
	async function assertPriorPublicationAndReuse() {
		expect(
			(
				await native.prisma.jellyfinNativeWatchPublication.findUnique({
					where: { instanceId: "jf" },
				})
			)?.activeRunId,
		).toBe("old-run");
		expect(
			await native.prisma.jellyfinNativeWatchRow.count({
				where: { instanceId: "jf", runId: "old-run" },
			}),
		).toBe(1);
		expect(
			await native.prisma.jellyfinNativeWatchRow.count({ where: { instanceId: "jf-other" } }),
		).toBe(0);
		await native.prisma.$executeRawUnsafe("UPDATE SnapshotProbe SET value=99 WHERE id=1");
		expect(writer.prepare("SELECT value FROM SnapshotProbe WHERE id=1").get()).toEqual({
			value: 99,
		});
		expect(losses).toBe(0);
	}

	it("acquires a preparation in a fresh transaction after a real guarded WAL snapshot conflict", async () => {
		await runtime.runIndependentOperation(async () => {
			const race = interfere();
			race.arm();
			const result = await acquireJellyfinEpisodePreparation(native.prisma, {
				userId: "owner",
				instanceId: "jf",
				runId: "new-run",
				generationId: "new-run",
				now,
			});
			expect(result?.token).toEqual(expect.any(String));
			expect(race.commits()).toBe(1);
			expect(await native.prisma.jellyfinEpisodePreparation.count()).toBe(1);
			await assertPriorPublicationAndReuse();
		});
	});
	// Dropping the runtime opt-in (or reserving after the guard) breaks episode
	// staging before its first write and can exhaust native-watch snapshot retries.
	it("stages exact episode and native-watch generations under sustained guard-boundary competition with write intent", async () => {
		await native.close();
		native = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		await runtime.runIndependentOperation(async () => {
			const race = competeAtEveryGuard();
			const lease = await acquireJellyfinEpisodePreparation(native.prisma, {
				userId: "owner",
				instanceId: "jf",
				runId: "new-run",
				generationId: "new-run",
				now,
			});
			expect(lease).not.toBeNull();
			const rows = Array.from({ length: 501 }, (_, index) => ({
				showTmdbId: 42,
				seasonNumber: 1,
				episodeNumber: index + 1,
				jellyfinId: `episode-${index}`,
				title: `Synthetic episode ${index}`,
				watched: false,
				watchedByUsers: "[]",
				lastWatchedAt: null,
			}));
			const prepared = await prepareJellyfinEpisodeGeneration(native.prisma, {
				userId: "owner",
				instanceId: "jf",
				runId: "new-run",
				generationId: "new-run",
				token: lease!.token,
				rows,
				expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
				observedAt: now,
				now,
			});
			expect(prepared).toMatchObject({ rowCount: 501, receiptCount: 1 });
			expect(
				await native.prisma.jellyfinEpisodePreparation.findUnique({ where: { runId: "new-run" } }),
			).toMatchObject({
				state: "verified",
				expectedRowCount: 501,
				expectedReceiptCount: 1,
				token: lease!.token,
			});
			expect(
				await native.prisma.jellyfinEpisodeGenerationRow.findMany({
					where: { instanceId: "jf", generationId: "new-run" },
					orderBy: { episodeNumber: "asc" },
					select: {
						showTmdbId: true,
						seasonNumber: true,
						episodeNumber: true,
						jellyfinId: true,
						title: true,
						watched: true,
						watchedByUsers: true,
						lastWatchedAt: true,
					},
				}),
			).toEqual(rows);
			expect(
				await native.prisma.jellyfinEpisodeGenerationShowReceipt.findMany({
					where: { instanceId: "jf", generationId: "new-run" },
					select: { showTmdbId: true, rowCount: true },
				}),
			).toEqual([{ showTmdbId: 42, rowCount: 501 }]);
			const input = { ...publication(), preparationToken: lease!.token };
			await prepareNativeWatchGeneration(native.prisma, input);
			expect(
				await native.prisma.jellyfinNativeWatchRow.findMany({
					where: { instanceId: "jf", runId: "new-run" },
					orderBy: { episodeNumber: "asc" },
					select: {
						userKeyDigest: true,
						libraryId: true,
						jellyfinId: true,
						seriesId: true,
						seasonNumber: true,
						episodeNumber: true,
						played: true,
						playCount: true,
						lastPlayedAt: true,
					},
				}),
			).toEqual(input.candidates);
			expect(
				await native.prisma.jellyfinNativeWatchScopeReceipt.findMany({
					where: { instanceId: "jf", runId: "new-run" },
					select: {
						userKeyDigest: true,
						libraryId: true,
						expectedRawCount: true,
						observedRawCount: true,
						exact: true,
						contentFingerprint: true,
					},
				}),
			).toEqual(input.receipts);
			expect(race.commits()).toBe(0);
			expect(race.blocked()).toBeGreaterThan(20);
			expect(
				(
					await native.prisma.cacheRefreshStatus.findUnique({
						where: { instanceId_cacheType: { instanceId: "jf", cacheType: "jellyfin_episode" } },
					})
				)?.generationId,
			).toBe("old-run");
			await assertPriorPublicationAndReuse();
		});
	});
	it("stages one exact 500-row generation after a guarded write-upgrade conflict without publishing it", async () => {
		await runtime.runIndependentOperation(async () => {
			await verifiedPreparation();
			const race = interfere();
			await prepareNativeWatchGeneration(native.prisma, publication(), undefined, (event) => {
				if (event.kind === "row-chunk" && event.phase === "callback-entered") race.arm();
			});
			expect(race.commits()).toBe(1);
			expect(
				await native.prisma.jellyfinNativeWatchRow.count({
					where: { instanceId: "jf", runId: "new-run" },
				}),
			).toBe(500);
			expect(
				await native.prisma.jellyfinNativeWatchScopeReceipt.count({
					where: { instanceId: "jf", runId: "new-run" },
				}),
			).toBe(1);
			await assertPriorPublicationAndReuse();
		});
	});
	// Writer reservation cannot substitute for the current lease, instance owner,
	// or connection/identity generation checked by the actual staging repository.
	it.each([
		[
			"replaced lease",
			"UPDATE jellyfin_episode_preparations SET token='replacement' WHERE runId='new-run'",
		],
		[
			"expired lease",
			"UPDATE jellyfin_episode_preparations SET leaseExpiresAt='1970-01-01T00:00:00.000+00:00' WHERE runId='new-run'",
		],
		["changed owner", "UPDATE ServiceInstance SET userId='other-owner' WHERE id='jf'"],
		[
			"changed connection generation",
			"UPDATE ServiceInstance SET connectionGeneration=2 WHERE id='jf'",
		],
		[
			"changed identity generation",
			"UPDATE ServiceInstance SET identityGeneration=2 WHERE id='jf'",
		],
	])(
		"write intent rejects %s before native staging and preserves prior publication",
		async (_kind, mutation) => {
			await native.close();
			native = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
			await runtime.runIndependentOperation(async () => {
				await verifiedPreparation();
				writer.exec(mutation);
				await expect(prepareNativeWatchGeneration(native.prisma, publication())).rejects.toThrow();
				expect(
					await native.prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } }),
				).toBe(0);
				expect(
					await native.prisma.jellyfinNativeWatchScopeReceipt.count({
						where: { runId: "new-run" },
					}),
				).toBe(0);
				await assertPriorPublicationAndReuse();
			});
		},
	);
	it("rechecks a replaced lease after rollback instead of writing with its former token", async () => {
		await runtime.runIndependentOperation(async () => {
			await verifiedPreparation();
			const race = interfere(
				"UPDATE jellyfin_episode_preparations SET token='replacement-token' WHERE runId='new-run';",
			);
			await expect(
				prepareNativeWatchGeneration(native.prisma, publication(), undefined, (event) => {
					if (event.kind === "row-chunk" && event.phase === "callback-entered") race.arm();
				}),
			).rejects.toBeInstanceOf(JellyfinNativeWatchLeaseLostError);
			expect(race.commits()).toBe(1);
			expect(
				(await native.prisma.jellyfinEpisodePreparation.findUnique({ where: { runId: "new-run" } }))
					?.token,
			).toBe("replacement-token");
			expect(
				await native.prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } }),
			).toBe(0);
			await assertPriorPublicationAndReuse();
		});
	});
	it("refuses preparation when the real competing commit transfers the instance to another owner", async () => {
		await runtime.runIndependentOperation(async () => {
			const race = interfere("UPDATE ServiceInstance SET userId='other-owner' WHERE id='jf';");
			race.arm();
			await expect(
				acquireJellyfinEpisodePreparation(native.prisma, {
					userId: "owner",
					instanceId: "jf",
					runId: "new-run",
					generationId: "new-run",
					now,
				}),
			).resolves.toBeNull();
			expect(race.commits()).toBe(1);
			expect(await native.prisma.jellyfinEpisodePreparation.count()).toBe(0);
			expect(
				(await native.prisma.serviceInstance.findUnique({ where: { id: "jf" } }))?.userId,
			).toBe("other-owner");
			await assertPriorPublicationAndReuse();
		});
	});
	it("exhausts a finite four-attempt snapshot budget with no partially staged rows", async () => {
		await runtime.runIndependentOperation(async () => {
			await verifiedPreparation();
			const race = interfere("", 10);
			await expect(
				prepareNativeWatchGeneration(native.prisma, publication(), undefined, (event) => {
					if (event.kind === "row-chunk" && event.phase === "callback-entered") race.arm();
				}),
			).rejects.toMatchObject({ code: "SQLITE_BUSY_SNAPSHOT" });
			expect(race.commits()).toBe(4);
			expect(
				await native.prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } }),
			).toBe(0);
			await assertPriorPublicationAndReuse();
		});
	});
	it("does not retry an unrelated real uniqueness failure", async () => {
		await runtime.runIndependentOperation(async () => {
			await verifiedPreparation();
			const input = publication();
			input.candidates[1] = { ...input.candidates[0]! };
			let calls = 0;
			await expect(
				prepareNativeWatchGeneration(native.prisma, input, undefined, (event) => {
					if (event.kind === "row-chunk" && event.phase === "callback-entered") calls += 1;
				}),
			).rejects.toMatchObject({ code: "P2002" });
			expect(calls).toBe(1);
			expect(
				await native.prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } }),
			).toBe(0);
			await assertPriorPublicationAndReuse();
		});
	});
	it("cannot reenter a staging callback after real runtime admission is lost during recovery", async () => {
		await runtime.runIndependentOperation(async () => {
			await verifiedPreparation();
			const race = interfere();
			let callbacks = 0;
			await expect(
				prepareNativeWatchGeneration(native.prisma, publication(), undefined, (event) => {
					if (event.kind === "row-chunk" && event.phase === "callback-entered") {
						callbacks += 1;
						race.arm();
					}
					if (event.kind === "row-chunk" && event.phase === "failed")
						getRestoreRuntimeClientContext(runtime).unavailable("native-owner-unavailable");
				}),
			).rejects.toBeDefined();
			expect(callbacks).toBe(1);
			expect(losses).toBe(1);
			expect(
				writer
					.prepare("SELECT COUNT(*) AS count FROM jellyfin_native_watch_rows WHERE runId='new-run'")
					.get(),
			).toEqual({ count: 0 });
		});
	});
});
