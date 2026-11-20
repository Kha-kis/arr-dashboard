import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { readNativeInventoryPage } from "../native-inventory.js";
import { schedulePeriodicNativeInventoryWork } from "../native-inventory-job-orchestration.js";
import { admitNativeInventoryRun } from "../native-inventory-job-repository.js";
import {
	type NativeInventoryJobAdapter,
	runNativeInventoryJobSlice,
} from "../native-inventory-job-runner.js";

const fixtures: Array<{ directory: string; prisma: PrismaClient }> = [];
let schemaDirectory: string;
let template: string;

beforeAll(() => {
	schemaDirectory = mkdtempSync(join(tmpdir(), "native-drift-schema-"));
	template = join(schemaDirectory, "template.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${template}` },
		stdio: "ignore",
	});
}, 30_000);

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.prisma.$disconnect();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});
afterAll(() => rmSync(schemaDirectory, { recursive: true, force: true }));

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "native-drift-recovery-"));
	const dbPath = join(directory, "test.db");
	copyFileSync(template, dbPath);
	const prisma = createTestPrismaClient(dbPath);
	fixtures.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	const instance = await prisma.serviceInstance.create({
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
			expectedIdentity: "synthetic-provider",
			identityStatus: "VERIFIED",
			identityKind: "JELLYFIN_SERVER_ID",
			identityVerifiedAt: new Date(),
		},
	});
	const authority = createProviderPublicationAuthority(instance);
	let total = 3;
	let unavailable = false;
	let beforeReturn: (() => Promise<void>) | undefined;
	const offsets: number[] = [];
	const adapter: NativeInventoryJobAdapter<{ scopeKey: string }> = {
		domain: "episode",
		async discoverScopes() {
			return {
				status: "ready",
				catalogIdentity: "stable",
				scopes: [{ scopeKey: "library:scope" }],
			};
		},
		async readPage(_scope, startIndex, limit) {
			offsets.push(startIndex);
			if (unavailable) return { status: "unavailable", reason: "provider-unavailable" };
			if (beforeReturn) {
				const callback = beforeReturn;
				beforeReturn = undefined;
				await callback();
			}
			const ids = Array.from(
				{ length: Math.max(0, Math.min(limit, total - startIndex)) },
				(_, index) => `episode-${startIndex + index}`,
			);
			return {
				status: "page",
				domain: "episode",
				scopeKey: "library:scope",
				startIndex,
				totalRecordCount: total,
				rawNativeIds: ids,
				comparisonKeys: ids.map((id) => `Episode:${id}`),
				rows: ids.map((nativeId, index) => ({
					nativeId,
					mediaType: "episode",
					libraryIds: ["scope"],
					parentNativeId: "series",
					seasonNumber: 1,
					episodeNumber: startIndex + index + 1,
					title: "Synthetic",
				})),
			};
		},
	};
	async function admit() {
		expect((await admitNativeInventoryRun(prisma, authority, "episode", new Date())).status).toBe(
			"acquired",
		);
		return prisma.providerNativeInventoryRun.findFirstOrThrow({
			where: { instanceId: authority.id, workKey: "episode", activeSlotKey: { not: null } },
		});
	}
	async function slice(runId: string, maxPages = 20) {
		return runNativeInventoryJobSlice(prisma, runId, adapter, {
			deadlineAt: Date.now() + 10_000,
			maxPages,
			pageSize: 1,
			retryDelayMs: 0,
			verifyIdentity: async () => "verified",
		});
	}
	const seed = await admit();
	expect((await slice(seed.id)).status).toBe("pass-complete");
	expect((await slice(seed.id)).status).toBe("published");
	await prisma.providerNativeInventoryRun.update({
		where: { id: seed.id },
		data: { createdAt: new Date(Date.now() - 60_000) },
	});
	await prisma.providerNativeInventorySnapshot.updateMany({
		data: { observedAt: new Date(Date.now() - 60 * 60_000) },
	});
	const prior = await prisma.providerNativeInventorySnapshot.findFirstOrThrow();
	return {
		prisma,
		instance,
		dbPath,
		authority,
		adapter,
		offsets,
		prior,
		admit,
		slice,
		setTotal: (value: number) => {
			total = value;
		},
		setUnavailable: (value: boolean) => {
			unavailable = value;
		},
		beforeReturn: (value: () => Promise<void>) => {
			beforeReturn = value;
		},
	};
}

describe("native inventory incompatible-total recovery", { timeout: 30_000 }, () => {
	// Break caught: reusing an incompatible pass cursor for two more provider reads,
	// or accepting the changed total and publishing mixed old/new inventory pages.
	it.each(
		[1, 2].flatMap((passOrdinal) => [2, 4].map((changedTotal) => ({ passOrdinal, changedTotal }))),
	)(
		"releases pass $passOrdinal after total changes 3->$changedTotal, then recovers through fresh verified passes",
		async ({ passOrdinal, changedTotal }) => {
			const f = await fixture();
			const run = await f.admit();
			if (passOrdinal === 2) expect((await f.slice(run.id)).status).toBe("pass-complete");
			expect((await f.slice(run.id, 1)).status).toBe("yielded");
			const pass = await f.prisma.providerNativeInventoryPass.findUniqueOrThrow({
				where: { runId_ordinal: { runId: run.id, ordinal: passOrdinal } },
			});
			const receipts = await f.prisma.providerNativeInventoryPageReceipt.findMany({
				where: { passId: pass.id },
			});
			const stage = await f.prisma.providerNativeInventoryStageItem.findMany({
				where: { passId: pass.id },
			});
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({ startIndex: 0, expectedRawCount: 3, rawCount: 1 });
			f.setTotal(changedTotal);
			expect(await f.slice(run.id)).toEqual({ status: "incomplete", pagesCommitted: 0 });
			const terminal = await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({
				where: { id: run.id },
			});
			expect(terminal).toMatchObject({
				state: "incomplete",
				activeSlotKey: null,
				claimToken: null,
				leaseUntil: null,
				nextAttemptAt: null,
				failureCount: 1,
				lastFailureCategory: "coverage-incomplete",
			});
			expect(
				await f.prisma.providerNativeInventoryPageReceipt.findMany({ where: { passId: pass.id } }),
			).toEqual(receipts);
			expect(
				await f.prisma.providerNativeInventoryStageItem.findMany({ where: { passId: pass.id } }),
			).toEqual(stage);
			expect(await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(f.prior);
			const readsAtTerminal = f.offsets.length;
			expect((await f.slice(run.id)).status).toBe("superseded");
			expect(f.offsets).toHaveLength(readsAtTerminal);

			const cadence = {
				maxInstances: 1,
				refreshIntervalMs: 30 * 60_000,
				retryCooldownMs: 5 * 60_000,
			};
			await schedulePeriodicNativeInventoryWork(
				f.prisma,
				new Date(terminal.updatedAt.getTime() + cadence.retryCooldownMs - 1),
				cadence,
			);
			expect(
				await f.prisma.providerNativeInventoryRun.count({
					where: { workKey: "episode", activeSlotKey: { not: null } },
				}),
			).toBe(0);
			await schedulePeriodicNativeInventoryWork(
				f.prisma,
				new Date(terminal.updatedAt.getTime() + cadence.retryCooldownMs + 1),
				cadence,
			);
			const fresh = await f.prisma.providerNativeInventoryRun.findFirstOrThrow({
				where: { workKey: "episode", activeSlotKey: { not: null } },
			});
			expect(fresh.id).not.toBe(run.id);
			expect(fresh.passOrdinal).toBe(1);
			expect((await f.slice(fresh.id)).status).toBe("pass-complete");
			expect(await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(f.prior);
			expect((await f.slice(fresh.id)).status).toBe("published");
			const head = await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow({
				include: { publishedPass: { include: { run: true, receipts: true, items: true } } },
			});
			expect(head.itemCount).toBe(changedTotal);
			expect(head.generationId).not.toBe(f.prior.generationId);
			expect(head.publishedPass?.run.id).toBe(fresh.id);
			expect(head.publishedPass?.state).toBe("complete");
			expect(head.publishedPass?.receipts).toHaveLength(changedTotal);
			expect(head.publishedPass?.items).toHaveLength(changedTotal);
			expect(
				await readNativeInventoryPage(f.prisma, {
					userId: "owner",
					instanceId: f.authority.id,
					domain: "episode",
				}),
			).toMatchObject({ status: "available", complete: true, itemCount: changedTotal });
		},
	);

	it("preserves the same cursor for a transient provider outage", async () => {
		const f = await fixture();
		const run = await f.admit();
		expect((await f.slice(run.id, 1)).status).toBe("yielded");
		f.setUnavailable(true);
		expect((await f.slice(run.id)).status).toBe("retryable");
		expect(
			await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "pending",
			failureCount: 1,
			lastFailureCategory: "provider-unavailable",
		});
		f.setUnavailable(false);
		expect((await f.slice(run.id)).status).toBe("pass-complete");
		expect(f.offsets.slice(-3)).toEqual([1, 1, 2]);
		expect((await f.slice(run.id)).status).toBe("published");
	});

	it("preserves compatible receipts after a real database write failure", async () => {
		const f = await fixture();
		const run = await f.admit();
		expect((await f.slice(run.id, 1)).status).toBe("yielded");
		const receipts = await f.prisma.providerNativeInventoryPageReceipt.findMany({
			where: { pass: { runId: run.id } },
		});
		const raw = new Database(f.dbPath);
		try {
			raw.exec(
				"CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON provider_native_inventory_page_receipts BEGIN SELECT RAISE(FAIL, 'synthetic storage failure'); END",
			);
			expect((await f.slice(run.id)).status).toBe("retryable");
			expect(
				await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
			).toMatchObject({
				state: "pending",
				failureCount: 1,
				lastFailureCategory: "database-retryable",
			});
			expect(
				await f.prisma.providerNativeInventoryPageReceipt.findMany({
					where: { pass: { runId: run.id } },
				}),
			).toEqual(receipts);
			raw.exec("DROP TRIGGER synthetic_receipt_failure");
		} finally {
			raw.close();
		}
		expect((await f.slice(run.id)).status).toBe("pass-complete");
		expect(f.offsets.slice(-3)).toEqual([1, 1, 2]);
		expect((await f.slice(run.id)).status).toBe("published");
	});

	it("does not classify an invalid page total as established inventory drift", async () => {
		const f = await fixture();
		const run = await f.admit();
		expect((await f.slice(run.id, 1)).status).toBe("yielded");
		const read = f.adapter.readPage;
		f.adapter.readPage = async (...args) => {
			const page = await read(...args);
			return page.status === "page" ? { ...page, totalRecordCount: 3.5 } : page;
		};
		expect((await f.slice(run.id)).status).toBe("retryable");
		expect(
			await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "pending",
			failureCount: 1,
			lastFailureCategory: "coverage-incomplete",
		});
		expect(await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(f.prior);
	});

	it("concurrent workers do not duplicate the rejected provider read or steal a claim", async () => {
		const f = await fixture();
		const run = await f.admit();
		expect((await f.slice(run.id, 1)).status).toBe("yielded");
		f.setTotal(2);
		const before = f.offsets.length;
		const results = await Promise.all([f.slice(run.id), f.slice(run.id)]);
		expect(results.map((result) => result.status)).toContain("incomplete");
		expect(
			results.every((result) => ["incomplete", "coalesced", "superseded"].includes(result.status)),
		).toBe(true);
		expect(f.offsets.length - before).toBe(1);
		expect(
			await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "incomplete", failureCount: 1, activeSlotKey: null });
		expect(await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(f.prior);
	});

	it("does not invalidate a second instance sharing native IDs and a library scope", async () => {
		const f = await fixture();
		const other = await f.prisma.serviceInstance.create({
			data: { ...f.instance, id: "other-provider", label: "Synthetic peer" },
		});
		expect(
			(
				await admitNativeInventoryRun(
					f.prisma,
					createProviderPublicationAuthority(other),
					"episode",
					new Date(),
				)
			).status,
		).toBe("acquired");
		const peer = await f.prisma.providerNativeInventoryRun.findFirstOrThrow({
			where: { instanceId: other.id, activeSlotKey: { not: null } },
		});
		expect((await f.slice(peer.id, 1)).status).toBe("yielded");
		const peerState = await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: peer.id },
		});
		const peerReceipts = await f.prisma.providerNativeInventoryPageReceipt.findMany({
			where: { pass: { runId: peer.id } },
		});
		const run = await f.admit();
		expect(run.instanceId).toBe("provider");
		expect(run.id).not.toBe(peer.id);
		expect((await f.slice(run.id, 1)).status).toBe("yielded");
		f.setTotal(2);
		expect((await f.slice(run.id)).status).toBe("incomplete");
		expect(
			await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: peer.id } }),
		).toEqual(peerState);
		expect(
			await f.prisma.providerNativeInventoryPageReceipt.findMany({
				where: { pass: { runId: peer.id } },
			}),
		).toEqual(peerReceipts);
		f.setTotal(3);
		expect((await f.slice(peer.id)).status).toBe("pass-complete");
		expect((await f.slice(peer.id)).status).toBe("published");
		expect(
			await readNativeInventoryPage(f.prisma, {
				userId: "owner",
				instanceId: other.id,
				domain: "episode",
			}),
		).toMatchObject({ status: "available", complete: true, itemCount: 3 });
	});

	it.each(["claim", "lease", "generation"] as const)(
		"cannot terminate a superseded %s while rejecting drift",
		async (boundary) => {
			const f = await fixture();
			const run = await f.admit();
			expect((await f.slice(run.id, 1)).status).toBe("yielded");
			f.setTotal(2);
			f.beforeReturn(async () => {
				if (boundary === "generation") {
					await f.prisma.serviceInstance.update({
						where: { id: f.authority.id },
						data: { identityGeneration: { increment: 1 } },
					});
				} else {
					await f.prisma.providerNativeInventoryRun.update({
						where: { id: run.id },
						data:
							boundary === "claim"
								? { claimToken: "replacement-claim" }
								: { leaseUntil: new Date(0) },
					});
				}
			});
			expect((await f.slice(run.id)).status).toBe("superseded");
			expect(
				await f.prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
			).toMatchObject({ state: "running", failureCount: 0 });
			expect(await f.prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(f.prior);
		},
	);
});
