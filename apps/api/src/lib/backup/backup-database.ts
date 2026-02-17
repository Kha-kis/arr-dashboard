/**
 * Backup Database Operations
 *
 * Export and restore database tables for backup/restore operations.
 * Uses Prisma transactions for atomic restore operations.
 */

import type { BackupData } from "@arr/shared";
import type { Prisma, PrismaClient } from "../prisma.js";
import { validateRecords } from "./backup-validation.js";

/**
 * Export all database tables
 *
 * CURRENT IMPLEMENTATION: In-memory bulk export
 * - Loads all table data into memory at once using findMany()
 * - Efficient for typical installations (< 50 MB of data)
 * - Size checks in createBackup() prevent excessive memory usage
 *
 * @param options.includeTrashBackups - Include TRaSH ARR config snapshots (can be large)
 */
export async function exportDatabase(
	prisma: PrismaClient,
	options: { includeTrashBackups?: boolean } = {},
) {
	// Export all core tables in parallel
	const [
		// Core authentication & services
		users,
		sessions,
		serviceInstances,
		serviceTags,
		serviceInstanceTags,
		oidcProviders,
		oidcAccounts,
		webAuthnCredentials,
		// System settings
		systemSettings,
		// TRaSH Guides configuration
		trashTemplates,
		trashSettings,
		trashSyncSchedules,
		templateQualityProfileMappings,
		instanceQualityProfileOverrides,
		standaloneCFDeployments,
		// Quality size preset mappings
		qualitySizeMappings,
		// TRaSH Guides history/audit
		trashSyncHistory,
		templateDeploymentHistory,
		// Hunting feature
		huntConfigs,
		huntLogs,
		huntSearchHistory,
	] = await Promise.all([
		// Core authentication & services
		prisma.user.findMany(),
		prisma.session.findMany(),
		prisma.serviceInstance.findMany(),
		prisma.serviceTag.findMany(),
		prisma.serviceInstanceTag.findMany(),
		prisma.oIDCProvider.findMany(),
		prisma.oIDCAccount.findMany(),
		prisma.webAuthnCredential.findMany(),
		// System settings
		prisma.systemSettings.findMany(),
		// TRaSH Guides configuration
		prisma.trashTemplate.findMany(),
		prisma.trashSettings.findMany(),
		prisma.trashSyncSchedule.findMany(),
		prisma.templateQualityProfileMapping.findMany(),
		prisma.instanceQualityProfileOverride.findMany(),
		prisma.standaloneCFDeployment.findMany(),
		// Quality size preset mappings
		prisma.qualitySizeMapping.findMany(),
		// TRaSH Guides history/audit
		prisma.trashSyncHistory.findMany(),
		prisma.templateDeploymentHistory.findMany(),
		// Hunting feature
		prisma.huntConfig.findMany(),
		prisma.huntLog.findMany(),
		prisma.huntSearchHistory.findMany(),
	]);

	// Optionally include TRaSH instance backups (ARR config snapshots)
	// Limited to non-expired backups from the last 7 days to control size
	let trashBackups: unknown[] = [];
	if (options.includeTrashBackups) {
		const sevenDaysAgo = new Date();
		sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

		trashBackups = await prisma.trashBackup.findMany({
			where: {
				// Only include backups from the last 7 days
				createdAt: { gte: sevenDaysAgo },
				// Only include non-expired backups (expiresAt is null OR in the future)
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
		});
	}

	return {
		// Core authentication & services
		users,
		sessions,
		serviceInstances,
		serviceTags,
		serviceInstanceTags,
		oidcProviders,
		oidcAccounts,
		webAuthnCredentials,
		// System settings
		systemSettings,
		// TRaSH Guides configuration
		trashTemplates,
		trashSettings,
		trashSyncSchedules,
		templateQualityProfileMappings,
		instanceQualityProfileOverrides,
		standaloneCFDeployments,
		// Quality size preset mappings
		qualitySizeMappings,
		// TRaSH Guides history/audit
		trashSyncHistory,
		templateDeploymentHistory,
		// TRaSH instance backups (optional)
		trashBackups,
		// Hunting feature
		huntConfigs,
		huntLogs,
		huntSearchHistory,
	};
}

/**
 * Restore database from backup data
 * Uses bulk inserts for better performance and validates data before restoration
 *
 * CURRENT IMPLEMENTATION: In-memory bulk restore
 * - Performs bulk createMany() operations for all records in a single transaction
 * - Transaction ensures atomicity but can be long-running for large datasets
 */
export async function restoreDatabase(prisma: PrismaClient, data: BackupData["data"]) {
	// Use a transaction to ensure atomicity
	await prisma.$transaction(async (tx) => {
		// =================================================================
		// DELETE all existing data (in reverse order of dependencies)
		// =================================================================

		// Hunting feature (HuntSearchHistory → HuntLog → HuntConfig)
		await tx.huntSearchHistory.deleteMany();
		await tx.huntLog.deleteMany();
		await tx.huntConfig.deleteMany();

		// TRaSH history/audit (depends on templates, instances, backups)
		await tx.templateDeploymentHistory.deleteMany();
		await tx.trashSyncHistory.deleteMany();

		// TRaSH configuration (depends on templates, instances)
		await tx.qualitySizeMapping.deleteMany();
		await tx.templateQualityProfileMapping.deleteMany();
		await tx.instanceQualityProfileOverride.deleteMany();
		await tx.standaloneCFDeployment.deleteMany();
		await tx.trashBackup.deleteMany();
		await tx.trashSyncSchedule.deleteMany();
		await tx.trashTemplate.deleteMany();
		await tx.trashSettings.deleteMany();

		// System settings (singleton)
		await tx.systemSettings.deleteMany();

		// Core tables (existing)
		await tx.serviceInstanceTag.deleteMany();
		await tx.serviceTag.deleteMany();
		await tx.serviceInstance.deleteMany();
		await tx.webAuthnCredential.deleteMany();
		await tx.oIDCAccount.deleteMany();
		await tx.oIDCProvider.deleteMany();
		await tx.session.deleteMany();
		await tx.user.deleteMany();

		// =================================================================
		// RESTORE data (in order of dependencies)
		// =================================================================

		// --- Core authentication (no dependencies) ---

		if (data.users.length > 0) {
			validateRecords(data.users, "user", ["id", "username"]);
			await tx.user.createMany({
				data: data.users as Prisma.UserCreateManyInput[],
			});
		}

		if (data.sessions.length > 0) {
			validateRecords(data.sessions, "session", ["id", "userId", "expiresAt"]);
			await tx.session.createMany({
				data: data.sessions as Prisma.SessionCreateManyInput[],
			});
		}

		if (data.oidcProviders && data.oidcProviders.length > 0) {
			validateRecords(data.oidcProviders, "oidcProvider", ["id", "clientId", "issuer"]);
			const providerData = data.oidcProviders[0] as Prisma.OIDCProviderCreateInput;
			await tx.oIDCProvider.create({
				data: { ...providerData, id: 1 },
			});
		}

		if (data.oidcAccounts.length > 0) {
			validateRecords(data.oidcAccounts, "oidcAccount", ["id", "userId", "providerUserId"]);
			await tx.oIDCAccount.createMany({
				data: data.oidcAccounts as Prisma.OIDCAccountCreateManyInput[],
			});
		}

		if (data.webAuthnCredentials.length > 0) {
			validateRecords(data.webAuthnCredentials, "webAuthnCredential", [
				"id",
				"userId",
				"publicKey",
			]);
			await tx.webAuthnCredential.createMany({
				data: data.webAuthnCredentials as Prisma.WebAuthnCredentialCreateManyInput[],
			});
		}

		// --- Service instances & tags ---

		if (data.serviceInstances.length > 0) {
			validateRecords(data.serviceInstances, "serviceInstance", [
				"id",
				"service",
				"baseUrl",
			]);
			await tx.serviceInstance.createMany({
				data: data.serviceInstances as Prisma.ServiceInstanceCreateManyInput[],
			});
		}

		if (data.serviceTags.length > 0) {
			validateRecords(data.serviceTags, "serviceTag", ["id", "name"]);
			await tx.serviceTag.createMany({
				data: data.serviceTags as Prisma.ServiceTagCreateManyInput[],
			});
		}

		if (data.serviceInstanceTags.length > 0) {
			validateRecords(data.serviceInstanceTags, "serviceInstanceTag", [
				"instanceId",
				"tagId",
			]);
			await tx.serviceInstanceTag.createMany({
				data: data.serviceInstanceTags as Prisma.ServiceInstanceTagCreateManyInput[],
			});
		}

		// --- System settings (singleton) ---

		if (data.systemSettings && data.systemSettings.length > 0) {
			validateRecords(data.systemSettings, "systemSettings", ["id"]);
			const settingsData = data.systemSettings[0] as Prisma.SystemSettingsCreateInput;
			await tx.systemSettings.create({
				data: { ...settingsData, id: 1 },
			});
		}

		// --- TRaSH Guides configuration ---

		if (data.trashSettings && data.trashSettings.length > 0) {
			validateRecords(data.trashSettings, "trashSettings", ["id", "userId"]);
			await tx.trashSettings.createMany({
				data: data.trashSettings as Prisma.TrashSettingsCreateManyInput[],
			});
		}

		if (data.trashTemplates && data.trashTemplates.length > 0) {
			validateRecords(data.trashTemplates, "trashTemplate", ["id", "name", "serviceType"]);
			await tx.trashTemplate.createMany({
				data: data.trashTemplates as Prisma.TrashTemplateCreateManyInput[],
			});
		}

		if (data.trashSyncSchedules && data.trashSyncSchedules.length > 0) {
			validateRecords(data.trashSyncSchedules, "trashSyncSchedule", ["id", "userId"]);
			await tx.trashSyncSchedule.createMany({
				data: data.trashSyncSchedules as Prisma.TrashSyncScheduleCreateManyInput[],
			});
		}

		if (data.trashBackups && data.trashBackups.length > 0) {
			validateRecords(data.trashBackups, "trashBackup", ["id", "instanceId", "userId"]);
			await tx.trashBackup.createMany({
				data: data.trashBackups as Prisma.TrashBackupCreateManyInput[],
			});
		}

		if (data.templateQualityProfileMappings && data.templateQualityProfileMappings.length > 0) {
			validateRecords(data.templateQualityProfileMappings, "templateQualityProfileMapping", [
				"id",
				"templateId",
				"instanceId",
			]);
			await tx.templateQualityProfileMapping.createMany({
				data: data.templateQualityProfileMappings as Prisma.TemplateQualityProfileMappingCreateManyInput[],
			});
		}

		if (data.instanceQualityProfileOverrides && data.instanceQualityProfileOverrides.length > 0) {
			validateRecords(
				data.instanceQualityProfileOverrides,
				"instanceQualityProfileOverride",
				["id", "instanceId"],
			);
			await tx.instanceQualityProfileOverride.createMany({
				data: data.instanceQualityProfileOverrides as Prisma.InstanceQualityProfileOverrideCreateManyInput[],
			});
		}

		if (data.standaloneCFDeployments && data.standaloneCFDeployments.length > 0) {
			validateRecords(data.standaloneCFDeployments, "standaloneCFDeployment", [
				"id",
				"instanceId",
				"cfTrashId",
			]);
			await tx.standaloneCFDeployment.createMany({
				data: data.standaloneCFDeployments as Prisma.StandaloneCFDeploymentCreateManyInput[],
			});
		}

		if (data.qualitySizeMappings && data.qualitySizeMappings.length > 0) {
			validateRecords(data.qualitySizeMappings, "qualitySizeMapping", [
				"id",
				"instanceId",
				"userId",
			]);
			await tx.qualitySizeMapping.createMany({
				data: data.qualitySizeMappings as Prisma.QualitySizeMappingCreateManyInput[],
			});
		}

		// --- TRaSH Guides history/audit ---

		if (data.trashSyncHistory && data.trashSyncHistory.length > 0) {
			validateRecords(data.trashSyncHistory, "trashSyncHistory", [
				"id",
				"instanceId",
				"userId",
			]);
			await tx.trashSyncHistory.createMany({
				data: data.trashSyncHistory as Prisma.TrashSyncHistoryCreateManyInput[],
			});
		}

		if (data.templateDeploymentHistory && data.templateDeploymentHistory.length > 0) {
			validateRecords(data.templateDeploymentHistory, "templateDeploymentHistory", [
				"id",
				"templateId",
				"instanceId",
			]);
			await tx.templateDeploymentHistory.createMany({
				data: data.templateDeploymentHistory as Prisma.TemplateDeploymentHistoryCreateManyInput[],
			});
		}

		// --- Hunting feature ---

		if (data.huntConfigs && data.huntConfigs.length > 0) {
			validateRecords(data.huntConfigs, "huntConfig", ["id", "instanceId"]);
			await tx.huntConfig.createMany({
				data: data.huntConfigs as Prisma.HuntConfigCreateManyInput[],
			});
		}

		if (data.huntLogs && data.huntLogs.length > 0) {
			validateRecords(data.huntLogs, "huntLog", ["id", "instanceId"]);
			await tx.huntLog.createMany({
				data: data.huntLogs as Prisma.HuntLogCreateManyInput[],
			});
		}

		if (data.huntSearchHistory && data.huntSearchHistory.length > 0) {
			validateRecords(data.huntSearchHistory, "huntSearchHistory", ["id", "configId"]);
			await tx.huntSearchHistory.createMany({
				data: data.huntSearchHistory as Prisma.HuntSearchHistoryCreateManyInput[],
			});
		}
	});
}
