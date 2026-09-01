/**
 * Backup Database Operations
 *
 * Export and restore database tables for backup/restore operations.
 * Uses Prisma transactions for atomic restore operations.
 */

import type { BackupData } from "@arr/shared";
import { BackupCompatibilityError } from "../errors.js";
import { loggers } from "../logger.js";
import type { Prisma, PrismaClient, TrashBackup } from "../prisma.js";
import {
	isNonterminalRollback,
	isNonterminalUndeploy,
	LEGACY_RELATIONAL_CONFIG_DELEGATES,
	LEGACY_RELATIONAL_CONFIG_FIELDS,
	validateCoordinationEvidence,
	validateRecords,
} from "./backup-validation.js";

const log = loggers.backup;

export interface ExportDatabaseOptions {
	/** Include TRaSH ARR config snapshots (can be large) */
	includeTrashBackups?: boolean;
	/**
	 * Skip disposable operational history. Hunt history is omitted entirely;
	 * terminal TRaSH history is omitted while nonterminal rollback/undeploy rows
	 * and their referenced snapshots are always preserved. Defaults to true for
	 * scheduled and update backups (set by caller).
	 */
	excludeOperationalHistory?: boolean;
	/**
	 * When operational history IS included, cap each history table to the most
	 * recent N rows (ordered by timestamp DESC). Prevents a single user with
	 * months of accumulated history from blowing the heap. Default: 1000.
	 */
	historyRetentionLimit?: number;
}

async function targetHasDurableConfig(
	prisma: Prisma.TransactionClient | PrismaClient,
	missingFields: readonly string[],
): Promise<boolean> {
	const client = prisma as unknown as Record<string, { count?: () => Promise<number> }>;
	for (const [payloadField, delegate] of LEGACY_RELATIONAL_CONFIG_DELEGATES) {
		if (!missingFields.includes(payloadField)) continue;
		if (
			payloadField === "libraryCleanupApproval" ||
			payloadField === "libraryCleanupMediaServerScan"
		) {
			continue;
		}
		const accessor = client[delegate];
		if (accessor?.count && (await accessor.count()) > 0) return true;
	}
	return false;
}

const ACTIVE_APPROVAL_STATUSES = [
	"pending",
	"approved",
	"retry_pending",
	"executing",
	"retry_executing",
] as const;
const ACTIVE_SCAN_STATUSES = ["pending", "triggering", "failed"] as const;

function activeCleanupApprovalWhere() {
	return {
		OR: [
			{ status: { in: [...ACTIVE_APPROVAL_STATUSES] } },
			{ status: "executed", terminalAuditRecordedAt: null },
		],
	};
}

async function targetHasUncoveredSingletonSecretState(
	prisma: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
): Promise<boolean> {
	const record = data as Record<string, unknown>;
	const client = prisma as unknown as Record<
		string,
		{
			findFirst?: (args: unknown) => Promise<Record<string, unknown> | null>;
		}
	>;
	if (!Array.isArray(record.backupSettings)) {
		const backupSettings = await client.backupSettings?.findFirst?.({
			select: { encryptedPassword: true, passwordIv: true },
		});
		if (backupSettings?.encryptedPassword != null || backupSettings?.passwordIv != null) {
			return true;
		}
	}

	if (!Array.isArray(record.vapidKeys)) {
		const vapidKeys = await client.vapidKeys?.findFirst?.({
			select: { encryptedPrivateKey: true, privateKeyIv: true },
		});
		if (vapidKeys?.encryptedPrivateKey != null || vapidKeys?.privateKeyIv != null) {
			return true;
		}
	}

	return false;
}

async function targetHasOmittedOidcProvider(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const provider = (prisma as unknown as Record<string, { count?: () => Promise<number> }>)
		.oIDCProvider;
	return provider?.count ? (await provider.count()) > 0 : false;
}

async function targetHasActiveCleanupCoordination(
	prisma: Prisma.TransactionClient | PrismaClient,
	missingFields: readonly string[],
): Promise<boolean> {
	const client = prisma as unknown as Record<
		string,
		{ findMany?: (args: unknown) => Promise<unknown[]> }
	>;
	const approval = client.libraryCleanupApproval;
	const scan = client.libraryCleanupMediaServerScan;
	let activeScans: Array<Record<string, unknown>> = [];

	if (missingFields.includes("libraryCleanupMediaServerScan") && scan?.findMany) {
		activeScans = (await scan.findMany({
			where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
			select: { id: true, approvalId: true },
		})) as Array<Record<string, unknown>>;
		if (activeScans.length > 0) return true;
	}

	if (!missingFields.includes("libraryCleanupApproval") || !approval?.findMany) return false;
	const activeApprovals = await approval.findMany({
		where: activeCleanupApprovalWhere(),
		select: { id: true },
	});
	if (activeApprovals.length > 0) return true;

	if (!scan?.findMany) return false;
	activeScans = (await scan.findMany({
		where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
		select: { approvalId: true },
	})) as Array<Record<string, unknown>>;
	const approvalIds = activeScans
		.map((row) => row.approvalId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (approvalIds.length === 0) return false;
	const parentApprovals = await approval.findMany({
		where: { id: { in: [...new Set(approvalIds)] } },
		select: { id: true },
	});
	return parentApprovals.length > 0;
}

async function targetHasActiveNamingRecovery(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const model = (
		prisma as unknown as Record<string, { findMany?: (args: unknown) => Promise<unknown[]> }>
	).namingDeployHistory;
	if (!model?.findMany) return false;
	const rows = await model.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
		select: { id: true },
	});
	return rows.length > 0;
}

/**
 * Reject incomplete legacy payloads before restore mutation. Singleton rows
 * that do not carry secrets may be preserved, but omitted ciphertext must not
 * survive replacement of the installation encryption key.
 */
export async function assertRestoreCompatibility(
	prisma: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
): Promise<void> {
	const record = data as Record<string, unknown>;
	const missingFields = LEGACY_RELATIONAL_CONFIG_FIELDS.filter(
		(field) => !Array.isArray(record[field]),
	);
	if (missingFields.length > 0 && (await targetHasDurableConfig(prisma, missingFields))) {
		throw new BackupCompatibilityError();
	}
	if (await targetHasUncoveredSingletonSecretState(prisma, data)) {
		throw new BackupCompatibilityError();
	}
	if (!Array.isArray(record.oidcProviders) && (await targetHasOmittedOidcProvider(prisma))) {
		throw new BackupCompatibilityError();
	}
	if (
		missingFields.some(
			(field) => field === "libraryCleanupApproval" || field === "libraryCleanupMediaServerScan",
		) &&
		(await targetHasActiveCleanupCoordination(prisma, missingFields))
	) {
		throw new BackupCompatibilityError();
	}
	if (!Array.isArray(record.namingDeployHistory) && (await targetHasActiveNamingRecovery(prisma))) {
		throw new BackupCompatibilityError();
	}
	try {
		await validateCurrentCoordinationPreserved(prisma, data);
	} catch (error) {
		if (error instanceof CoordinationMismatchError) {
			throw new BackupCompatibilityError(error);
		}
		throw error;
	}
}

type CoordinationKind = "rollback" | "undeploy";
type CoordinationRow = Record<string, unknown> & { id: string };

class CoordinationMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoordinationMismatchError";
	}
}

function isAuditOnlyUncertainSync(record: Record<string, unknown>): boolean {
	return (
		record.status === "UNCERTAIN" &&
		record.rollbackStatus == null &&
		record.backupId == null &&
		record.rolledBack !== true
	);
}

function shouldPreserveSyncHistory(record: Record<string, unknown>): boolean {
	return isNonterminalRollback(record) || isAuditOnlyUncertainSync(record);
}

const COORDINATION_FIELDS: Record<CoordinationKind, readonly string[]> = {
	rollback: [
		"userId",
		"instanceId",
		"templateId",
		"status",
		"rolledBack",
		"appliedConfigs",
		"rollbackStatus",
		"rollbackAttemptedAt",
		"rollbackProgress",
		"backupId",
		"startedAt",
	],
	undeploy: [
		"userId",
		"instanceId",
		"templateId",
		"status",
		"rolledBack",
		"canRollback",
		"appliedConfigs",
		"templateSnapshot",
		"undeployStatus",
		"undeployAttemptedAt",
		"undeployProgress",
		"backupId",
		"deployedAt",
	],
};

const SCORE_INTENT_FIELDS = [
	"userId",
	"instanceId",
	"qualityProfileId",
	"customFormatId",
	"score",
	"status",
	"intentOperation",
	"intendedScore",
	"connectionGeneration",
	"connectionStateToken",
	"createdAt",
	"updatedAt",
] as const;

const ACTIVE_NAMING_FIELDS = [
	"instanceId",
	"userId",
	"status",
	"selectedPresets",
	"resolvedPayload",
	"deployedHash",
	"previousConfig",
	"changedFields",
	"totalFields",
	"errorMessage",
	"rolledBack",
	"rolledBackAt",
	"deployedAt",
] as const;

const ACTIVE_APPROVAL_FIELDS = [
	"configId",
	"instanceId",
	"arrItemId",
	"itemType",
	"targetScope",
	"arrEpisodeId",
	"episodeFileId",
	"seasonNumber",
	"episodeNumber",
	"episodeTitle",
	"title",
	"matchedRuleId",
	"matchedRuleName",
	"reason",
	"action",
	"scanMediaServerAfterDelete",
	"sizeOnDisk",
	"year",
	"rating",
	"status",
	"executionToken",
	"executionAuditCorrelationId",
	"reconciledWithoutMutation",
	"safetySnapshot",
	"lastExecutionError",
	"reviewedAt",
	"executedAt",
	"expiresAt",
	"createdAt",
] as const;

const ACTIVE_SCAN_FIELDS = [
	"approvalId",
	"instanceId",
	"service",
	"serverIdentity",
	"mediaType",
	"plannedSectionIds",
	"targetKey",
	"status",
	"executionToken",
	"attemptCount",
	"completedSectionIds",
	"lastError",
	"nextAttemptAt",
	"requestStartedAt",
	"triggeredAt",
	"createdAt",
	"updatedAt",
] as const;

const COORDINATION_DATE_FIELDS = new Set([
	"startedAt",
	"rollbackAttemptedAt",
	"undeployAttemptedAt",
	"deployedAt",
	"createdAt",
	"updatedAt",
	"reviewedAt",
	"executedAt",
	"expiresAt",
	"nextAttemptAt",
	"requestStartedAt",
	"triggeredAt",
]);

function recordsById(value: unknown): Map<string, CoordinationRow> {
	const records = new Map<string, CoordinationRow>();
	if (!Array.isArray(value)) return records;
	for (const row of value) {
		if (
			typeof row === "object" &&
			row !== null &&
			"id" in row &&
			typeof row.id === "string" &&
			row.id.length > 0
		) {
			records.set(row.id, row as CoordinationRow);
		}
	}
	return records;
}

function assertCurrentUndeployFallbackPreserved(
	current: CoordinationRow,
	incomingTemplates: Map<string, CoordinationRow>,
): void {
	if (typeof current.templateSnapshot === "string" && current.templateSnapshot.length > 0) {
		return;
	}
	if (typeof current.templateId !== "string" || current.templateId.length === 0) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current nonterminal coordination row ${current.id} has no undeploy template authority`,
		);
	}
	const currentTemplate = current.template;
	if (typeof currentTemplate !== "object" || currentTemplate === null) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current undeploy fallback template ${current.templateId} is missing from the database`,
		);
	}
	const incomingTemplate = incomingTemplates.get(current.templateId);
	if (!incomingTemplate) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current undeploy fallback template ${current.templateId} is missing from incoming data`,
		);
	}
	for (const field of ["userId", "serviceType", "configData"] as const) {
		if (incomingTemplate[field] !== (currentTemplate as Record<string, unknown>)[field]) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current undeploy fallback template ${current.templateId} changed ${field}`,
			);
		}
	}
}

function comparableCoordinationValue(value: unknown, field?: string): unknown {
	if (field === "sizeOnDisk" && (typeof value === "bigint" || typeof value === "string")) {
		try {
			return BigInt(value).toString();
		} catch {
			return value;
		}
	}
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" && field && COORDINATION_DATE_FIELDS.has(field)) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return value;
}

function assertCurrentRowPreserved(
	kind: CoordinationKind,
	current: CoordinationRow,
	incomingRows: Map<string, CoordinationRow>,
): void {
	const incoming = incomingRows.get(current.id);
	if (!incoming) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current nonterminal coordination row ${current.id} is missing from incoming data`,
		);
	}

	for (const field of COORDINATION_FIELDS[kind]) {
		if (
			comparableCoordinationValue(incoming[field], field) !==
			comparableCoordinationValue(current[field], field)
		) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current nonterminal coordination row ${current.id} changed ${field}`,
			);
		}
	}
}

function assertCurrentSpecialRowPreserved(
	label: string,
	current: CoordinationRow,
	incomingRows: Map<string, CoordinationRow>,
	fields: readonly string[],
): void {
	const incoming = incomingRows.get(current.id);
	if (!incoming) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current ${label} ${current.id} is missing from incoming data`,
		);
	}
	for (const field of fields) {
		if (
			comparableCoordinationValue(incoming[field], field) !==
			comparableCoordinationValue(current[field], field)
		) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current ${label} ${current.id} changed ${field}`,
			);
		}
	}
}

async function validateCurrentCoordinationPreserved(
	tx: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
): Promise<void> {
	const db = tx as Prisma.TransactionClient;
	const optionalModels = tx as unknown as Record<
		string,
		{ findMany?: (args: unknown) => Promise<unknown[]> }
	>;
	if (
		!optionalModels.trashSyncHistory?.findMany ||
		!optionalModels.templateDeploymentHistory?.findMany ||
		!optionalModels.instanceQualityProfileOverride?.findMany ||
		!optionalModels.namingDeployHistory?.findMany ||
		!optionalModels.trashBackup?.findMany
	) {
		return;
	}
	const currentRollbackRows = (
		await db.trashSyncHistory.findMany({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		})
	).filter(shouldPreserveSyncHistory) as CoordinationRow[];
	const currentUndeployRows = (
		await db.templateDeploymentHistory.findMany({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
			include: {
				template: {
					select: { id: true, userId: true, serviceType: true, configData: true },
				},
			},
		})
	).filter(isNonterminalUndeploy) as CoordinationRow[];
	const currentScoreIntents = (await db.instanceQualityProfileOverride.findMany({
		where: { status: { in: ["PENDING", "UNCERTAIN"] } },
	})) as CoordinationRow[];
	const currentActiveNaming = (await db.namingDeployHistory.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
	})) as CoordinationRow[];
	const currentActiveApprovals = optionalModels.libraryCleanupApproval?.findMany
		? ((await optionalModels.libraryCleanupApproval.findMany({
				where: activeCleanupApprovalWhere(),
			})) as CoordinationRow[])
		: [];
	const currentActiveScans = optionalModels.libraryCleanupMediaServerScan?.findMany
		? ((await optionalModels.libraryCleanupMediaServerScan.findMany({
				where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
			})) as CoordinationRow[])
		: [];
	const scanApprovalIds = [
		...new Set(
			currentActiveScans
				.map((row) => row.approvalId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const currentScanParentApprovals =
		scanApprovalIds.length > 0 && optionalModels.libraryCleanupApproval?.findMany
			? ((await optionalModels.libraryCleanupApproval.findMany({
					where: { id: { in: scanApprovalIds } },
				})) as CoordinationRow[])
			: [];
	const incomingRollbackRows = recordsById(data.trashSyncHistory);
	const incomingUndeployRows = recordsById(data.templateDeploymentHistory);
	const incomingTemplates = recordsById(data.trashTemplates);
	const incomingScoreIntents = recordsById(data.instanceQualityProfileOverrides);
	const incomingActiveNaming = recordsById(data.namingDeployHistory);
	const incomingApprovals = recordsById(data.libraryCleanupApproval);
	const incomingScans = recordsById(data.libraryCleanupMediaServerScan);

	for (const row of currentRollbackRows) {
		assertCurrentRowPreserved("rollback", row, incomingRollbackRows);
	}
	for (const row of currentUndeployRows) {
		assertCurrentRowPreserved("undeploy", row, incomingUndeployRows);
		assertCurrentUndeployFallbackPreserved(row, incomingTemplates);
	}
	for (const row of currentScoreIntents) {
		assertCurrentSpecialRowPreserved(
			"pending or uncertain quality-score intent",
			row,
			incomingScoreIntents,
			SCORE_INTENT_FIELDS,
		);
	}
	for (const row of currentActiveNaming) {
		assertCurrentSpecialRowPreserved(
			"active naming recovery",
			row,
			incomingActiveNaming,
			ACTIVE_NAMING_FIELDS,
		);
	}
	for (const row of [...currentActiveApprovals, ...currentScanParentApprovals]) {
		assertCurrentSpecialRowPreserved(
			"active cleanup approval",
			row,
			incomingApprovals,
			ACTIVE_APPROVAL_FIELDS,
		);
	}
	for (const row of currentActiveScans) {
		assertCurrentSpecialRowPreserved(
			"active media-server scan",
			row,
			incomingScans,
			ACTIVE_SCAN_FIELDS,
		);
	}

	const currentRecoveryRows = [
		...currentRollbackRows.filter((row) =>
			isNonterminalRollback({
				status: row.status,
				rolledBack: row.rolledBack,
				rollbackStatus: row.rollbackStatus,
			}),
		),
		...currentUndeployRows,
	];
	const requiredSnapshotIds = currentRecoveryRows.map((row) => {
		if (typeof row.backupId !== "string" || row.backupId.length === 0) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current nonterminal coordination row ${row.id} has no required recovery snapshot reference`,
			);
		}
		return row.backupId;
	});
	if (requiredSnapshotIds.length === 0) return;

	const currentSnapshots = recordsById(
		await db.trashBackup.findMany({ where: { id: { in: [...new Set(requiredSnapshotIds)] } } }),
	);
	const incomingSnapshots = recordsById(data.trashBackups);
	for (const snapshotId of new Set(requiredSnapshotIds)) {
		const current = currentSnapshots.get(snapshotId);
		if (!current) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current recovery snapshot ${snapshotId} is missing from the database`,
			);
		}
		const incoming = incomingSnapshots.get(snapshotId);
		if (!incoming) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current recovery snapshot ${snapshotId} is missing from incoming data`,
			);
		}
		for (const field of ["userId", "instanceId", "backupData"] as const) {
			if (incoming[field] !== current[field]) {
				throw new CoordinationMismatchError(
					`Cannot restore backup: current recovery snapshot ${snapshotId} changed ${field}`,
				);
			}
		}
	}
}

function mergeRowsById<T extends { id: string }>(rows: T[], preservedRows: T[]): T[] {
	const merged = [...rows];
	const seen = new Set(rows.map((row) => row.id));
	for (const row of preservedRows) {
		if (!seen.has(row.id)) {
			merged.push(row);
			seen.add(row.id);
		}
	}
	return merged;
}

/**
 * Export all database tables.
 *
 * Tables are fetched sequentially (not in parallel) so each table's row data
 * lives only as long as needed before being assigned into the result object.
 * For scheduled backups, disposable operational history is skipped by default
 * to keep peak heap bounded. Nonterminal rollback/undeploy coordination is
 * always exported because it is required to resume safely after restore.
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
	const backupSettings = await prisma.backupSettings.findMany();
	const vapidKeys = await prisma.vapidKeys.findMany();

	// TRaSH Guides configuration (always full — these are config, not history)
	const trashTemplates = await prisma.trashTemplate.findMany();
	const trashSettings = await prisma.trashSettings.findMany();
	const trashSyncSchedules = await prisma.trashSyncSchedule.findMany();
	const templateQualityProfileMappings = await prisma.templateQualityProfileMapping.findMany();
	const instanceQualityProfileOverrides = await prisma.instanceQualityProfileOverride.findMany();
	const standaloneCFDeployments = await prisma.standaloneCFDeployment.findMany();
	const qualitySizeMappings = await prisma.qualitySizeMapping.findMany();

	// Durable user and instance configuration (always full, including empty
	// arrays so v1.2 distinguishes complete coverage from legacy omission).
	const notificationChannel = await prisma.notificationChannel.findMany();
	const notificationSubscription = await prisma.notificationSubscription.findMany();
	const notificationRule = await prisma.notificationRule.findMany();
	const notificationAggregationConfig = await prisma.notificationAggregationConfig.findMany();
	const autoTagRule = await prisma.autoTagRule.findMany();
	const labelSyncRule = await prisma.labelSyncRule.findMany();
	const queueCleanerConfig = await prisma.queueCleanerConfig.findMany();
	const libraryCleanupConfig = await prisma.libraryCleanupConfig.findMany();
	const libraryCleanupRule = await prisma.libraryCleanupRule.findMany();
	const namingConfig = await prisma.namingConfig.findMany();
	const userCustomFormat = await prisma.userCustomFormat.findMany();
	const activeCleanupApprovals = await prisma.libraryCleanupApproval.findMany({
		where: activeCleanupApprovalWhere(),
	});
	const activeCleanupScans = await prisma.libraryCleanupMediaServerScan.findMany({
		where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
	});
	const cleanupScanApprovalIds = [
		...new Set(
			activeCleanupScans
				.map((row) => row.approvalId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const cleanupScanParentApprovals =
		cleanupScanApprovalIds.length > 0
			? await prisma.libraryCleanupApproval.findMany({
					where: { id: { in: cleanupScanApprovalIds } },
				})
			: [];
	const serializeCleanupApproval = (row: (typeof activeCleanupApprovals)[number]) => ({
		...row,
		sizeOnDisk: row.sizeOnDisk.toString(),
		terminalAuditRecordedAt: null,
		terminalAuditRecoveryAttemptedAt: null,
	});
	const libraryCleanupApproval = mergeRowsById(
		activeCleanupApprovals.map(serializeCleanupApproval),
		cleanupScanParentApprovals.map(serializeCleanupApproval),
	);

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

	// Rollback/undeploy coordination is durable safety state, even though it is
	// stored in history tables. Fetch it independently so exclusion and row caps
	// can discard terminal audit rows without stranding resumable operations.
	const nonterminalRollbackHistory = (
		await prisma.trashSyncHistory.findMany({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		})
	).filter(shouldPreserveSyncHistory);
	const nonterminalUndeployHistory = (
		await prisma.templateDeploymentHistory.findMany({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
		})
	).filter(isNonterminalUndeploy);
	const activeNamingDeployHistory = await prisma.namingDeployHistory.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
	});

	const cappedTrashSyncHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"trashSyncHistory",
				() => prisma.trashSyncHistory.count(),
				(take) => prisma.trashSyncHistory.findMany({ take, orderBy: { startedAt: "desc" } }),
			);
	const cappedTemplateDeploymentHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"templateDeploymentHistory",
				() => prisma.templateDeploymentHistory.count(),
				(take) =>
					prisma.templateDeploymentHistory.findMany({ take, orderBy: { deployedAt: "desc" } }),
			);
	const trashSyncHistory = mergeRowsById(cappedTrashSyncHistory, nonterminalRollbackHistory);
	const templateDeploymentHistory = mergeRowsById(
		cappedTemplateDeploymentHistory,
		nonterminalUndeployHistory,
	);
	const cappedNamingDeployHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"namingDeployHistory",
				() => prisma.namingDeployHistory.count(),
				(take) => prisma.namingDeployHistory.findMany({ take, orderBy: { deployedAt: "desc" } }),
			);
	const namingDeployHistory = mergeRowsById(cappedNamingDeployHistory, activeNamingDeployHistory);

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

	// Optionally include recent TRaSH instance backups. Snapshots referenced by
	// nonterminal rollback/undeploy rows are added below regardless of age/expiry.
	let trashBackups: TrashBackup[] = [];
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

	const requiredBackupIds = [
		...nonterminalRollbackHistory.filter(isNonterminalRollback),
		...nonterminalUndeployHistory,
	].map((row) => {
		if (typeof row.backupId !== "string" || row.backupId.length === 0) {
			throw new Error(
				`Cannot create backup: nonterminal coordination row ${row.id} has no referenced TRaSH backup snapshot`,
			);
		}
		return row.backupId;
	});
	const uniqueRequiredBackupIds = [...new Set(requiredBackupIds)];
	if (uniqueRequiredBackupIds.length > 0) {
		const requiredSnapshots = await prisma.trashBackup.findMany({
			where: { id: { in: uniqueRequiredBackupIds } },
		});
		trashBackups = mergeRowsById(trashBackups, requiredSnapshots);
	}

	validateCoordinationEvidence({
		serviceInstances,
		trashTemplates,
		trashSyncHistory,
		templateDeploymentHistory,
		trashBackups,
	});

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
		backupSettings,
		vapidKeys,
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
		namingDeployHistory,
		// TRaSH instance backups (optional)
		trashBackups,
		// Hunting feature
		huntConfigs,
		huntLogs,
		huntSearchHistory,
		// Durable configuration
		notificationChannel,
		notificationSubscription,
		notificationRule,
		notificationAggregationConfig,
		autoTagRule,
		labelSyncRule,
		queueCleanerConfig,
		libraryCleanupConfig,
		libraryCleanupRule,
		namingConfig,
		userCustomFormat,
		libraryCleanupApproval,
		libraryCleanupMediaServerScan: activeCleanupScans,
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
		// Recheck inside the transaction immediately before any delete. The
		// service-level preflight closes the filesystem TOCTOU window; this check
		// protects direct callers and races between preflight and transaction.
		await assertRestoreCompatibility(tx, data);

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
		await tx.namingDeployHistory.deleteMany();

		// TRaSH configuration (depends on templates, instances)
		await tx.qualitySizeMapping.deleteMany();
		await tx.templateQualityProfileMapping.deleteMany();
		await tx.instanceQualityProfileOverride.deleteMany();
		await tx.standaloneCFDeployment.deleteMany();
		await tx.trashBackup.deleteMany();
		await tx.trashSyncSchedule.deleteMany();
		await tx.trashTemplate.deleteMany();
		await tx.trashSettings.deleteMany();

		// Durable configuration, children before parents.
		await tx.libraryCleanupMediaServerScan.deleteMany();
		await tx.libraryCleanupApproval.deleteMany();
		await tx.notificationSubscription.deleteMany();
		await tx.libraryCleanupRule.deleteMany();
		await tx.notificationChannel.deleteMany();
		await tx.notificationRule.deleteMany();
		await tx.notificationAggregationConfig.deleteMany();
		await tx.autoTagRule.deleteMany();
		await tx.labelSyncRule.deleteMany();
		await tx.queueCleanerConfig.deleteMany();
		await tx.libraryCleanupConfig.deleteMany();
		await tx.namingConfig.deleteMany();
		await tx.userCustomFormat.deleteMany();

		// These singleton rows are not removed by user/instance cascades. Each
		// incoming array independently authorizes replacement of its own model.
		if (Array.isArray(data.backupSettings)) {
			await tx.backupSettings.deleteMany();
		}
		if (Array.isArray(data.vapidKeys)) {
			await tx.vapidKeys.deleteMany();
		}

		// System settings are independent of user/instance cascades. Preserve
		// them for legacy files that predate this payload coverage.
		if (Array.isArray(data.systemSettings)) {
			await tx.systemSettings.deleteMany();
		}

		// Core tables (existing)
		await tx.serviceInstanceTag.deleteMany();
		await tx.serviceTag.deleteMany();
		await tx.serviceInstance.deleteMany();
		await tx.webAuthnCredential.deleteMany();
		await tx.oIDCAccount.deleteMany();
		// OIDC providers are independent of the user/instance cascades too.
		// Legacy files may omit them, so do not turn omission into deletion.
		if (Array.isArray(data.oidcProviders)) {
			await tx.oIDCProvider.deleteMany();
		}
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

		if (Array.isArray(data.backupSettings) && data.backupSettings.length > 0) {
			validateRecords(data.backupSettings, "backupSettings", ["id"]);
			const settings = data.backupSettings[0] as Prisma.BackupSettingsCreateInput;
			await tx.backupSettings.create({ data: { ...settings, id: 1 } });
		}

		if (Array.isArray(data.vapidKeys) && data.vapidKeys.length > 0) {
			validateRecords(data.vapidKeys, "vapidKeys", ["id", "publicKey"]);
			const keys = data.vapidKeys[0] as Prisma.VapidKeysCreateInput;
			await tx.vapidKeys.create({ data: { ...keys, id: 1 } });
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

		if (data.namingDeployHistory && data.namingDeployHistory.length > 0) {
			validateRecords(data.namingDeployHistory, "namingDeployHistory", [
				"id",
				"instanceId",
				"userId",
				"status",
			]);
			await tx.namingDeployHistory.createMany({
				data: data.namingDeployHistory as Prisma.NamingDeployHistoryCreateManyInput[],
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

		// Durable configuration (dependency order).
		if (data.notificationChannel && data.notificationChannel.length > 0) {
			validateRecords(data.notificationChannel, "notificationChannel", ["id", "userId"]);
			await tx.notificationChannel.createMany({
				data: data.notificationChannel as Prisma.NotificationChannelCreateManyInput[],
			});
		}
		if (data.notificationSubscription && data.notificationSubscription.length > 0) {
			validateRecords(data.notificationSubscription, "notificationSubscription", [
				"channelId",
				"eventType",
			]);
			await tx.notificationSubscription.createMany({
				data: data.notificationSubscription as Prisma.NotificationSubscriptionCreateManyInput[],
			});
		}
		if (data.notificationRule && data.notificationRule.length > 0) {
			validateRecords(data.notificationRule, "notificationRule", ["id", "userId"]);
			await tx.notificationRule.createMany({
				data: data.notificationRule as Prisma.NotificationRuleCreateManyInput[],
			});
		}
		if (data.notificationAggregationConfig && data.notificationAggregationConfig.length > 0) {
			validateRecords(data.notificationAggregationConfig, "notificationAggregationConfig", [
				"id",
				"userId",
			]);
			await tx.notificationAggregationConfig.createMany({
				data: data.notificationAggregationConfig as Prisma.NotificationAggregationConfigCreateManyInput[],
			});
		}
		if (data.autoTagRule && data.autoTagRule.length > 0) {
			validateRecords(data.autoTagRule, "autoTagRule", ["id", "userId"]);
			await tx.autoTagRule.createMany({
				data: data.autoTagRule as Prisma.AutoTagRuleCreateManyInput[],
			});
		}
		if (data.labelSyncRule && data.labelSyncRule.length > 0) {
			validateRecords(data.labelSyncRule, "labelSyncRule", ["id", "userId"]);
			await tx.labelSyncRule.createMany({
				data: data.labelSyncRule as Prisma.LabelSyncRuleCreateManyInput[],
			});
		}
		if (data.queueCleanerConfig && data.queueCleanerConfig.length > 0) {
			validateRecords(data.queueCleanerConfig, "queueCleanerConfig", ["id", "instanceId"]);
			await tx.queueCleanerConfig.createMany({
				data: data.queueCleanerConfig as Prisma.QueueCleanerConfigCreateManyInput[],
			});
		}
		if (data.libraryCleanupConfig && data.libraryCleanupConfig.length > 0) {
			validateRecords(data.libraryCleanupConfig, "libraryCleanupConfig", ["id", "userId"]);
			await tx.libraryCleanupConfig.createMany({
				data: data.libraryCleanupConfig as Prisma.LibraryCleanupConfigCreateManyInput[],
			});
		}
		if (data.libraryCleanupRule && data.libraryCleanupRule.length > 0) {
			validateRecords(data.libraryCleanupRule, "libraryCleanupRule", ["id", "configId"]);
			await tx.libraryCleanupRule.createMany({
				data: data.libraryCleanupRule as Prisma.LibraryCleanupRuleCreateManyInput[],
			});
		}
		if (data.libraryCleanupApproval && data.libraryCleanupApproval.length > 0) {
			validateRecords(data.libraryCleanupApproval, "libraryCleanupApproval", [
				"id",
				"configId",
				"instanceId",
				"status",
				"sizeOnDisk",
				"expiresAt",
			]);
			await tx.libraryCleanupApproval.createMany({
				data: data.libraryCleanupApproval.map((row) => ({
					...(row as Prisma.LibraryCleanupApprovalCreateManyInput),
					terminalAuditRecordedAt: null,
					terminalAuditRecoveryAttemptedAt: null,
					sizeOnDisk:
						typeof (row as Record<string, unknown>).sizeOnDisk === "string"
							? BigInt((row as Record<string, unknown>).sizeOnDisk as string)
							: (row as Prisma.LibraryCleanupApprovalCreateManyInput).sizeOnDisk,
				})) as Prisma.LibraryCleanupApprovalCreateManyInput[],
			});
		}
		if (data.libraryCleanupMediaServerScan && data.libraryCleanupMediaServerScan.length > 0) {
			validateRecords(data.libraryCleanupMediaServerScan, "libraryCleanupMediaServerScan", [
				"id",
				"approvalId",
				"instanceId",
				"service",
				"mediaType",
				"targetKey",
				"status",
			]);
			await tx.libraryCleanupMediaServerScan.createMany({
				data: data.libraryCleanupMediaServerScan as Prisma.LibraryCleanupMediaServerScanCreateManyInput[],
			});
		}
		if (data.namingConfig && data.namingConfig.length > 0) {
			validateRecords(data.namingConfig, "namingConfig", ["id", "instanceId", "userId"]);
			await tx.namingConfig.createMany({
				data: data.namingConfig as Prisma.NamingConfigCreateManyInput[],
			});
		}
		if (data.userCustomFormat && data.userCustomFormat.length > 0) {
			validateRecords(data.userCustomFormat, "userCustomFormat", ["id", "userId"]);
			await tx.userCustomFormat.createMany({
				data: data.userCustomFormat as Prisma.UserCustomFormatCreateManyInput[],
			});
		}
	});
}
