import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { readNativeInventoryPage } from "../native-inventory.js";
import {
	admitNativeInventoryRun,
	claimDueNativeInventoryRun,
	commitNativeInventoryPage,
	yieldNativeInventoryRun,
} from "../native-inventory-job-repository.js";
import {
	type NativeInventoryJobAdapter,
	type NativeInventorySlicePhase,
	runNativeInventoryJobSlice,
} from "../native-inventory-job-runner.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function row(offset: number) {
	return {
		nativeId: `movie-${offset}`,
		mediaType: "movie" as const,
		libraryIds: ["scope-a"],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Synthetic",
	};
}

async function fixture(guarded = false) {
	const directory = mkdtempSync(join(tmpdir(), "native-inventory-contention-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	let prisma = createTestPrismaClient(dbPath);
	const lock = new Database(dbPath, { timeout: 0 });
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>> | undefined;
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	cleanups.push(async () => {
		if (lock.inTransaction) lock.exec("ROLLBACK");
		lock.close();
		if (native) await native.close();
		else await prisma.$disconnect();
		await runtime?.close();
		rmSync(directory, { recursive: true, force: true });
	});
	if (guarded) {
		await prisma.$disconnect();
		lock.pragma("journal_mode=WAL");
		runtime = await openRestoreRuntime({ databaseUrl: `file:${dbPath}`, onUnavailable() {} });
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		prisma = native.prisma;
	}
	const operation = <T>(work: () => Promise<T>) => (runtime ? runtime.runOperation(work) : work());
	return operation(async () => {
		await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
		const instance = await prisma.serviceInstance.create({
			data: {
				id: "jellyfin-1",
				userId: "owner",
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "http://jellyfin.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
				connectionGeneration: 2,
				expectedIdentity: "synthetic-provider",
				identityStatus: "VERIFIED",
				identityGeneration: 3,
				identityKind: "JELLYFIN_SERVER_ID",
				identityVerifiedAt: new Date(),
			},
		});
		const authority = createProviderPublicationAuthority(instance);
		expect(await admitNativeInventoryRun(prisma, authority, "library", new Date())).toEqual({
			status: "acquired",
		});
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const control = {
			lockAt: null as NativeInventorySlicePhase | null,
			armed: false,
			holdRelease: false,
			invalidCoverage: false,
		};
		const offsets: number[] = [];
		const phases: NativeInventorySlicePhase[] = [];
		const adapter: NativeInventoryJobAdapter<{ scopeKey: string }> = {
			domain: "library",
			async discoverScopes() {
				return {
					status: "ready",
					catalogIdentity: "stable-catalog",
					scopes: [{ scopeKey: "library:scope-a" }],
				};
			},
			async readPage(_scope, startIndex) {
				offsets.push(startIndex);
				return {
					status: "page",
					domain: "library",
					scopeKey: control.invalidCoverage ? "wrong-scope" : "library:scope-a",
					startIndex,
					totalRecordCount: 2,
					rawNativeIds: [`movie-${startIndex}`],
					comparisonKeys: [`comparison-${startIndex}`],
					rows: [row(startIndex)],
				};
			},
		};
		const slice = (maxPages = 1) =>
			operation(() =>
				runNativeInventoryJobSlice(prisma, run.id, adapter, {
					deadlineAt: Date.now() + 60_000,
					maxPages,
					pageSize: 1,
					retryDelayMs: 0,
					verifyIdentity: async () => "verified",
					reportPhase(phase) {
						phases.push(phase);
						if (control.armed && phase === control.lockAt) {
							lock.exec(phase === "identity" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
							control.armed = false;
						}
						if (
							(phase === "yield" || phase === "failure-settlement") &&
							!control.holdRelease &&
							lock.inTransaction
						)
							lock.exec("ROLLBACK");
					},
				}),
			);
		return {
			prisma,
			lock,
			operation,
			authority,
			instance,
			run,
			control,
			slice,
			offsets,
			phases,
			adapter,
		};
	});
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function partial(f: Fixture) {
	expect(await f.slice(2)).toEqual({ status: "pass-complete", pagesCommitted: 2 });
	expect(await f.slice()).toEqual({ status: "yielded", pagesCommitted: 1 });
	return f.operation(async () => {
		const pass = await f.prisma.providerNativeInventoryPass.findUniqueOrThrow({
			where: { runId_ordinal: { runId: f.run.id, ordinal: 2 } },
		});
		const receipts = await f.prisma.providerNativeInventoryPageReceipt.findMany({
			where: { passId: pass.id },
		});
		const staged = await f.prisma.providerNativeInventoryStageItem.findMany({
			where: { passId: pass.id },
		});
		expect(receipts).toHaveLength(1);
		expect(staged).toHaveLength(1);
		return {
			pass,
			receipts,
			staged,
			snapshots: await f.prisma.providerNativeInventorySnapshot.findMany(),
		};
	});
}
async function published(f: Fixture) {
	await f.operation(async () => {
		const result = await readNativeInventoryPage(f.prisma, {
			userId: "owner",
			instanceId: f.instance.id,
			domain: "library",
			expectedAuthority: f.authority,
		});
		expect(result.status).toBe("available");
		if (result.status !== "available") throw new Error("Synthetic publication unavailable");
		expect(result.rows.map((item) => item.nativeId)).toEqual(["movie-0", "movie-1"]);
		const snapshots = await f.prisma.providerNativeInventorySnapshot.findMany();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.itemCount).toBe(2);
	});
}

describe("native inventory contention progress", { timeout: 120_000 }, () => {
	it.each([false, true])(
		"preserves the same partial pass through three contended commits (guarded=%s)",
		async (guarded) => {
			const f = await fixture(guarded),
				before = await partial(f);
			f.control.lockAt = "page-commit";
			for (let attempt = 0; attempt < 3; attempt++) {
				f.control.armed = true;
				expect.soft(await f.slice()).toEqual({ status: "yielded", pagesCommitted: 0 });
				await f.operation(async () => {
					expect
						.soft(
							await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({
								where: { id: f.run.id },
							}),
						)
						.toMatchObject({
							state: "pending",
							passOrdinal: 2,
							failureCount: 0,
							lastFailureCategory: null,
							claimToken: null,
							leaseUntil: null,
							activeSlotKey: f.run.activeSlotKey,
						});
					expect(
						await f.prisma.providerNativeInventoryPageReceipt.findMany({
							where: { passId: before.pass.id },
						}),
					).toEqual(before.receipts);
					expect(
						await f.prisma.providerNativeInventoryStageItem.findMany({
							where: { passId: before.pass.id },
						}),
					).toEqual(before.staged);
					expect(await f.prisma.providerNativeInventorySnapshot.findMany()).toEqual(
						before.snapshots,
					);
					expect(
						await f.prisma.serviceInstance.findUniqueOrThrow({ where: { id: f.instance.id } }),
					).toEqual(f.instance);
				});
			}
			expect(await f.slice(2)).toEqual({ status: "published", pagesCommitted: 1 });
			expect(f.offsets).toEqual([0, 1, 0, 1, 1, 1, 1]);
			await published(f);
		},
	);
	it.each(["pass-begin", "pass-complete"] as const)(
		"yields a contended %s without a coverage failure",
		async (boundary) => {
			const f = await fixture();
			if (boundary === "pass-begin") {
				expect(await f.slice(2)).toEqual({ status: "pass-complete", pagesCommitted: 2 });
			} else await partial(f);
			f.control.lockAt = boundary;
			f.control.armed = true;
			expect(await f.slice(2)).toEqual({
				status: "yielded",
				pagesCommitted: boundary === "pass-complete" ? 1 : 0,
			});
			expect(
				await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: f.run.id } }),
			).toMatchObject({
				state: "pending",
				passOrdinal: 2,
				failureCount: 0,
				lastFailureCategory: null,
			});
			expect(await f.slice(2)).toEqual({
				status: "published",
				pagesCommitted: boundary === "pass-complete" ? 0 : 2,
			});
			await published(f);
		},
	);
	it.each([
		["P1008", undefined],
		["P2002", undefined],
		["P2028", undefined],
		["P2034", undefined],
		["P1008", "SQLITE_BUSY_SNAPSHOT"],
		["generic", undefined],
	] as const)(
		"ambiguous %s query errors with %s provenance still exhaust three failures",
		async (code, originalCode) => {
			const f = await fixture();
			await partial(f);
			const error = Object.assign(new Error("Synthetic database denial"), {
				...(code === "generic" ? {} : { code }),
				...(originalCode ? { meta: { driverAdapterError: { cause: { originalCode } } } } : {}),
			});
			const observed = f.prisma.$extends({
				query: {
					providerNativeInventoryPass: {
						findUnique: async () => {
							throw error;
						},
					},
				},
			});
			for (let failureCount = 1; failureCount <= 3; failureCount++) {
				expect(
					await runNativeInventoryJobSlice(
						observed as unknown as typeof f.prisma,
						f.run.id,
						f.adapter,
						{
							deadlineAt: Date.now() + 60_000,
							maxPages: 1,
							pageSize: 1,
							retryDelayMs: 0,
							verifyIdentity: async () => "verified",
						},
					),
				).toEqual({ status: failureCount < 3 ? "retryable" : "incomplete", pagesCommitted: 0 });
				expect(
					await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: f.run.id } }),
				).toMatchObject({
					failureCount,
					lastFailureCategory: "database-retryable",
					state: failureCount < 3 ? "pending" : "incomplete",
				});
			}
		},
	);
	it.each([
		["SQLITE_BUSY", undefined],
		["SQLITE_LOCKED", undefined],
		["P1008", "SQLITE_BUSY"],
		["P1008", "SQLITE_LOCKED"],
	] as const)(
		"yields only proven native or wrapped %s lock errors with %s provenance",
		async (code, originalCode) => {
			const f = await fixture();
			await partial(f);
			const error = Object.assign(new Error("Synthetic proven lock wrapper"), {
				code,
				...(originalCode ? { meta: { driverAdapterError: { cause: { originalCode } } } } : {}),
			});
			const observed = f.prisma.$extends({
				query: {
					providerNativeInventoryPass: {
						findUnique: async () => {
							throw error;
						},
					},
				},
			});
			expect(
				await runNativeInventoryJobSlice(
					observed as unknown as typeof f.prisma,
					f.run.id,
					f.adapter,
					{
						deadlineAt: Date.now() + 60_000,
						maxPages: 1,
						pageSize: 1,
						retryDelayMs: 0,
						verifyIdentity: async () => "verified",
					},
				),
			).toEqual({ status: "yielded", pagesCommitted: 0 });
			expect(
				await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: f.run.id } }),
			).toMatchObject({ state: "pending", failureCount: 0, lastFailureCategory: null });
		},
	);
	it("returns contended for known repository exhaustion and retryable for invalid coverage", async () => {
		const f = await fixture();
		await partial(f);
		const claim = await claimDueNativeInventoryRun(f.prisma, f.run.id, new Date());
		expect(claim.status).toBe("acquired");
		if (claim.status !== "acquired") throw new Error("Synthetic claim unavailable");
		const receipt = {
			domain: "library" as const,
			scopeKey: "library:scope-a",
			pageKey: "1",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 2,
			rawNativeIds: ["movie-1"],
			comparisonKeys: ["comparison-1"],
		};
		f.lock.exec("BEGIN IMMEDIATE");
		try {
			expect(
				await commitNativeInventoryPage(f.prisma, claim.claim, receipt, [row(1)], new Date()),
			).toEqual({ status: "contended" });
		} finally {
			f.lock.exec("ROLLBACK");
		}
		expect(
			await commitNativeInventoryPage(
				f.prisma,
				claim.claim,
				{ ...receipt, comparisonKeys: [] },
				[row(1)],
				new Date(),
			),
		).toEqual({ status: "retryable" });
		expect(await yieldNativeInventoryRun(f.prisma, claim.claim, new Date())).toEqual({
			status: "yielded",
		});
	});
	it("yields a raw known database read conflict without spending failures", async () => {
		const f = await fixture();
		await partial(f);
		f.control.lockAt = "identity";
		f.control.armed = true;
		expect(await f.slice()).toEqual({ status: "yielded", pagesCommitted: 0 });
		expect(
			await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: f.run.id } }),
		).toMatchObject({ state: "pending", failureCount: 0, claimToken: null });
		expect(await f.slice(2)).toEqual({ status: "published", pagesCommitted: 1 });
		await published(f);
	});
	it("genuine coverage contradictions still exhaust three failures", async () => {
		const f = await fixture();
		await partial(f);
		f.control.invalidCoverage = true;
		for (let attempt = 1; attempt <= 3; attempt++) {
			expect(await f.slice()).toEqual({
				status: attempt < 3 ? "retryable" : "incomplete",
				pagesCommitted: 0,
			});
			expect(
				await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: f.run.id } }),
			).toMatchObject({
				failureCount: attempt,
				lastFailureCategory: "coverage-incomplete",
				state: attempt < 3 ? "pending" : "incomplete",
			});
		}
	});
	it("retains the bounded claim when release is still locked then reclaims after expiry", async () => {
		const f = await fixture();
		const before = await partial(f);
		f.control.lockAt = "page-commit";
		f.control.armed = true;
		f.control.holdRelease = true;
		expect(await f.slice()).toEqual({ status: "retryable", pagesCommitted: 0 });
		f.lock.exec("ROLLBACK");
		const held = await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: f.run.id },
		});
		expect(held).toMatchObject({
			state: "running",
			failureCount: 0,
			lastFailureCategory: null,
			activeSlotKey: f.run.activeSlotKey,
		});
		expect(held.claimToken).not.toBeNull();
		expect(held.leaseUntil).not.toBeNull();
		expect(f.phases.at(-1)).toBe("yield");
		expect(await f.slice()).toEqual({ status: "coalesced", pagesCommitted: 0 });
		expect(
			await f.prisma.providerNativeInventoryPageReceipt.findMany({
				where: { passId: before.pass.id },
			}),
		).toEqual(before.receipts);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(held.leaseUntil!.getTime() + 1);
		f.control.holdRelease = false;
		expect(await f.slice(2)).toEqual({ status: "published", pagesCommitted: 1 });
		await published(f);
	});
});
