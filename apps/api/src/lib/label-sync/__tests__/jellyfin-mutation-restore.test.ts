import { describe, expect, it } from "vitest";

const claimed = {
	id: "attempt-1",
	userId: "owner-1",
	ruleId: "rule-1",
	destinationInstanceId: "destination-1",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 123,
	connectionGeneration: 0,
	identityGeneration: 1,
	targetItemId: "item-1",
	libraryId: "library-1",
	intentFingerprint: "intent-1",
	ruleFingerprint: "rule-fingerprint-1",
	destinationTag: "tag-1",
	activeOperationKey: "hold-1",
	claimToken: "source-worker",
	sendAttemptCount: 0,
	reconcileAttemptCount: 0,
	requestStartedAt: null,
	lastObservedAt: null,
	completedAt: null,
	status: "claimed",
	reasonCode: null,
	createdAt: "2026-09-05T00:00:00.000Z",
	updatedAt: "2026-09-05T00:00:00.000Z",
};
const originalEvidence = {
	version: 1,
	originalStatus: "claimed",
	originalReasonCode: null,
	originalSendAttemptCount: 0,
	originalReconcileAttemptCount: 0,
	originalRequestStartedAt: null,
	originalLastObservedAt: null,
	originalCreatedAt: "2026-09-05T00:00:00.000Z",
	originalUpdatedAt: "2026-09-05T00:00:00.000Z",
};

describe("pure restored-held label preparation", () => {
	it.each([
		{ status: "claimed", sendAttemptCount: 0, requestStartedAt: null, reasonCode: null },
		{
			status: "sending",
			sendAttemptCount: 1,
			requestStartedAt: "2026-09-05T00:00:00.000Z",
			reasonCode: null,
		},
		{
			status: "unknown",
			sendAttemptCount: 1,
			requestStartedAt: "2026-09-05T00:00:00.000Z",
			reasonCode: "uncertain_send",
		},
	])("retains the $status snapshot hold without importing source ownership", async (patch) => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		const input = Object.freeze({
			...claimed,
			...patch,
			claimToken: patch.status === "unknown" ? null : claimed.claimToken,
		});
		const before = JSON.stringify(input);
		const held = prepareRestoredLabelSyncMutationAttempt(input);
		expect(held).toMatchObject({
			id: "attempt-1",
			userId: "owner-1",
			ruleId: "rule-1",
			destinationInstanceId: "destination-1",
			targetItemId: "item-1",
			libraryId: "library-1",
			activeOperationKey: "hold-1",
			intentFingerprint: "intent-1",
			ruleFingerprint: "rule-fingerprint-1",
			destinationTag: "tag-1",
			connectionGeneration: 0,
			identityGeneration: 1,
			status: "restored-held",
			claimToken: null,
			completedAt: null,
			sendAttemptCount: patch.sendAttemptCount,
			reconcileAttemptCount: 0,
			reasonCode: "restore_uncertain",
		});
		expect(held.requestStartedAt?.toISOString() ?? null).toBe(patch.requestStartedAt);
		expect(JSON.parse(held.restoreEvidence!)).toEqual({
			...originalEvidence,
			originalStatus: patch.status,
			originalReasonCode: patch.reasonCode,
			originalSendAttemptCount: patch.sendAttemptCount,
			originalRequestStartedAt: patch.requestStartedAt,
		});
		expect(held.restoreEvidence).not.toContain("source-worker");
		expect(JSON.stringify(input)).toBe(before);
	});

	it("retains prior observation counts and bounded unknown evidence", async () => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		const held = prepareRestoredLabelSyncMutationAttempt({
			...claimed,
			status: "unknown",
			claimToken: "source-observer",
			sendAttemptCount: 1,
			requestStartedAt: "2026-09-05T00:00:00.000Z",
			reconcileAttemptCount: 3,
			reasonCode: "reconciliation_unavailable",
			lastObservedAt: "2026-09-05T00:01:00.000Z",
		});
		expect(held.reconcileAttemptCount).toBe(3);
		expect(held.lastObservedAt?.toISOString()).toBe("2026-09-05T00:01:00.000Z");
		expect(JSON.parse(held.restoreEvidence!)).toMatchObject({
			originalStatus: "unknown",
			originalReasonCode: "reconciliation_unavailable",
			originalReconcileAttemptCount: 3,
			originalLastObservedAt: "2026-09-05T00:01:00.000Z",
		});
		expect(held.claimToken).toBeNull();
	});

	it("re-prepares held work without nesting evidence or resetting fresh checks", async () => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		const input = Object.freeze({
			...claimed,
			status: "restored-held",
			reasonCode: "reconciliation_unavailable",
			claimToken: "fresh-observer",
			reconcileAttemptCount: 2,
			lastObservedAt: "2026-09-05T00:02:00.000Z",
			restoreEvidence: JSON.stringify(originalEvidence),
		});
		const held = prepareRestoredLabelSyncMutationAttempt(input);
		expect(held.restoreEvidence).toBe(JSON.stringify(originalEvidence));
		expect(held).toMatchObject({
			status: "restored-held",
			activeOperationKey: "hold-1",
			claimToken: null,
			reconcileAttemptCount: 2,
			reasonCode: "reconciliation_unavailable",
			sendAttemptCount: 0,
			requestStartedAt: null,
		});
		expect(held.lastObservedAt?.toISOString()).toBe("2026-09-05T00:02:00.000Z");
		expect(prepareRestoredLabelSyncMutationAttempt(held)).toEqual(held);
		expect(input.claimToken).toBe("fresh-observer");
	});

	it("leaves native terminal evidence terminal and does not create a hold", async () => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		const failed = prepareRestoredLabelSyncMutationAttempt({
			...claimed,
			status: "failed",
			reasonCode: "startup_before_send",
			activeOperationKey: null,
			claimToken: null,
			completedAt: "2026-09-05T00:01:00.000Z",
		});
		expect(failed).toMatchObject({
			status: "failed",
			reasonCode: "startup_before_send",
			activeOperationKey: null,
			claimToken: null,
			restoreEvidence: null,
			sendAttemptCount: 0,
		});
	});

	it("preserves a reconciled zero-send observation without promoting it to applied", async () => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		const input = {
			...claimed,
			status: "reconciled",
			reasonCode: "desired_state_observed",
			activeOperationKey: null,
			claimToken: null,
			reconcileAttemptCount: 1,
			lastObservedAt: "2026-09-05T00:01:00.000Z",
			completedAt: "2026-09-05T00:01:00.000Z",
			restoreEvidence: JSON.stringify(originalEvidence),
		};
		expect(prepareRestoredLabelSyncMutationAttempt(input)).toMatchObject({
			status: "reconciled",
			reasonCode: "desired_state_observed",
			sendAttemptCount: 0,
			requestStartedAt: null,
			restoreEvidence: JSON.stringify(originalEvidence),
		});
	});

	it("refuses malformed original evidence instead of silently dropping uncertainty", async () => {
		const { prepareRestoredLabelSyncMutationAttempt } = await import(
			"../jellyfin-mutation-restore.js"
		);
		expect(() => prepareRestoredLabelSyncMutationAttempt({ ...claimed, claimToken: null })).toThrow(
			"Invalid label sync mutation attempt",
		);
		expect(() =>
			prepareRestoredLabelSyncMutationAttempt({
				...claimed,
				status: "restored-held",
				claimToken: null,
				reasonCode: "restore_uncertain",
				restoreEvidence: JSON.stringify({ ...originalEvidence, originalSendAttemptCount: 1 }),
			}),
		).toThrow("Invalid label sync mutation attempt");
	});
});
