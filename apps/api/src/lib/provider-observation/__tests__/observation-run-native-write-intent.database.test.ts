import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import {
	buildJellyfinEpisodeScopePlan,
	stageJellyfinEpisodePage,
} from "../../jellyfin/jellyfin-episode-refresh-repository.js";
import { withSqliteTransactionWriteIntent } from "../../sqlite-transaction-intent.js";
import {
	claimObservationUnit,
	completeObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	getAutomaticObservationRenewalDeadline,
	invalidateObservationRuns,
	recoverAbandonedObservationRuns,
} from "../observation-run-repository.js";

const schema = new SqliteSchemaFixture();
beforeAll(() => schema.initialize(), 60000);
afterAll(() => schema.dispose());

const authority = {
	provider: "plex_episode",
	cacheType: "plex_episode",
	instanceId: "native-observation-instance",
	parentGenerationId: "native-observation-parent",
	targetDigest: "a".repeat(64),
	connectionGeneration: 2,
	identityGeneration: 3,
} as const;
const units = [
	{
		ordinal: 0,
		scopeKey: "native-scope",
		scopeDigest: "b".repeat(64),
		phase: "collect",
		expectedTargets: 1,
	},
] as const;

async function fixture(service: "PLEX" | "JELLYFIN" = "PLEX") {
	const directory = mkdtempSync(join(tmpdir(), "observation-native-write-"));
	chmodSync(directory, 0o700);
	const held = lstatSync(directory),
		path = join(directory, "synthetic.db");
	schema.copyTo(path);
	chmodSync(path, 0o600);
	const writer = new Database(path, { timeout: 0 });
	writer.pragma("journal_mode=WAL");
	writer.exec(
		"CREATE TABLE NativeObservationProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO NativeObservationProbe VALUES(1,0)",
	);
	const losses: string[] = [];
	const runtime = await openRestoreRuntime({
		databaseUrl: `file:${path}`,
		onUnavailable: (event) => losses.push(event.reason),
	});
	let actualNative: Database.Database | undefined;
	const nativeHandles = new Set<Database.Database>();
	let overlapArmed = false,
		guardPaused = false,
		reservationReleased = false,
		guardReadInTransaction = false;
	let signalGuardPaused!: () => void, resumeGuard!: () => void, signalGuardRead!: () => void;
	const paused = new Promise<void>((resolve) => {
		signalGuardPaused = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		resumeGuard = resolve;
	});
	const guardRead = new Promise<void>((resolve) => {
		signalGuardRead = resolve;
	});
	const driverHooks: Array<ReturnType<typeof vi.spyOn>> = [];
	const connect = PrismaBetterSqlite3.prototype.connect;
	const connectHook = vi
		.spyOn(PrismaBetterSqlite3.prototype, "connect")
		.mockImplementation(async function (this: PrismaBetterSqlite3) {
			const driver = await connect.call(this),
				handle = Reflect.get(driver, "client");
			if (!(handle instanceof Database) || handle.name !== path)
				throw Error("Native observation handle unconfirmed");
			actualNative ??= handle;
			nativeHandles.add(handle);
			const queryRaw = driver.queryRaw.bind(driver);
			driverHooks.push(
				vi.spyOn(driver, "queryRaw").mockImplementation(async (query) => {
					if (
						overlapArmed &&
						!guardPaused &&
						handle === actualNative &&
						!handle.inTransaction &&
						query.sql.includes("FROM RestoreRuntimeControl")
					) {
						guardPaused = true;
						signalGuardPaused();
						await resume;
						const result = await queryRaw(query);
						guardReadInTransaction = handle.inTransaction;
						writer.prepare("UPDATE NativeObservationProbe SET value=value+1 WHERE id=1").run();
						signalGuardRead();
						return result;
					}
					return queryRaw(query);
				}),
			);
			const startTransaction = driver.startTransaction.bind(driver);
			driverHooks.push(
				vi.spyOn(driver, "startTransaction").mockImplementation(async (...args) => {
					const transaction = await startTransaction(...args);
					const executeRaw = transaction.executeRaw.bind(transaction);
					driverHooks.push(
						vi.spyOn(transaction, "executeRaw").mockImplementation(async (query) => {
							if (
								overlapArmed &&
								!reservationReleased &&
								query.sql === 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0'
							) {
								reservationReleased = true;
								resumeGuard();
								await guardRead;
							}
							return executeRaw(query);
						}),
					);
					return transaction;
				}),
			);
			return driver;
		});
	const client = createRuntimePrismaClient(runtime);
	let hook: ReturnType<typeof vi.spyOn> | undefined;
	let injected = false,
		committed = false,
		blocked = false;
	try {
		await runtime.bindDestination("native-observation-destination");
		await runtime.activate();
		await runtime.runOperation(async () => {
			await client.prisma.user.create({
				data: { id: "native-observation-user", username: "native-observation-user" },
			});
			await client.prisma.serviceInstance.create({
				data: {
					id: authority.instanceId,
					userId: "native-observation-user",
					service,
					label: "native-observation",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
					connectionGeneration: 2,
					identityGeneration: 3,
				},
			});
		});
	} catch (error) {
		await client.close();
		await runtime.close();
		connectHook.mockRestore();
		writer.close();
		rmSync(directory, { recursive: true });
		throw error;
	}
	return {
		runtime,
		prisma: client.prisma,
		writer,
		losses,
		async startOverlappingRead() {
			overlapArmed = true;
			const completion = runtime.runOperation(() => client.prisma.user.count());
			void completion.catch(() => undefined);
			await paused;
			return { completion };
		},
		overlapObservation: () => ({ guardPaused, reservationReleased, guardReadInTransaction }),
		injectCommit() {
			const prepare = Database.prototype.prepare;
			hook = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				const statement = prepare.call(this, sql);
				if (
					!injected &&
					nativeHandles.has(this) &&
					this.inTransaction &&
					sql.includes("FROM RestoreRuntimeControl")
				) {
					const all = statement.all;
					statement.all = function (this: Database.Statement, ...args: unknown[]) {
						const result = Reflect.apply(all, this, args);
						if (!injected) {
							injected = true;
							try {
								writer.prepare("UPDATE NativeObservationProbe SET value=value+1 WHERE id=1").run();
								committed = true;
							} catch (error) {
								if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
									throw error;
								blocked = true;
							}
						}
						return result;
					} as typeof statement.all;
				}
				return statement;
			});
		},
		observation: () => ({ actualNativeBound: Boolean(actualNative), injected, committed, blocked }),
		async close() {
			resumeGuard();
			hook?.mockRestore();
			await client.close();
			await runtime.close();
			for (const driverHook of driverHooks.reverse()) driverHook.mockRestore();
			connectHook.mockRestore();
			writer.close();
			const current = lstatSync(directory);
			if (
				current.dev !== held.dev ||
				current.ino !== held.ino ||
				current.uid !== process.getuid?.() ||
				!current.isDirectory() ||
				current.isSymbolicLink()
			)
				throw Error("Synthetic observation ownership changed");
			rmSync(directory, { recursive: true });
		},
	};
}

describe("native observation transaction write admission", () => {
	it("stages a Jellyfin page once when an ordinary guard read overlaps writer reservation", async () => {
		const f = await fixture("JELLYFIN");
		try {
			const scope = {
				userId: "native-jellyfin-user",
				userName: "synthetic",
				libraryId: "native-jellyfin-library",
			};
			const plan = buildJellyfinEpisodeScopePlan([scope]);
			const run = await f.runtime.runOperation(() =>
				createOrLoadObservationRun(f.prisma, {
					authority: {
						...authority,
						provider: "jellyfin_episode",
						cacheType: "jellyfin_episode",
						targetDigest: plan.targetDigest,
					},
					units: plan.units,
				}),
			);
			const now = new Date();
			const claim = await f.runtime.runOperation(() =>
				claimObservationUnit(f.prisma, { runId: run.id, now }),
			);
			expect(claim?.phase).toBe("collect");
			const page = {
				startIndex: 0,
				totalRecordCount: 1,
				items: [
					{
						id: "native-jellyfin-episode",
						name: "synthetic",
						type: "Episode" as const,
						seriesId: "native-jellyfin-series",
						seasonNumber: 1,
						episodeNumber: 1,
						played: true,
						playCount: 1,
						lastPlayedDate: null,
					},
				],
			};
			const { completion } = await f.startOverlappingRead();
			const result = await f.runtime
				.runOperation(() => stageJellyfinEpisodePage(f.prisma, claim!, scope, page, now))
				.then(
					(staged) => ({ staged, code: "none" }),
					(error) => ({
						staged: false,
						code: error?.code === "SQLITE_BUSY_SNAPSHOT" ? error.code : "other",
					}),
				);
			await expect(completion).resolves.toBe(1);
			expect(f.overlapObservation()).toMatchObject({
				guardPaused: true,
				reservationReleased: true,
			});
			expect(result).toEqual({ staged: true, code: "none" });
			expect(f.overlapObservation().guardReadInTransaction).toBe(false);
			await expect(
				f.runtime.runOperation(() => stageJellyfinEpisodePage(f.prisma, claim!, scope, page, now)),
			).resolves.toBe(false);
			const state = await f.runtime.runOperation(async () => ({
				rows: await f.prisma.jellyfinEpisodeObservationStage.findMany({
					where: { runId: run.id },
					select: { unitId: true, jellyfinId: true, pass: true },
				}),
				unit: await f.prisma.providerObservationUnit.findUniqueOrThrow({
					where: { id: claim!.unitId },
					select: {
						state: true,
						claimToken: true,
						cursor: true,
						expectedRawCount: true,
						observedRawCount: true,
						completedPages: true,
					},
				}),
				run: await f.prisma.providerObservationRun.findUniqueOrThrow({
					where: { id: run.id },
					select: { state: true, completedUnits: true, completedWork: true },
				}),
			}));
			expect(state).toEqual({
				rows: [{ unitId: claim!.unitId, jellyfinId: "native-jellyfin-episode", pass: "collect" }],
				unit: {
					state: "complete",
					claimToken: null,
					cursor: 1,
					expectedRawCount: 1,
					observedRawCount: 1,
					completedPages: 1,
				},
				run: { state: "running", completedUnits: 1, completedWork: 1 },
			});
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("claims once when an ordinary guard read overlaps writer reservation", async () => {
		const f = await fixture();
		try {
			const run = await f.runtime.runOperation(() =>
				createOrLoadObservationRun(f.prisma, { authority, units }),
			);
			const { completion } = await f.startOverlappingRead();
			const result = await f.runtime
				.runOperation(() => claimObservationUnit(f.prisma, { runId: run.id, now: new Date() }))
				.then(
					(claim) => ({ claimed: Boolean(claim), code: "none" }),
					(error) => ({
						claimed: false,
						code: error?.code === "SQLITE_BUSY_SNAPSHOT" ? error.code : "other",
					}),
				);
			await expect(completion).resolves.toBe(1);
			expect(f.overlapObservation()).toMatchObject({
				guardPaused: true,
				reservationReleased: true,
			});
			expect(result).toEqual({ claimed: true, code: "none" });
			expect(f.overlapObservation().guardReadInTransaction).toBe(false);
			expect(
				await f.runtime.runOperation(() =>
					f.prisma.providerObservationUnit.findMany({
						where: { runId: run.id },
						select: { state: true, attemptCount: true },
					}),
				),
			).toEqual([{ state: "running", attemptCount: 0 }]);
			await expect(
				f.runtime.runOperation(() =>
					claimObservationUnit(f.prisma, { runId: run.id, now: new Date() }),
				),
			).resolves.toBeNull();
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it.each(["run-open", "unit-claim", "complete", "fail", "invalidate", "recover"] as const)(
		"reserves the writer before guard reads for %s",
		async (boundary) => {
			const f = await fixture();
			try {
				const run =
					boundary === "run-open"
						? null
						: await f.runtime.runOperation(() =>
								withSqliteTransactionWriteIntent(() =>
									createOrLoadObservationRun(f.prisma, { authority, units }),
								),
							);
				const claim =
					boundary === "complete" || boundary === "fail"
						? await f.runtime.runOperation(() =>
								withSqliteTransactionWriteIntent(() =>
									claimObservationUnit(f.prisma, { runId: run!.id, now: new Date() }),
								),
							)
						: null;
				if (boundary === "recover")
					await f.runtime.runOperation(() =>
						f.prisma.serviceInstance.update({
							where: { id: authority.instanceId },
							data: { connectionGeneration: 3 },
						}),
					);
				f.injectCommit();
				const result = await f.runtime
					.runOperation(async () => {
						switch (boundary) {
							case "run-open":
								return Boolean(await createOrLoadObservationRun(f.prisma, { authority, units }));
							case "unit-claim":
								return Boolean(
									await claimObservationUnit(f.prisma, { runId: run!.id, now: new Date() }),
								);
							case "complete":
								return await completeObservationUnit(f.prisma, {
									claim: claim!,
									expectedRawCount: 1,
									observedRawCount: 1,
								});
							case "fail":
								return await failObservationUnit(f.prisma, {
									claim: claim!,
									reasonCode: "provider-unavailable",
									now: new Date(),
								});
							case "invalidate":
								return (
									(await invalidateObservationRuns(f.prisma, {
										instanceId: authority.instanceId,
									})) === 1
								);
							case "recover":
								return (await recoverAbandonedObservationRuns(f.prisma)) === 1;
						}
					})
					.then(
						(value) => ({ succeeded: value === true, code: "none" }),
						(error) => ({
							succeeded: false,
							code: error?.code === "SQLITE_BUSY_SNAPSHOT" ? "SQLITE_BUSY_SNAPSHOT" : "other",
						}),
					);
				expect(result).toEqual({ succeeded: true, code: "none" });
				expect(f.observation()).toEqual({
					actualNativeBound: true,
					injected: true,
					committed: false,
					blocked: true,
				});
				expect(f.losses).toEqual([]);
			} finally {
				await f.close();
			}
		},
	);

	it("does not reserve the writer for the read-only renewal deadline", async () => {
		const f = await fixture();
		try {
			f.injectCommit();
			const result = await f.runtime.runOperation(() =>
				getAutomaticObservationRenewalDeadline(f.prisma, {
					runId: "missing-synthetic-run",
					instanceId: authority.instanceId,
					userId: "native-observation-user",
					authorityKey: "invalid",
					parentGenerationId: `jellyfin-episode-parent-v3:${"d".repeat(64)}`,
					targetDigest: authority.targetDigest,
					connectionGeneration: 2,
					identityGeneration: 3,
					now: new Date(),
				}),
			);
			expect(result).toBeNull();
			expect(f.observation()).toEqual({
				actualNativeBound: true,
				injected: true,
				committed: true,
				blocked: false,
			});
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("refuses a held external writer before creating work and still requires a runtime ticket", async () => {
		const f = await fixture();
		try {
			await expect(createOrLoadObservationRun(f.prisma, { authority, units })).rejects.toThrow();
			f.writer.exec("BEGIN IMMEDIATE; UPDATE NativeObservationProbe SET value=value+1 WHERE id=1");
			await expect(
				f.runtime.runOperation(() => createOrLoadObservationRun(f.prisma, { authority, units })),
			).rejects.toThrow();
			f.writer.exec("ROLLBACK");
			expect(await f.runtime.runOperation(() => f.prisma.providerObservationRun.count())).toBe(0);
			expect(f.losses).toEqual([]);
		} finally {
			if (f.writer.inTransaction) f.writer.exec("ROLLBACK");
			await f.close();
		}
	});
});
