import { describe, expect, it } from "vitest";
import {
	MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
	parseLabelSyncMutationAttempt,
	parseLabelSyncMutationReasonCode,
	parseLabelSyncMutationStatus,
	validateLabelSyncMutationAttemptLifecycle,
} from "../jellyfin-mutation-state.js";

const baseAttempt = {
	id: "attempt-1",
	userId: "user-1",
	ruleId: "rule-1",
	destinationInstanceId: "instance-1",
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
	activeOperationKey: "active-1",
	claimToken: "claim-1",
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

describe("Jellyfin/Emby mutation state codecs", () => {
	it("accepts only the finite status and reason vocabularies", () => {
		expect(parseLabelSyncMutationStatus("claimed")).toBe("claimed");
		expect(() => parseLabelSyncMutationStatus("sending-now")).toThrow();
		expect(parseLabelSyncMutationReasonCode("provider_unavailable")).toBe("provider_unavailable");
		expect(() => parseLabelSyncMutationReasonCode("provider-error-details")).toThrow();
	});

	it("enforces unresolved and terminal active-key/claim-token invariants", () => {
		expect(parseLabelSyncMutationAttempt(baseAttempt).status).toBe("claimed");
		expect(() =>
			parseLabelSyncMutationAttempt({ ...baseAttempt, activeOperationKey: null }),
		).toThrow();
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				status: "verified",
				activeOperationKey: "active-1",
			}),
		).toThrow();
		const reconciling = parseLabelSyncMutationAttempt({
			...baseAttempt,
			status: "unknown",
			claimToken: "claim-1",
			requestStartedAt: "2026-09-05T00:00:00.000Z",
			sendAttemptCount: 1,
			reconcileAttemptCount: 1,
			reasonCode: "uncertain_send",
		});
		expect(reconciling.claimToken).toBe("claim-1");
	});

	it("enforces the operational lifecycle for claimed, sending, and unknown rows", () => {
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				requestStartedAt: "2026-09-05T00:00:00.000Z",
			}),
		).toThrow();
		expect(() => parseLabelSyncMutationAttempt({ ...baseAttempt, sendAttemptCount: 1 })).toThrow();

		for (const status of ["sending", "unknown"] as const) {
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					status,
					claimToken: status === "sending" ? "claim-1" : null,
				}),
			).toThrow();
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					status,
					claimToken: status === "sending" ? "claim-1" : null,
					requestStartedAt: "2026-09-05T00:00:00.000Z",
				}),
			).toThrow();
		}

		const reconciledUnknown = parseLabelSyncMutationAttempt({
			...baseAttempt,
			status: "unknown",
			claimToken: null,
			requestStartedAt: "2026-09-05T00:00:00.000Z",
			sendAttemptCount: 1,
			reconcileAttemptCount: 0,
			reasonCode: "uncertain_send",
		});
		expect(() => validateLabelSyncMutationAttemptLifecycle(reconciledUnknown)).not.toThrow();
		expect(() =>
			parseLabelSyncMutationAttempt({
				...reconciledUnknown,
				claimToken: "reconcile-1",
				reconcileAttemptCount: 0,
			}),
		).toThrow();
	});

	it("rejects unreachable active lifecycle combinations", () => {
		for (const status of ["claimed", "sending"] as const) {
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					status,
					claimToken: "claim-1",
					requestStartedAt: status === "sending" ? "2026-09-05T00:00:00.000Z" : null,
					lastObservedAt: "2026-09-05T00:00:00.000Z",
					sendAttemptCount: status === "sending" ? 1 : 0,
				}),
			).toThrow();
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					status,
					claimToken: "claim-1",
					requestStartedAt: status === "sending" ? "2026-09-05T00:00:00.000Z" : null,
					sendAttemptCount: status === "sending" ? 1 : 0,
					reasonCode: "provider_unavailable",
				}),
			).toThrow();
		}
		for (const reasonCode of ["reconciliation_unavailable", "attempt_limit"] as const) {
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					status: "unknown",
					claimToken: null,
					requestStartedAt: "2026-09-05T00:00:00.000Z",
					sendAttemptCount: 1,
					reconcileAttemptCount: 0,
					reasonCode,
				}),
			).toThrow();
		}
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				status: "unknown",
				claimToken: null,
				requestStartedAt: "2026-09-05T00:00:00.000Z",
				sendAttemptCount: 1,
				reconcileAttemptCount: 0,
				reasonCode: "uncertain_send",
			}),
		).not.toThrow();
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				status: "unknown",
				claimToken: null,
				requestStartedAt: "2026-09-05T00:00:00.000Z",
				sendAttemptCount: 1,
				reconcileAttemptCount: 0,
				reasonCode: "applied",
			}),
		).toThrow();
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				status: "unknown",
				claimToken: "reconcile-1",
				requestStartedAt: "2026-09-05T00:00:00.000Z",
				sendAttemptCount: 1,
				reconcileAttemptCount: 1,
				reasonCode: "uncertain_send",
			}),
		).not.toThrow();
	});

	it("rejects private/unbounded malformed values", () => {
		expect(() => parseLabelSyncMutationAttempt({ ...baseAttempt, tmdbId: 0 })).toThrow();
		expect(() => parseLabelSyncMutationAttempt({ ...baseAttempt, sendAttemptCount: -1 })).toThrow();
		expect(() => parseLabelSyncMutationAttempt({ ...baseAttempt, destinationTag: "" })).toThrow();
	});

	it("rejects a verified terminal row without send, request, and observation evidence", () => {
		expect(() =>
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				status: "verified",
				activeOperationKey: null,
				claimToken: null,
				completedAt: "2026-09-05T00:00:00.000Z",
				reasonCode: "applied",
			}),
		).toThrow();
	});

	it("accepts and rejects terminal rows according to the complete evidence matrix", () => {
		const timestamp = "2026-09-05T00:00:00.000Z";
		const authorityReasons = [
			"identity_changed",
			"rule_changed",
			"destination_changed",
			"generation_changed",
			"target_missing",
			"target_ambiguous",
			"target_changed",
			"library_ancestry_changed",
		] as const;
		const validRows = [
			{
				status: "verified",
				reasonCode: "applied",
				sendAttemptCount: 1,
				reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
				requestStartedAt: timestamp,
				lastObservedAt: timestamp,
			},
			{
				status: "noop",
				reasonCode: "already_applied",
				sendAttemptCount: 0,
				reconcileAttemptCount: 0,
				requestStartedAt: null,
				lastObservedAt: timestamp,
			},
			{
				status: "failed",
				reasonCode: "startup_before_send",
				sendAttemptCount: 0,
				reconcileAttemptCount: 0,
				requestStartedAt: null,
				lastObservedAt: null,
			},
			{
				status: "failed",
				reasonCode: "provider_unavailable",
				sendAttemptCount: 0,
				reconcileAttemptCount: 0,
				requestStartedAt: null,
				lastObservedAt: null,
			},
			{
				status: "failed",
				reasonCode: "identity_unavailable",
				sendAttemptCount: 0,
				reconcileAttemptCount: 0,
				requestStartedAt: null,
				lastObservedAt: null,
			},
			{
				status: "failed",
				reasonCode: "internal_failure",
				sendAttemptCount: 0,
				reconcileAttemptCount: 0,
				requestStartedAt: null,
				lastObservedAt: null,
			},
			{
				status: "failed",
				reasonCode: "confirmed_absent",
				sendAttemptCount: 1,
				reconcileAttemptCount: 0,
				requestStartedAt: timestamp,
				lastObservedAt: timestamp,
			},
			...authorityReasons.map((reasonCode) => ({
				status: "blocked" as const,
				reasonCode,
				sendAttemptCount: 0 as const,
				reconcileAttemptCount: 0 as const,
				requestStartedAt: null,
				lastObservedAt: null,
			})),
		] as const;
		for (const evidence of validRows) {
			const parsed = parseLabelSyncMutationAttempt({
				...baseAttempt,
				...evidence,
				activeOperationKey: null,
				claimToken: null,
				completedAt: timestamp,
			});
			expect(parsed).toMatchObject({
				status: evidence.status,
				reasonCode: evidence.reasonCode,
				sendAttemptCount: evidence.sendAttemptCount,
				reconcileAttemptCount: evidence.reconcileAttemptCount,
			});
		}

		const contradictions = [
			{ status: "verified", reasonCode: "already_applied" },
			{ status: "verified", sendAttemptCount: 0 },
			{ status: "verified", requestStartedAt: null },
			{ status: "verified", lastObservedAt: null },
			{ status: "noop", sendAttemptCount: 1 },
			{ status: "noop", requestStartedAt: timestamp },
			{ status: "noop", reconcileAttemptCount: 1 },
			{ status: "noop", lastObservedAt: null },
			{ status: "failed", reasonCode: "target_missing" },
			{ status: "failed", reasonCode: "confirmed_absent", sendAttemptCount: 0 },
			{ status: "failed", reasonCode: "confirmed_absent", requestStartedAt: null },
			{ status: "failed", reasonCode: "confirmed_absent", lastObservedAt: null },
			{ status: "blocked", sendAttemptCount: 1 },
			{ status: "blocked", requestStartedAt: timestamp },
			{ status: "blocked", reconcileAttemptCount: 1 },
		] as const;
		for (const contradiction of contradictions) {
			expect(() =>
				parseLabelSyncMutationAttempt({
					...baseAttempt,
					...validRows.find(({ status }) => status === contradiction.status),
					...contradiction,
					activeOperationKey: null,
					claimToken: null,
					completedAt: timestamp,
				}),
			).toThrow();
		}
	});

	it("enforces signed 32-bit bounds for portable Prisma integers", () => {
		const maximum = 2_147_483_647;
		expect(
			parseLabelSyncMutationAttempt({
				...baseAttempt,
				tmdbId: maximum,
				connectionGeneration: maximum,
				identityGeneration: maximum,
			}).tmdbId,
		).toBe(maximum);
		for (const field of ["tmdbId", "connectionGeneration", "identityGeneration"] as const) {
			expect(() =>
				parseLabelSyncMutationAttempt({ ...baseAttempt, [field]: maximum + 1 }),
			).toThrow();
		}
	});

	it.each([
		["2024-02-29T12:00:00.000Z", true],
		["2024-02-29T23:59:59.123+05:30", true],
		["2023-02-29T12:00:00.000Z", false],
		["2024-04-31T12:00:00.000Z", false],
		["2024-02-30T12:00:00.000Z", false],
	] as const)("accepts only calendar-valid ISO timestamp %s", (timestamp, valid) => {
		const terminal = {
			...baseAttempt,
			status: "verified",
			activeOperationKey: null,
			claimToken: null,
			sendAttemptCount: 1,
			reasonCode: "applied",
			requestStartedAt: timestamp,
			lastObservedAt: timestamp,
			completedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (valid) {
			expect(parseLabelSyncMutationAttempt(terminal).completedAt).toBeInstanceOf(Date);
		} else {
			expect(() => parseLabelSyncMutationAttempt(terminal)).toThrow();
		}
	});
});
