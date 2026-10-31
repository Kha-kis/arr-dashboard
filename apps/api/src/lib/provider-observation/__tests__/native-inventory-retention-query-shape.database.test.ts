import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "../../prisma.js";
import { pruneNativeInventoryRetentionSlice } from "../native-inventory-retention.js";

const OLD = new Date("2026-10-10T06:00:00Z");
const NEWER = new Date("2026-10-11T06:00:00Z");
const CUTOFF = new Date("2026-10-20T06:00:00Z");
const cleanup: Array<() => Promise<void>> = [];
let templateDirectory: string;
let template: string;

beforeAll(() => {
	templateDirectory = mkdtempSync(join(tmpdir(), "native-query-template-"));
	template = join(templateDirectory, "template.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${template}` },
		stdio: "ignore",
	});
});
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
afterAll(() => rmSync(templateDirectory, { recursive: true, force: true }));

async function fixture(mode: "DELETE" | "WAL", children = 601) {
	const directory = mkdtempSync(join(tmpdir(), "native-query-shape-"));
	const dbPath = join(directory, "fixture.db");
	copyFileSync(template, dbPath);
	const native = new Database(dbPath);
	native.pragma(`journal_mode=${mode}`);
	native.close();
	const prisma = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: dbPath }),
		log: [{ level: "query", emit: "event" }],
	});
	const queries: Prisma.QueryEvent[] = [];
	let capture = false;
	prisma.$on("query", (query) => {
		if (capture) queries.push(query);
	});
	cleanup.push(async () => {
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	});
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other-owner", username: "synthetic-other" },
		],
	});
	for (const id of ["drain", "published", "active", "latest", "positive", "metadata"]) {
		await prisma.serviceInstance.create({
			data: {
				id,
				userId: "owner",
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "http://fixture.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		});
	}
	for (const [id, instanceId, workKey, state, newer] of [
		["obsolete", "drain", "library", "incomplete", false],
		["drain-latest", "drain", "library", "pending", true],
		["published", "published", "paired", "published", false],
		["active", "active", "library", "running", false],
		["latest", "latest", "library", "incomplete", false],
		["positive", "positive", "episode", "incomplete", false],
		["positive-latest", "positive", "episode", "pending", true],
		["metadata", "metadata", "library", "incomplete", false],
		["metadata-latest", "metadata", "library", "pending", true],
	] as const) {
		await prisma.providerNativeInventoryRun.create({
			data: {
				id,
				instanceId,
				workKey,
				state,
				createdAt: newer ? NEWER : OLD,
				updatedAt: OLD,
				connectionGeneration: 2,
				identityGeneration: 3,
				...(id === "active"
					? { activeSlotKey: "slot", claimToken: "claim", leaseUntil: NEWER }
					: {}),
			},
		});
	}
	for (const [id, runId, ordinal] of [
		["obsolete-pass", "obsolete", 1],
		["drain-latest-pass", "drain-latest", 1],
		["published-prior", "published", 1],
		["published-final", "published", 2],
		["active-pass", "active", 1],
		["latest-pass", "latest", 1],
		["positive-pass", "positive", 1],
	] as const) {
		const positive = runId === "positive";
		await prisma.providerNativeInventoryPass.create({
			data: {
				id,
				runId,
				ordinal,
				...(positive
					? {
							state: "complete",
							completedAt: OLD,
							episodeItemCount: 1,
							scopeManifest: '[{"domain":"episode","scopeKeys":["scope"]}]',
							scopeDigest: "a".repeat(64),
							comparisonDigest: "b".repeat(64),
						}
					: {}),
			},
		});
		if (runId !== "obsolete") {
			await prisma.providerNativeInventoryStageItem.create({
				data: {
					id: `${id}-stage`,
					passId: id,
					domain: positive ? "episode" : "library",
					nativeId: "same-000000",
					mediaType: positive ? "episode" : "movie",
					libraryIds: '["scope"]',
					...(positive ? { parentNativeId: "show", seasonNumber: 1, episodeNumber: 1 } : {}),
				},
			});
			await prisma.providerNativeInventorySeenItem.create({
				data: {
					id: `${id}-seen`,
					passId: id,
					domain: positive ? "episode" : "library",
					scopeKey: "scope",
					nativeId: "same-000000",
				},
			});
		}
	}
	await prisma.providerNativeInventoryPageReceipt.create({
		data: {
			id: "receipt",
			passId: "obsolete-pass",
			domain: "library",
			scopeKey: "scope",
			pageKey: "0",
			startIndex: 0,
			isLast: true,
			expectedRawCount: children,
			rawCount: children,
			rowCount: children,
			contentHash: "b".repeat(64),
		},
	});
	await prisma.providerNativeInventorySnapshot.createMany({
		data: [
			{
				id: "head",
				instanceId: "published",
				domain: "library",
				publishedPassId: "published-final",
				connectionGeneration: 2,
				identityGeneration: 3,
				observedAt: OLD,
			},
			{
				id: "older-head",
				instanceId: "metadata",
				domain: "library",
				connectionGeneration: 2,
				identityGeneration: 3,
				observedAt: new Date("2026-10-09T06:00:00Z"),
			},
		],
	});
	await prisma.providerNativeInventoryItem.create({
		data: {
			id: "current",
			snapshotId: "head",
			nativeId: "same-000000",
			mediaType: "movie",
			libraryIds: '["scope"]',
		},
	});
	for (let start = 0; start < children; start += 200) {
		const indexes = Array.from({ length: Math.min(200, children - start) }, (_, i) => start + i);
		await prisma.providerNativeInventoryStageItem.createMany({
			data: indexes.map((i) => ({
				id: `stage-${String(i).padStart(6, "0")}`,
				passId: "obsolete-pass",
				domain: "library",
				nativeId: `same-${String(children - i - 1).padStart(6, "0")}`,
				mediaType: "movie",
				libraryIds: '["scope"]',
			})),
		});
		await prisma.providerNativeInventorySeenItem.createMany({
			data: indexes.map((i) => ({
				id: `seen-${String(i).padStart(6, "0")}`,
				passId: "obsolete-pass",
				domain: "library",
				scopeKey: "scope",
				nativeId: `same-${String(children - i - 1).padStart(6, "0")}`,
			})),
		});
	}
	return {
		prisma,
		dbPath,
		queries,
		capture: () => {
			capture = true;
		},
	};
}

async function physical(prisma: PrismaClient) {
	return (
		await Promise.all([
			prisma.providerNativeInventoryStageItem.count(),
			prisma.providerNativeInventorySeenItem.count(),
			prisma.providerNativeInventoryPageReceipt.count(),
			prisma.providerNativeInventoryPass.count(),
			prisma.providerNativeInventoryRun.count(),
		])
	).reduce((sum, count) => sum + count, 0);
}
async function protectedRows(prisma: PrismaClient) {
	return Promise.all([
		prisma.user.findMany({ orderBy: { id: "asc" } }),
		prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }),
		prisma.providerNativeInventoryRun.findMany({
			where: { id: { not: "obsolete" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventoryPass.findMany({
			where: { runId: { not: "obsolete" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventoryStageItem.findMany({
			where: { passId: { not: "obsolete-pass" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventorySeenItem.findMany({
			where: { passId: { not: "obsolete-pass" } },
			orderBy: { id: "asc" },
		}),
		prisma.providerNativeInventorySnapshot.findMany({ orderBy: { id: "asc" } }),
		prisma.providerNativeInventoryItem.findMany({ orderBy: { id: "asc" } }),
	]);
}

// Interleave a real transaction-local binding update after actual child selection.
// The real DELETE must refuse it; throwing afterward also verifies rollback of
// any earlier deletions in that slice. No counts or selected rows are invented.
function invalidate(prisma: PrismaClient, model: string, field: "userId" | "identityGeneration") {
	return new Proxy(prisma, {
		get(target, property) {
			if (property !== "$transaction") return Reflect.get(target, property, target);
			return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
				Reflect.apply(target.$transaction, target, [
					(tx: Prisma.TransactionClient) =>
						operation(
							new Proxy(tx, {
								get(transaction, name) {
									const delegate = Reflect.get(transaction, name, transaction);
									if (name !== model) return delegate;
									return new Proxy(delegate, {
										get(real, method) {
											const fn = Reflect.get(real, method, real);
											if (method !== "findMany" && method !== "deleteMany") return fn;
											return async (...args: unknown[]) => {
												const result = await Reflect.apply(fn, real, args);
												if (method === "findMany") {
													await tx.serviceInstance.update({
														where: { id: "drain" },
														data:
															field === "userId"
																? { userId: "other-owner" }
																: { identityGeneration: 9 },
													});
												} else {
													expect((result as { count: number }).count).toBe(0);
													throw new Error("synthetic rollback after guarded refusal");
												}
												return result;
											};
										},
									});
								},
							}),
						),
					options,
				]);
		},
	});
}

describe("guarded retention query access paths", { timeout: 30_000 }, () => {
	it.each(["DELETE", "WAL"] as const)(
		"avoids pass-wide sort and DELETE scans while draining both child tables in %s",
		async (mode) => {
			const { prisma, dbPath, queries, capture } = await fixture(mode);
			const controls = await protectedRows(prisma);
			const slices = [];
			capture();
			for (let i = 0; i < 8; i++) {
				const before = await physical(prisma);
				const result = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF);
				expect(before - (await physical(prisma))).toBe(result.deletedRows);
				expect(result.deletedRows).toBeLessThanOrEqual(500);
				slices.push(result);
				if (!result.hasMore) break;
			}
			expect(slices.reduce((sum, result) => sum + result.deletedRows, 0)).toBe(1205);
			expect(slices.reduce((sum, result) => sum + result.deletedRuns, 0)).toBe(1);
			expect(
				await prisma.providerNativeInventoryRun.findUnique({ where: { id: "obsolete" } }),
			).toBeNull();
			expect((await pruneNativeInventoryRetentionSlice(prisma, CUTOFF)).deletedRows).toBe(0);
			expect(await protectedRows(prisma)).toEqual(controls);
			const db = new Database(dbPath, { readonly: true });
			try {
				expect(db.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
				expect(db.pragma("foreign_key_check")).toEqual([]);
				expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
				const evidence = [];
				const temporarySorts = [],
					nonPointDeletes = [];
				for (const table of [
					"provider_native_inventory_stage_items",
					"provider_native_inventory_seen_items",
				]) {
					const selects = queries.filter((q) =>
						q.query.startsWith(`SELECT \`main\`.\`${table}\`.\`id\` FROM`),
					);
					const deletes = queries.filter((q) =>
						q.query.startsWith(`DELETE FROM \`main\`.\`${table}\``),
					);
					expect(selects.length).toBeGreaterThan(0);
					expect(deletes.length).toBeGreaterThan(0);
					for (const query of [...selects, ...deletes]) {
						const plan = db
							.prepare(`EXPLAIN QUERY PLAN ${query.query}`)
							.all(...JSON.parse(query.params)) as Array<{ detail: string }>;
						evidence.push({ table, ...query, plan });
						if (
							selects.includes(query) &&
							plan.some((row) => /TEMP B-TREE FOR ORDER BY/.test(row.detail))
						)
							temporarySorts.push({ table, plan });
						if (
							deletes.includes(query) &&
							!plan.some(
								(row) =>
									row.detail.startsWith(`SEARCH main.${table} `) && /\(id=\?\)/.test(row.detail),
							)
						)
							nonPointDeletes.push({ table, plan });
					}
				}
				if (process.env.NATIVE_RETENTION_QUERY_EVIDENCE_DIR)
					writeFileSync(
						join(process.env.NATIVE_RETENTION_QUERY_EVIDENCE_DIR, `query-shape-${mode}.json`),
						JSON.stringify({ mode, slices, evidence }, null, 2),
						{ mode: 0o600 },
					);
				expect({ temporarySorts, nonPointDeletes }).toEqual({
					temporarySorts: [],
					nonPointDeletes: [],
				});
			} finally {
				db.close();
			}
		},
	);

	for (const model of ["providerNativeInventoryStageItem", "providerNativeInventorySeenItem"]) {
		it.each(["userId", "identityGeneration"] as const)(
			`refuses ${model} deletion after execution-time %s invalidation and rolls back`,
			async (field) => {
				const { prisma } = await fixture("WAL", 3);
				const before = await physical(prisma),
					controls = await protectedRows(prisma);
				await expect(
					pruneNativeInventoryRetentionSlice(invalidate(prisma, model, field), CUTOFF),
				).rejects.toThrow("synthetic rollback after guarded refusal");
				expect(await physical(prisma)).toBe(before);
				expect(await protectedRows(prisma)).toEqual(controls);
				expect(
					await prisma.providerNativeInventoryStageItem.count({
						where: { passId: "obsolete-pass" },
					}),
				).toBe(3);
				expect(
					await prisma.providerNativeInventorySeenItem.count({
						where: { passId: "obsolete-pass" },
					}),
				).toBe(3);
			},
		);
	}
});
