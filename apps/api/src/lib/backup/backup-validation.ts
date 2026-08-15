/**
 * Backup Validation
 *
 * Pure validation functions for backup data structures.
 * No side effects — only type checking and structural validation.
 */

import type { BackupData } from "@arr/shared";
import { ArrClientFactory } from "../arr/client-factory.js";
import { Encryptor } from "../auth/encryption.js";
import {
	parseDeploymentBackupState,
	shouldRetainDeploymentBackup,
} from "../trash-guides/deployment-backup-state.js";
import {
	isLegacyTerminalSyncHistory,
	isManuallyResolvedSyncHistory,
} from "../trash-guides/deployment-recovery-state.js";
import {
	createDeploymentConnectionStateToken,
	isDeploymentBackupEndpointIdentityCurrent,
	normalizeDeploymentBaseUrl,
} from "../trash-guides/deployment-target.js";
import type { EncryptedBackupEnvelope } from "./backup-crypto.js";

export const BACKUP_VERSION = "1.1";
export const LEGACY_BACKUP_VERSION = "1.0";

const SUPPORTED_BACKUP_VERSIONS = new Set([LEGACY_BACKUP_VERSION, BACKUP_VERSION]);

type CoordinationRecord = Record<string, unknown>;
type CoordinationValidationOptions = {
	credentialIdentityForInstance?: (instance: {
		id: string;
		service: string;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials?: string | null;
		httpAuthEncryptionIv?: string | null;
	}) => string;
};

export type CoordinationState = {
	backupId?: unknown;
	canRollback?: unknown;
	rollbackStatus?: unknown;
	undeployStatus?: unknown;
	status?: unknown;
	rolledBack?: unknown;
};

function isRecord(value: unknown): value is CoordinationRecord {
	return typeof value === "object" && value !== null;
}

function isNonterminalStatus(value: unknown): boolean {
	return typeof value === "string" && value !== "COMPLETED";
}

const NONTERMINAL_SYNC_STATUSES = new Set(["IN_PROGRESS", "RUNNING"]);
const NONTERMINAL_DEPLOYMENT_STATUSES = new Set(["PARTIAL_UNDEPLOY", "IN_PROGRESS"]);
const ACTIVE_SYNC_OWNER_STATUSES = new Set(["SUCCESS", "PARTIAL_SUCCESS", "UNCERTAIN"]);
const ACTIVE_DEPLOYMENT_OWNER_STATUSES = new Set(["SUCCESS", "PARTIAL_SUCCESS", "UNCERTAIN"]);

export function isAuditOnlyUncertainSync(record: CoordinationState): boolean {
	return (
		record.status === "UNCERTAIN" &&
		record.rollbackStatus == null &&
		record.backupId == null &&
		record.rolledBack !== true
	);
}

export function isAuditOnlyUncertainDeployment(record: CoordinationState): boolean {
	return (
		record.status === "UNCERTAIN" &&
		record.undeployStatus == null &&
		record.backupId == null &&
		record.rolledBack === false &&
		record.canRollback === false
	);
}

export function isNonterminalRollback(record: CoordinationState): boolean {
	if (isManuallyResolvedSyncHistory(record)) {
		return false;
	}
	if (isLegacyTerminalSyncHistory(record)) {
		return false;
	}
	if (isAuditOnlyUncertainSync(record)) {
		return false;
	}
	if (record.rolledBack === true || record.rollbackStatus === "COMPLETED") {
		return false;
	}

	return (
		isNonterminalStatus(record.rollbackStatus) ||
		(typeof record.status === "string" && NONTERMINAL_SYNC_STATUSES.has(record.status)) ||
		(record.rolledBack === false &&
			typeof record.status === "string" &&
			ACTIVE_SYNC_OWNER_STATUSES.has(record.status))
	);
}

export function isNonterminalUndeploy(record: CoordinationState): boolean {
	if (isAuditOnlyUncertainDeployment(record)) {
		return false;
	}
	if (record.rolledBack === true || record.undeployStatus === "COMPLETED") {
		return false;
	}

	return (
		isNonterminalStatus(record.undeployStatus) ||
		(typeof record.status === "string" && NONTERMINAL_DEPLOYMENT_STATUSES.has(record.status)) ||
		(record.rolledBack === false &&
			typeof record.status === "string" &&
			ACTIVE_DEPLOYMENT_OWNER_STATUSES.has(record.status))
	);
}

/**
 * Convert snapshotless v1.0 partial undeploy rows into honest audit-only state.
 * These legacy payloads predate v1.1's recovery-evidence contract and cannot
 * safely claim that undeploy or rollback remains resumable without a snapshot.
 */
export function normalizeBackupForRestore(backup: BackupData): BackupData {
	if (backup.version !== LEGACY_BACKUP_VERSION) {
		return backup;
	}

	const snapshots = Array.isArray(backup.data.trashBackups) ? backup.data.trashBackups : [];
	const snapshotIds = new Set<string>();
	for (const snapshot of snapshots) {
		if (isRecord(snapshot) && typeof snapshot.id === "string" && snapshot.id.length > 0) {
			snapshotIds.add(snapshot.id);
		}
	}
	const deploymentHistory = Array.isArray(backup.data.templateDeploymentHistory)
		? backup.data.templateDeploymentHistory
		: [];
	let changed = false;
	const normalizedDeploymentHistory = deploymentHistory.map((row) => {
		if (!isRecord(row)) {
			return row;
		}
		if (
			row.status !== "PARTIAL_UNDEPLOY" ||
			(typeof row.backupId === "string" && snapshotIds.has(row.backupId))
		) {
			return row;
		}

		changed = true;
		return {
			...row,
			status: "UNCERTAIN",
			undeployStatus: null,
			backupId: null,
			canRollback: false,
		};
	});

	if (!changed) {
		return backup;
	}

	return {
		...backup,
		data: {
			...backup.data,
			templateDeploymentHistory: normalizedDeploymentHistory,
		},
	};
}

function coordinationId(record: CoordinationRecord): string {
	return typeof record.id === "string" && record.id.length > 0 ? record.id : "<unknown>";
}

function recordsById(value: unknown, label: string): Map<string, CoordinationRecord> {
	const records = new Map<string, CoordinationRecord>();
	if (!Array.isArray(value)) {
		return records;
	}

	for (const record of value) {
		if (isRecord(record) && typeof record.id === "string" && record.id.length > 0) {
			if (records.has(record.id)) {
				throw new Error(
					`Invalid TRaSH recovery evidence: duplicate ${label} identity ${record.id}`,
				);
			}
			records.set(record.id, record);
		}
	}

	return records;
}

function validateDeploymentLedgerBinding(
	snapshot: CoordinationRecord,
	instance: CoordinationRecord,
	rowId: string,
	kind: "rollback" | "undeploy",
	options: CoordinationValidationOptions,
): void {
	let ledger: ReturnType<typeof parseDeploymentBackupState>;
	try {
		ledger = parseDeploymentBackupState(snapshot.backupData as string);
	} catch {
		// Positively identified pre-ledger snapshots remain restorable. Unknown,
		// malformed, and malformed schema-v2 payloads still fail closed.
		if (!shouldRetainDeploymentBackup(snapshot.backupData as string)) return;
		throw new Error(
			`Invalid ${kind} coordination evidence for row ${rowId}: referenced snapshot ${snapshot.id} has an invalid deployment ledger`,
		);
	}

	if (
		typeof instance.userId !== "string" ||
		typeof instance.service !== "string" ||
		typeof instance.baseUrl !== "string" ||
		typeof instance.encryptedApiKey !== "string" ||
		typeof instance.encryptionIv !== "string" ||
		(instance.encryptedHttpAuthCredentials !== null &&
			instance.encryptedHttpAuthCredentials !== undefined &&
			typeof instance.encryptedHttpAuthCredentials !== "string") ||
		(instance.httpAuthEncryptionIv !== null &&
			instance.httpAuthEncryptionIv !== undefined &&
			typeof instance.httpAuthEncryptionIv !== "string") ||
		(instance.connectionGeneration !== undefined &&
			(typeof instance.connectionGeneration !== "number" ||
				!Number.isSafeInteger(instance.connectionGeneration) ||
				instance.connectionGeneration < 0))
	) {
		throw new Error(
			`Invalid ${kind} coordination evidence for row ${rowId}: service instance ${snapshot.instanceId} cannot verify its deployment ledger binding`,
		);
	}

	const connectionInstance = {
		id: snapshot.instanceId as string,
		service: instance.service,
		baseUrl: instance.baseUrl,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials as
			| string
			| null
			| undefined,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv as string | null | undefined,
		connectionGeneration: instance.connectionGeneration as number | undefined,
	};
	const currentPrefix = `${instance.userId}:${instance.service.toUpperCase()}:${normalizeDeploymentBaseUrl(instance.baseUrl)}:`;
	const legacyPrefix = `${instance.userId}:${instance.service.toUpperCase()}:`;
	const embeddedCredentialIdentity = ledger.endpointKey.startsWith(currentPrefix)
		? ledger.endpointKey.slice(currentPrefix.length)
		: ledger.endpointKey.startsWith(legacyPrefix)
			? ledger.endpointKey.slice(legacyPrefix.length)
			: "";
	let credentialIdentity = embeddedCredentialIdentity;
	if (options.credentialIdentityForInstance) {
		try {
			credentialIdentity = options.credentialIdentityForInstance(connectionInstance);
		} catch {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: service instance ${snapshot.instanceId} cannot decrypt its deployment credentials`,
			);
		}
	}
	if (
		embeddedCredentialIdentity.length === 0 ||
		credentialIdentity.length === 0 ||
		ledger.connectionStateToken !== createDeploymentConnectionStateToken(connectionInstance) ||
		!isDeploymentBackupEndpointIdentityCurrent({
			userId: instance.userId,
			backupEndpointKey: ledger.endpointKey,
			backupConnectionStateToken: ledger.connectionStateToken,
			instance: connectionInstance,
			credentialIdentity,
		})
	) {
		throw new Error(
			`Invalid ${kind} coordination evidence for row ${rowId}: referenced snapshot ${snapshot.id} belongs to a different ARR connection`,
		);
	}
}

/**
 * Verify that rollback/undeploy work can still be resumed after restore.
 * This runs before secrets or database state are changed.
 */
export function validateCoordinationEvidence(
	data: Record<string, unknown>,
	options: CoordinationValidationOptions = {},
): void {
	const instancesById = recordsById(data.serviceInstances, "service instance");
	const templatesById = recordsById(data.trashTemplates, "template");
	const snapshots = Array.isArray(data.trashBackups) ? data.trashBackups : [];
	const snapshotsById = new Map<string, CoordinationRecord>();
	for (let index = 0; index < snapshots.length; index++) {
		const snapshot = snapshots[index];
		if (!isRecord(snapshot) || typeof snapshot.id !== "string" || snapshot.id.length === 0) {
			throw new Error(
				`Invalid TRaSH recovery snapshot at index ${index}: missing snapshot identity`,
			);
		}
		if (snapshotsById.has(snapshot.id)) {
			throw new Error(
				`Invalid TRaSH recovery evidence: duplicate backup snapshot identity ${snapshot.id}`,
			);
		}
		if (
			typeof snapshot.instanceId !== "string" ||
			snapshot.instanceId.length === 0 ||
			typeof snapshot.userId !== "string" ||
			snapshot.userId.length === 0
		) {
			throw new Error(
				`Invalid TRaSH recovery snapshot ${snapshot.id}: missing instance or owner identity`,
			);
		}

		const instance = instancesById.get(snapshot.instanceId);
		if (!instance) {
			throw new Error(
				`Invalid TRaSH recovery snapshot ${snapshot.id}: referenced service instance ${snapshot.instanceId} is missing`,
			);
		}
		if (instance.userId !== snapshot.userId) {
			throw new Error(
				`Invalid TRaSH recovery snapshot ${snapshot.id}: owner does not match service instance ${snapshot.instanceId}`,
			);
		}

		snapshotsById.set(snapshot.id, snapshot);
	}

	const requiredRows: Array<{ kind: "rollback" | "undeploy"; row: CoordinationRecord }> = [];
	if (Array.isArray(data.trashSyncHistory)) {
		for (const row of data.trashSyncHistory) {
			if (isRecord(row) && isNonterminalRollback(row)) {
				requiredRows.push({ kind: "rollback", row });
			}
		}
	}
	if (Array.isArray(data.templateDeploymentHistory)) {
		for (const row of data.templateDeploymentHistory) {
			if (isRecord(row) && isNonterminalUndeploy(row)) {
				requiredRows.push({ kind: "undeploy", row });
			}
		}
	}

	for (const { kind, row } of requiredRows) {
		const rowId = coordinationId(row);
		if (
			typeof row.instanceId !== "string" ||
			row.instanceId.length === 0 ||
			typeof row.userId !== "string" ||
			row.userId.length === 0
		) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: missing instance or owner identity`,
			);
		}

		const instance = instancesById.get(row.instanceId);
		if (!instance) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: referenced service instance ${row.instanceId} is missing`,
			);
		}
		if (instance.userId !== row.userId) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: owner does not match service instance ${row.instanceId}`,
			);
		}

		const requiresTemplate =
			kind === "undeploy" || (row.templateId !== null && row.templateId !== undefined);
		if (requiresTemplate) {
			if (typeof row.templateId !== "string" || row.templateId.length === 0) {
				throw new Error(
					`Invalid ${kind} coordination evidence for row ${rowId}: missing template reference`,
				);
			}

			const template = templatesById.get(row.templateId);
			if (!template) {
				throw new Error(
					`Invalid ${kind} coordination evidence for row ${rowId}: referenced template ${row.templateId} is missing`,
				);
			}
			if (template.userId !== row.userId) {
				throw new Error(
					`Invalid ${kind} coordination evidence for row ${rowId}: owner does not match template ${row.templateId}`,
				);
			}
		}

		if (typeof row.backupId !== "string" || row.backupId.length === 0) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: missing backup snapshot reference`,
			);
		}

		const snapshot = snapshotsById.get(row.backupId);
		if (!snapshot) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: referenced snapshot ${row.backupId} is missing`,
			);
		}
		if (
			snapshot.instanceId !== row.instanceId ||
			snapshot.userId !== row.userId ||
			typeof snapshot.backupData !== "string" ||
			snapshot.backupData.length === 0
		) {
			throw new Error(
				`Invalid ${kind} coordination evidence for row ${rowId}: referenced snapshot ${row.backupId} is incomplete or belongs to a different instance or owner`,
			);
		}
		validateDeploymentLedgerBinding(snapshot, instance, rowId, kind, options);
	}
}

/**
 * Validate that an object is a valid encrypted backup envelope
 * Performs strict type checking on all required fields to prevent misclassification
 */
export function isEncryptedBackupEnvelope(obj: unknown): obj is EncryptedBackupEnvelope {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const envelope = obj as Record<string, unknown>;

	// Validate all required fields with correct types
	return (
		typeof envelope.version === "string" &&
		typeof envelope.salt === "string" &&
		typeof envelope.iv === "string" &&
		typeof envelope.tag === "string" &&
		typeof envelope.cipherText === "string" &&
		typeof envelope.kdfParams === "object" &&
		envelope.kdfParams !== null &&
		typeof (envelope.kdfParams as Record<string, unknown>).algorithm === "string" &&
		typeof (envelope.kdfParams as Record<string, unknown>).hash === "string" &&
		typeof (envelope.kdfParams as Record<string, unknown>).iterations === "number" &&
		typeof (envelope.kdfParams as Record<string, unknown>).saltLength === "number"
	);
}

/**
 * Validate that an object is a valid plaintext backup (legacy format)
 * Performs strict type checking on all required fields to prevent misclassification
 */
export function isPlaintextBackup(obj: unknown): obj is BackupData {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const backup = obj as Record<string, unknown>;

	// Validate all required top-level fields with correct types
	return (
		typeof backup.version === "string" &&
		typeof backup.appVersion === "string" &&
		typeof backup.timestamp === "string" &&
		typeof backup.data === "object" &&
		backup.data !== null &&
		typeof backup.secrets === "object" &&
		backup.secrets !== null &&
		// Ensure this isn't an encrypted envelope (no cipherText field)
		!("cipherText" in backup)
	);
}

/**
 * Validate that records have the expected shape before inserting
 * Prevents runtime errors from corrupted or incompatible backup data
 */
export function validateRecords(
	records: unknown[],
	entityType: string,
	requiredFields: string[],
): void {
	for (let i = 0; i < records.length; i++) {
		const record = records[i];

		if (!record || typeof record !== "object") {
			throw new Error(`Invalid ${entityType} record at index ${i}: not an object`);
		}

		const recordObj = record as Record<string, unknown>;
		for (const field of requiredFields) {
			if (!(field in recordObj) || recordObj[field] === undefined) {
				throw new Error(
					`Invalid ${entityType} record at index ${i}: missing required field '${field}'`,
				);
			}

			// Basic type check: ensure field is a primitive (string, number, boolean) or Date
			// Complex objects likely indicate corrupted or incompatible backup data
			const value = recordObj[field];
			if (value !== null && typeof value === "object" && !(value instanceof Date)) {
				throw new Error(
					`Invalid ${entityType} record at index ${i}: field '${field}' has unexpected type (expected primitive, got object)`,
				);
			}
		}
	}
}

/**
 * Validate backup structure
 */
export function validateBackup(backup: unknown): asserts backup is BackupData {
	if (typeof backup !== "object" || backup === null) {
		throw new Error("Invalid backup format: not an object");
	}

	const b = backup as Partial<BackupData>;

	if (!b.version || typeof b.version !== "string") {
		throw new Error("Invalid backup format: missing or invalid version");
	}

	if (!SUPPORTED_BACKUP_VERSIONS.has(b.version)) {
		throw new Error(
			`Unsupported backup version: ${b.version} (supported: ${[...SUPPORTED_BACKUP_VERSIONS].join(", ")})`,
		);
	}

	if (!b.data || typeof b.data !== "object") {
		throw new Error("Invalid backup format: missing or invalid data");
	}

	if (!b.secrets || typeof b.secrets !== "object") {
		throw new Error("Invalid backup format: missing or invalid secrets");
	}

	// Validate required data fields
	const requiredFields = [
		"users",
		"sessions",
		"serviceInstances",
		"serviceTags",
		"serviceInstanceTags",
		"oidcAccounts",
		"webAuthnCredentials",
	];

	const dataRecord = b.data as Record<string, unknown>;
	for (const field of requiredFields) {
		if (!Array.isArray(dataRecord[field])) {
			throw new Error(`Invalid backup format: missing or invalid data.${field}`);
		}
	}

	// Optional fields for backward compatibility
	// These fields were added in later versions, so old backups may not have them
	const optionalArrayFields = [
		"oidcProviders",
		// System settings
		"systemSettings",
		// TRaSH Guides configuration
		"trashTemplates",
		"trashSettings",
		"trashSyncSchedules",
		"templateQualityProfileMappings",
		"instanceQualityProfileOverrides",
		"standaloneCFDeployments",
		// TRaSH Guides history/audit
		"trashSyncHistory",
		"templateDeploymentHistory",
		// TRaSH instance backups (optional, can be large)
		"trashBackups",
		// Hunting feature
		"huntConfigs",
		"huntLogs",
		"huntSearchHistory",
	];

	for (const field of optionalArrayFields) {
		if (dataRecord[field] !== undefined && !Array.isArray(dataRecord[field])) {
			throw new Error(`Invalid backup format: ${field} must be an array`);
		}
	}

	// Validate required secret fields
	if (
		typeof b.secrets.encryptionKey !== "string" ||
		typeof b.secrets.sessionCookieSecret !== "string"
	) {
		throw new Error("Invalid backup format: missing or invalid secrets");
	}

	if (b.version === BACKUP_VERSION) {
		const encryptionKey = b.secrets.encryptionKey;
		let credentialFactory: ArrClientFactory | undefined;
		validateCoordinationEvidence(dataRecord, {
			credentialIdentityForInstance: (instance) => {
				credentialFactory ??= new ArrClientFactory(new Encryptor(encryptionKey));
				return credentialFactory.createConnectionCredentialIdentity(instance as never);
			},
		});
	}
}
