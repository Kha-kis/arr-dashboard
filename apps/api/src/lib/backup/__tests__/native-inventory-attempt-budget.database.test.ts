import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { readProviderInventoryConnections } from "../../provider-observation/inventory-connection-repository.js";
import {
	beginNativeInventoryAttempt,
	publishNativeInventoriesInTransaction,
	readNativeInventoryDisplayPage,
	readNativeInventoryPage,
} from "../../provider-observation/native-inventory.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";
import { type RuntimeReadTiming, withRuntimeReadTiming } from "../restore-runtime-read-timing.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const OWNER = "synthetic-user";
const INSTANCE = "synthetic-jellyfin";
const log = pino({ level: "silent" });

afterEach(async () => {
	vi.restoreAllMocks();
	await closeScopedWriteFixtures();
});

async function seed(f: ScopedWriteFixture, instanceId = INSTANCE) {
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: instanceId } });
	const attempt = await beginNativeInventoryAttempt(f.plain, {
		userId: OWNER,
		instance,
		domains: ["library", "episode"],
		now: NOW,
	});
	if (attempt.status !== "acquired") throw new Error("Synthetic publication not acquired");
	const library = [
		{
			nativeId: "movie",
			mediaType: "movie" as const,
			libraryIds: ["movies"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic movie",
		},
		{
			nativeId: "series",
			mediaType: "series" as const,
			libraryIds: ["shows"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic series",
		},
	];
	const episode = [
		{
			nativeId: "episode",
			mediaType: "episode" as const,
			libraryIds: ["shows"],
			parentNativeId: "series",
			seasonNumber: 1,
			episodeNumber: 1,
			title: "Synthetic episode",
		},
	];
	await f.plain.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: OWNER,
			authority: attempt.authority,
			attempt: attempt.attempt,
			now: NOW,
			snapshots: [
				{ domain: "library", scopeKeys: ["movies", "shows"], rows: library },
				{ domain: "episode", scopeKeys: ["shows"], rows: episode },
			],
		}),
	);
	// Deterministic in-progress evidence belongs only to this disposable database.
	const run = await f.plain.providerNativeInventoryRun.create({
		data: {
			instanceId,
			workKey: "paired",
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "pending",
			createdAt: NOW,
		},
	});
	const pass = await f.plain.providerNativeInventoryPass.create({
		data: { runId: run.id, ordinal: 1 },
	});
	for (const [domain, rows] of [
		["library", library],
		["episode", episode],
	] as const) {
		await f.plain.providerNativeInventoryPageReceipt.create({
			data: {
				passId: pass.id,
				domain,
				scopeKey: "synthetic-scope",
				pageKey: "first",
				startIndex: 0,
				isLast: true,
				expectedRawCount: rows.length,
				rawCount: rows.length,
				rowCount: rows.length,
				contentHash: "a".repeat(64),
			},
		});
		await f.plain.providerNativeInventoryStageItem.createMany({
			data: rows.map((row) => ({
				...row,
				passId: pass.id,
				domain,
				libraryIds: JSON.stringify(row.libraryIds),
			})),
		});
	}
	return run.id;
}

function countProgressReads(f: ScopedWriteFixture) {
	let reads = 0;
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (
			this.name !== f.path ||
			this === f.writer ||
			!sql.includes("provider_native_inventory_page_receipts")
		)
			return statement;
		const all = statement.all;
		statement.all = function (this: typeof statement, ...args: unknown[]) {
			reads++;
			return Reflect.apply(all, this, args);
		} as typeof statement.all;
		return statement;
	});
	return () => reads;
}

describe("guarded native inventory progress work", { timeout: 20_000 }, () => {
	it.each(["library", "episode", "missing-tmdb"] as const)(
		"does not calculate discarded initial %s progress and still returns the latest attempt",
		async (view) => {
			const domain = view === "episode" ? "episode" : "library";
			const instanceId = view === "missing-tmdb" ? "synthetic-plex" : INSTANCE;
			const f = await createScopedWriteFixture();
			const runId = await seed(f, instanceId);
			const progressReads = countProgressReads(f);
			let changed = false;
			let stages!: RuntimeReadTiming;
			const result = await withRuntimeReadTiming(
				() =>
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
							readProviderInventoryConnections(
								client,
								{
									userId: OWNER,
									instanceId,
									domain,
									now: NOW,
									includeAttempt: true,
									...(view === "missing-tmdb" ? { metadataFilter: "missing-tmdb" as const } : {}),
								},
								log,
								(timing) => {
									if (timing.stage === "arr-catalog" && timing.outcome === "returned") {
										f.writer
											.prepare(
												'UPDATE "provider_native_inventory_runs" SET "state"=?, "failureCount"=?, "lastFailureCategory"=? WHERE "id"=?',
											)
											.run("incomplete", 2, "coverage-incomplete", runId);
										changed = true;
									}
								},
							),
						),
					),
				(value) => {
					stages = value;
				},
			);
			expect(changed).toBe(true);
			expect(result).toMatchObject({
				status: "available",
				freshness: "last-known",
				complete: false,
				attempt: {
					state: "incomplete",
					passOrdinal: 1,
					pagesCompleted: 1,
					itemsStaged: domain === "library" ? 2 : 1,
					failureCount: 2,
					reasonCode: "coverage-incomplete",
				},
			});
			if (result.status !== "available") throw new Error("Synthetic page unavailable");
			expect(result.rows.map((row) => row.nativeId)).toEqual(
				domain === "library" ? ["movie", "series"] : ["episode"],
			);
			if (domain === "episode") expect(result.rows[0]?.watch).toMatchObject({ state: "unknown" });
			if (view === "missing-tmdb") expect(result).toMatchObject({ filteredItemCount: 2 });
			expect(stages.guard.count).toBeGreaterThan(0);
			expect(stages.yield.count).toBeGreaterThan(0);
			expect(f.losses).toEqual([]);
			expect(progressReads()).toBe(1);
		},
	);

	it("retains the final generation fence and its progress when the publication changes during ARR reading", async () => {
		const f = await createScopedWriteFixture();
		await seed(f);
		const progressReads = countProgressReads(f);
		let changed = false;
		const result = await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
				readProviderInventoryConnections(
					client,
					{
						userId: OWNER,
						instanceId: INSTANCE,
						domain: "library",
						now: NOW,
						includeAttempt: true,
					},
					log,
					(timing) => {
						if (timing.stage === "arr-catalog" && timing.outcome === "returned") {
							f.writer
								.prepare(
									'UPDATE "provider_native_inventory_snapshots" SET "generationId"=? WHERE "instanceId"=? AND "domain"=?',
								)
								.run("changed-during-arr", INSTANCE, "library");
							changed = true;
						}
					},
				),
			),
		);
		expect(changed).toBe(true);
		expect(result).toMatchObject({
			status: "unavailable",
			reason: "snapshot-changed",
			attempt: { state: "pending", pagesCompleted: 1, itemsStaged: 2 },
		});
		expect(progressReads()).toBe(1);
		expect(f.losses).toEqual([]);
	});

	it("retains failed authoritative publication progress on a usable positive-only episode fallback", async () => {
		const f = await createScopedWriteFixture();
		const runId = await seed(f);
		const pass = await f.plain.providerNativeInventoryPass.findUniqueOrThrow({
			where: { runId_ordinal: { runId, ordinal: 1 } },
		});
		await f.plain.providerNativeInventorySnapshot.delete({
			where: { instanceId_domain: { instanceId: INSTANCE, domain: "episode" } },
		});
		await f.plain.providerNativeInventoryStageItem.deleteMany({
			where: { passId: pass.id, domain: "library" },
		});
		await f.plain.providerNativeInventoryPageReceipt.deleteMany({
			where: { passId: pass.id, domain: "library" },
		});
		await f.plain.providerNativeInventoryRun.update({
			where: { id: runId },
			data: { workKey: "episode" },
		});
		await f.plain.providerNativeInventoryPass.update({
			where: { id: pass.id },
			data: {
				state: "complete",
				completedAt: NOW,
				episodeItemCount: 1,
				scopeManifest: JSON.stringify([{ domain: "episode", scopeKeys: ["shows"] }]),
				scopeDigest: "a".repeat(64),
				comparisonDigest: "b".repeat(64),
			},
		});
		const progressReads = countProgressReads(f);
		const result = await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
				readNativeInventoryDisplayPage(client, {
					userId: OWNER,
					instanceId: INSTANCE,
					domain: "episode",
					now: NOW,
					includeAttempt: "unavailable",
				}),
			),
		);
		expect(result).toMatchObject({
			status: "available",
			evidence: "positive-only",
			freshness: "last-known",
			complete: false,
			rows: [{ nativeId: "episode" }],
			attempt: { state: "pending", pagesCompleted: 1, itemsStaged: 1 },
		});
		expect(progressReads()).toBe(1);
		expect(f.losses).toEqual([]);
	});

	it.each(["no-publication", "malformed-publication", "snapshot-changed"] as const)(
		"retains attempt progress on an initially %s page",
		async (reason) => {
			const f = await createScopedWriteFixture();
			await seed(f);
			if (reason === "no-publication")
				await f.plain.providerNativeInventorySnapshot.delete({
					where: { instanceId_domain: { instanceId: INSTANCE, domain: "library" } },
				});
			if (reason === "malformed-publication")
				await f.plain.providerNativeInventorySnapshot.update({
					where: { instanceId_domain: { instanceId: INSTANCE, domain: "library" } },
					data: { itemCount: 99 },
				});
			const progressReads = countProgressReads(f);
			const result = await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
					readNativeInventoryPage(client, {
						userId: OWNER,
						instanceId: INSTANCE,
						domain: "library",
						now: NOW,
						includeAttempt: "unavailable",
						...(reason === "snapshot-changed" ? { expectedGenerationId: "changed" } : {}),
					}),
				),
			);
			expect(result).toMatchObject({
				status: "unavailable",
				reason,
				attempt: { state: "pending", pagesCompleted: 1, itemsStaged: 2 },
			});
			expect(progressReads()).toBe(1);
			expect(f.losses).toEqual([]);
		},
	);

	it.each(["foreign", "disabled", "identity"] as const)(
		"does not disclose progress for %s authority",
		async (kind) => {
			const f = await createScopedWriteFixture();
			await seed(f);
			if (kind === "disabled")
				await f.plain.serviceInstance.update({ where: { id: INSTANCE }, data: { enabled: false } });
			if (kind === "identity")
				await f.plain.serviceInstance.update({
					where: { id: INSTANCE },
					data: { identityStatus: "UNVERIFIED" },
				});
			const progressReads = countProgressReads(f);
			const result = await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
					readNativeInventoryPage(client, {
						userId: kind === "foreign" ? "other-owner" : OWNER,
						instanceId: INSTANCE,
						domain: "library",
						now: NOW,
						includeAttempt: "unavailable",
					}),
				),
			);
			expect(result).toEqual({
				status: "unavailable",
				reason:
					kind === "foreign"
						? "not-owned"
						: kind === "disabled"
							? "provider-unavailable"
							: "identity-changed",
			});
			expect(progressReads()).toBe(0);
			expect(f.losses).toEqual([]);
		},
	);
});
