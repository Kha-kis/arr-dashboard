export const MANUALLY_RESOLVED_ROLLBACK_STATUS = "MANUALLY_RESOLVED";

interface ManualResolutionRecord {
	status?: unknown;
	backupId?: unknown;
	rolledBack?: unknown;
	rollbackStatus?: unknown;
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
