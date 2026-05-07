/**
 * Backup Database Operations
 *
 * Export and restore database tables for backup/restore operations.
 * Uses Prisma transactions for atomic restore operations.
 */

import type { BackupData } from "@arr/shared";
import { loggers } from "../logger.js";
import type { Prisma, PrismaClient } from "../prisma.js";
import { validateRecords } from "./backup-validation.js";

const log = loggers.backup;

export interface ExportDatabaseOptions {
	/** Include TRaSH ARR config snapshots (can be large) */
	includeTrashBackups?: boolean;
	/**
	 * Skip operational history tables (huntLog, huntSearchHistory, trashSyncHistory,
	 * templateDeploymentHistory). These grow unbounded over time and are not needed
	 * for restoring a working configuration — losing them on restore is expected.
	 * Defaults to true for scheduled backups (set by caller).
	 */
	excludeOperationalHistory?: boolean;
	/**
	 * When operational history IS included, cap each history table to the most
	 * recent N rows (ordered by timestamp DESC). Prevents a single user with
	 * months of accumulated history from blowing the heap. Default: 1000.
	 */
	historyRetentionLimit?: number;
}

/**
 * Export all database tables.
 *
 * Tables are fetched sequentially (not in parallel) so each table's row data
 * lives only as long as needed before being assigned into the result object.
 * For scheduled backups, operational history tables are skipped by default to
 * keep peak heap bounded — those tables grow unbounded over time and are not
 * essential for restore.
 */
export async function exportDatabase(prisma: PrismaClient, options: ExportDatabaseOptions = {}) {
	const skipHistory = options.excludeOperationalHistory ?? false;
	const historyLimit = options.historyRetentionLimit ?? 1000;

	// Core authentication & services (always full)
	const users = await prisma.user.findMany();
	const sessions = await prisma.session.findMany();
	const serviceInstances = await prisma.serviceInstance.findMany();
	const serviceTags = await prisma.serviceTag.findMany();
	const serviceInstanceTags = await prisma.serviceInstanceTag.findMany();
	const oidcProviders = await prisma.oIDCProvider.findMany();
	const oidcAccounts = await prisma.oIDCAccount.findMany();
	const webAuthnCredentials = await prisma.webAuthnCredential.findMany();

	// System settings (singleton-ish)
	const systemSettings = await prisma.systemSettings.findMany();

	// TRaSH Guides configuration (always full — these are config, not history)
	const trashTemplates = await prisma.trashTemplate.findMany();
	const trashSettings = await prisma.trashSettings.findMany();
	const trashSyncSchedules = await prisma.trashSyncSchedule.findMany();
	const templateQualityProfileMappings = await prisma.templateQualityProfileMapping.findMany();
	const instanceQualityProfileOverrides = await prisma.instanceQualityProfileOverride.findMany();
	const standaloneCFDeployments = await prisma.standaloneCFDeployment.findMany();
	const qualitySizeMappings = await prisma.qualitySizeMapping.findMany();

	// TRaSH Guides history/audit — operational, capped or skipped.
	// When capped, log a warn so operators can correlate restore-time gaps to
	// the retention limit rather than silently losing the older history.
	const fetchCappedHistory = async <T>(
		tableName: string,
		count: () => Promise<number>,
		find: (take: number) => Promise<T[]>,
	): Promise<T[]> => {
		const total = await count();
		if (total > historyLimit) {
			log.warn(
				{ tableName, totalRows: total, kept: historyLimit, dropped: total - historyLimit },
				"Backup truncated history table to retention limit — older rows excluded",
			);
		}
		return find(historyLimit);
	};

	const trashSyncHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"trashSyncHistory",
				() => prisma.trashSyncHistory.count(),
				(take) => prisma.trashSyncHistory.findMany({ take, orderBy: { startedAt: "desc" } }),
			);
	const templateDeploymentHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"templateDeploymentHistory",
				() => prisma.templateDeploymentHistory.count(),
				(take) =>
					prisma.templateDeploymentHistory.findMany({ take, orderBy: { deployedAt: "desc" } }),
			);

	// Hunting feature: configs are config (always full); logs/history are operational
	const huntConfigs = await prisma.huntConfig.findMany();
	const huntLogs = skipHistory
		? []
		: await fetchCappedHistory(
				"huntLog",
				() => prisma.huntLog.count(),
				(take) => prisma.huntLog.findMany({ take, orderBy: { startedAt: "desc" } }),
			);
	const huntSearchHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"huntSearchHistory",
				() => prisma.huntSearchHistory.count(),
				(take) => prisma.huntSearchHistory.findMany({ take, orderBy: { searchedAt: "desc" } }),
			);

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
			validateRecords(data.serviceInstances, "serviceInstance", ["id", "service", "baseUrl"]);
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
			validateRecords(data.serviceInstanceTags, "serviceInstanceTag", ["instanceId", "tagId"]);
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
			validateRecords(data.instanceQualityProfileOverrides, "instanceQualityProfileOverride", [
				"id",
				"instanceId",
			]);
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
			validateRecords(data.trashSyncHistory, "trashSyncHistory", ["id", "instanceId", "userId"]);
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
