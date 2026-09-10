import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	JellyfinMutationRepository,
	type MutationClaimInput,
	recoverLabelSyncMutationAttempts,
} from "../jellyfin-mutation-repository.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const base: MutationClaimInput = {
	userId: "recovery-owner",
	ruleId: "recovery-rule",
	destinationInstanceId: "recovery-destination",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 8100,
	connectionGeneration: 0,
	identityGeneration: 0,
	targetItemId: "target",
	libraryId: "library",
	intentFingerprint: "intent",
	ruleFingerprint: "rule",
	destinationTag: "managed",
};
const now = new Date("2026-09-05T00:00:00.000Z");

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-mutation-recovery-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: base.userId, username: "recovery" } });
	await prisma.serviceInstance.create({
		data: {
			id: base.destinationInstanceId,
			userId: base.userId,
			service: "JELLYFIN",
			label: "recovery",
			baseUrl: "http://127.0.0.1:8096",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: base.ruleId,
			userId: base.userId,
			name: "recovery",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: base.destinationInstanceId,
			destTagName: base.destinationTag,
		},
	});
	return prisma;
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("startup mutation recovery SQLite lifecycle", () => {
	it("maps claimed/sending/unknown, preserves terminal rows, and is idempotent", async () => {
		const prisma = await database();
		let tokenNumber = 0;
		const repository = new JellyfinMutationRepository(prisma, {
			clock: () => now,
			tokenFactory: () => `recovery-token-${++tokenNumber}`,
		});
		const claim = async (tmdbId: number) => {
			const result = await repository.claim({ ...base, tmdbId });
			expect(result.kind).toBe("acquired");
			if (result.kind !== "acquired") throw new Error("expected acquired claim");
			return result;
		};
		const inheritedClaimed = await claim(8101);
		const inheritedSending = await claim(8102);
		await repository.markSending({
			id: inheritedSending.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: inheritedSending.activeOperationKey,
			claimToken: inheritedSending.claimToken,
			sendAttemptCount: 0,
		});
		const inheritedUnknown = await claim(8103);
		await repository.markSending({
			id: inheritedUnknown.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: inheritedUnknown.activeOperationKey,
			claimToken: inheritedUnknown.claimToken,
			sendAttemptCount: 0,
		});
		await repository.completeSend({
			id: inheritedUnknown.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: inheritedUnknown.activeOperationKey,
			claimToken: inheritedUnknown.claimToken,
			sendAttemptCount: 1,
			status: "unknown",
		});
		const recon = await repository.acquireReconciliation({
			id: inheritedUnknown.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: inheritedUnknown.activeOperationKey,
		});
		expect(recon.kind).toBe("acquired");
		const terminal = await claim(8104);
		await repository.completePreSend({
			id: terminal.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: terminal.activeOperationKey,
			claimToken: terminal.claimToken,
			sendAttemptCount: 0,
			status: "noop",
			reasonCode: "already_applied",
			lastObservedAt: now,
		});
		await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(3);
		const rows = await prisma.labelSyncMutationAttempt.findMany({ orderBy: { id: "asc" } });
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: inheritedClaimed.id } }),
		).resolves.toMatchObject({
			status: "failed",
			reasonCode: "startup_before_send",
			activeOperationKey: null,
			claimToken: null,
			completedAt: now,
		});
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: inheritedSending.id } }),
		).resolves.toMatchObject({
			status: "unknown",
			reasonCode: "uncertain_send",
			claimToken: null,
			completedAt: null,
		});
		if (recon.kind !== "acquired") throw new Error("expected reconciliation handle");
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: inheritedUnknown.id } }),
		).resolves.toMatchObject({
			status: "unknown",
			claimToken: null,
			reconcileAttemptCount: 1,
			activeOperationKey: inheritedUnknown.activeOperationKey,
		});
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: terminal.id } }),
		).resolves.toMatchObject({
			status: "noop",
			reasonCode: "already_applied",
			activeOperationKey: null,
		});
		expect(rows).toHaveLength(4);
		await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(0);
	}, 120_000);

	it("rolls back all recovery CAS updates when a later CAS count fails", async () => {
		const prisma = await database();
		const repository = new JellyfinMutationRepository(prisma, {
			clock: () => now,
			tokenFactory: () => "rollback-recovery-token",
		});
		const first = await repository.claim({ ...base, tmdbId: 8201 });
		const second = await repository.claim({ ...base, tmdbId: 8202 });
		expect(first.kind).toBe("acquired");
		expect(second.kind).toBe("acquired");
		if (first.kind !== "acquired" || second.kind !== "acquired") return;
		await repository.markSending({
			id: second.id,
			userId: base.userId,
			ruleId: base.ruleId,
			destinationInstanceId: base.destinationInstanceId,
			activeOperationKey: second.activeOperationKey,
			claimToken: second.claimToken,
			sendAttemptCount: 0,
		});
		const originalTransaction = prisma.$transaction.bind(prisma);
		let updateCount = 0;
		const faultPrisma = {
			$transaction: (work: (tx: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
				originalTransaction(async (tx) => {
					const delegate = tx.labelSyncMutationAttempt;
					const wrappedDelegate = new Proxy(delegate, {
						get(target, property, receiver) {
							if (property !== "updateMany") return Reflect.get(target, property, receiver);
							return async (...args: unknown[]) => {
								updateCount += 1;
								if (updateCount === 2) return { count: 0 };
								return Reflect.apply(target.updateMany, target, args);
							};
						},
					});
					const wrappedTx = new Proxy(tx, {
						get(target, property, receiver) {
							if (property === "labelSyncMutationAttempt") return wrappedDelegate;
							return Reflect.get(target, property, receiver);
						},
					});
					return work(wrappedTx);
				}, options),
		};
		await expect(recoverLabelSyncMutationAttempts(faultPrisma, () => now)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: first.id } }),
		).resolves.toMatchObject({ status: "claimed", claimToken: first.claimToken });
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: second.id } }),
		).resolves.toMatchObject({ status: "sending", claimToken: second.claimToken });
	}, 120_000);
});
