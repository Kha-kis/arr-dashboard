import { describe, expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { encryptBackupData } from "../backup-crypto.js";
import { PORTABLE_SAFETY_PAYLOAD_FIELDS } from "../backup-portability.js";
import {
	originalPreparedRestoreRecords,
	prepareRestoreData,
} from "../backup-restore-preparation.js";
import { COMPLETE_V1_2_PAYLOAD_FIELDS, validateBackup } from "../backup-validation.js";

const date = "2026-10-07T00:00:00.000Z";
const source = new Encryptor("11".repeat(32));
const target = new Encryptor("22".repeat(32));
type Row = Record<string, unknown>;
function attempt(status = "claimed"): Row {
	return {
		id: "attempt",
		userId: "owner",
		ruleId: "rule",
		destinationInstanceId: "destination",
		provider: "jellyfin",
		mediaType: "movie",
		tmdbId: 123,
		connectionGeneration: 0,
		identityGeneration: 1,
		targetItemId: "item",
		libraryId: "library",
		intentFingerprint: "intent",
		ruleFingerprint: "rule-fingerprint",
		destinationTag: "tag",
		activeOperationKey: "held-key",
		claimToken: "source-worker",
		sendAttemptCount: status === "claimed" ? 0 : 1,
		reconcileAttemptCount: status === "unknown" ? 1 : 0,
		requestStartedAt: status === "claimed" ? null : date,
		lastObservedAt: null,
		completedAt: null,
		status,
		reasonCode: status === "unknown" ? "uncertain_send" : null,
		createdAt: date,
		updatedAt: date,
		restoreEvidence: null,
	};
}
function evidence(): string {
	return JSON.stringify({
		version: 1,
		originalStatus: "claimed",
		originalReasonCode: null,
		originalSendAttemptCount: 0,
		originalReconcileAttemptCount: 0,
		originalRequestStartedAt: null,
		originalLastObservedAt: null,
		originalCreatedAt: date,
		originalUpdatedAt: date,
	});
}
function held(): Row {
	return {
		...attempt(),
		status: "restored-held",
		claimToken: null,
		reasonCode: "restore_uncertain",
		restoreEvidence: evidence(),
	};
}
function fixture(version = "1.4", rows: Row[] = [attempt()]) {
	const key = source.encrypt("synthetic-provider-key");
	return {
		version,
		appVersion: "2.24.2",
		timestamp: date,
		data: {
			...Object.fromEntries(
				[...COMPLETE_V1_2_PAYLOAD_FIELDS, ...PORTABLE_SAFETY_PAYLOAD_FIELDS].map((f) => [f, []]),
			),
			users: [{ id: "owner", username: "synthetic" }],
			sessions: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
			serviceInstances: [
				{
					id: "destination",
					userId: "owner",
					service: "JELLYFIN",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			],
			labelSyncRule: [
				{ id: "rule", userId: "owner", destInstanceId: "destination", destService: "jellyfin" },
			],
			labelSyncMutationAttempts: rows,
		},
		secrets: { encryptionKey: "11".repeat(32), sessionCookieSecret: "synthetic-cookie" },
	};
}
async function prepare(value: ReturnType<typeof fixture>) {
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(value), "synthetic-password"),
		password: "synthetic-password",
		destination: {
			encryptor: target,
			installationId: "destination-installation",
			stableForRestart: true,
		},
	});
}

describe("backup 1.4 held-evidence contract", () => {
	it.each(["1.0", "1.1", "1.2", "1.3", "1.4"])(
		"keeps the %s reader usable without upgrading its evidence",
		(version) => {
			const value = fixture(version);
			expect(() => validateBackup(value)).not.toThrow();
			expect(value.version).toBe(version);
		},
	);
	it.each(["1.3", "1.4"])(
		"does not downgrade mandatory configuration coverage for %s",
		(version) => {
			for (const field of COMPLETE_V1_2_PAYLOAD_FIELDS) {
				const value = fixture(version, []);
				delete (value.data as Row)[field];
				expect(() => validateBackup(value), field).toThrow(new RegExp(field));
			}
		},
	);
	it.each(["1.3", "1.4"])("does not downgrade mandatory safety coverage for %s", (version) => {
		for (const field of PORTABLE_SAFETY_PAYLOAD_FIELDS) {
			const value = fixture(version);
			delete (value.data as Row)[field];
			expect(() => validateBackup(value), field).toThrow(new RegExp(field));
		}
	});
	it("requires the explicit nullable provenance field on every 1.4 attempt", () => {
		const row = attempt();
		delete row.restoreEvidence;
		expect(() => validateBackup(fixture("1.4", [row]))).toThrow(/label sync/i);
	});
	it.each(["1.0", "1.1", "1.2", "1.3"])(
		"rejects new held or reconciled states disguised as %s",
		(version) => {
			for (const row of [
				held(),
				{
					...held(),
					status: "reconciled",
					reasonCode: "desired_state_observed",
					activeOperationKey: null,
					reconcileAttemptCount: 1,
					lastObservedAt: date,
					completedAt: date,
				},
			])
				expect(() => validateBackup(fixture(version, [row]))).toThrow(/label sync/i);
		},
	);
	it.each(["1.3", "1.2"])("accepts missing native provenance in historical %s", (version) => {
		const row = attempt();
		delete row.restoreEvidence;
		expect(() => validateBackup(fixture(version, [row]))).not.toThrow();
	});
	it("accepts canonical held and positively observed evidence in 1.4", () => {
		for (const row of [
			held(),
			{
				...held(),
				status: "reconciled",
				reasonCode: "desired_state_observed",
				activeOperationKey: null,
				reconcileAttemptCount: 1,
				lastObservedAt: date,
				completedAt: date,
			},
		])
			expect(() => validateBackup(fixture("1.4", [row]))).not.toThrow();
	});
	it.each([
		"{}",
		"not-json",
		JSON.stringify({ ...JSON.parse(evidence()), version: 2 }),
		JSON.stringify({ ...JSON.parse(evidence()), claimToken: "must-not-import" }),
	])("rejects malformed provenance %s", (invalid) => {
		expect(() => validateBackup(fixture("1.4", [{ ...held(), restoreEvidence: invalid }]))).toThrow(
			/label sync/i,
		);
	});
	it.each(["claimed", "sending", "unknown"])(
		"authenticates then translates %s without importing send ownership",
		async (status) => {
			const row = attempt(status),
				value = fixture("1.4", [row]),
				before = structuredClone(value);
			const prepared = await prepare(value);
			expect(prepared.safetyCoverage).toBe("complete");
			expect(prepared.publicationBlockers).toEqual([]);
			expect(prepared.records.labelSyncMutationAttempts).toEqual([
				{
					...row,
					status: "restored-held",
					reasonCode: "restore_uncertain",
					claimToken: null,
					restoreEvidence: JSON.stringify({
						version: 1,
						originalStatus: status,
						originalReasonCode: row.reasonCode,
						originalSendAttemptCount: row.sendAttemptCount,
						originalReconcileAttemptCount: row.reconcileAttemptCount,
						originalRequestStartedAt: row.requestStartedAt,
						originalLastObservedAt: null,
						originalCreatedAt: date,
						originalUpdatedAt: date,
					}),
				},
			]);
			expect(originalPreparedRestoreRecords(prepared).labelSyncMutationAttempts).toEqual([row]);
			expect(value).toEqual(before);
		},
	);
	it("re-prepares acquired held evidence without resetting counts or nesting provenance", async () => {
		const row = { ...held(), claimToken: "read-worker", reconcileAttemptCount: 1 };
		const prepared = await prepare(fixture("1.4", [row]));
		expect(prepared.records.labelSyncMutationAttempts).toEqual([{ ...row, claimToken: null }]);
		expect(originalPreparedRestoreRecords(prepared).labelSyncMutationAttempts).toEqual([row]);
	});
	it("keeps 1.2 preparation incomplete even when additive safety arrays happen to exist", async () => {
		expect((await prepare(fixture("1.2"))).safetyCoverage).toBe("legacy-incomplete");
	});
});
