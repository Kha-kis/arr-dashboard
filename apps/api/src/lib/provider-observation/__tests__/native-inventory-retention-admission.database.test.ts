import { execFile } from "node:child_process";
import {
	chmodSync,
	constants,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNativeInventoryRetentionTick } from "../../../plugins/native-inventory-scheduler.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	withIsolatedRuntimePrismaTransaction,
} from "../../backup/restore-runtime-client.js";
import type { Prisma, PrismaClient } from "../../prisma.js";
import {
	beginNativeInventoryPass,
	claimDueNativeInventoryRun,
	commitNativeInventoryPage,
} from "../native-inventory-job-repository.js";
import {
	type NativeInventoryRetentionCursor,
	pruneNativeInventoryRetentionSlice,
} from "../native-inventory-retention.js";
import { nativeInventoryRetentionDiagnosticsFrom } from "../native-inventory-retention-diagnostics.js";

const OLD = new Date(Date.now() - 30 * 86_400_000);
const CUTOFF = new Date(Date.now() - 7 * 86_400_000);
let directory: string;
let sequence = 0;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "native-retention-admission-"));
	const api = resolve(import.meta.dirname, "../../../..");
	const schema = readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
		/generator client \{[\s\S]*?\}/,
		'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
	);
	const schemaPath = join(directory, "schema.prisma");
	const config = join(directory, "safe.config.ts");
	const url = `file:${join(directory, "template.db")}`;
	writeFileSync(schemaPath, schema, { mode: 0o600 });
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
			schemaPath,
			"--config",
			config,
			"--url",
			url,
		],
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH,
				LANG: "C.UTF-8",
				TZ: "UTC",
				DATABASE_URL: url,
				CHECKPOINT_DISABLE: "1",
				DOTENV_CONFIG_PATH: "/dev/null",
			},
			timeout: 60_000,
		},
	);
	const database = new Database(join(directory, "template.db"));
	database.pragma("journal_mode = WAL");
	database.close();
}, 90_000);

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function nativeBusy() {
	return Object.assign(new Error("Synthetic native writer admission refusal"), {
		code: "P1008",
		meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
	});
}

async function withFixture(
	operation: (fixture: {
		databaseUrl: string;
		prisma: PrismaClient;
		writer: Database.Database;
		seedOld: (id: string) => Promise<void>;
		assertProtected: () => Promise<void>;
	}) => Promise<void>,
	journalMode?: "wal" | "delete",
) {
	const path = join(directory, `case-${sequence++}.db`);
	copyFileSync(join(directory, "template.db"), path, constants.COPYFILE_EXCL);
	chmodSync(path, 0o600);
	if (journalMode) {
		const setup = new Database(path);
		try {
			expect(setup.pragma(`journal_mode = ${journalMode}`, { simple: true })).toBe(journalMode);
		} finally {
			setup.close();
		}
	}
	let losses = 0;
	const runtime = await openRestoreRuntime({
		databaseUrl: `file:${path}`,
		onUnavailable: () => losses++,
	});
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let writer: Database.Database | undefined;
	try {
		await runtime.bindDestination("synthetic-retention-admission");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		const prisma = native.prisma;
		await runtime.runOperation(async () => {
			await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
			await prisma.serviceInstance.create({
				data: {
					id: "provider",
					userId: "owner",
					service: "JELLYFIN",
					label: "Synthetic",
					baseUrl: "http://provider.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
					connectionGeneration: 2,
					identityGeneration: 3,
				},
			});
			const common = {
				instanceId: "provider",
				workKey: "library",
				connectionGeneration: 2,
				identityGeneration: 3,
			};
			await prisma.providerNativeInventoryRun.create({
				data: {
					id: "latest",
					...common,
					state: "pending",
					activeSlotKey: "synthetic-slot",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await prisma.providerNativeInventoryRun.create({
				data: { id: "head", ...common, state: "published", createdAt: OLD, updatedAt: OLD },
			});
			await prisma.providerNativeInventoryPass.create({
				data: { id: "head-pass", runId: "head", ordinal: 1, state: "complete" },
			});
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					id: "snapshot",
					instanceId: "provider",
					domain: "library",
					generationId: "synthetic",
					publishedPassId: "head-pass",
					connectionGeneration: 2,
					identityGeneration: 3,
					observedAt: OLD,
					itemCount: 1,
				},
			});
			await prisma.providerNativeInventoryItem.create({
				data: {
					snapshotId: "snapshot",
					nativeId: "protected",
					mediaType: "movie",
					libraryIds: '["synthetic"]',
				},
			});
			const seedOld = async (id: string) => {
				await prisma.providerNativeInventoryRun.create({
					data: { id, ...common, state: "incomplete", createdAt: OLD, updatedAt: OLD },
				});
				await prisma.providerNativeInventoryPass.create({
					data: { id: `${id}-pass`, runId: id, ordinal: 1 },
				});
				await prisma.providerNativeInventoryStageItem.create({
					data: {
						passId: `${id}-pass`,
						domain: "library",
						nativeId: "synthetic",
						mediaType: "movie",
						libraryIds: '["synthetic"]',
					},
				});
			};
			await seedOld("old-A");
			writer = new Database(path, { timeout: 0 });
			await operation({
				databaseUrl: `file:${path}`,
				prisma,
				writer,
				seedOld,
				assertProtected: async () => {
					for (const id of ["latest", "head", "old-A"])
						expect(await prisma.providerNativeInventoryRun.count({ where: { id } })).toBe(1);
					expect(
						await prisma.providerNativeInventoryPass.count({ where: { id: "head-pass" } }),
					).toBe(1);
					expect(
						await prisma.providerNativeInventorySnapshot.count({ where: { id: "snapshot" } }),
					).toBe(1);
					expect(
						await prisma.providerNativeInventoryItem.count({ where: { snapshotId: "snapshot" } }),
					).toBe(1);
					expect(await prisma.user.count({ where: { id: "owner" } })).toBe(1);
				},
			});
		});
		expect(losses).toBe(0);
	} finally {
		if (writer?.inTransaction) writer.exec("ROLLBACK");
		writer?.close();
		await native?.close();
		await runtime.close();
	}
}

type TransactionOperation = (tx: Prisma.TransactionClient) => Promise<unknown>;
function observeTransactions(
	prisma: PrismaClient,
	options: {
		before?: (attempt: number) => void;
		afterRefusal?: (attempt: number, error: unknown) => void;
		enteredError?: unknown;
		injectedError?: unknown;
	} = {},
) {
	const observed = { attempts: 0, callbacks: 0 };
	const proxy = new Proxy(prisma, {
		get(target, property) {
			if (property === "$transaction")
				return async (operation: TransactionOperation, settings: unknown) => {
					const attempt = ++observed.attempts;
					options.before?.(attempt);
					if (Object.hasOwn(options, "injectedError")) throw options.injectedError;
					try {
						return await target.$transaction(
							async (tx) => {
								observed.callbacks++;
								if (options.enteredError) {
									const failing = new Proxy(tx, {
										get(client, name) {
											if (name === "providerNativeInventoryRun")
												return new Proxy(client.providerNativeInventoryRun, {
													get(delegate, method) {
														if (method === "findFirst")
															return async () => {
																throw options.enteredError;
															};
														return Reflect.get(delegate, method);
													},
												});
											return Reflect.get(client, name);
										},
									});
									return operation(failing);
								}
								return operation(tx);
							},
							settings as {
								maxWait?: number;
								timeout?: number;
								isolationLevel?: Prisma.TransactionIsolationLevel;
							},
						);
					} catch (error) {
						options.afterRefusal?.(attempt, error);
						throw error;
					}
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { prisma: proxy, observed };
}

function retentionForFixture(prisma: PrismaClient, databaseUrl: string) {
	const errors: unknown[] = [];
	const completed: Array<{ deletedRows: number; scannedRuns: number }> = [];
	const state: { cursor: NativeInventoryRetentionCursor | null } = { cursor: null };
	return {
		completed,
		errors,
		state,
		tick: () =>
			runNativeInventoryRetentionTick(
				{
					prisma,
					config: { DATABASE_URL: databaseUrl },
					log: {
						info(event: (typeof completed)[number]) {
							completed.push(event);
						},
						error(event: unknown) {
							errors.push(event);
						},
					},
				} as never,
				{ retentionState: state },
			),
	};
}

it("recovers the next retention tick after a guarded native inventory page writer holds SQLite", async () => {
	await withFixture(async ({ databaseUrl, prisma, assertProtected }) => {
		await prisma.serviceInstance.update({
			where: { id: "provider" },
			data: {
				expectedIdentity: "synthetic-provider",
				identityKind: "JELLYFIN_SERVER_ID",
				identityStatus: "VERIFIED",
			},
		});
		const now = new Date();
		const acquired = await claimDueNativeInventoryRun(prisma, "latest", now);
		if (acquired.status !== "acquired")
			throw new Error(`Expected live claim, got ${acquired.status}`);
		const { claim } = acquired;
		const scopeKey = "synthetic-scope";
		await expect(
			beginNativeInventoryPass(
				prisma,
				claim,
				{
					catalogIdentity: "synthetic-catalog",
					domains: [{ domain: "library", scopeKeys: [scopeKey] }],
				},
				now,
			),
		).resolves.toMatchObject({ status: "recorded" });
		const pass = await prisma.providerNativeInventoryPass.findFirstOrThrow({
			where: { runId: "latest" },
		});
		const activeCounts = () =>
			Promise.all([
				prisma.providerNativeInventoryPageReceipt.count({ where: { passId: pass.id } }),
				prisma.providerNativeInventoryStageItem.count({ where: { passId: pass.id } }),
			]);
		const obsoleteCount = () =>
			prisma.providerNativeInventoryStageItem.count({
				where: { passId: "old-A-pass" },
			});
		const retention = retentionForFixture(prisma, databaseUrl);
		const receipt = {
			domain: "library" as const,
			scopeKey,
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["new-page-item"],
			comparisonKeys: ["movie:new-page-item"],
		};
		const rows = [
			{
				nativeId: "new-page-item",
				mediaType: "movie" as const,
				libraryIds: [scopeKey],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Synthetic movie",
			},
		];
		await expect(activeCounts()).resolves.toEqual([0, 0]);
		await expect(obsoleteCount()).resolves.toBe(1);
		await assertProtected();
		// Pause after the real guarded page write and before the writer releases SQLite.
		const heldWriter = new Proxy(prisma, {
			get(target, property) {
				if (property === "$transaction") {
					return (
						operation: TransactionOperation,
						options?: {
							maxWait?: number;
							timeout?: number;
							isolationLevel?: Prisma.TransactionIsolationLevel;
						},
					) =>
						withIsolatedRuntimePrismaTransaction(
							target,
							async (tx) => {
								const result = await operation(tx);
								await expect(retention.tick()).rejects.toThrow("Native inventory retention failed");
								return result;
							},
							options,
						);
				}
				return Reflect.get(target, property, target);
			},
		});
		await expect(commitNativeInventoryPage(heldWriter, claim, receipt, rows, now)).resolves.toEqual(
			{
				status: "recorded",
			},
		);
		// The guarded writer holds its lock through both admission attempts.
		expect(retention.errors).toEqual([
			{
				category: "native-inventory-retention-failed",
				failurePhase: "retention",
				failureCode: "P1008",
				outcome: "failed",
				elapsedMs: expect.any(Number),
				retentionBoundary: {
					operation: "transaction-start",
					transactionEntered: false,
					nativeCode: "SQLITE_BUSY",
					retryObserved: true,
				},
			},
		]);
		expect(retention.state.cursor).toBeNull();
		await expect(activeCounts()).resolves.toEqual([1, 1]);
		await expect(obsoleteCount()).resolves.toBe(1);
		await assertProtected();

		await retention.tick();
		await expect(obsoleteCount()).resolves.toBe(0);
		await expect(activeCounts()).resolves.toEqual([1, 1]);
		await assertProtected();
		await expect(
			prisma.providerNativeInventoryRun.findUnique({ where: { id: claim.runId } }),
		).resolves.toMatchObject({
			claimToken: claim.token,
			leaseUntil: claim.leaseUntil,
			connectionGeneration: 2,
			identityGeneration: 3,
			failureCount: 0,
		});
		await expect(
			commitNativeInventoryPage(prisma, { ...claim, token: "stale" }, receipt, rows, now),
		).resolves.toEqual({ status: "superseded" });
		await expect(commitNativeInventoryPage(prisma, claim, receipt, rows, now)).resolves.toEqual({
			status: "coalesced",
		});
	});
}, 20_000);

it("retires two scaled cohorts with the default scheduler limits", async () => {
	await withFixture(async ({ databaseUrl, prisma, seedOld, assertProtected }) => {
		const retention = retentionForFixture(prisma, databaseUrl);
		const cohortSize = 1_000;
		const samples = [];
		for (const runId of ["old-C", "old-D"]) {
			await seedOld(runId);
			const passId = `${runId}-pass`;
			const items = Array.from({ length: cohortSize }, (_, index) => ({
				passId,
				domain: "library",
				nativeId: `cohort-item-${index}`,
			}));
			await prisma.providerNativeInventoryStageItem.createMany({
				data: items.map((item) => ({ ...item, mediaType: "movie", libraryIds: '["scope"]' })),
			});
			await prisma.providerNativeInventorySeenItem.createMany({
				data: items.map((item) => ({ ...item, scopeKey: "scope" })),
			});
			const countRows = () =>
				Promise.all([
					prisma.providerNativeInventoryStageItem.count({ where: { passId } }),
					prisma.providerNativeInventorySeenItem.count({ where: { passId } }),
				]);
			await expect(countRows()).resolves.toEqual([1_001, 1_000]);
			const firstReceipt = retention.completed.length;
			const started = performance.now();
			for (let tick = 0; tick < 8; tick++) {
				await retention.tick();
				if (!(await countRows()).some(Boolean)) break;
			}
			await expect(countRows()).resolves.toEqual([0, 0]);
			await expect(
				prisma.providerNativeInventoryPass.count({ where: { id: passId } }),
			).resolves.toBe(0);
			await assertProtected();
			const ticks = retention.completed
				.slice(firstReceipt)
				.map(({ deletedRows, scannedRuns }) => ({ deletedRows, scannedRuns }));
			expect(ticks.reduce((sum, tick) => sum + tick.deletedRows, 0)).toBe(
				runId === "old-C" ? 2_004 : 2_002,
			);
			samples.push({
				cohortRows: 2_001,
				elapsedMs: Math.round(performance.now() - started),
				ticks,
			});
		}
		expect(retention.errors).toEqual([]);
		process.stdout.write(
			`${JSON.stringify({ category: "synthetic-native-retention-capacity", samples })}\n`,
		);
	});
}, 35_000);

describe("bounded native retention admission retry", () => {
	it("advances over pass-less attempt metadata without reserving the writer", async () => {
		await withFixture(async ({ prisma, seedOld, assertProtected }) => {
			await seedOld("old-0");
			await prisma.providerNativeInventoryPass.delete({ where: { id: "old-0-pass" } });
			const metadata = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
				where: { id: "old-0" },
			});
			const observed = observeTransactions(prisma);
			const first = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF, {
				scanLimit: 1,
			});
			expect(first).toEqual({
				deletedRows: 0,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: { id: "old-0" },
				hasMore: true,
			});
			const drained = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF, {
				cursor: first.nextCursor,
			});
			expect(drained).toEqual({
				deletedRows: 2,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: null,
				hasMore: false,
			});
			await assertProtected();
			await expect(
				prisma.providerNativeInventoryRun.findUnique({ where: { id: "old-0" } }),
			).resolves.toEqual(metadata);
			await expect(
				prisma.providerNativeInventoryPass.count({ where: { runId: "old-A" } }),
			).resolves.toBe(0);
			expect(observed.observed).toEqual({ attempts: 1, callbacks: 1 });
		});
	});

	it.each(["wal", "delete"] as const)(
		"skips protected staged work while a real %s writer is reserved",
		async (journalMode) => {
			await withFixture(async ({ prisma, writer, assertProtected }) => {
				await prisma.providerNativeInventoryRun.update({
					where: { id: "latest" },
					data: { state: "incomplete", activeSlotKey: null, updatedAt: OLD },
				});
				await prisma.providerNativeInventoryPass.create({
					data: { id: "latest-pass", runId: "latest", ordinal: 1, state: "collecting" },
				});
				await prisma.providerNativeInventoryStageItem.create({
					data: {
						passId: "latest-pass",
						domain: "library",
						nativeId: "keep-protected",
						mediaType: "movie",
						libraryIds: '["synthetic"]',
					},
				});
				const observed = observeTransactions(prisma);
				writer.exec("BEGIN IMMEDIATE");
				let first: Awaited<ReturnType<typeof pruneNativeInventoryRetentionSlice>>;
				try {
					expect(writer.pragma("journal_mode", { simple: true })).toBe(journalMode);
					first = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF, {
						scanLimit: 1,
						skipProtectedWriteAdmission: true,
					});
					expect(first).toEqual({
						deletedRows: 0,
						deletedRuns: 0,
						scannedRuns: 1,
						nextCursor: { id: "latest" },
						hasMore: true,
					});
					expect(observed.observed).toEqual({ attempts: 0, callbacks: 0 });
					expect(writer.inTransaction).toBe(true);
				} finally {
					writer.exec("ROLLBACK");
				}
				const next = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF, {
					cursor: first.nextCursor,
					skipProtectedWriteAdmission: true,
				});
				expect(next).toMatchObject({ deletedRows: 2, scannedRuns: 1, hasMore: false });
				expect(observed.observed).toEqual({ attempts: 1, callbacks: 1 });
				await assertProtected();
				expect(
					await prisma.providerNativeInventoryStageItem.count({ where: { passId: "latest-pass" } }),
				).toBe(1);
				expect(
					await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } }),
				).toBe(0);
			}, journalMode);
		},
		15_000,
	);

	it("retries one settled native-busy admission and revalidates the real transaction", async () => {
		await withFixture(async ({ prisma, writer, assertProtected }) => {
			writer.exec("BEGIN IMMEDIATE");
			const observed = observeTransactions(prisma, {
				afterRefusal: (attempt, error) => {
					expect(attempt).toBe(1);
					expect(error).toMatchObject({
						code: "P1008",
						meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
					});
					expect(observed.observed.callbacks).toBe(0);
					writer.exec("ROLLBACK");
				},
			});
			const result = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF);
			expect(result.deletedRows).toBe(2);
			expect(observed.observed).toEqual({ attempts: 2, callbacks: 1 });
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				0,
			);
		});
	}, 15_000);

	it("exhausts the single retry honestly without entering retention or changing rows", async () => {
		await withFixture(async ({ prisma, writer, assertProtected }) => {
			writer.exec("BEGIN IMMEDIATE");
			const observed = observeTransactions(prisma);
			const failure = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF).catch(
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ code: "P1008" });
			expect(nativeInventoryRetentionDiagnosticsFrom(failure)).toMatchObject({
				retentionBoundary: {
					operation: "transaction-start",
					transactionEntered: false,
					nativeCode: "SQLITE_BUSY",
					retryObserved: true,
				},
			});
			expect(observed.observed).toEqual({ attempts: 2, callbacks: 0 });
			writer.exec("ROLLBACK");
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				1,
			);
			expect(
				await prisma.providerNativeInventoryStageItem.count({ where: { passId: "old-A-pass" } }),
			).toBe(1);
		});
	}, 15_000);

	it("shares one retry across candidates and does not conceal a later partial failure", async () => {
		await withFixture(async ({ prisma, writer, seedOld, assertProtected }) => {
			await seedOld("old-B");
			writer.exec("BEGIN IMMEDIATE");
			const observed = observeTransactions(prisma, {
				before: (attempt) => {
					if (attempt === 3) writer.exec("BEGIN IMMEDIATE");
				},
				afterRefusal: (attempt) => {
					if (attempt === 1) writer.exec("ROLLBACK");
				},
			});
			await expect(
				pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF),
			).rejects.toMatchObject({ code: "P1008" });
			expect(observed.observed).toEqual({ attempts: 3, callbacks: 1 });
			writer.exec("ROLLBACK");
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				0,
			);
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-B-pass" } })).toBe(
				1,
			);
		});
	}, 15_000);

	it("rechecks the service generation after admission contention instead of deleting stale selection", async () => {
		await withFixture(async ({ prisma, writer, assertProtected }) => {
			writer.exec("BEGIN IMMEDIATE");
			const observed = observeTransactions(prisma, {
				afterRefusal: () => {
					writer.exec("ROLLBACK");
					writer
						.prepare('UPDATE "ServiceInstance" SET "connectionGeneration"=3 WHERE id=?')
						.run("provider");
				},
			});
			const result = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF);
			expect(result.deletedRows).toBe(0);
			expect(observed.observed).toEqual({ attempts: 2, callbacks: 1 });
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				1,
			);
		});
	}, 15_000);

	it("cancels between settled attempts and retains the old cursor and rows", async () => {
		await withFixture(async ({ prisma, writer, assertProtected }) => {
			const cancellation = new AbortController();
			writer.exec("BEGIN IMMEDIATE");
			const observed = observeTransactions(prisma, {
				afterRefusal: () => {
					writer.exec("ROLLBACK");
					cancellation.abort();
				},
			});
			const result = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF, {
				signal: cancellation.signal,
			});
			expect(result).toMatchObject({ deletedRows: 0, nextCursor: null, hasMore: true });
			expect(observed.observed).toEqual({ attempts: 1, callbacks: 0 });
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				1,
			);
		});
	}, 15_000);

	it("does not replay a native-busy failure after the retention callback entered", async () => {
		await withFixture(async ({ prisma, assertProtected }) => {
			const observed = observeTransactions(prisma, { enteredError: nativeBusy() });
			const failure = await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF).catch(
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ code: "P1008" });
			expect(nativeInventoryRetentionDiagnosticsFrom(failure)).toMatchObject({
				retentionBoundary: {
					operation: "run-recheck",
					transactionEntered: true,
					nativeCode: "SQLITE_BUSY",
					retryObserved: false,
				},
			});
			expect(observed.observed).toEqual({ attempts: 1, callbacks: 1 });
			await assertProtected();
			expect(await prisma.providerNativeInventoryPass.count({ where: { id: "old-A-pass" } })).toBe(
				1,
			);
		});
	});

	it("does not add a retry when a short writer releases within the ordinary reservation", async () => {
		await withFixture(async ({ prisma, writer, assertProtected }) => {
			writer.exec("BEGIN IMMEDIATE");
			const released = delay(100).then(() => writer.exec("ROLLBACK"));
			try {
				const observed = observeTransactions(prisma);
				expect(
					(await pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF)).deletedRows,
				).toBe(2);
				expect(observed.observed).toEqual({ attempts: 1, callbacks: 1 });
				await assertProtected();
			} finally {
				await released;
			}
		});
	});

	it.each([
		"generic",
		"wrong-code",
		"locked",
		"inherited",
		"accessor",
		"code-accessor",
		"proxy",
	] as const)(
		"does not classify %s failure as retryable or inspect private getters",
		async (kind) => {
			await withFixture(async ({ prisma, assertProtected }) => {
				let privateReads = 0;
				const accessor = {
					get originalCode() {
						privateReads++;
						throw new Error("private accessor");
					},
				};
				const errors = {
					generic: { code: "P1008" },
					"wrong-code": { ...nativeBusy(), code: "P2028" },
					locked: {
						code: "P1008",
						meta: { driverAdapterError: { cause: { originalCode: "SQLITE_LOCKED" } } },
					},
					inherited: Object.create(nativeBusy()),
					accessor: { code: "P1008", meta: { driverAdapterError: { cause: accessor } } },
					"code-accessor": {
						get code() {
							privateReads++;
							throw new Error("private code accessor");
						},
					},
					proxy: new Proxy(
						{},
						{
							getOwnPropertyDescriptor() {
								throw new Error("descriptor unavailable");
							},
						},
					),
				};
				const error = errors[kind];
				const observed = observeTransactions(prisma, { injectedError: error });
				await expect(pruneNativeInventoryRetentionSlice(observed.prisma, CUTOFF)).rejects.toBe(
					error,
				);
				expect(observed.observed).toEqual({ attempts: 1, callbacks: 0 });
				expect(privateReads).toBe(0);
				await assertProtected();
			});
		},
	);
});
