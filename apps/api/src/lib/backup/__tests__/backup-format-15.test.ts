import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { Encryptor } from "../../auth/encryption.js";
import type { ServiceInstance } from "../../prisma.js";
import { encryptBackupData } from "../backup-crypto.js";
import { PORTABLE_SAFETY_PAYLOAD_FIELDS } from "../backup-portability.js";
import {
	originalPreparedRestoreRecords,
	prepareRestoreData,
} from "../backup-restore-preparation.js";
import { COMPLETE_V1_2_PAYLOAD_FIELDS, validateBackup } from "../backup-validation.js";

type Row = Record<string, unknown>;
const date = "2026-10-10T09:00:00.000Z";
const firstId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const source = new Encryptor("11".repeat(32));
const destination = new Encryptor("22".repeat(32));
const minimal = {
	purpose: "arr-dashboard:search-grab-target",
	version: 1,
	guid: "opaque:exact-guid",
	indexerId: 7,
};
// Independent digest fixture: the encrypted target must prove this exact tuple.
function targetHash(connectionFingerprint: string) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"arr-dashboard:search-grab-target",
				1,
				"owner",
				"prowlarr",
				connectionFingerprint,
				"opaque:exact-guid",
				7,
			]),
		)
		.digest("hex");
}
function fixture(version = "1.5") {
	const key = source.encrypt("synthetic-provider-key");
	const instance = {
		id: "prowlarr",
		userId: "owner",
		service: "PROWLARR",
		baseUrl: "http://synthetic.invalid",
		enabled: true,
		encryptedApiKey: key.value,
		encryptionIv: key.iv,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
	};
	const connectionFingerprint = createArrServiceFingerprint(instance as unknown as ServiceInstance);
	const encrypted = source.encrypt(JSON.stringify(minimal));
	const attempt = {
		id: firstId,
		userId: "owner",
		intentId: "33333333-3333-4333-8333-333333333333",
		serviceInstanceId: "prowlarr",
		connectionFingerprint,
		targetHash: targetHash(connectionFingerprint),
		encryptedTarget: encrypted.value,
		targetIv: encrypted.iv,
		state: "uncertain",
		outcomeCategory: "transport-unconfirmed",
		workerEpoch: "source-worker",
		predecessorId: null,
		requestedAt: date,
		updatedAt: date,
		dispatchedAt: date,
		completedAt: null,
	};
	const successor = {
		...attempt,
		id: nextId,
		intentId: "44444444-4444-4444-8444-444444444444",
		predecessorId: firstId,
		state: "prepared",
		outcomeCategory: null,
		dispatchedAt: null,
	};
	return {
		version,
		appVersion: "2.24.2",
		timestamp: date,
		data: {
			...Object.fromEntries(
				[...COMPLETE_V1_2_PAYLOAD_FIELDS, ...PORTABLE_SAFETY_PAYLOAD_FIELDS].map((field) => [
					field,
					[],
				]),
			),
			users: [{ id: "owner", username: "synthetic" }],
			sessions: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
			serviceInstances: [instance],
			searchGrabAttempts: [attempt, successor],
			searchGrabClaims: [
				{
					userId: "owner",
					serviceInstanceId: "prowlarr",
					targetHash: attempt.targetHash,
					attemptId: nextId,
					createdAt: date,
				},
			],
		},
		secrets: { encryptionKey: "11".repeat(32), sessionCookieSecret: "synthetic-cookie" },
	};
}
async function prepare(value: ReturnType<typeof fixture>) {
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(value), "synthetic-password"),
		password: "synthetic-password",
		destination: {
			encryptor: destination,
			installationId: "destination-installation",
			stableForRestart: true,
		},
	});
}

describe("backup1.5 durable Grab safety", () => {
	it("keeps missing historical Grab coverage explicit after preparation", async () => {
		const value = fixture("1.4");
		delete (value.data as Row).searchGrabAttempts;
		delete (value.data as Row).searchGrabClaims;
		const prepared = await prepare(value);
		expect(prepared.grabSafetyCoverage).toBe("legacy-incomplete");
		expect(prepared.records.searchGrabAttempts).toBeUndefined();
	});
	it("still authenticates complete historical 1.5 Grab coverage", async () => {
		expect(() => validateBackup(fixture())).not.toThrow();
		const prepared = await prepare(fixture());
		expect(prepared.formatVersion).toBe("1.5");
		expect(prepared.grabSafetyCoverage).toBe("complete");
	});
	it.each(["searchGrabAttempts", "searchGrabClaims"])(
		"requires explicit %s coverage in 1.5",
		(field) => {
			const value = fixture();
			delete (value.data as Row)[field];
			expect(() => validateBackup(value)).toThrow(new RegExp(field));
		},
	);
	it.each(["1.0", "1.1", "1.2", "1.3", "1.4"])(
		"keeps historical %s readable without fabricating Grab coverage",
		(version) => {
			const value = fixture(version);
			delete (value.data as Row).searchGrabAttempts;
			delete (value.data as Row).searchGrabClaims;
			expect(() => validateBackup(value)).not.toThrow();
			expect(value.version).toBe(version);
		},
	);
	// Additive older-format rows already pass the old version reader. These REDs
	// catch missing graph validation rather than an unsupported-version error.
	it.each([
		["foreign owner", "userId", "other"],
		["missing predecessor", "predecessorId", "55555555-5555-4555-8555-555555555555"],
		["different predecessor target", "targetHash", "f".repeat(64)],
		["cycle", "predecessorId", nextId],
		["invalid state", "state", "success"],
		["missing marker", "dispatchedAt", null],
		["invalid intent", "intentId", "invalid"],
		["missing IV", "targetIv", null],
		["completion before request", "completedAt", "2000-01-01T00:00:00.000Z"],
	])("rejects additive malformed attempt: %s", (_category, field, value) => {
		const backup = fixture("1.4");
		(backup.data.searchGrabAttempts[0] as Row)[field as string] = value;
		expect(() => validateBackup(backup)).toThrow(/Grab|portable safety/i);
	});
	it.each([
		["cross-owner", "userId", "other"],
		["different target", "targetHash", "e".repeat(64)],
		["missing attempt", "attemptId", "55555555-5555-4555-8555-555555555555"],
		["wrong instance", "serviceInstanceId", "missing"],
	])("rejects additive malformed claim: %s", (_category, field, value) => {
		const backup = fixture("1.4");
		(backup.data.searchGrabClaims[0] as Row)[field as string] = value;
		expect(() => validateBackup(backup)).toThrow(/Grab|portable safety/i);
	});
	it("rejects duplicate intent records", () => {
		const value = fixture("1.4");
		value.data.searchGrabAttempts[1]!.intentId = value.data.searchGrabAttempts[0]!.intentId;
		expect(() => validateBackup(value)).toThrow(/Grab|portable safety/i);
	});
	it("rejects a missing hold for a still-prepared successor", () => {
		const value = fixture("1.4");
		value.data.searchGrabClaims = [];
		expect(() => validateBackup(value)).toThrow(/Grab|portable safety/i);
	});
	it("rejects multiple successor links for one confirmation", () => {
		const value = fixture("1.4");
		value.data.searchGrabAttempts.push({
			...value.data.searchGrabAttempts[1]!,
			id: "55555555-5555-4555-8555-555555555555",
			intentId: "66666666-6666-4666-8666-666666666666",
		});
		expect(() => validateBackup(value)).toThrow(/Grab|portable safety/i);
	});
	it("preserves the recovery chain, rebinds matching proof, and imports no worker authority", async () => {
		const value = fixture(),
			before = structuredClone(value);
		const prepared = await prepare(value);
		expect(prepared.formatVersion).toBe("1.5");
		expect(prepared.safetyCoverage).toBe("complete");
		const instance = prepared.records.serviceInstances[0] as ServiceInstance;
		const fingerprint = createArrServiceFingerprint(instance);
		expect(fingerprint).not.toBe(before.data.searchGrabAttempts[0]!.connectionFingerprint);
		const attempts = prepared.records.searchGrabAttempts as Row[];
		expect(attempts).toHaveLength(2);
		for (let index = 0; index < 2; index++) {
			const row = attempts[index]!,
				original = before.data.searchGrabAttempts[index]!;
			expect(row).toMatchObject({
				...original,
				connectionFingerprint: fingerprint,
				targetHash: targetHash(fingerprint),
				workerEpoch: null,
				encryptedTarget: expect.any(String),
				targetIv: expect.any(String),
			});
			expect(
				destination.decrypt({ value: row.encryptedTarget as string, iv: row.targetIv as string }),
			).toBe(JSON.stringify(minimal));
			expect(row.targetIv).not.toBe(original.targetIv);
		}
		expect(prepared.records.searchGrabClaims).toEqual([
			{ ...before.data.searchGrabClaims[0]!, targetHash: targetHash(fingerprint) },
		]);
		expect(originalPreparedRestoreRecords(prepared).searchGrabAttempts).toEqual(
			before.data.searchGrabAttempts,
		);
		expect(value).toEqual(before);
	});
	it.each([
		{ ...minimal, guid: "different-guid" },
		{ ...minimal, purpose: "arr-dashboard:search-grab-selector" },
		{ ...minimal, version: 2 },
		{ ...minimal, selector: "must-not-import" },
		{ ...minimal, indexerId: 0 },
	])("rejects authenticated malformed/mismatched minimal target", async (target) => {
		const value = fixture("1.4"),
			encrypted = source.encrypt(JSON.stringify(target));
		Object.assign(value.data.searchGrabAttempts[0]!, {
			encryptedTarget: encrypted.value,
			targetIv: encrypted.iv,
		});
		await expect(prepare(value)).rejects.toMatchObject({ category: "invalid-credential" });
	});
	it("does not promote a historical stale connection proof", async () => {
		const value = fixture();
		value.data.serviceInstances[0]!.baseUrl = "http://synthetic-repointed.invalid";
		const prepared = await prepare(value);
		expect((prepared.records.searchGrabAttempts as Row[])[0]).toMatchObject({
			connectionFingerprint: value.data.searchGrabAttempts[0]!.connectionFingerprint,
			targetHash: value.data.searchGrabAttempts[0]!.targetHash,
			workerEpoch: null,
		});
		expect(prepared.records.searchGrabClaims).toEqual(value.data.searchGrabClaims);
	});
});
