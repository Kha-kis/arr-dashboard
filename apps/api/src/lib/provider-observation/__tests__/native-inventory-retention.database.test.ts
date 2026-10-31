import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import {
	previewNativeInventoryRetention,
	pruneNativeInventoryRetention,
} from "../native-inventory-job-repository.js";
import { readNativeInventoryDisplayPage } from "../native-inventory.js";
import {
	pruneNativeInventoryRetentionSlice,
	type NativeInventoryRetentionCursor,
} from "../native-inventory-retention.js";

const NOW = new Date("2026-10-23T06:00:00.000Z");
const OLD = new Date("2026-10-10T06:00:00.000Z");
const CUTOFF = new Date("2026-10-20T06:00:00.000Z");
const databases: Array<{ directory: string; prisma: PrismaClient }> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const { directory, prisma } of databases.splice(0)) {
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	}
});

async function fixture(workKey: "library" | "episode" = "library") {
	const directory = mkdtempSync(join(tmpdir(), "native-retention-"));
	const dbPath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
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
			expectedIdentity: "synthetic-server",
			identityStatus: "VERIFIED",
			identityKind: "JELLYFIN_SERVER_ID",
			identityVerifiedAt: OLD,
		},
	});
	const common = {
		instanceId: "provider",
		workKey,
		connectionGeneration: 2,
		identityGeneration: 3,
	};
	await prisma.providerNativeInventoryRun.create({
		data: { id: "old", ...common, state: "incomplete", createdAt: OLD, updatedAt: OLD },
	});
	await prisma.providerNativeInventoryRun.create({
		data: {
			id: "latest",
			...common,
			state: "pending",
			activeSlotKey: "synthetic-slot",
			createdAt: NOW,
			updatedAt: NOW,
		},
	});
	return { prisma, dbPath };
}

async function selectedBeforeChange(prisma: PrismaClient) {
	return prisma.providerNativeInventoryRun.findMany({
		where: { id: "old" },
		include: {
			instance: {
				select: {
					userId: true,
					service: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			},
		},
	});
}

async function mixedAttemptFixture(retainFailureMetadata = false) {
	const { prisma } = await fixture();
	await prisma.providerNativeInventoryRun.delete({ where: { id: "latest" } });
	const createdAt = new Date("2026-10-10T00:00:00Z");
	await prisma.providerNativeInventoryRun.update({
		where: { id: "old" },
		data: {
			id: "legacy-candidate",
			createdAt,
			updatedAt: OLD,
			failureCount: 1,
			lastFailureCategory: "budget-exhausted",
		},
	});
	await prisma.$executeRawUnsafe(
		'UPDATE "provider_native_inventory_runs" SET "updatedAt"=? WHERE "id"=?',
		"2026-10-10 09:00:00.000",
		"legacy-candidate",
	);
	await prisma.providerNativeInventoryRun.create({
		data: {
			id: "raw-reader-latest",
			instanceId: "provider",
			workKey: "library",
			state: "incomplete",
			connectionGeneration: 2,
			identityGeneration: 3,
			createdAt,
			updatedAt: new Date("2026-10-10T08:00:00Z"),
			failureCount: 7,
			lastFailureCategory: "provider-unavailable",
		},
	});
	if (retainFailureMetadata) {
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				id: "older-publication",
				instanceId: "provider",
				domain: "library",
				connectionGeneration: 2,
				identityGeneration: 3,
				observedAt: new Date("2026-10-09T00:00:00Z"),
			},
		});
	}
	return prisma;
}

describe("bounded native staging retention", { timeout: 30_000 }, () => {
	it("REG916-01 advances through a full protected legacy timestamp window", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryRun.update({
			where: { id: "old" },
			data: { id: "z-obsolete", updatedAt: OLD },
		});
		await prisma.$executeRawUnsafe(
			'UPDATE "provider_native_inventory_runs" SET "updatedAt"=? WHERE "id"=?',
			"2026-10-10 02:00:00.000",
			"z-obsolete",
		);
		for (let index = 0; index < 10; index++) {
			const instanceId = `protected-legacy-${index}`;
			await prisma.serviceInstance.create({
				data: {
					id: instanceId,
					userId: "owner",
					service: "PLEX",
					label: "Synthetic",
					baseUrl: "http://fixture.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			const id = `a-protected-${index}`;
			await prisma.providerNativeInventoryRun.create({
				data: {
					id,
					instanceId,
					workKey: "paired",
					state: "incomplete",
					connectionGeneration: 0,
					identityGeneration: 0,
					createdAt: OLD,
					updatedAt: OLD,
				},
			});
			await prisma.$executeRawUnsafe(
				'UPDATE "provider_native_inventory_runs" SET "updatedAt"=? WHERE "id"=?',
				"2026-10-10 01:00:00.000",
				id,
			);
		}
		let cursor: NativeInventoryRetentionCursor | null = null;
		for (let tick = 0; tick < 6; tick++) {
			const result = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, {
				scanLimit: 10,
				cursor,
			});
			cursor = result.nextCursor;
		}
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "z-obsolete" } }),
		).toBeNull();
		expect(
			await prisma.providerNativeInventoryRun.count({
				where: { id: { startsWith: "a-protected-" } },
			}),
		).toBe(10);
	});

	it("REG916-02 preserves the actual reader-selected latest attempt across a mixed-spelling tie", async () => {
		const prisma = await mixedAttemptFixture();
		const input = {
			userId: "owner",
			instanceId: "provider",
			domain: "library" as const,
			now: NOW,
			includeAttempt: true,
		};
		const before = await readNativeInventoryDisplayPage(prisma, input);
		expect(before.attempt?.failureCount).toBe(7);
		await pruneNativeInventoryRetentionSlice(prisma, CUTOFF);
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "raw-reader-latest" } }),
		).not.toBeNull();
		expect(await readNativeInventoryDisplayPage(prisma, input)).toEqual(before);
	});

	it("REG916-02 leaves retained legacy timestamp scalars and failure diagnostics unchanged", async () => {
		const prisma = await mixedAttemptFixture(true);
		const raw = () =>
			prisma.$queryRawUnsafe(
				'SELECT CAST("createdAt" AS TEXT) AS created,CAST("updatedAt" AS TEXT) AS updated FROM "provider_native_inventory_runs" WHERE "id"=?',
				"legacy-candidate",
			);
		const before = await raw();
		await pruneNativeInventoryRetentionSlice(prisma, CUTOFF);
		expect(await raw()).toEqual(before);
	});
	it("preserves runs attached to an unsupported native provider service", async () => {
		const { prisma } = await fixture();
		await prisma.serviceInstance.update({ where: { id: "provider" }, data: { service: "SONARR" } });
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 0,
		});
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
	});

	it.each(["connectionGeneration", "identityGeneration"] as const)(
		"preserves runs with invalid %s evidence",
		async (field) => {
			const { prisma } = await fixture();
			await prisma.providerNativeInventoryRun.update({
				where: { id: "old" },
				data: { [field]: -1, updatedAt: OLD },
			});
			await prisma.providerNativeInventoryRun.update({
				where: { id: "latest" },
				data: { [field]: -1 },
			});
			expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
				candidateCount: 0,
			});
			expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		},
	);

	it.each([
		{ claimToken: "synthetic-claim", leaseUntil: null },
		{ claimToken: null, leaseUntil: new Date("2026-10-24T00:00:00.000Z") },
		{ claimToken: null, leaseUntil: OLD },
	])("preserves terminal work with any remaining claim or lease: %j", async (claim) => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryRun.update({
			where: { id: "old" },
			data: { ...claim, updatedAt: OLD },
		});
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 0,
		});
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("does not cascade a large run in a single retention call", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryPass.create({
			data: { id: "pass", runId: "old", ordinal: 1 },
		});
		for (let offset = 0; offset < 1_001; offset += 250) {
			await prisma.providerNativeInventoryStageItem.createMany({
				data: Array.from({ length: Math.min(250, 1_001 - offset) }, (_, index) => ({
					passId: "pass",
					domain: "library",
					nativeId: `synthetic-${offset + index}`,
					mediaType: "movie",
					libraryIds: '["synthetic-scope"]',
				})),
			});
		}
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(await prisma.providerNativeInventoryStageItem.count({ where: { passId: "pass" } })).toBe(
			501,
		);
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("preserves the latest attempt even when it is old and unreferenced", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryRun.delete({ where: { id: "latest" } });
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 0,
		});
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("preserves the current positive-only display run without a snapshot reference", async () => {
		const { prisma } = await fixture("episode");
		await prisma.providerNativeInventoryPass.create({
			data: {
				id: "positive-pass",
				runId: "old",
				ordinal: 1,
				state: "complete",
				completedAt: OLD,
				episodeItemCount: 1,
				scopeManifest: '[{"domain":"episode","scopeKeys":["synthetic-scope"]}]',
				scopeDigest: "a".repeat(64),
				comparisonDigest: "b".repeat(64),
			},
		});
		await prisma.providerNativeInventoryStageItem.create({
			data: {
				passId: "positive-pass",
				domain: "episode",
				nativeId: "synthetic-episode",
				mediaType: "episode",
				libraryIds: '["synthetic-scope"]',
				parentNativeId: "synthetic-show",
				seasonNumber: 1,
				episodeNumber: 1,
			},
		});
		const input = { userId: "owner", instanceId: "provider", domain: "episode" as const, now: NOW };
		const before = await readNativeInventoryDisplayPage(prisma, input);
		expect(before.status).toBe("available");
		await pruneNativeInventoryRetention(prisma, CUTOFF, 10);
		const after = await readNativeInventoryDisplayPage(prisma, input);
		expect(after).toEqual(before);
	});

	it.each(["connectionGeneration", "identityGeneration"] as const)(
		"refuses a stale selection after the instance %s changes",
		async (field) => {
			const { prisma } = await fixture();
			const selected = await selectedBeforeChange(prisma);
			await prisma.serviceInstance.update({ where: { id: "provider" }, data: { [field]: 9 } });
			vi.spyOn(prisma.providerNativeInventoryRun, "findMany").mockResolvedValueOnce(selected);
			expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
			expect(
				await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
			).not.toBeNull();
		},
	);

	it("refuses a stale selection after the owning user changes", async () => {
		const { prisma } = await fixture();
		const selected = await selectedBeforeChange(prisma);
		await prisma.user.create({ data: { id: "other-owner", username: "synthetic-other" } });
		await prisma.serviceInstance.update({
			where: { id: "provider" },
			data: { userId: "other-owner" },
		});
		vi.spyOn(prisma.providerNativeInventoryRun, "findMany").mockResolvedValueOnce(selected);
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("refuses a newly referenced run after the candidate list was read", async () => {
		const { prisma } = await fixture();
		const selected = await selectedBeforeChange(prisma);
		await prisma.providerNativeInventoryPass.create({
			data: { id: "new-head", runId: "old", ordinal: 1 },
		});
		await prisma.providerNativeInventorySnapshot.create({
			data: { instanceId: "provider", domain: "library", publishedPassId: "new-head" },
		});
		vi.spyOn(prisma.providerNativeInventoryRun, "findMany").mockResolvedValueOnce(selected);
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(
			await prisma.providerNativeInventoryPass.findUnique({ where: { id: "new-head" } }),
		).not.toBeNull();
	});

	it("refuses a new claim even when the candidate timestamp stays old", async () => {
		const { prisma } = await fixture();
		const selected = await selectedBeforeChange(prisma);
		await prisma.providerNativeInventoryRun.update({
			where: { id: "old" },
			data: { claimToken: "synthetic-new-claim", updatedAt: OLD },
		});
		vi.spyOn(prisma.providerNativeInventoryRun, "findMany").mockResolvedValueOnce(selected);
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("preserves both passes of a published head and same-native-id rows in another instance", async () => {
		const { prisma } = await fixture();
		await prisma.serviceInstance.create({
			data: {
				id: "other-instance",
				userId: "owner",
				service: "PLEX",
				label: "Synthetic other",
				baseUrl: "http://other.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		await prisma.providerNativeInventoryRun.create({
			data: {
				id: "published",
				instanceId: "other-instance",
				workKey: "paired",
				state: "published",
				connectionGeneration: 0,
				identityGeneration: 0,
				createdAt: OLD,
				updatedAt: OLD,
			},
		});
		for (const [id, runId, ordinal] of [
			["obsolete", "old", 1],
			["prior", "published", 1],
			["final", "published", 2],
		] as const) {
			await prisma.providerNativeInventoryPass.create({ data: { id, runId, ordinal } });
			await prisma.providerNativeInventoryStageItem.create({
				data: {
					passId: id,
					domain: "library",
					nativeId: "same-id",
					mediaType: "movie",
					libraryIds: '["scope"]',
				},
			});
		}
		await prisma.providerNativeInventorySnapshot.create({
			data: { instanceId: "other-instance", domain: "library", publishedPassId: "final" },
		});
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 1 });
		expect(
			await prisma.providerNativeInventoryStageItem.count({
				where: { passId: { in: ["prior", "final"] } },
			}),
		).toBe(2);
		expect(
			await prisma.providerNativeInventoryStageItem.count({ where: { passId: "obsolete" } }),
		).toBe(0);
	});

	it("retries small slices to completion without counting cascaded or duplicate rows", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryPass.create({
			data: { id: "pass", runId: "old", ordinal: 1 },
		});
		await prisma.providerNativeInventoryStageItem.createMany({
			data: Array.from({ length: 7 }, (_, index) => ({
				passId: "pass",
				domain: "library",
				nativeId: `item-${index}`,
				mediaType: "movie",
				libraryIds: '["scope"]',
			})),
		});
		const first = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, { rowLimit: 3 });
		expect(first.deletedRows).toBe(3);
		expect(await prisma.providerNativeInventoryStageItem.count({ where: { passId: "pass" } })).toBe(
			4,
		);
		const second = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, {
			rowLimit: 3,
			cursor: first.nextCursor,
		});
		expect(second.deletedRows).toBe(3);
		const third = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, {
			rowLimit: 3,
			cursor: second.nextCursor,
		});
		expect(third.deletedRows).toBe(3);
		expect(first.deletedRuns + second.deletedRuns + third.deletedRuns).toBe(1);
		expect((await pruneNativeInventoryRetentionSlice(prisma, CUTOFF)).deletedRows).toBe(0);
	});

	it("does not mutate on preview and performs no work after cancellation", async () => {
		const { prisma } = await fixture();
		const before = await prisma.providerNativeInventoryRun.findMany();
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 1,
		});
		expect(await prisma.providerNativeInventoryRun.findMany()).toEqual(before);
		const controller = new AbortController();
		controller.abort();
		expect(
			(await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, { signal: controller.signal }))
				.deletedRows,
		).toBe(0);
		expect(await prisma.providerNativeInventoryRun.findMany()).toEqual(before);
	});

	it("keeps failure metadata that makes an older published head last-known", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: "provider",
				domain: "library",
				observedAt: new Date("2026-10-09T00:00:00.000Z"),
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		});
		await prisma.providerNativeInventoryPass.create({
			data: { id: "pass", runId: "old", ordinal: 1 },
		});
		expect(await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({ deletedRuns: 0 });
		expect(await prisma.providerNativeInventoryPass.count({ where: { runId: "old" } })).toBe(0);
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("rejects an unsafe recent cutoff and invalid budgets before using a database", async () => {
		for (const options of [
			{ rowLimit: 0 },
			{ rowLimit: 501 },
			{ scanLimit: 0 },
			{ scanLimit: 101 },
		]) {
			await expect(
				pruneNativeInventoryRetentionSlice({} as PrismaClient, CUTOFF, options),
			).rejects.toThrow("retention input is invalid");
		}
		await expect(
			pruneNativeInventoryRetentionSlice({} as PrismaClient, new Date(Date.now() - 60_000)),
		).rejects.toThrow("retention input is invalid");
	});

	it("advances past a protected candidate prefix without starving later obsolete runs", async () => {
		const { prisma } = await fixture();
		await prisma.providerNativeInventoryRun.update({
			where: { id: "old" },
			data: { id: "z-obsolete", updatedAt: OLD },
		});
		for (let index = 0; index < 5; index++) {
			const instanceId = `protected-${index}`;
			await prisma.serviceInstance.create({
				data: {
					id: instanceId,
					userId: "owner",
					service: "PLEX",
					label: "Synthetic",
					baseUrl: "http://fixture.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			await prisma.providerNativeInventoryRun.create({
				data: {
					id: `a-${index}`,
					instanceId,
					workKey: "paired",
					state: "incomplete",
					connectionGeneration: 0,
					identityGeneration: 0,
					createdAt: OLD,
					updatedAt: OLD,
				},
			});
		}
		let cursor: NativeInventoryRetentionCursor | null = null,
			deleted = 0;
		for (let attempt = 0; attempt < 4; attempt++) {
			const slice = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF, {
				scanLimit: 2,
				cursor,
			});
			deleted += slice.deletedRuns;
			cursor = slice.nextCursor;
			if (!slice.hasMore) break;
		}
		expect(deleted).toBe(1);
		expect(
			await prisma.providerNativeInventoryRun.count({ where: { id: { startsWith: "a-" } } }),
		).toBe(5);
	});

	it("preserves a newer timestamp even when its SQLite spelling sorts before the cutoff", async () => {
		const { prisma } = await fixture();
		await prisma.$executeRawUnsafe(
			'UPDATE "provider_native_inventory_runs" SET "updatedAt" = ? WHERE "id" = ?',
			"2026-10-20 18:00:00.000",
			"old",
		);
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 0,
		});
		expect((await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).deletedRuns).toBe(0);
		expect(
			await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
		).not.toBeNull();
	});

	it("cleans an expired timestamp in the legacy SQLite spelling without changing its age", async () => {
		const { prisma } = await fixture();
		await prisma.$executeRawUnsafe(
			'UPDATE "provider_native_inventory_runs" SET "updatedAt" = ? WHERE "id" = ?',
			"2026-10-19 18:00:00.000",
			"old",
		);
		expect(await previewNativeInventoryRetention(prisma, CUTOFF, 10)).toEqual({
			candidateCount: 1,
		});
		expect((await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).deletedRuns).toBe(1);
	});

	it.each(["createdAt", "updatedAt"] as const)(
		"refuses a stale candidate after its %s timestamp changes",
		async (field) => {
			const { prisma } = await fixture();
			const selected = await selectedBeforeChange(prisma);
			await prisma.providerNativeInventoryRun.update({
				where: { id: "old" },
				data: {
					[field]: new Date("2026-10-11T06:00:00.000Z"),
					...(field === "createdAt" ? { updatedAt: OLD } : {}),
				},
			});
			vi.spyOn(prisma.providerNativeInventoryRun, "findMany").mockResolvedValueOnce(selected);
			expect((await pruneNativeInventoryRetention(prisma, CUTOFF, 10)).deletedRuns).toBe(0);
			expect(
				await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
			).not.toBeNull();
		},
	);

	it("accounts only committed deletions across concurrent clients and a later retry", async () => {
		const { prisma, dbPath } = await fixture();
		await prisma.providerNativeInventoryPass.create({
			data: { id: "pass", runId: "old", ordinal: 1 },
		});
		await prisma.providerNativeInventoryStageItem.createMany({
			data: Array.from({ length: 7 }, (_, index) => ({
				passId: "pass",
				domain: "library",
				nativeId: `concurrent-${index}`,
				mediaType: "movie",
				libraryIds: '["scope"]',
			})),
		});
		const other = createTestPrismaClient(dbPath);
		try {
			const outcomes = await Promise.allSettled([
				pruneNativeInventoryRetentionSlice(prisma, CUTOFF, { rowLimit: 3 }),
				pruneNativeInventoryRetentionSlice(other, CUTOFF, { rowLimit: 3 }),
			]);
			let committed = 0;
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled") {
					expect(outcome.value.deletedRows).toBeLessThanOrEqual(3);
					committed += outcome.value.deletedRows;
				} else {
					const code = (outcome.reason as { code?: string }).code;
					if (code === "P2010") {
						// Raw SQL uses a different Prisma wrapper; require the actual
						// retryable SQLite cause, not arbitrary raw-query failures.
						expect(outcome.reason).toMatchObject({
							meta: {
								driverAdapterError: {
									cause: {
										originalCode: "SQLITE_BUSY",
										kind: "SocketTimeout",
									},
								},
							},
						});
					} else
						expect(["P1008", "P2028", "P2034", "SQLITE_BUSY", "SQLITE_LOCKED"]).toContain(code);
				}
			}
			const remaining =
				(await prisma.providerNativeInventoryStageItem.count({ where: { passId: "pass" } })) +
				(await prisma.providerNativeInventoryPass.count({ where: { runId: "old" } })) +
				(await prisma.providerNativeInventoryRun.count({ where: { id: "old" } }));
			expect(committed + remaining).toBe(9);
			const retried = await pruneNativeInventoryRetentionSlice(prisma, CUTOFF);
			expect(committed + retried.deletedRows).toBe(9);
			expect(
				await prisma.providerNativeInventoryRun.findUnique({ where: { id: "old" } }),
			).toBeNull();
		} finally {
			await other.$disconnect();
		}
	});
});
