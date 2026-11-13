import {
	type LabelSyncMutationAttemptRecord,
	type LabelSyncRestoreEvidence,
	parseLabelSyncMutationAttempt,
} from "./jellyfin-mutation-state.js";

/** Pure preparation of portable evidence; never acquires worker authority. */
export function prepareRestoredLabelSyncMutationAttempt(
	value: unknown,
): LabelSyncMutationAttemptRecord {
	const original = parseLabelSyncMutationAttempt(value);
	if (original.status === "restored-held") {
		return parseLabelSyncMutationAttempt({ ...original, claimToken: null });
	}
	if (
		original.status !== "claimed" &&
		original.status !== "sending" &&
		original.status !== "unknown"
	) {
		return original;
	}
	const evidence: LabelSyncRestoreEvidence = {
		version: 1,
		originalStatus: original.status,
		originalReasonCode: original.reasonCode,
		originalSendAttemptCount: original.sendAttemptCount,
		originalReconcileAttemptCount: original.reconcileAttemptCount,
		originalRequestStartedAt: original.requestStartedAt?.toISOString() ?? null,
		originalLastObservedAt: original.lastObservedAt?.toISOString() ?? null,
		originalCreatedAt: original.createdAt.toISOString(),
		originalUpdatedAt: original.updatedAt.toISOString(),
	};
	return parseLabelSyncMutationAttempt({
		...original,
		status: "restored-held",
		reasonCode: "restore_uncertain",
		claimToken: null,
		restoreEvidence: JSON.stringify(evidence),
	});
}
