/**
 * Prisma persistence contract for the durable deployment-state foundation.
 *
 * These fields are coordination state for rollback, undeploy, and score
 * operations. Exercise the generated client against the schema-backed test
 * database so a missing schema column or generated-client field fails here.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { restoreDatabase } from "../../backup/backup-database.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const TEST_DB_PATH = path.resolve(import.meta.dirname, "../../../../prisma/test-integration.db");

const ids = {
	user: "trash-state-contract-user",
	instance: "trash-state-contract-instance",
	template: "trash-state-contract-template",
	syncHistory: "trash-state-contract-sync-history",
	mapping: "trash-state-contract-mapping",
	override: "trash-state-contract-override",
	deployment: "trash-state-contract-deployment",
	snapshot: "trash-state-contract-snapshot",
};

(RUN_DB_TESTS ? describe : describe.skip)("durable deployment-state Prisma contract", () => {
	let prisma: PrismaClient;

	beforeEach(async () => {
		prisma = createTestPrismaClient(TEST_DB_PATH);
		await prisma.templateDeploymentHistory.deleteMany({ where: { id: ids.deployment } });
		await prisma.instanceQualityProfileOverride.deleteMany({ where: { id: ids.override } });
		await prisma.templateQualityProfileMapping.deleteMany({ where: { id: ids.mapping } });
		await prisma.trashSyncHistory.deleteMany({ where: { id: ids.syncHistory } });
		await prisma.trashBackup.deleteMany({ where: { id: ids.snapshot } });
		await prisma.trashTemplate.deleteMany({ where: { id: ids.template } });
		await prisma.serviceInstance.deleteMany({ where: { id: ids.instance } });
		await prisma.user.deleteMany({ where: { id: ids.user } });

		await prisma.user.create({ data: { id: ids.user, username: ids.user } });
		await prisma.serviceInstance.create({
			data: {
				id: ids.instance,
				userId: ids.user,
				service: "RADARR",
				label: "Deployment state contract instance",
				baseUrl: "http://localhost:7878",
				encryptedApiKey: "encrypted-api-key",
				encryptionIv: "encryption-iv",
			},
		});
		await prisma.trashTemplate.create({
			data: {
				id: ids.template,
				userId: ids.user,
				name: "Deployment state contract template",
				serviceType: "RADARR",
				configData: "{}",
			},
		});
	});

	afterEach(async () => {
		await prisma.templateDeploymentHistory.deleteMany({ where: { id: ids.deployment } });
		await prisma.instanceQualityProfileOverride.deleteMany({ where: { id: ids.override } });
		await prisma.templateQualityProfileMapping.deleteMany({ where: { id: ids.mapping } });
		await prisma.trashSyncHistory.deleteMany({ where: { id: ids.syncHistory } });
		await prisma.trashBackup.deleteMany({ where: { id: ids.snapshot } });
		await prisma.trashTemplate.deleteMany({ where: { id: ids.template } });
		await prisma.serviceInstance.deleteMany({ where: { id: ids.instance } });
		await prisma.user.deleteMany({ where: { id: ids.user } });
		await prisma.$disconnect();
	});

	it("creates, updates, and reads every durable deployment-state field", async () => {
		const rollbackStartedAt = new Date("2026-08-09T13:00:00.000Z");
		const rollbackCompletedAt = new Date("2026-08-09T13:01:00.000Z");
		const undeployStartedAt = new Date("2026-08-09T14:00:00.000Z");
		const undeployCompletedAt = new Date("2026-08-09T14:01:00.000Z");

		const syncCreate = {
			id: ids.syncHistory,
			instanceId: ids.instance,
			userId: ids.user,
			syncType: "MANUAL",
			status: "SUCCESS",
			appliedConfigs: "[]",
			rollbackStatus: "IN_PROGRESS",
			rollbackAttemptedAt: rollbackStartedAt,
			rollbackProgress: '[{"step":"restore","status":"PENDING"}]',
		} satisfies Prisma.TrashSyncHistoryUncheckedCreateInput;
		const syncUpdate = {
			rollbackStatus: "COMPLETED",
			rollbackAttemptedAt: rollbackCompletedAt,
			rollbackProgress: '[{"step":"restore","status":"COMPLETED"}]',
		} satisfies Prisma.TrashSyncHistoryUpdateInput;

		const mappingCreate = {
			id: ids.mapping,
			templateId: ids.template,
			instanceId: ids.instance,
			qualityProfileId: 42,
			qualityProfileName: "HD-1080p",
			connectionGeneration: 3,
			connectionStateToken: "state-before-deploy",
			managedCustomFormats: '[{"id":1001}]',
			managedCustomFormatsCaptured: false,
		} satisfies Prisma.TemplateQualityProfileMappingUncheckedCreateInput;
		const mappingUpdate = {
			connectionGeneration: 4,
			connectionStateToken: "state-after-deploy",
			managedCustomFormats: '[{"id":1001},{"id":1002}]',
			managedCustomFormatsCaptured: true,
		} satisfies Prisma.TemplateQualityProfileMappingUpdateInput;

		const overrideCreate = {
			id: ids.override,
			instanceId: ids.instance,
			qualityProfileId: 42,
			customFormatId: 1001,
			score: 15,
			status: "PENDING",
			intentOperation: "SET_SCORE",
			intendedScore: 15,
			userId: ids.user,
			connectionGeneration: 3,
			connectionStateToken: "state-before-score",
		} satisfies Prisma.InstanceQualityProfileOverrideUncheckedCreateInput;
		const overrideUpdate = {
			status: "UNCERTAIN",
			intentOperation: "RESET_SCORE",
			intendedScore: 0,
			connectionGeneration: 4,
			connectionStateToken: "state-after-score",
		} satisfies Prisma.InstanceQualityProfileOverrideUpdateInput;

		const deploymentCreate = {
			id: ids.deployment,
			templateId: ids.template,
			instanceId: ids.instance,
			userId: ids.user,
			deployedBy: ids.user,
			status: "IN_PROGRESS",
			undeployStatus: "IN_PROGRESS",
			undeployAttemptedAt: undeployStartedAt,
			undeployProgress: '[{"step":"remove-custom-formats","status":"PENDING"}]',
		} satisfies Prisma.TemplateDeploymentHistoryUncheckedCreateInput;
		const deploymentUpdate = {
			undeployStatus: "COMPLETED",
			undeployAttemptedAt: undeployCompletedAt,
			undeployProgress: '[{"step":"remove-custom-formats","status":"COMPLETED"}]',
		} satisfies Prisma.TemplateDeploymentHistoryUpdateInput;

		await prisma.trashSyncHistory.create({ data: syncCreate });
		await prisma.templateQualityProfileMapping.create({ data: mappingCreate });
		await prisma.instanceQualityProfileOverride.create({ data: overrideCreate });
		await prisma.templateDeploymentHistory.create({ data: deploymentCreate });

		await prisma.trashSyncHistory.update({ where: { id: ids.syncHistory }, data: syncUpdate });
		await prisma.templateQualityProfileMapping.update({
			where: { id: ids.mapping },
			data: mappingUpdate,
		});
		await prisma.instanceQualityProfileOverride.update({
			where: { id: ids.override },
			data: overrideUpdate,
		});
		await prisma.templateDeploymentHistory.update({
			where: { id: ids.deployment },
			data: deploymentUpdate,
		});

		const [syncHistory, mapping, override, deployment] = await Promise.all([
			prisma.trashSyncHistory.findUniqueOrThrow({ where: { id: ids.syncHistory } }),
			prisma.templateQualityProfileMapping.findUniqueOrThrow({ where: { id: ids.mapping } }),
			prisma.instanceQualityProfileOverride.findUniqueOrThrow({ where: { id: ids.override } }),
			prisma.templateDeploymentHistory.findUniqueOrThrow({ where: { id: ids.deployment } }),
		]);

		expect(syncHistory).toMatchObject({
			rollbackStatus: "COMPLETED",
			rollbackAttemptedAt: rollbackCompletedAt,
			rollbackProgress: '[{"step":"restore","status":"COMPLETED"}]',
		});
		expect(mapping).toMatchObject({
			connectionGeneration: 4,
			connectionStateToken: "state-after-deploy",
			managedCustomFormats: '[{"id":1001},{"id":1002}]',
			managedCustomFormatsCaptured: true,
		});
		expect(override).toMatchObject({
			status: "UNCERTAIN",
			intentOperation: "RESET_SCORE",
			intendedScore: 0,
			connectionGeneration: 4,
			connectionStateToken: "state-after-score",
		});
		expect(deployment).toMatchObject({
			undeployStatus: "COMPLETED",
			undeployAttemptedAt: undeployCompletedAt,
			undeployProgress: '[{"step":"remove-custom-formats","status":"COMPLETED"}]',
		});
	});

	function olderBackupData() {
		return {
			trashSyncHistory: [],
			templateDeploymentHistory: [],
			trashTemplates: [],
			trashBackups: [],
		} as never;
	}

	async function createRecoverySnapshot() {
		await prisma.trashBackup.create({
			data: {
				id: ids.snapshot,
				instanceId: ids.instance,
				userId: ids.user,
				backupData: "current-owner-evidence",
			},
		});
	}

	it("detects a successful unrolled sync owner whose rollback status is null", async () => {
		await createRecoverySnapshot();
		await prisma.trashSyncHistory.create({
			data: {
				id: ids.syncHistory,
				instanceId: ids.instance,
				templateId: ids.template,
				userId: ids.user,
				syncType: "MANUAL",
				status: "SUCCESS",
				appliedConfigs: "[]",
				rolledBack: false,
				rollbackStatus: null,
				backupId: ids.snapshot,
			},
		});

		await expect(restoreDatabase(prisma, olderBackupData())).rejects.toThrow(
			`current nonterminal coordination row ${ids.syncHistory}`,
		);
	});

	it("detects a successful unrolled deployment owner whose undeploy status is null", async () => {
		await createRecoverySnapshot();
		await prisma.templateDeploymentHistory.create({
			data: {
				id: ids.deployment,
				instanceId: ids.instance,
				templateId: ids.template,
				userId: ids.user,
				deployedBy: ids.user,
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: null,
				canRollback: true,
				templateSnapshot: "{}",
				backupId: ids.snapshot,
			},
		});

		await expect(restoreDatabase(prisma, olderBackupData())).rejects.toThrow(
			`current nonterminal coordination row ${ids.deployment}`,
		);
	});

	it("detects an unresolved score intent before an older restore can erase it", async () => {
		await prisma.instanceQualityProfileOverride.create({
			data: {
				id: ids.override,
				instanceId: ids.instance,
				qualityProfileId: 42,
				customFormatId: 1001,
				score: 0,
				status: "UNCERTAIN",
				intentOperation: "SET_SCORE",
				intendedScore: 15,
				userId: ids.user,
				connectionGeneration: 3,
				connectionStateToken: "state-before-score",
			},
		});

		await expect(restoreDatabase(prisma, olderBackupData())).rejects.toThrow(
			`current unresolved score intent ${ids.override}`,
		);
	});

	it("cascades terminal recovery audits so the service and account remain deletable", async () => {
		await createRecoverySnapshot();
		await prisma.trashSyncHistory.create({
			data: {
				id: ids.syncHistory,
				instanceId: ids.instance,
				templateId: ids.template,
				userId: ids.user,
				syncType: "MANUAL",
				status: "SUCCESS",
				appliedConfigs: "[]",
				rolledBack: true,
				rollbackStatus: "COMPLETED",
				backupId: ids.snapshot,
			},
		});
		await prisma.templateDeploymentHistory.create({
			data: {
				id: ids.deployment,
				instanceId: ids.instance,
				templateId: ids.template,
				userId: ids.user,
				deployedBy: ids.user,
				status: "SUCCESS",
				rolledBack: true,
				undeployStatus: "COMPLETED",
				backupId: ids.snapshot,
			},
		});

		await prisma.serviceInstance.delete({ where: { id: ids.instance, userId: ids.user } });

		expect(await prisma.trashSyncHistory.count({ where: { id: ids.syncHistory } })).toBe(0);
		expect(await prisma.templateDeploymentHistory.count({ where: { id: ids.deployment } })).toBe(0);
		expect(await prisma.trashBackup.count({ where: { id: ids.snapshot } })).toBe(0);

		await prisma.user.delete({ where: { id: ids.user } });
		expect(await prisma.user.findUnique({ where: { id: ids.user } })).toBeNull();
	});
});
