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
import { prepareRestoredLabelSyncMutationAttempt } from "../jellyfin-mutation-restore.js";
import { parseLabelSyncMutationAttempt } from "../jellyfin-mutation-state.js";

const fixtures: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const now = new Date("2026-10-07T00:00:00.000Z");
const input: MutationClaimInput = {
	userId: "held-owner",
	ruleId: "held-rule",
	destinationInstanceId: "held-destination",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 101,
	connectionGeneration: 0,
	identityGeneration: 0,
	targetItemId: "held-item",
	libraryId: "held-library",
	intentFingerprint: "held-intent",
	ruleFingerprint: "held-rule-fingerprint",
	destinationTag: "managed",
};
async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-mutation-restored-held-"));
	const path = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(path);
	fixtures.push({ directory, prisma });
	await prisma.user.create({ data: { id: input.userId, username: "held-fixture" } });
	await prisma.serviceInstance.create({
		data: {
			id: input.destinationInstanceId,
			userId: input.userId,
			service: "JELLYFIN",
			label: "fixture",
			baseUrl: "http://127.0.0.1:8096",
			encryptedApiKey: "fixture",
			encryptionIv: "fixture",
			identityStatus: "VERIFIED",
			identityKind: "JELLYFIN_SERVER_ID",
			expectedIdentity: "held-server",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: input.ruleId,
			userId: input.userId,
			name: "fixture",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: input.destinationInstanceId,
			destTagName: input.destinationTag,
		},
	});
	let tokens = 0;
	const repository = new JellyfinMutationRepository(prisma, {
		clock: () => now,
		tokenFactory: () => `held-claim-${++tokens}`,
	});
	return { prisma, repository };
}
async function heldFixture(
	original: "claimed" | "sending" | "unknown" = "claimed",
	originalReconcileCount = 0,
) {
	const fixture = await database();
	const claim = await fixture.repository.claim(input);
	if (claim.kind !== "acquired") throw new Error("fixture claim not acquired");
	const handle = {
		id: claim.id,
		activeOperationKey: claim.activeOperationKey,
		userId: input.userId,
		ruleId: input.ruleId,
		destinationInstanceId: input.destinationInstanceId,
	};
	if (original !== "claimed")
		await fixture.repository.markSending({
			id: claim.id,
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 0,
		});
	if (original === "unknown")
		await fixture.repository.completeSend({
			id: claim.id,
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 1,
			status: "unknown",
		});
	if (originalReconcileCount > 0)
		await fixture.prisma.labelSyncMutationAttempt.update({
			where: { id: claim.id },
			data: { reconcileAttemptCount: originalReconcileCount },
		});
	const source = await fixture.prisma.labelSyncMutationAttempt.findUniqueOrThrow({
		where: { id: claim.id },
	});
	const held = prepareRestoredLabelSyncMutationAttempt(source);
	if (original === "claimed")
		await fixture.repository.markSending({
			...handle,
			claimToken: claim.claimToken,
			sendAttemptCount: 0,
		});
	// Use the same DateTime representation as the real Prisma restore writer.
	await fixture.prisma.labelSyncMutationAttempt.update({
		where: { id: claim.id },
		data: { sendAttemptCount: held.sendAttemptCount, requestStartedAt: held.requestStartedAt },
	});
	await fixture.prisma.$executeRawUnsafe(
		'UPDATE "label_sync_mutation_attempts" SET "status" = ?, "reasonCode" = ?, "claimToken" = NULL, "restoreEvidence" = ? WHERE "id" = ?',
		held.status,
		held.reasonCode,
		held.restoreEvidence,
		claim.id,
	);
	return { ...fixture, handle, held };
}
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.prisma.$disconnect();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

describe("persisted restored-held recovery", { timeout: 30_000 }, () => {
	it("upgrades a populated pre-evidence table without changing native attempts or parent connections", async () => {
		const { prisma, repository } = await database();
		const claim = await repository.claim(input);
		if (claim.kind !== "acquired") throw new Error("expected native claim");
		const before = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({
			where: { id: claim.id },
		});
		const parents = await prisma.serviceInstance.findMany();
		// The task's only schema change is this nullable column. Removing it on
		// this disposable populated fixture reproduces the exact old table shape.
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "label_sync_mutation_attempts" DROP COLUMN "restoreEvidence"',
		);
		const fixture = fixtures.at(-1)!;
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${join(fixture.directory, "test.db")}` },
			stdio: "ignore",
		});
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: claim.id } }),
		).toEqual(before);
		expect(await prisma.serviceInstance.findMany()).toEqual(parents);
	});
	it("adds a nullable evidence column without assigning evidence to native work", async () => {
		const { prisma, repository } = await database();
		const columns = await prisma.$queryRawUnsafe<Array<{ name: string; notnull: number }>>(
			'PRAGMA table_info("label_sync_mutation_attempts")',
		);
		expect(Number(columns.find((column) => column.name === "restoreEvidence")?.notnull)).toBe(0);
		const claim = await repository.claim(input);
		if (claim.kind !== "acquired") throw new Error("expected native claim");
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: claim.id } }),
		).toMatchObject({ restoreEvidence: null, status: "claimed" });
	});
	it.each(["claimed", "sending", "unknown"] as const)(
		"retains restored %s evidence and hold across two startups",
		async (original) => {
			const { prisma, held, handle } = await heldFixture(original);
			await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(0);
			await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(0);
			expect(
				await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: handle.id } }),
			).toMatchObject({
				status: "restored-held",
				activeOperationKey: held.activeOperationKey,
				restoreEvidence: held.restoreEvidence,
				sendAttemptCount: held.sendAttemptCount,
				requestStartedAt: held.requestStartedAt,
				claimToken: null,
			});
		},
	);
	it("does not let a normal claim resend held work", async () => {
		const { repository, held } = await heldFixture();
		await expect(repository.claim(input)).resolves.toMatchObject({
			kind: "existing-held",
			status: "restored-held",
			snapshot: { restoreEvidence: held.restoreEvidence },
		});
	});
	it("fences rule, destination and account changes while a restored hold exists", async () => {
		const { repository } = await heldFixture();
		await expect(
			repository.guardRuleUpdate({
				userId: input.userId,
				ruleId: input.ruleId,
				data: { name: "changed" },
			}),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			repository.guardDestinationUpdate({
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
				data: { label: "changed" },
			}),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			repository.deleteRuleGuarded({ userId: input.userId, ruleId: input.ruleId }),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			repository.deleteDestinationGuarded({
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
			}),
		).rejects.toMatchObject({ category: "conflict" });
		let called = false;
		await expect(
			repository.withGuardedAccountDeletion({ userId: input.userId }, async () => {
				called = true;
			}),
		).rejects.toMatchObject({ category: "conflict" });
		expect(called).toBe(false);
	});
	it("owns one fresh read claim, clears it on startup, and rejects its stale completion", async () => {
		const { repository, prisma, handle, held } = await heldFixture();
		const first = await repository.acquireReconciliation(handle);
		expect(first.kind).toBe("acquired");
		if (first.kind !== "acquired") throw new Error("expected read claim");
		await expect(repository.acquireReconciliation(handle)).resolves.toEqual({
			kind: "already-owned",
		});
		await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(1);
		const second = await repository.acquireReconciliation(handle);
		if (second.kind !== "acquired") throw new Error("expected replacement read claim");
		expect(second.claimToken).not.toBe(first.claimToken);
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: first.snapshot,
				claimToken: first.claimToken,
				reconcileAttemptCount: first.reconcileAttemptCount,
				outcome: { status: "verified", reasonCode: "applied" },
				lastObservedAt: now,
			}),
		).resolves.toEqual({ kind: "superseded" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: handle.id } }),
		).toMatchObject({
			status: "restored-held",
			restoreEvidence: held.restoreEvidence,
			reconcileAttemptCount: 2,
			claimToken: second.claimToken,
		});
	});
	it.each(["claimed", "sending", "unknown"] as const)(
		"observes desired state for restored %s without fabricating a send acknowledgement",
		async (original) => {
			const { repository, prisma, handle, held } = await heldFixture(original);
			const acquired = await repository.acquireReconciliation(handle);
			if (acquired.kind !== "acquired") throw new Error("expected read claim");
			await expect(
				repository.completeReconciliation({
					...handle,
					snapshot: acquired.snapshot,
					claimToken: acquired.claimToken,
					reconcileAttemptCount: acquired.reconcileAttemptCount,
					outcome: { status: "verified", reasonCode: "applied" },
					lastObservedAt: now,
				}),
			).resolves.toMatchObject({ kind: "applied", status: "reconciled" });
			const terminal = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({
				where: { id: handle.id },
			});
			expect(terminal).toMatchObject({
				status: "reconciled",
				reasonCode: "desired_state_observed",
				activeOperationKey: null,
				claimToken: null,
				completedAt: now,
				restoreEvidence: held.restoreEvidence,
				sendAttemptCount: held.sendAttemptCount,
				requestStartedAt: held.requestStartedAt,
			});
			expect(() => parseLabelSyncMutationAttempt(terminal)).not.toThrow();
			await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(0);
			await expect(
				repository.guardRuleUpdate({
					userId: input.userId,
					ruleId: input.ruleId,
					data: { name: "changed" },
				}),
			).resolves.toBeUndefined();
			await expect(
				repository.withGuardedAccountDeletion(
					{ userId: input.userId },
					async (tx) =>
						await tx.labelSyncMutationAttempt.count({ where: { userId: input.userId } }),
				),
			).resolves.toBe(0);
		},
	);
	it("keeps missing evidence held and refuses an absence outcome", async () => {
		const { repository, prisma, handle, held } = await heldFixture();
		const acquired = await repository.acquireReconciliation(handle);
		if (acquired.kind !== "acquired") throw new Error("expected read claim");
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: acquired.snapshot,
				claimToken: acquired.claimToken,
				reconcileAttemptCount: acquired.reconcileAttemptCount,
				outcome: { status: "failed", reasonCode: "confirmed_absent" },
				lastObservedAt: now,
			}),
		).rejects.toMatchObject({ category: "invalid-input" });
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: acquired.snapshot,
				claimToken: acquired.claimToken,
				reconcileAttemptCount: acquired.reconcileAttemptCount,
				outcome: { status: "unknown", reasonCode: "reconciliation_unavailable" },
				lastObservedAt: now,
			}),
		).resolves.toMatchObject({ kind: "applied", status: "restored-held" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: handle.id } }),
		).toMatchObject({
			status: "restored-held",
			restoreEvidence: held.restoreEvidence,
			activeOperationKey: held.activeOperationKey,
			claimToken: null,
			completedAt: null,
			sendAttemptCount: 0,
			requestStartedAt: null,
		});
	});
	it("admits exactly one concurrent observation owner", async () => {
		const { repository, handle } = await heldFixture();
		const results = await Promise.all([
			repository.acquireReconciliation(handle),
			repository.acquireReconciliation(handle),
		]);
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "already-owned")).toHaveLength(1);
	});
	it("blocks physical alias claims across owners without exposing the held owner", async () => {
		const { prisma, repository } = await heldFixture();
		await prisma.user.create({ data: { id: "alias-owner", username: "alias-fixture" } });
		await prisma.serviceInstance.create({
			data: {
				id: "alias-destination",
				userId: "alias-owner",
				service: "JELLYFIN",
				label: "fixture",
				baseUrl: "http://127.0.0.1:8096",
				encryptedApiKey: "fixture",
				encryptionIv: "fixture",
				identityStatus: "VERIFIED",
				identityKind: "JELLYFIN_SERVER_ID",
				expectedIdentity: "held-server",
			},
		});
		await prisma.labelSyncRule.create({
			data: {
				id: "alias-rule",
				userId: "alias-owner",
				name: "fixture",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: "alias-destination",
				destTagName: "other",
			},
		});
		await expect(
			repository.claimPhysicalTarget(
				{
					...input,
					userId: "alias-owner",
					ruleId: "alias-rule",
					destinationInstanceId: "alias-destination",
					destinationTag: "other",
				},
				"held-server",
			),
		).resolves.toEqual({ kind: "target-busy" });
		expect(await prisma.labelSyncMutationAttempt.count()).toBe(1);
	});
	it("does not accept another owner's reconciliation handle", async () => {
		const { repository, handle } = await heldFixture();
		await expect(
			repository.acquireReconciliation({ ...handle, userId: "other-owner" }),
		).resolves.toEqual({ kind: "not-reconcilable" });
	});
	it("refuses a stored operation key that no longer matches the held identity", async () => {
		const { repository, prisma, handle } = await heldFixture();
		await prisma.labelSyncMutationAttempt.update({
			where: { id: handle.id },
			data: { activeOperationKey: "mismatched-key" },
		});
		await expect(
			repository.acquireReconciliation({ ...handle, activeOperationKey: "mismatched-key" }),
		).rejects.toMatchObject({ category: "invalid-state" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: handle.id } }),
		).toMatchObject({ claimToken: null, reconcileAttemptCount: 0 });
	});
	it("rejects changed captured evidence rather than releasing a held target", async () => {
		const { repository, prisma, handle, held } = await heldFixture();
		const acquired = await repository.acquireReconciliation(handle);
		if (acquired.kind !== "acquired") throw new Error("expected read claim");
		await prisma.labelSyncMutationAttempt.update({
			where: { id: handle.id },
			data: { intentFingerprint: "changed-during-provider-read" },
		});
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: acquired.snapshot,
				claimToken: acquired.claimToken,
				reconcileAttemptCount: acquired.reconcileAttemptCount,
				outcome: { status: "verified", reasonCode: "applied" },
				lastObservedAt: now,
			}),
		).resolves.toEqual({ kind: "superseded" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: handle.id } }),
		).toMatchObject({
			status: "restored-held",
			activeOperationKey: held.activeOperationKey,
			restoreEvidence: held.restoreEvidence,
		});
	});
	it("keeps imported exhausted checks honest, held and valid across restart", async () => {
		const { repository, prisma, handle, held } = await heldFixture("unknown", 1_000_000);
		await expect(repository.acquireReconciliation(handle)).resolves.toMatchObject({
			kind: "attempt-limit",
		});
		const stored = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({
			where: { id: handle.id },
		});
		expect(stored).toMatchObject({
			status: "restored-held",
			reasonCode: "restore_uncertain",
			reconcileAttemptCount: 1_000_000,
			activeOperationKey: held.activeOperationKey,
			claimToken: null,
		});
		expect(() => parseLabelSyncMutationAttempt(stored)).not.toThrow();
		await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).resolves.toBe(0);
	});
	it("rejects future restore provenance before any startup recovery is committed", async () => {
		const { repository, prisma, handle } = await heldFixture();
		const native = await repository.claim({ ...input, tmdbId: 102, targetItemId: "another-item" });
		if (native.kind !== "acquired") throw new Error("expected native claim");
		await prisma.$executeRawUnsafe(
			'UPDATE "label_sync_mutation_attempts" SET "restoreEvidence" = ? WHERE "id" = ?',
			'{"version":2}',
			handle.id,
		);
		const before = await prisma.labelSyncMutationAttempt.findMany({ orderBy: { id: "asc" } });
		await expect(recoverLabelSyncMutationAttempts(prisma, () => now)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(await prisma.labelSyncMutationAttempt.findMany({ orderBy: { id: "asc" } })).toEqual(
			before,
		);
	});
});
