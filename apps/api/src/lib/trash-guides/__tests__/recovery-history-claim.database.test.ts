import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPgClient, createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClientInstance } from "../../prisma.js";
import {
	claimRollbackRecoveryGroup,
	claimUndeployRecoveryGroup,
} from "../recovery-history-claim.js";

const databaseUrl = process.env.RECOVERY_CLAIM_DATABASE_URL;
const isPostgresDatabase = Boolean(databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl));
const runDatabaseTests =
	process.env.INTEGRATION_TESTS === "1" && databaseUrl ? describe : describe.skip;

const runId = randomUUID();
const ids = {
	user: `recovery-claim-user-${runId}`,
	instance: `recovery-claim-instance-${runId}`,
	template: `recovery-claim-template-${runId}`,
	backup: `recovery-claim-backup-${runId}`,
	syncA: `recovery-claim-sync-a-${runId}`,
	syncB: `recovery-claim-sync-b-${runId}`,
	deployment: `recovery-claim-deployment-${runId}`,
	deploymentLater: `recovery-claim-deployment-z-${runId}`,
};
const syncRecoveryStateSelect = {
	id: true,
	userId: true,
	instanceId: true,
	templateId: true,
	backupId: true,
	status: true,
	rolledBack: true,
	rollbackStatus: true,
	rollbackAttemptedAt: true,
	rollbackProgress: true,
} as const;
const deploymentRecoveryStateSelect = {
	id: true,
	userId: true,
	instanceId: true,
	templateId: true,
	backupId: true,
	status: true,
	rolledBack: true,
	undeployStatus: true,
	undeployAttemptedAt: true,
	undeployProgress: true,
} as const;

runDatabaseTests("recovery history group claim Prisma contract", () => {
	let prisma: PrismaClientInstance;
	let peerPrisma: PrismaClientInstance;
	let cleanupDatabaseClient: (() => Promise<void>) | undefined;
	let cleanupPeerDatabaseClient: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("RECOVERY_CLAIM_DATABASE_URL is required");
		if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
			const client = await createTestPgClient(databaseUrl);
			const peerClient = await createTestPgClient(databaseUrl);
			prisma = client.prisma;
			peerPrisma = peerClient.prisma;
			cleanupDatabaseClient = client.cleanup;
			cleanupPeerDatabaseClient = peerClient.cleanup;
		} else {
			const sqlitePath = databaseUrl.replace(/^file:/, "");
			prisma = createTestPrismaClient(sqlitePath);
			peerPrisma = createTestPrismaClient(sqlitePath);
			cleanupDatabaseClient = () => prisma.$disconnect();
			cleanupPeerDatabaseClient = () => peerPrisma.$disconnect();
		}

		await prisma.user.create({ data: { id: ids.user, username: ids.user } });
		await prisma.serviceInstance.create({
			data: {
				id: ids.instance,
				userId: ids.user,
				service: "SONARR",
				label: "Recovery claim Sonarr",
				baseUrl: "http://recovery-claim-sonarr.test:8989",
				encryptedApiKey: "synthetic-encrypted-api-key",
				encryptionIv: "synthetic-encryption-iv",
			},
		});
		await prisma.trashTemplate.create({
			data: {
				id: ids.template,
				userId: ids.user,
				name: "Recovery claim template",
				serviceType: "SONARR",
				configData: "{}",
			},
		});
		await prisma.trashBackup.create({
			data: {
				id: ids.backup,
				instanceId: ids.instance,
				userId: ids.user,
				backupData: "{}",
			},
		});
		await prisma.trashSyncHistory.createMany({
			data: [ids.syncA, ids.syncB].map((id) => ({
				id,
				instanceId: ids.instance,
				templateId: ids.template,
				userId: ids.user,
				syncType: "MANUAL",
				status: "SUCCESS",
				appliedConfigs: "[]",
				backupId: ids.backup,
			})),
		});
		await prisma.templateDeploymentHistory.createMany({
			data: [ids.deployment, ids.deploymentLater].map((id) => ({
				id,
				templateId: ids.template,
				instanceId: ids.instance,
				userId: ids.user,
				deployedBy: ids.user,
				status: "SUCCESS",
				backupId: ids.backup,
				canRollback: true,
			})),
		});
	});

	beforeEach(async () => {
		await prisma.$transaction([
			prisma.trashSyncHistory.updateMany({
				where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
				data: {
					status: "SUCCESS",
					backupId: ids.backup,
					rolledBack: false,
					rolledBackAt: null,
					rollbackStatus: null,
					rollbackAttemptedAt: null,
					rollbackProgress: null,
				},
			}),
			prisma.templateDeploymentHistory.updateMany({
				where: {
					id: { in: [ids.deployment, ids.deploymentLater] },
					userId: ids.user,
				},
				data: {
					status: "SUCCESS",
					backupId: ids.backup,
					rolledBack: false,
					rolledBackAt: null,
					rolledBackBy: null,
					undeployStatus: null,
					undeployAttemptedAt: null,
					undeployProgress: null,
				},
			}),
		]);
	});

	afterAll(async () => {
		if (prisma) {
			await prisma.templateDeploymentHistory.deleteMany({
				where: {
					id: { in: [ids.deployment, ids.deploymentLater] },
					userId: ids.user,
				},
			});
			await prisma.trashSyncHistory.deleteMany({
				where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			});
			await prisma.trashBackup.deleteMany({ where: { id: ids.backup, userId: ids.user } });
			await prisma.trashTemplate.deleteMany({ where: { id: ids.template, userId: ids.user } });
			await prisma.serviceInstance.deleteMany({
				where: { id: ids.instance, userId: ids.user },
			});
			await prisma.user.deleteMany({ where: { id: ids.user } });
		}
		await cleanupPeerDatabaseClient?.();
		await cleanupDatabaseClient?.();
	});

	it("rolls back earlier peer claims when a later deployment CAS misses", async () => {
		const syncStates = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: syncRecoveryStateSelect,
		});
		const deploymentStates = await prisma.templateDeploymentHistory.findMany({
			where: {
				id: { in: [ids.deployment, ids.deploymentLater] },
				userId: ids.user,
			},
			orderBy: { id: "asc" },
			select: deploymentRecoveryStateSelect,
		});
		await prisma.templateDeploymentHistory.update({
			where: { id: ids.deploymentLater },
			data: {
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: new Date("2026-08-08T11:00:00.000Z"),
			},
		});

		const claimed = await claimRollbackRecoveryGroup(
			prisma,
			ids.user,
			syncStates,
			deploymentStates,
			new Date("2026-08-08T12:00:00.000Z"),
		);

		expect(claimed).toBe(false);
		expect(
			await prisma.templateDeploymentHistory.findMany({
				where: { id: { in: [ids.deployment, ids.deploymentLater] }, userId: ids.user },
				orderBy: { id: "asc" },
				select: { id: true, undeployStatus: true, undeployAttemptedAt: true },
			}),
		).toEqual([
			{ id: ids.deployment, undeployStatus: null, undeployAttemptedAt: null },
			{
				id: ids.deploymentLater,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: new Date("2026-08-08T11:00:00.000Z"),
			},
		]);
		const syncRows = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: { rollbackStatus: true, rollbackAttemptedAt: true },
		});
		expect(syncRows).toEqual([
			{ rollbackStatus: null, rollbackAttemptedAt: null },
			{ rollbackStatus: null, rollbackAttemptedAt: null },
		]);
	});

	it("rolls back an undeploy target claim when a later sync CAS misses", async () => {
		const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
			where: { id: ids.deployment, userId: ids.user },
			select: deploymentRecoveryStateSelect,
		});
		const syncStates = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: syncRecoveryStateSelect,
		});
		await prisma.trashSyncHistory.updateMany({
			where: { id: ids.syncB, userId: ids.user },
			data: {
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: new Date("2026-08-08T11:30:00.000Z"),
			},
		});

		const claimed = await claimUndeployRecoveryGroup(
			prisma,
			ids.user,
			deploymentState,
			syncStates,
			new Date("2026-08-08T12:00:00.000Z"),
		);

		expect(claimed).toBe(false);
		expect(
			await prisma.templateDeploymentHistory.findFirstOrThrow({
				where: { id: ids.deployment, userId: ids.user },
				select: { undeployStatus: true, undeployAttemptedAt: true },
			}),
		).toEqual({ undeployStatus: null, undeployAttemptedAt: null });
		expect(
			await prisma.trashSyncHistory.findFirstOrThrow({
				where: { id: ids.syncA, userId: ids.user },
				select: { rollbackStatus: true, rollbackAttemptedAt: true },
			}),
		).toEqual({ rollbackStatus: null, rollbackAttemptedAt: null });
	});

	it("rejects a claim when a snapshotted sync status changes", async () => {
		const syncStates = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: syncRecoveryStateSelect,
		});
		const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
			where: { id: ids.deployment, userId: ids.user },
			select: deploymentRecoveryStateSelect,
		});
		await prisma.trashSyncHistory.update({
			where: { id: ids.syncB },
			data: { status: "FAILED" },
		});

		await expect(
			claimRollbackRecoveryGroup(
				prisma,
				ids.user,
				syncStates,
				[deploymentState],
				new Date("2026-08-08T12:00:00.000Z"),
			),
		).resolves.toBe(false);
		expect(
			await prisma.templateDeploymentHistory.findUniqueOrThrow({
				where: { id: ids.deployment },
				select: { undeployStatus: true },
			}),
		).toEqual({ undeployStatus: null });
	});

	it("rejects a claim when a snapshotted backup grouping changes", async () => {
		const syncStates = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: syncRecoveryStateSelect,
		});
		const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
			where: { id: ids.deployment, userId: ids.user },
			select: deploymentRecoveryStateSelect,
		});
		await prisma.templateDeploymentHistory.update({
			where: { id: ids.deployment },
			data: { backupId: null },
		});

		await expect(
			claimUndeployRecoveryGroup(
				prisma,
				ids.user,
				deploymentState,
				syncStates,
				new Date("2026-08-08T12:00:00.000Z"),
			),
		).resolves.toBe(false);
		expect(
			await prisma.trashSyncHistory.findMany({
				where: { id: { in: [ids.syncA, ids.syncB] } },
				select: { rollbackStatus: true },
			}),
		).toEqual([{ rollbackStatus: null }, { rollbackStatus: null }]);
	});

	it.runIf(isPostgresDatabase)(
		"allows exactly one concurrent claimant across two PostgreSQL clients",
		async () => {
			const syncStates = await prisma.trashSyncHistory.findMany({
				where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
				orderBy: { id: "asc" },
				select: syncRecoveryStateSelect,
			});
			const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
				where: { id: ids.deployment, userId: ids.user },
				select: deploymentRecoveryStateSelect,
			});
			const attemptedAtA = new Date("2026-08-08T12:30:00.000Z");
			const attemptedAtB = new Date("2026-08-08T12:31:00.000Z");

			const results = await Promise.all([
				claimRollbackRecoveryGroup(prisma, ids.user, syncStates, [deploymentState], attemptedAtA),
				claimRollbackRecoveryGroup(
					peerPrisma,
					ids.user,
					syncStates,
					[deploymentState],
					attemptedAtB,
				),
			]);

			expect(results.filter(Boolean)).toHaveLength(1);
			const winningAttemptedAt = results[0] ? attemptedAtA : attemptedAtB;
			expect(
				await prisma.trashSyncHistory.findMany({
					where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
					orderBy: { id: "asc" },
					select: { rollbackStatus: true, rollbackAttemptedAt: true },
				}),
			).toEqual([
				{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: winningAttemptedAt },
				{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: winningAttemptedAt },
			]);
			expect(
				await prisma.templateDeploymentHistory.findFirstOrThrow({
					where: { id: ids.deployment, userId: ids.user },
					select: { undeployStatus: true, undeployAttemptedAt: true },
				}),
			).toEqual({ undeployStatus: "IN_PROGRESS", undeployAttemptedAt: winningAttemptedAt });
		},
	);

	it.runIf(isPostgresDatabase)(
		"serializes concurrent undeploy and rollback entrypoints with opposite input order",
		async () => {
			const syncStates = await prisma.trashSyncHistory.findMany({
				where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
				orderBy: { id: "asc" },
				select: syncRecoveryStateSelect,
			});
			const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
				where: { id: ids.deployment, userId: ids.user },
				select: deploymentRecoveryStateSelect,
			});
			const undeployAttemptedAt = new Date("2026-08-08T12:40:00.000Z");
			const rollbackAttemptedAt = new Date("2026-08-08T12:41:00.000Z");

			const results = await Promise.all([
				claimUndeployRecoveryGroup(
					prisma,
					ids.user,
					deploymentState,
					[...syncStates].reverse(),
					undeployAttemptedAt,
				),
				claimRollbackRecoveryGroup(
					peerPrisma,
					ids.user,
					syncStates,
					[deploymentState],
					rollbackAttemptedAt,
				),
			]);

			expect(results.filter(Boolean)).toHaveLength(1);
			const winningAttemptedAt = results[0] ? undeployAttemptedAt : rollbackAttemptedAt;
			expect(
				await prisma.templateDeploymentHistory.findUniqueOrThrow({
					where: { id: ids.deployment },
					select: { undeployStatus: true, undeployAttemptedAt: true },
				}),
			).toEqual({ undeployStatus: "IN_PROGRESS", undeployAttemptedAt: winningAttemptedAt });
			expect(
				await prisma.trashSyncHistory.findMany({
					where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
					orderBy: { id: "asc" },
					select: { rollbackStatus: true, rollbackAttemptedAt: true },
				}),
			).toEqual([
				{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: winningAttemptedAt },
				{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: winningAttemptedAt },
			]);
		},
	);

	it("claims an undeploy target and every paired sync with one timestamp", async () => {
		const syncStates = await prisma.trashSyncHistory.findMany({
			where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
			orderBy: { id: "asc" },
			select: syncRecoveryStateSelect,
		});
		const deploymentState = await prisma.templateDeploymentHistory.findFirstOrThrow({
			where: { id: ids.deployment, userId: ids.user },
			select: deploymentRecoveryStateSelect,
		});
		const attemptedAt = new Date("2026-08-08T13:00:00.000Z");

		const claimed = await claimUndeployRecoveryGroup(
			prisma,
			ids.user,
			deploymentState,
			syncStates,
			attemptedAt,
		);

		expect(claimed).toBe(true);
		expect(
			await prisma.templateDeploymentHistory.findUniqueOrThrow({
				where: { id: ids.deployment },
				select: { undeployStatus: true, undeployAttemptedAt: true },
			}),
		).toEqual({ undeployStatus: "IN_PROGRESS", undeployAttemptedAt: attemptedAt });
		expect(
			await prisma.trashSyncHistory.findMany({
				where: { id: { in: [ids.syncA, ids.syncB] }, userId: ids.user },
				orderBy: { id: "asc" },
				select: { rollbackStatus: true, rollbackAttemptedAt: true },
			}),
		).toEqual([
			{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: attemptedAt },
			{ rollbackStatus: "IN_PROGRESS", rollbackAttemptedAt: attemptedAt },
		]);
	});
});
