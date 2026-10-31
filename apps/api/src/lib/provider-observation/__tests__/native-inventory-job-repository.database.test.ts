import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { readNativeInventoryPage } from "../native-inventory.js";
import {
	admitNativeInventoryRun,
	beginNativeInventoryPass,
	claimDueNativeInventoryRun,
	commitNativeInventoryPage,
	completeNativeInventoryPass,
	failNativeInventoryRun,
	type NativeInventoryRunClaim,
	previewNativeInventoryRetention,
	pruneNativeInventoryRetention,
	publishNativeInventoryRun,
	renewNativeInventoryRunLease,
	yieldNativeInventoryRun,
} from "../native-inventory-job-repository.js";

const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const NOW = new Date("2026-09-28T09:00:00.000Z");

afterEach(async () => {
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

async function database(service: "PLEX" | "JELLYFIN" = "PLEX") {
	const directory = mkdtempSync(join(tmpdir(), "native-inventory-job-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "plex-1",
			userId: "owner",
			service,
			label: "Synthetic Plex",
			baseUrl: "http://plex.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
			connectionGeneration: 2,
			expectedIdentity: "synthetic-provider",
			identityStatus: "VERIFIED",
			identityGeneration: 3,
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: NOW,
		},
	});
	return { prisma, dbPath, authority: createProviderPublicationAuthority(instance) };
}

async function recordScopeManifest(
	prisma: PrismaClient,
	claim: NativeInventoryRunClaim,
	scopeKeys: string[],
	now: Date,
) {
	const domains =
		claim.workKey === "paired"
			? [
					{ domain: "library" as const, scopeKeys },
					{ domain: "episode" as const, scopeKeys: [] },
				]
			: [{ domain: claim.workKey, scopeKeys }];
	expect(
		(
			await beginNativeInventoryPass(
				prisma,
				claim,
				{ catalogIdentity: "stable-catalog", domains },
				now,
			)
		).status,
	).toBe("recorded");
}

describe("native inventory durable run admission", { timeout: 30_000 }, () => {
	it("coalesces duplicate paired work into one active database run", async () => {
		const { prisma, authority } = await database();
		const first = await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const second = await admitNativeInventoryRun(prisma, authority, "paired", NOW);

		expect(first.status).toBe("acquired");
		expect(second.status).toBe("coalesced");
		expect(await prisma.providerNativeInventoryRun.count()).toBe(1);
	});

	it("settles two clients racing for one paired work slot without duplicate runs", async () => {
		const { prisma, dbPath, authority } = await database();
		const other = createTestPrismaClient(dbPath);
		try {
			const outcomes = await Promise.allSettled([
				admitNativeInventoryRun(prisma, authority, "paired", NOW),
				admitNativeInventoryRun(other, authority, "paired", NOW),
			]);
			const categories = outcomes.map((outcome) => {
				if (outcome.status === "fulfilled") return outcome.value.status;
				const error = outcome.reason as {
					code?: string;
					cause?: { originalCode?: string };
				};
				return `error:${error.code ?? "none"}:${error.cause?.originalCode ?? "none"}`;
			});
			expect(categories.sort()).toEqual(["acquired", "coalesced"]);
			expect(await prisma.providerNativeInventoryRun.count()).toBe(1);
		} finally {
			await other.$disconnect();
		}
	});

	it("lets only one worker hold an unexpired lease and replaces its token after expiry", async () => {
		const { prisma, authority } = await database();
		expect((await admitNativeInventoryRun(prisma, authority, "paired", NOW)).status).toBe(
			"acquired",
		);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		expect(first.status).toBe("acquired");
		if (first.status !== "acquired") return;
		const competing = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		expect(competing.status).toBe("coalesced");
		const takeover = await claimDueNativeInventoryRun(
			prisma,
			run.id,
			new Date(first.claim.leaseUntil.getTime() + 1),
		);
		expect(takeover.status).toBe("acquired");
		if (takeover.status !== "acquired") return;
		expect(takeover.claim.token).not.toBe(first.claim.token);
		const persisted = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(persisted.claimToken).toBe(takeover.claim.token);
	});

	it("renews only a live exact token and prevents takeover at the old expiry", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected claim");
		const renewalAt = new Date(first.claim.leaseUntil.getTime() - 1);
		const renewed = await renewNativeInventoryRunLease(prisma, first.claim, renewalAt);
		expect(renewed.status).toBe("renewed");
		if (renewed.status !== "renewed") return;
		expect(renewed.claim.token).toBe(first.claim.token);
		expect(renewed.claim.leaseUntil.getTime()).toBeGreaterThan(first.claim.leaseUntil.getTime());
		expect(
			(
				await claimDueNativeInventoryRun(
					prisma,
					run.id,
					new Date(first.claim.leaseUntil.getTime() + 1),
				)
			).status,
		).toBe("coalesced");
		expect(
			(await renewNativeInventoryRunLease(prisma, first.claim, renewed.claim.leaseUntil)).status,
		).toBe("superseded");
	});

	it("retains committed receipts and waits until a bounded provider retry is due", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected first claim");
		await recordScopeManifest(prisma, first.claim, ["scope-a"], NOW);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					first.claim,
					{
						domain: "library",
						scopeKey: "scope-a",
						pageKey: "0",
						nextCursor: "1",
						isLast: false,
						expectedRawCount: 2,
						rawNativeIds: ["synthetic-1"],
						comparisonKeys: ["movie:synthetic-1"],
					},
					[
						{
							nativeId: "synthetic-1",
							mediaType: "movie",
							libraryIds: ["scope-a"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic title",
						},
					],
					NOW,
				)
			).status,
		).toBe("recorded");
		const retryAt = new Date(NOW.getTime() + 60_000);
		expect(
			(await failNativeInventoryRun(prisma, first.claim, "provider-unavailable", retryAt, NOW))
				.status,
		).toBe("scheduled");
		expect((await claimDueNativeInventoryRun(prisma, run.id, NOW)).status).toBe("coalesced");
		const recovered = await claimDueNativeInventoryRun(prisma, run.id, retryAt);
		expect(recovered.status).toBe("acquired");
		if (recovered.status !== "acquired") return;
		expect(recovered.claim.passOrdinal).toBe(1);
		expect(recovered.claim.token).not.toBe(first.claim.token);
		expect(
			(
				await beginNativeInventoryPass(
					prisma,
					recovered.claim,
					{
						catalogIdentity: "stable-catalog",
						domains: [{ domain: "library", scopeKeys: ["scope-a"] }],
					},
					retryAt,
				)
			).status,
		).toBe("coalesced");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("cooperatively yields a live claim without recording a provider failure", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected claim");
		expect((await yieldNativeInventoryRun(prisma, first.claim, NOW)).status).toBe("yielded");
		const persisted = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(persisted).toMatchObject({
			state: "pending",
			claimToken: null,
			leaseUntil: null,
			lastFailureCategory: null,
			failureCount: 0,
		});
		const resumed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		expect(resumed.status).toBe("acquired");
		if (resumed.status !== "acquired") return;
		expect(resumed.claim.passOrdinal).toBe(1);
		expect(resumed.claim.token).not.toBe(first.claim.token);
		expect((await yieldNativeInventoryRun(prisma, first.claim, NOW)).status).toBe("superseded");
	});

	it("retries a fenced yield after transient database contention", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected claim");
		const transaction = vi.spyOn(prisma, "$transaction");
		for (let attempt = 0; attempt < 3; attempt++) {
			transaction.mockRejectedValueOnce(
				Object.assign(new Error("synthetic contention"), { code: "P1008" }),
			);
		}
		try {
			expect((await yieldNativeInventoryRun(prisma, first.claim, NOW)).status).toBe("yielded");
		} finally {
			transaction.mockRestore();
		}
		const persisted = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(persisted).toMatchObject({
			state: "pending",
			claimToken: null,
			leaseUntil: null,
			failureCount: 0,
		});
	});

	it("renews the same fenced token after transient database contention", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected claim");
		const transaction = vi.spyOn(prisma, "$transaction");
		for (let attempt = 0; attempt < 3; attempt++) {
			transaction.mockRejectedValueOnce(
				Object.assign(new Error("synthetic contention"), { code: "P1008" }),
			);
		}
		let renewed: Awaited<ReturnType<typeof renewNativeInventoryRunLease>>;
		try {
			renewed = await renewNativeInventoryRunLease(
				prisma,
				first.claim,
				new Date(NOW.getTime() + 1_000),
			);
		} finally {
			transaction.mockRestore();
		}
		expect(renewed.status).toBe("renewed");
		if (renewed.status !== "renewed") return;
		expect(renewed.claim.token).toBe(first.claim.token);
		expect(renewed.claim.leaseUntil.getTime()).toBeGreaterThan(first.claim.leaseUntil.getTime());
		expect((await claimDueNativeInventoryRun(prisma, run.id, NOW)).status).toBe("coalesced");
	});

	it("bounds an orphaned fenced claim when contention persists", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected claim");
		const transaction = vi
			.spyOn(prisma, "$transaction")
			.mockRejectedValue(Object.assign(new Error("synthetic contention"), { code: "P1008" }));
		try {
			expect((await yieldNativeInventoryRun(prisma, first.claim, NOW)).status).toBe("retryable");
		} finally {
			transaction.mockRestore();
		}
		const persisted = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(persisted.leaseUntil?.getTime()).toBeLessThanOrEqual(NOW.getTime() + 120_000);
		expect((await claimDueNativeInventoryRun(prisma, run.id, NOW)).status).toBe("coalesced");
		expect(
			(await claimDueNativeInventoryRun(prisma, run.id, new Date(NOW.getTime() + 120_001))).status,
		).toBe("acquired");
	});

	it("rejects a replaced token while recording and replaying one current page exactly once", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected first claim");
		const takeoverAt = new Date(first.claim.leaseUntil.getTime() + 1);
		const takeover = await claimDueNativeInventoryRun(prisma, run.id, takeoverAt);
		if (takeover.status !== "acquired") throw new Error("expected takeover claim");
		await recordScopeManifest(prisma, takeover.claim, ["synthetic-scope"], takeoverAt);
		const receipt = {
			domain: "library" as const,
			scopeKey: "synthetic-scope",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-movie"],
			comparisonKeys: ["movie:synthetic-movie"],
		};
		const rows = [
			{
				nativeId: "synthetic-movie",
				mediaType: "movie" as const,
				libraryIds: ["synthetic-scope"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Synthetic title",
			},
		];
		expect(
			(await commitNativeInventoryPage(prisma, first.claim, receipt, rows, takeoverAt)).status,
		).toBe("superseded");
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(0);
		expect(
			(await commitNativeInventoryPage(prisma, takeover.claim, receipt, rows, takeoverAt)).status,
		).toBe("recorded");
		expect(
			(await commitNativeInventoryPage(prisma, takeover.claim, receipt, rows, takeoverAt)).status,
		).toBe("coalesced");
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(1);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
	});

	it("rejects comparison evidence for a raw item that was not staged", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{
						domain: "library",
						scopeKey: "scope-a",
						pageKey: "0",
						nextCursor: null,
						isLast: true,
						expectedRawCount: 1,
						rawNativeIds: ["synthetic-id"],
						comparisonKeys: ["movie:synthetic-id"],
					},
					[],
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
	});

	it("merges one native item across scopes but rolls back an inconsistent replay", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a", "scope-b"], NOW);
		const baseRow = {
			nativeId: "synthetic-movie",
			mediaType: "movie" as const,
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		const firstReceipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-movie"],
			comparisonKeys: ["movie:synthetic-movie"],
		};
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					firstReceipt,
					[{ ...baseRow, libraryIds: ["scope-a"], externalIds: { tmdb: [1] } }],
					NOW,
				)
			).status,
		).toBe("recorded");
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{ ...firstReceipt, scopeKey: "scope-b" },
					[
						{
							...baseRow,
							libraryIds: ["scope-b"],
							title: "Updated synthetic title",
							externalIds: { tmdb: [2] },
						},
					],
					NOW,
				)
			).status,
		).toBe("recorded");
		const staged = await prisma.providerNativeInventoryStageItem.findFirstOrThrow();
		expect(JSON.parse(staged.libraryIds)).toEqual(["scope-a", "scope-b"]);
		expect(staged.title).toBe("Updated synthetic title");
		expect(JSON.parse(staged.externalIds ?? "null")).toEqual({ tmdb: [1, 2] });
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(1);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					firstReceipt,
					[
						{
							...baseRow,
							libraryIds: ["scope-a"],
							title: "Conflicting synthetic title",
							externalIds: { tmdb: [1] },
						},
					],
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(2);
		expect((await prisma.providerNativeInventoryStageItem.findFirstOrThrow()).title).toBe(
			"Updated synthetic title",
		);
	});

	it("stages a full provider page with bounded stage-item queries", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "episode", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const ids = Array.from({ length: 500 }, (_, index) => `episode-${index}`);
		const calls = { findUnique: 0, create: 0, createMany: 0 };
		const observed = prisma.$extends({
			query: {
				providerNativeInventoryStageItem: {
					async findUnique({ args, query }) {
						calls.findUnique++;
						return await query(args);
					},
					async create({ args, query }) {
						calls.create++;
						return await query(args);
					},
					async createMany({ args, query }) {
						calls.createMany++;
						return await query(args);
					},
				},
			},
		});
		const result = await commitNativeInventoryPage(
			observed as unknown as PrismaClient,
			claimed.claim,
			{
				domain: "episode",
				scopeKey: "scope-a",
				pageKey: "0",
				nextCursor: null,
				isLast: true,
				expectedRawCount: ids.length,
				rawNativeIds: ids,
				comparisonKeys: ids.map(() => "Episode"),
			},
			ids.map((nativeId) => ({
				nativeId,
				mediaType: "episode" as const,
				libraryIds: ["scope-a"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Synthetic episode",
			})),
			NOW,
		);
		expect(result.status).toBe("recorded");
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(500);
		expect(calls.findUnique).toBeLessThan(10);
		expect(calls.create).toBe(0);
		expect(calls.createMany).toBe(1);
	});

	it("rolls back a later chunk of a 2000-item Jellyfin page before retrying", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "episode", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const ids = Array.from({ length: 2_000 }, (_, index) => `episode-${index}`);
		const receipt = {
			domain: "episode" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: ids.length,
			rawNativeIds: ids,
			comparisonKeys: ids.map(() => "Episode"),
		};
		const rows = ids.map((nativeId) => ({
			nativeId,
			mediaType: "episode" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic episode",
		}));
		let failSecondChunk = true;
		let stageChunks = 0;
		let seenChunks = 0;
		const observed = prisma.$extends({
			query: {
				providerNativeInventoryStageItem: {
					async createMany({ args, query }) {
						stageChunks++;
						if (failSecondChunk && stageChunks % 2 === 0) {
							throw Object.assign(new Error("synthetic later-chunk conflict"), { code: "P2002" });
						}
						return await query(args);
					},
				},
				providerNativeInventorySeenItem: {
					async createMany({ args, query }) {
						seenChunks++;
						return await query(args);
					},
				},
			},
		});
		expect(
			(
				await commitNativeInventoryPage(
					observed as unknown as PrismaClient,
					claimed.claim,
					receipt,
					rows,
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(stageChunks).toBeGreaterThan(1);
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(0);
		expect(await prisma.providerNativeInventorySeenItem.count()).toBe(0);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
		failSecondChunk = false;
		stageChunks = 0;
		seenChunks = 0;
		expect(
			(
				await commitNativeInventoryPage(
					observed as unknown as PrismaClient,
					claimed.claim,
					receipt,
					rows,
					NOW,
				)
			).status,
		).toBe("recorded");
		expect(stageChunks).toBe(4);
		expect(seenChunks).toBe(4);
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(2_000);
		expect(await prisma.providerNativeInventorySeenItem.count()).toBe(2_000);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
	});

	it("merges an existing Jellyfin row within a 2000-item page", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "episode", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a", "scope-b"], NOW);
		const row = (nativeId: string, scopeKey: string) => ({
			nativeId,
			mediaType: "episode" as const,
			libraryIds: [scopeKey],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic episode",
		});
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{
						domain: "episode",
						scopeKey: "scope-a",
						pageKey: "0",
						nextCursor: null,
						isLast: true,
						expectedRawCount: 1,
						rawNativeIds: ["episode-0"],
						comparisonKeys: ["Episode"],
					},
					[row("episode-0", "scope-a")],
					NOW,
				)
			).status,
		).toBe("recorded");
		const ids = Array.from({ length: 2_000 }, (_, index) => `episode-${index}`);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{
						domain: "episode",
						scopeKey: "scope-b",
						pageKey: "0",
						nextCursor: null,
						isLast: true,
						expectedRawCount: ids.length,
						rawNativeIds: ids,
						comparisonKeys: ids.map(() => "Episode"),
					},
					ids.map((nativeId) => row(nativeId, "scope-b")),
					NOW,
				)
			).status,
		).toBe("recorded");
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(2_000);
		expect(await prisma.providerNativeInventorySeenItem.count()).toBe(2_001);
		expect(
			JSON.parse(
				(
					await prisma.providerNativeInventoryStageItem.findFirstOrThrow({
						where: { nativeId: "episode-0" },
					})
				).libraryIds,
			),
		).toEqual(["scope-a", "scope-b"]);
	});

	it("does not admit a 2000-item Plex page", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const ids = Array.from({ length: 2_000 }, (_, index) => `movie-${index}`);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{
						domain: "library",
						scopeKey: "scope-a",
						pageKey: "0",
						nextCursor: null,
						isLast: true,
						expectedRawCount: ids.length,
						rawNativeIds: ids,
						comparisonKeys: ids.map((nativeId) => `movie:${nativeId}`),
					},
					ids.map((nativeId) => ({
						nativeId,
						mediaType: "movie" as const,
						libraryIds: ["scope-a"],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: "Synthetic movie",
					})),
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(0);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
	});

	it("rejects a Plex native ID repeated across scopes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a", "scope-b"], NOW);
		const row = {
			nativeId: "same-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		const receipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["same-id"],
			comparisonKeys: ["movie:same-id"],
		};
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, receipt, [row], NOW)).status,
		).toBe("recorded");
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{ ...receipt, scopeKey: "scope-b" },
					[{ ...row, libraryIds: ["scope-b"] }],
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(1);
	});

	it("replaces an obsolete active slot after the connection generation changes", async () => {
		const { prisma, authority } = await database();
		expect((await admitNativeInventoryRun(prisma, authority, "paired", NOW)).status).toBe(
			"acquired",
		);
		const oldRun = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const updated = await prisma.serviceInstance.update({
			where: { id: authority.id },
			data: { connectionGeneration: authority.connectionGeneration + 1 },
		});
		const currentAuthority = createProviderPublicationAuthority(updated);
		expect((await admitNativeInventoryRun(prisma, currentAuthority, "paired", NOW)).status).toBe(
			"acquired",
		);
		expect((await claimDueNativeInventoryRun(prisma, oldRun.id, NOW)).status).toBe("superseded");
		expect(await prisma.providerNativeInventoryRun.count()).toBe(2);
		expect(
			(await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: oldRun.id } }))
				.activeSlotKey,
		).toBeNull();
	});

	it("rejects a repeated raw native ID across pages of one scope", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const row = {
			nativeId: "repeated-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		const first = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: "1",
			isLast: false,
			expectedRawCount: 2,
			rawNativeIds: ["repeated-id"],
			comparisonKeys: ["movie:repeated-id"],
		};
		expect((await commitNativeInventoryPage(prisma, claimed.claim, first, [row], NOW)).status).toBe(
			"recorded",
		);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{ ...first, pageKey: "1", nextCursor: null, isLast: true },
					[row],
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
		expect(await prisma.providerNativeInventoryStageItem.count()).toBe(1);
	});

	it("rejects a changed declared total between pages of one scope", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const row = (nativeId: string) => ({
			nativeId,
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		});
		const first = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: "1",
			isLast: false,
			expectedRawCount: 2,
			rawNativeIds: ["first-id"],
			comparisonKeys: ["movie:first-id"],
		};
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, first, [row("first-id")], NOW))
				.status,
		).toBe("recorded");
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{
						...first,
						pageKey: "1",
						nextCursor: null,
						isLast: true,
						expectedRawCount: 3,
						rawNativeIds: ["second-id", "third-id"],
						comparisonKeys: ["movie:second-id", "movie:third-id"],
					},
					[row("second-id"), row("third-id")],
					NOW,
				)
			).status,
		).toBe("drifted");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
	});

	it("requires a stable scope manifest before admitting a page", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		const receipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-id"],
			comparisonKeys: ["movie:synthetic-id"],
		};
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, receipt, [row], NOW)).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
		expect(
			(
				await beginNativeInventoryPass(
					prisma,
					claimed.claim,
					{
						catalogIdentity: "stable-catalog",
						domains: [{ domain: "library", scopeKeys: ["scope-a"] }],
					},
					NOW,
				)
			).status,
		).toBe("recorded");
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					claimed.claim,
					{ ...receipt, scopeKey: "scope-b" },
					[row],
					NOW,
				)
			).status,
		).toBe("retryable");
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, receipt, [row], NOW)).status,
		).toBe("recorded");
	});

	it("withholds pass completion until every manifested scope has a terminal page", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a", "scope-b"], NOW);
		const receipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-id"],
			comparisonKeys: ["movie:synthetic-id"],
		};
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, receipt, [row], NOW)).status,
		).toBe("recorded");
		expect(
			(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
		).toBe("retryable");
		expect((await prisma.providerNativeInventoryPass.findFirstOrThrow()).state).toBe("collecting");
	});

	it("advances a complete first pass to a separately claimed second pass", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const first = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (first.status !== "acquired") throw new Error("expected first claim");
		await recordScopeManifest(prisma, first.claim, ["scope-a"], NOW);
		const receipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-id"],
			comparisonKeys: ["movie:synthetic-id"],
		};
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		expect((await commitNativeInventoryPage(prisma, first.claim, receipt, [row], NOW)).status).toBe(
			"recorded",
		);
		expect(
			(await completeNativeInventoryPass(prisma, first.claim, "stable-catalog", NOW)).status,
		).toBe("completed");
		const persisted = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(persisted).toMatchObject({ passOrdinal: 2, state: "pending", claimToken: null });
		const second = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		expect(second.status).toBe("acquired");
		if (second.status !== "acquired") return;
		expect(second.claim.passOrdinal).toBe(2);
		expect(second.claim.token).not.toBe(first.claim.token);
	});

	it("does not complete a pass after its provider authority generation changes", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
		const receipt = {
			domain: "library" as const,
			scopeKey: "scope-a",
			pageKey: "0",
			nextCursor: null,
			isLast: true,
			expectedRawCount: 1,
			rawNativeIds: ["synthetic-id"],
			comparisonKeys: ["movie:synthetic-id"],
		};
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		expect(
			(await commitNativeInventoryPage(prisma, claimed.claim, receipt, [row], NOW)).status,
		).toBe("recorded");
		await prisma.serviceInstance.update({
			where: { id: authority.id },
			data: { identityGeneration: authority.identityGeneration + 1 },
		});
		expect(
			(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
		).toBe("superseded");
		expect((await prisma.providerNativeInventoryPass.findFirstOrThrow()).state).toBe("collecting");
	});

	it("persists different comparison digests for changed scoped evidence across complete passes", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		let finalClaim: NativeInventoryRunClaim | undefined;
		for (const comparisonKey of ["movie:stable", "series:changed"]) {
			const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
			if (claimed.status !== "acquired") throw new Error("expected claim");
			finalClaim = claimed.claim;
			await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
			expect(
				(
					await commitNativeInventoryPage(
						prisma,
						claimed.claim,
						{
							domain: "library",
							scopeKey: "scope-a",
							pageKey: "0",
							nextCursor: null,
							isLast: true,
							expectedRawCount: 1,
							rawNativeIds: ["synthetic-id"],
							comparisonKeys: [comparisonKey],
						},
						[row],
						NOW,
					)
				).status,
			).toBe("recorded");
			expect(
				(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
			).toBe("completed");
		}
		const passes = await prisma.providerNativeInventoryPass.findMany({
			where: { runId: run.id },
			orderBy: { ordinal: "asc" },
		});
		expect(passes).toHaveLength(2);
		expect(passes[0]?.comparisonDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(passes[1]?.comparisonDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(passes[1]?.comparisonDigest).not.toBe(passes[0]?.comparisonDigest);
		if (!finalClaim) throw new Error("expected final claim");
		expect((await publishNativeInventoryRun(prisma, finalClaim, NOW)).status).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(
			(await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }))
				.passOrdinal,
		).toBe(3);
		const third = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (third.status !== "acquired") throw new Error("expected third claim");
		await recordScopeManifest(prisma, third.claim, ["scope-a"], NOW);
		expect(
			(
				await commitNativeInventoryPage(
					prisma,
					third.claim,
					{
						domain: "library",
						scopeKey: "scope-a",
						pageKey: "0",
						nextCursor: null,
						isLast: true,
						expectedRawCount: 1,
						rawNativeIds: ["synthetic-id"],
						comparisonKeys: ["movie:still-different"],
					},
					[row],
					NOW,
				)
			).status,
		).toBe("recorded");
		expect(
			(await completeNativeInventoryPass(prisma, third.claim, "stable-catalog", NOW)).status,
		).toBe("completed");
		expect((await publishNativeInventoryRun(prisma, third.claim, NOW)).status).toBe("incomplete");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		const terminal = await prisma.providerNativeInventoryRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		expect(terminal.activeSlotKey).toBeNull();
		expect(terminal.state).toBe("incomplete");
		expect(terminal.lastFailureCategory).toBe("coverage-incomplete");
	});

	it("keeps complete staged passes invisible until an atomic copy-free head switch", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const row = {
			nativeId: "synthetic-id",
			mediaType: "movie" as const,
			libraryIds: ["scope-a"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Synthetic title",
		};
		let finalClaim: NativeInventoryRunClaim | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
			if (claimed.status !== "acquired") throw new Error("expected claim");
			finalClaim = claimed.claim;
			await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
			expect(
				(
					await commitNativeInventoryPage(
						prisma,
						claimed.claim,
						{
							domain: "library",
							scopeKey: "scope-a",
							pageKey: "0",
							nextCursor: null,
							isLast: true,
							expectedRawCount: 1,
							rawNativeIds: ["synthetic-id"],
							comparisonKeys: ["movie:synthetic-id"],
						},
						[{ ...row, externalIds: pass === 0 ? { tmdb: [11] } : { tmdb: [22], tvdb: [33] } }],
						NOW,
					)
				).status,
			).toBe("recorded");
			expect(
				(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
			).toBe("completed");
		}
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				now: NOW,
			}),
		).toEqual({ status: "unavailable", reason: "no-publication" });
		if (!finalClaim) throw new Error("expected final claim");
		expect((await publishNativeInventoryRun(prisma, finalClaim, NOW)).status).toBe("published");
		const page = await readNativeInventoryPage(prisma, {
			userId: authority.userId,
			instanceId: authority.id,
			domain: "library",
			now: NOW,
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") return;
		expect(page).toMatchObject({ itemCount: 1, complete: true });
		expect(page.rows.map((item) => item.nativeId)).toEqual(["synthetic-id"]);
		expect(page.rows[0]?.externalIds).toEqual({ tmdb: [11, 22] });
		expect(await prisma.providerNativeInventoryItem.count()).toBe(0);
		const snapshot = await prisma.providerNativeInventorySnapshot.findFirstOrThrow();
		const finalPass = await prisma.providerNativeInventoryPass.findFirstOrThrow({
			where: { runId: run.id, ordinal: 2 },
		});
		expect(snapshot.publishedPassId).toBe(finalPass.id);
		await prisma.providerNativeInventoryRun.create({
			data: {
				id: "0000000000000000000000000",
				instanceId: authority.id,
				workKey: "library",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: "pending",
				activeSlotKey: "synthetic-newer-slot",
				createdAt: NOW,
			},
		});
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				now: NOW,
			}),
		).toMatchObject({ status: "available", freshness: "last-known", complete: false });
	});

	it("recovers a complete final pass after lease expiry without rereading pages", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let finalClaim: NativeInventoryRunClaim | undefined;
		for (let ordinal = 1; ordinal <= 2; ordinal++) {
			const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
			if (claimed.status !== "acquired") throw new Error("expected claim");
			finalClaim = claimed.claim;
			await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
			expect(
				(
					await commitNativeInventoryPage(
						prisma,
						claimed.claim,
						{
							domain: "library",
							scopeKey: "scope-a",
							pageKey: "0",
							nextCursor: null,
							isLast: true,
							expectedRawCount: 1,
							rawNativeIds: ["synthetic-id"],
							comparisonKeys: ["movie:synthetic-id"],
						},
						[
							{
								nativeId: "synthetic-id",
								mediaType: "movie",
								libraryIds: ["scope-a"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: "Synthetic title",
							},
						],
						NOW,
					)
				).status,
			).toBe("recorded");
			expect(
				(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
			).toBe("completed");
		}
		if (!finalClaim) throw new Error("expected final claim");
		const recoveryAt = new Date(finalClaim.leaseUntil.getTime() + 1);
		const recovered = await claimDueNativeInventoryRun(prisma, run.id, recoveryAt);
		expect(recovered.status).toBe("acquired");
		if (recovered.status !== "acquired") return;
		expect(recovered.claim.token).not.toBe(finalClaim.token);
		expect((await publishNativeInventoryRun(prisma, finalClaim, recoveryAt)).status).toBe(
			"superseded",
		);
		expect((await publishNativeInventoryRun(prisma, recovered.claim, recoveryAt)).status).toBe(
			"published",
		);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(2);
	});

	it("retains published heads and active work while pruning only old terminal staging", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		const old = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000);
		const cutoff = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000);
		const eligible = await prisma.providerNativeInventoryRun.create({
			data: {
				instanceId: authority.id,
				workKey: "library",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: "incomplete",
				updatedAt: old,
			},
		});
		await prisma.providerNativeInventoryPass.create({
			data: { runId: eligible.id, ordinal: 1 },
		});
		const protectedRun = await prisma.providerNativeInventoryRun.create({
			data: {
				instanceId: authority.id,
				workKey: "library",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: "published",
				updatedAt: old,
			},
		});
		const protectedPass = await prisma.providerNativeInventoryPass.create({
			data: { runId: protectedRun.id, ordinal: 2, state: "complete" },
		});
		const head = await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "synthetic-generation",
				publishedPassId: protectedPass.id,
			},
		});
		await prisma.providerNativeInventoryItem.create({
			data: {
				snapshotId: head.id,
				nativeId: "legacy-id",
				mediaType: "movie",
				libraryIds: '["scope-a"]',
			},
		});
		const active = await prisma.providerNativeInventoryRun.create({
			data: {
				instanceId: authority.id,
				workKey: "episode",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: "pending",
				activeSlotKey: "synthetic-active-slot",
				updatedAt: old,
			},
		});
		const recent = await prisma.providerNativeInventoryRun.create({
			data: {
				instanceId: authority.id,
				workKey: "episode",
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: "incomplete",
				updatedAt: NOW,
			},
		});
		expect(await previewNativeInventoryRetention(prisma, cutoff, 10)).toEqual({
			candidateCount: 1,
		});
		expect(await prisma.providerNativeInventoryRun.count()).toBe(4);
		expect(await pruneNativeInventoryRetention(prisma, cutoff, 10)).toEqual({ deletedRuns: 1 });
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: eligible.id } }),
		).toBeNull();
		expect(
			await prisma.providerNativeInventoryRun.count({
				where: { id: { in: [protectedRun.id, active.id, recent.id] } },
			}),
		).toBe(3);
		expect(
			await prisma.providerNativeInventorySnapshot.findUnique({ where: { id: head.id } }),
		).not.toBeNull();
		expect(await prisma.providerNativeInventoryItem.count({ where: { snapshotId: head.id } })).toBe(
			1,
		);
	});

	it("does not throw or publish when a completed pass manifest is malformed", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const acquired = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (acquired.status !== "acquired") throw new Error("expected claim");
		await prisma.providerNativeInventoryRun.update({
			where: { id: run.id },
			data: { state: "ready", passOrdinal: 2 },
		});
		for (const ordinal of [1, 2]) {
			await prisma.providerNativeInventoryPass.create({
				data: {
					runId: run.id,
					ordinal,
					state: "complete",
					scopeManifest: ordinal === 2 ? "not-json" : "[]",
					scopeDigest: "a".repeat(64),
					comparisonDigest: "b".repeat(64),
					libraryItemCount: 0,
				},
			});
		}
		const claim = { ...acquired.claim, passOrdinal: 2 };
		expect((await publishNativeInventoryRun(prisma, claim, NOW)).status).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("rejects a paired pass manifest that repeats library but omits episode", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const acquired = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (acquired.status !== "acquired") throw new Error("expected claim");
		await prisma.providerNativeInventoryRun.update({
			where: { id: run.id },
			data: { state: "ready", passOrdinal: 2 },
		});
		for (const ordinal of [1, 2]) {
			await prisma.providerNativeInventoryPass.create({
				data: {
					runId: run.id,
					ordinal,
					state: "complete",
					scopeManifest:
						'[{"domain":"library","scopeKeys":[]},{"domain":"library","scopeKeys":[]}]',
					scopeDigest: "a".repeat(64),
					comparisonDigest: "b".repeat(64),
					libraryItemCount: 0,
					episodeItemCount: 0,
				},
			});
		}
		const claim = { ...acquired.claim, passOrdinal: 2 };
		expect((await publishNativeInventoryRun(prisma, claim, NOW)).status).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("retains legacy rows but denies current completeness during a newer incomplete run", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		const snapshot = await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "legacy-generation",
				observedAt: NOW,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "a".repeat(64),
				contentDigest: "b".repeat(64),
				itemCount: 1,
				scopeCount: 1,
				lastAttemptAt: NOW,
				lastAttemptResult: "success",
			},
		});
		await prisma.providerNativeInventoryItem.create({
			data: {
				snapshotId: snapshot.id,
				nativeId: "legacy-id",
				mediaType: "movie",
				libraryIds: '["scope-a"]',
			},
		});
		const read = () =>
			readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				now: NOW,
				includeAttempt: true,
			});
		expect(await read()).toMatchObject({
			status: "available",
			freshness: "current",
			complete: true,
			rows: [{ nativeId: "legacy-id" }],
		});
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
		if (claimed.status !== "acquired") throw new Error("expected claim");
		expect(await read()).toMatchObject({
			status: "available",
			freshness: "last-known",
			complete: false,
			rows: [{ nativeId: "legacy-id" }],
			attempt: { state: "running", pagesCompleted: 0, itemsStaged: 0 },
		});
		expect(
			(await failNativeInventoryRun(prisma, claimed.claim, "coverage-incomplete", null, NOW))
				.status,
		).toBe("incomplete");
		expect(await read()).toMatchObject({
			status: "available",
			freshness: "last-known",
			complete: false,
			rows: [{ nativeId: "legacy-id" }],
			attempt: { state: "incomplete", reasonCode: "coverage-incomplete" },
		});
	});

	it("rejects a complete pass whose staged row disappears before publication", async () => {
		const { prisma, authority } = await database("JELLYFIN");
		await admitNativeInventoryRun(prisma, authority, "library", NOW);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let finalClaim: NativeInventoryRunClaim | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const claimed = await claimDueNativeInventoryRun(prisma, run.id, NOW);
			if (claimed.status !== "acquired") throw new Error("expected claim");
			finalClaim = claimed.claim;
			await recordScopeManifest(prisma, claimed.claim, ["scope-a"], NOW);
			expect(
				(
					await commitNativeInventoryPage(
						prisma,
						claimed.claim,
						{
							domain: "library",
							scopeKey: "scope-a",
							pageKey: "0",
							nextCursor: null,
							isLast: true,
							expectedRawCount: 1,
							rawNativeIds: ["synthetic-id"],
							comparisonKeys: ["movie:synthetic-id"],
						},
						[
							{
								nativeId: "synthetic-id",
								mediaType: "movie",
								libraryIds: ["scope-a"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: "Synthetic title",
							},
						],
						NOW,
					)
				).status,
			).toBe("recorded");
			expect(
				(await completeNativeInventoryPass(prisma, claimed.claim, "stable-catalog", NOW)).status,
			).toBe("completed");
		}
		if (!finalClaim) throw new Error("expected final claim");
		const finalPass = await prisma.providerNativeInventoryPass.findUniqueOrThrow({
			where: { runId_ordinal: { runId: run.id, ordinal: 2 } },
		});
		await prisma.providerNativeInventoryStageItem.deleteMany({ where: { passId: finalPass.id } });
		expect((await publishNativeInventoryRun(prisma, finalClaim, NOW)).status).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});
});
