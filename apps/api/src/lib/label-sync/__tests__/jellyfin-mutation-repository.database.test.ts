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
import { MAX_LABEL_SYNC_MUTATION_ATTEMPTS } from "../jellyfin-mutation-state.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const baseInput: MutationClaimInput = {
	userId: "repo-owner",
	ruleId: "repo-rule",
	destinationInstanceId: "repo-destination",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 9001,
	connectionGeneration: 2,
	identityGeneration: 4,
	targetItemId: "target-a",
	libraryId: "library-a",
	intentFingerprint: "intent-a",
	ruleFingerprint: "rule-a",
	destinationTag: "managed",
};

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-mutation-repository-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: baseInput.userId, username: "repo-user" } });
	await prisma.serviceInstance.create({
		data: {
			id: baseInput.destinationInstanceId,
			userId: baseInput.userId,
			service: "JELLYFIN",
			label: "repo-destination",
			baseUrl: "http://127.0.0.1:8096",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			connectionGeneration: baseInput.connectionGeneration,
			identityGeneration: baseInput.identityGeneration,
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: baseInput.ruleId,
			userId: baseInput.userId,
			name: "repo-rule",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: baseInput.destinationInstanceId,
			destTagName: baseInput.destinationTag,
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

describe("JellyfinMutationRepository SQLite lifecycle", () => {
	it("claims once, performs exact CAS lifecycle, and blocks resend after unknown", async () => {
		const prisma = await database();
		const repository = new JellyfinMutationRepository(prisma, {
			clock: () => new Date("2026-09-05T00:00:00.000Z"),
			tokenFactory: (() => {
				let counter = 0;
				return () => `token-${++counter}`;
			})(),
		});
		const claim = await repository.claim(baseInput);
		expect(claim.kind).toBe("acquired");
		if (claim.kind !== "acquired") return;
		expect(await repository.claim({ ...baseInput, intentFingerprint: "new-intent" })).toMatchObject(
			{
				kind: "already-active",
				id: claim.id,
			},
		);
		expect(
			await repository.markSending({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			}),
		).toEqual({ kind: "applied", status: "sending", sendAttemptCount: 1 });
		const sending = await prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } });
		expect(sending?.requestStartedAt).toEqual(new Date("2026-09-05T00:00:00.000Z"));
		expect(sending?.sendAttemptCount).toBe(1);
		expect(
			await repository.completeSend({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 1,
				status: "unknown",
			}),
		).toEqual({ kind: "applied", status: "unknown" });
		const unknown = await prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } });
		expect(unknown?.activeOperationKey).toBe(claim.activeOperationKey);
		expect(unknown?.claimToken).toBeNull();
		const existingUnknown = await repository.claim({
			...baseInput,
			targetItemId: "target-moved",
			libraryId: "library-moved",
		});
		expect(existingUnknown).toMatchObject({ kind: "existing-unknown", id: claim.id });
		if (existingUnknown.kind !== "existing-unknown") return;
		expect(existingUnknown.snapshot.targetItemId).toBe("target-a");
		expect("claimToken" in existingUnknown.snapshot).toBe(false);
		await prisma.serviceInstance.update({
			where: { id: baseInput.destinationInstanceId },
			data: { connectionGeneration: 3, identityGeneration: 5 },
		});
		expect(
			await repository.claim({
				...baseInput,
				connectionGeneration: 3,
				identityGeneration: 5,
				intentFingerprint: "new-intent",
			}),
		).toMatchObject({ kind: "existing-unknown", id: claim.id });
		const recon = await repository.acquireReconciliation({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
		});
		expect(recon.kind).toBe("acquired");
		if (recon.kind !== "acquired") return;
		expect(recon.snapshot.targetItemId).toBe("target-a");
		expect(recon.snapshot.reconcileAttemptCount).toBe(1);
		expect(
			await repository.acquireReconciliation({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
			}),
		).toEqual({ kind: "already-owned" });
		expect(
			await repository.completeReconciliation({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: recon.claimToken,
				reconcileAttemptCount: recon.reconcileAttemptCount,
				outcome: { status: "verified", reasonCode: "applied" },
				lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
			}),
		).toEqual({ kind: "applied", status: "verified" });
		expect(
			(await prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }))
				?.activeOperationKey,
		).toBeNull();
		const stale = await repository.completeReconciliation({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: recon.claimToken,
			reconcileAttemptCount: recon.reconcileAttemptCount,
			outcome: { status: "failed", reasonCode: "confirmed_absent" },
			lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
		});
		expect(stale).toEqual({ kind: "superseded" });
	}, 120_000);

	it("persists attempt_limit after startup clears the final reconciliation token", async () => {
		const prisma = await database();
		let tokenCount = 0;
		const repository = new JellyfinMutationRepository(prisma, {
			clock: () => new Date("2026-09-05T00:00:00.000Z"),
			tokenFactory: (() => {
				return () => `limit-token-${++tokenCount}`;
			})(),
		});
		const claim = await repository.claim(baseInput);
		expect(claim.kind).toBe("acquired");
		if (claim.kind !== "acquired") return;
		await repository.markSending({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 0,
		});
		await repository.completeSend({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 1,
			status: "unknown",
		});
		await prisma.labelSyncMutationAttempt.update({
			where: { id: claim.id },
			data: {
				reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS - 1,
				reasonCode: "reconciliation_unavailable",
			},
		});
		const final = await repository.acquireReconciliation({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
		});
		expect(final).toMatchObject({
			kind: "acquired",
			reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
		});
		if (final.kind !== "acquired") return;
		await expect(
			repository.acquireReconciliation({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
			}),
		).resolves.toEqual({ kind: "already-owned" });
		await expect(
			recoverLabelSyncMutationAttempts(prisma, () => new Date("2026-09-05T00:00:00.000Z")),
		).resolves.toBe(1);

		const limited = await repository.acquireReconciliation({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
		});
		expect(limited).toMatchObject({
			kind: "attempt-limit",
			id: claim.id,
			reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
		});
		await expect(
			repository.acquireReconciliation({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
			}),
		).resolves.toMatchObject(limited);
		expect(tokenCount).toBe(2);
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
		).resolves.toMatchObject({
			status: "unknown",
			reasonCode: "attempt_limit",
			activeOperationKey: claim.activeOperationKey,
			claimToken: null,
			reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
		});
	}, 120_000);

	it("fences an unresolved row and deletes terminal history only in parent transaction", async () => {
		const prisma = await database();
		const repository = new JellyfinMutationRepository(prisma);
		const claim = await repository.claim(baseInput);
		expect(claim.kind).toBe("acquired");
		if (claim.kind !== "acquired") return;
		await expect(
			repository.guardRuleUpdate({
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				data: { enabled: false },
			}),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			prisma.labelSyncRule.findUnique({ where: { id: baseInput.ruleId } }),
		).resolves.toMatchObject({ enabled: true });
		await repository.completePreSend({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 0,
			status: "noop",
			reasonCode: "already_applied",
			lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
		});
		await repository.guardRuleUpdate({
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			data: { enabled: false },
		});
		expect(await prisma.labelSyncMutationAttempt.count({ where: { id: claim.id } })).toBe(1);
		await repository.deleteRuleGuarded({ userId: baseInput.userId, ruleId: baseInput.ruleId });
		expect(await prisma.labelSyncMutationAttempt.count({ where: { id: claim.id } })).toBe(0);
		expect(await prisma.labelSyncRule.count({ where: { id: baseInput.ruleId } })).toBe(0);
	}, 120_000);

	it("keeps distinct stable identities separate and denies cross-owner tuples generically", async () => {
		const prisma = await database();
		const repository = new JellyfinMutationRepository(prisma, {
			tokenFactory: (() => {
				let counter = 0;
				return () => `token-${++counter}`;
			})(),
		});
		const first = await repository.claim(baseInput);
		const second = await repository.claim({ ...baseInput, tmdbId: baseInput.tmdbId + 1 });
		expect(first.kind).toBe("acquired");
		expect(second.kind).toBe("acquired");
		expect(
			await prisma.labelSyncMutationAttempt.count({ where: { userId: baseInput.userId } }),
		).toBe(2);
		await prisma.user.create({ data: { id: "other-owner", username: "other" } });
		await prisma.serviceInstance.create({
			data: {
				id: "mismatched-destination",
				userId: baseInput.userId,
				service: "JELLYFIN",
				label: "mismatch",
				baseUrl: "http://127.0.0.1:8096",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				connectionGeneration: baseInput.connectionGeneration,
				identityGeneration: baseInput.identityGeneration,
			},
		});
		await expect(repository.claim({ ...baseInput, userId: "other-owner" })).rejects.toMatchObject({
			category: "conflict",
		});
		await expect(
			repository.claim({ ...baseInput, destinationInstanceId: "mismatched-destination" }),
		).rejects.toMatchObject({ category: "conflict" });
	}, 120_000);

	it("rolls back terminal cleanup when a guarded parent callback fails", async () => {
		const prisma = await database();
		const repository = new JellyfinMutationRepository(prisma, {
			tokenFactory: () => "rollback-token",
		});
		const claim = await repository.claim(baseInput);
		expect(claim.kind).toBe("acquired");
		if (claim.kind !== "acquired") return;
		await repository.completePreSend({
			id: claim.id,
			userId: baseInput.userId,
			ruleId: baseInput.ruleId,
			destinationInstanceId: baseInput.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
			sendAttemptCount: 0,
			status: "noop",
			reasonCode: "already_applied",
			lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
		});
		await expect(
			repository.deleteRuleGuarded({
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				deleteParent: async () => {
					await prisma.labelSyncRule.update({
						where: { id: baseInput.ruleId },
						data: { enabled: false },
					});
					throw new Error("private callback failure");
				},
			}),
		).rejects.toMatchObject({ category: "dependency-failure" });
		await expect(
			prisma.labelSyncRule.findUnique({ where: { id: baseInput.ruleId } }),
		).resolves.toMatchObject({ enabled: true });
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
		).resolves.toMatchObject({ status: "noop", activeOperationKey: null });
		await prisma.user.create({ data: { id: "guard-other-owner", username: "guard-other" } });
		await expect(
			repository.guardDestinationUpdate({
				userId: "guard-other-owner",
				destinationInstanceId: baseInput.destinationInstanceId,
				data: { enabled: false },
			}),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			repository.deleteAccountGuarded({
				userId: baseInput.userId,
				deleteParent: async (tx) => {
					await tx.user.delete({ where: { id: baseInput.userId } });
					throw new Error("private account callback failure");
				},
			}),
		).rejects.toMatchObject({ category: "dependency-failure" });
		await expect(
			prisma.user.findUnique({ where: { id: baseInput.userId } }),
		).resolves.not.toBeNull();
		await expect(
			prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
		).resolves.toMatchObject({ status: "noop" });
	}, 120_000);

	it("persists every allowed outcome with exact key and token retention", async () => {
		const prisma = await database();
		let tokenNumber = 0;
		const repository = new JellyfinMutationRepository(prisma, {
			tokenFactory: () => `outcome-token-${++tokenNumber}`,
			clock: () => new Date("2026-09-05T00:00:00.000Z"),
		});
		const claimFor = async (tmdbId: number) => {
			const result = await repository.claim({ ...baseInput, tmdbId });
			expect(result.kind).toBe("acquired");
			if (result.kind !== "acquired") throw new Error("expected acquired claim");
			return result;
		};
		for (const [offset, outcome] of [
			[0, { status: "noop" as const, reasonCode: "already_applied" as const }],
			[1, { status: "failed" as const, reasonCode: "provider_unavailable" as const }],
			[2, { status: "blocked" as const, reasonCode: "identity_changed" as const }],
		] as const) {
			const claim = await claimFor(baseInput.tmdbId + 100 + offset);
			await expect(
				repository.completePreSend({
					id: claim.id,
					userId: baseInput.userId,
					ruleId: baseInput.ruleId,
					destinationInstanceId: baseInput.destinationInstanceId,
					activeOperationKey: claim.activeOperationKey,
					claimToken: claim.claimToken,
					sendAttemptCount: 0,
					...outcome,
					...(outcome.status === "noop"
						? { lastObservedAt: new Date("2026-09-05T00:00:00.000Z") }
						: {}),
				}),
			).resolves.toMatchObject({ kind: "applied", status: outcome.status });
			await expect(
				prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
			).resolves.toMatchObject({
				status: outcome.status,
				activeOperationKey: null,
				claimToken: null,
				sendAttemptCount: 0,
				requestStartedAt: null,
			});
		}
		for (const [offset, outcome] of [
			[0, { status: "verified" as const, reasonCode: "applied" as const }],
			[1, { status: "failed" as const, reasonCode: "confirmed_absent" as const }],
		] as const) {
			const claim = await claimFor(baseInput.tmdbId + 200 + offset);
			await repository.markSending({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
			await expect(
				repository.completeSend({
					id: claim.id,
					userId: baseInput.userId,
					ruleId: baseInput.ruleId,
					destinationInstanceId: baseInput.destinationInstanceId,
					activeOperationKey: claim.activeOperationKey,
					claimToken: claim.claimToken,
					sendAttemptCount: 1,
					...outcome,
					lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
				}),
			).resolves.toMatchObject({ kind: "applied", status: outcome.status });
			await expect(
				prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
			).resolves.toMatchObject({
				status: outcome.status,
				activeOperationKey: null,
				claimToken: null,
			});
		}
		for (const [offset, outcome] of [
			[0, { status: "verified" as const, reasonCode: "applied" as const }],
			[1, { status: "failed" as const, reasonCode: "confirmed_absent" as const }],
			[3, { status: "unknown" as const, reasonCode: "reconciliation_unavailable" as const }],
			[4, { status: "unknown" as const, reasonCode: "attempt_limit" as const }],
		] as const) {
			const claim = await claimFor(baseInput.tmdbId + 300 + offset);
			await repository.markSending({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
			await repository.completeSend({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 1,
				status: "unknown",
			});
			const acquired = await repository.acquireReconciliation({
				id: claim.id,
				userId: baseInput.userId,
				ruleId: baseInput.ruleId,
				destinationInstanceId: baseInput.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
			});
			expect(acquired.kind).toBe("acquired");
			if (acquired.kind !== "acquired") throw new Error("expected reconciliation claim");
			await expect(
				repository.completeReconciliation({
					id: claim.id,
					userId: baseInput.userId,
					ruleId: baseInput.ruleId,
					destinationInstanceId: baseInput.destinationInstanceId,
					activeOperationKey: claim.activeOperationKey,
					claimToken: acquired.claimToken,
					reconcileAttemptCount: acquired.reconcileAttemptCount,
					outcome,
					...(outcome.status === "verified" || outcome.status === "failed"
						? { lastObservedAt: new Date("2026-09-05T00:00:00.000Z") }
						: {}),
				}),
			).resolves.toMatchObject({ kind: "applied", status: outcome.status });
			await expect(
				prisma.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
			).resolves.toMatchObject({
				status: outcome.status,
				claimToken: null,
				reconcileAttemptCount: 1,
				activeOperationKey: outcome.status === "unknown" ? claim.activeOperationKey : null,
			});
			if (outcome.status === "unknown") {
				await expect(
					repository.completeReconciliation({
						id: claim.id,
						userId: baseInput.userId,
						ruleId: baseInput.ruleId,
						destinationInstanceId: baseInput.destinationInstanceId,
						activeOperationKey: claim.activeOperationKey,
						claimToken: acquired.claimToken,
						reconcileAttemptCount: acquired.reconcileAttemptCount,
						outcome: { status: "verified", reasonCode: "applied" },
						lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
					}),
				).resolves.toEqual({ kind: "superseded" });
			}
		}
	}, 120_000);
});
