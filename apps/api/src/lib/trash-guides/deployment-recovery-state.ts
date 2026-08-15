export const MANUALLY_RESOLVED_ROLLBACK_STATUS = "MANUALLY_RESOLVED";

interface ManualResolutionRecord {
	status?: unknown;
	backupId?: unknown;
	rolledBack?: unknown;
	rollbackStatus?: unknown;
}

interface LegacyTerminalSyncRecord {
	status?: unknown;
	backupId?: unknown;
	rolledBack?: unknown;
	rollbackStatus?: unknown;
}

/** Identify pre-ledger terminal sync wrappers that never owned rollback state. */
export function isLegacyTerminalSyncHistory(record: LegacyTerminalSyncRecord): boolean {
	return (
		(record.status === "SUCCESS" || record.status === "FAILED") &&
		record.backupId === null &&
		record.rolledBack === false &&
		record.rollbackStatus === null
	);
}

/** Identify the exact audit state for a reviewed sync that had no rollback ledger. */
export function isManuallyResolvedSyncHistory(record: ManualResolutionRecord): boolean {
	return (
		record.status === "FAILED" &&
		record.backupId === null &&
		record.rolledBack === false &&
		record.rollbackStatus === MANUALLY_RESOLVED_ROLLBACK_STATUS
	);
}
