import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { BackupData, BackupFormatVersion } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import { importCommandFingerprint } from "../../arr/manual-import-command.js";
import { Encryptor } from "../../auth/encryption.js";
import type { ServiceInstance } from "../../prisma.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import { deriveKey, encryptBackupData } from "../backup-crypto.js";
import { ENCRYPTED_BACKUP_FIELDS, PORTABLE_SAFETY_PAYLOAD_FIELDS } from "../backup-portability.js";
import {
	assertPreparedRestoreData,
	originalPreparedRestoreRecords,
	prepareRestoreData,
} from "../backup-restore-preparation.js";
import { COMPLETE_V1_2_PAYLOAD_FIELDS } from "../backup-validation.js";

type Row = Record<string, unknown>;
const sourceKey = "11".repeat(32);
const destinationKey = "22".repeat(32);
const source = new Encryptor(sourceKey);
const destination = new Encryptor(destinationKey);
const date = "2026-10-07T00:00:00.000Z";
const file = {
	path: "/synthetic/movie.mkv",
	downloadId: "a".repeat(40),
	movieId: 7,
	movieFileId: 0,
};
const lookup = JSON.stringify({ version: 1, service: "radarr", files: [file] });
const plaintexts = [
	"tmdb-synthetic",
	"trakt-synthetic",
	"arr-synthetic",
	'{"username":"synthetic","password":"synthetic"}',
	"oidc-synthetic",
	"backup-synthetic",
	'{"url":"synthetic"}',
	"vapid-synthetic",
	lookup,
];
// This fixture characterizes the nine encrypted fields predating Grab and Outbox.
// Keep its historical field set fixed when the current encryption registry grows.
// Format1.5/1.6 target authentication is exercised by the native format suites.
const HISTORICAL_ENCRYPTED_VALUE_FIELDS = new Set([
	"encryptedTmdbApiKey",
	"encryptedTraktAccessToken",
	"encryptedApiKey",
	"encryptedHttpAuthCredentials",
	"encryptedClientSecret",
	"encryptedPassword",
	"encryptedConfig",
	"encryptedPrivateKey",
	"encryptedSources",
]);
const HISTORICAL_ENCRYPTED_FIELDS = ENCRYPTED_BACKUP_FIELDS.filter((pair) =>
	HISTORICAL_ENCRYPTED_VALUE_FIELDS.has(pair.valueField),
);
function row(data: BackupData["data"], field: keyof BackupData["data"]): Row {
	return data[field]![0] as Row;
}
function fixture(version: BackupFormatVersion = "1.3"): BackupData {
	const data: BackupData["data"] = {
		...Object.fromEntries(
			[...COMPLETE_V1_2_PAYLOAD_FIELDS, ...PORTABLE_SAFETY_PAYLOAD_FIELDS].map((f) => [f, []]),
		),
		users: [
			{
				id: "owner",
				username: "synthetic",
				hashedPassword: "authentic-synthetic-hash",
				createdAt: date,
				updatedAt: date,
			},
		],
		sessions: [{ id: "source-session", userId: "owner", token: "synthetic-session" }],
		serviceInstances: [
			{
				id: "arr",
				userId: "owner",
				service: "RADARR",
				baseUrl: "http://synthetic.invalid",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
			},
		],
		serviceTags: [],
		serviceInstanceTags: [],
		oidcAccounts: [{ id: "account", userId: "owner" }],
		webAuthnCredentials: [{ id: "passkey", userId: "owner" }],
		oidcProviders: [{ id: "oidc" }],
		backupSettings: [{ id: "backup" }],
		notificationChannel: [{ id: "channel" }],
		vapidKeys: [{ id: "vapid" }],
		arrImportOperations: [
			{
				id: "operation",
				userId: "owner",
				instanceId: "arr",
				originalInstanceId: "arr",
				service: "RADARR",
				origin: "queue-cleaner",
				mode: "Move",
				idempotencyKey: "idempotency",
				requestFingerprint: `v1:${"b".repeat(64)}`,
				commandFingerprint: importCommandFingerprint([file]),
				connectionFingerprint: "",
				legacyReceiptId: "receipt",
				state: "unknown",
				reason: "evidence-unavailable",
				commandId: 42,
				commandState: "unknown",
				commandTerminal: false,
				selectedFileCount: 1,
				verifiedFileCount: 0,
				preparationExpiresAt: date,
				submissionStartedAt: date,
				lastCheckedAt: date,
				nextCheckAt: date,
				reconcileToken: "source-worker",
				reconcileExpiresAt: date,
				reconcileCursor: null,
				revision: 1,
				createdAt: date,
				updatedAt: date,
			},
		],
		arrImportFileProofs: [
			{
				id: "proof",
				operationId: "operation",
				fileFingerprint: importCommandFingerprint([file]),
				downloadKey: queueDownloadKey(file),
				identityJson: {
					pathHash: createHash("sha256").update(file.path).digest("hex"),
					movieId: 7,
					movieFileId: 0,
				},
				verifiedAt: null,
				createdAt: date,
			},
		],
		arrImportSourceClaims: [
			{
				id: "claim",
				userId: "owner",
				downloadKey: queueDownloadKey(file),
				activeOperationId: "operation",
				createdAt: date,
				updatedAt: date,
			},
		],
		queueCleanerImportReceipts: [
			{
				id: "receipt",
				instanceId: "arr",
				downloadKey: queueDownloadKey(file),
				queueId: 7,
				downloadTitle: "synthetic",
				connectionFingerprint: "",
				commandFingerprint: importCommandFingerprint([file]),
				commandId: 42,
				state: "unknown",
				lastAttemptAt: date,
				createdAt: date,
				updatedAt: date,
			},
		],
	};
	HISTORICAL_ENCRYPTED_FIELDS.forEach((pair, i) => {
		const encrypted = source.encrypt(plaintexts[i]!);
		const record = row(data, pair.payloadField);
		record[pair.valueField] = encrypted.value;
		record[pair.ivField] = encrypted.iv;
	});
	const fingerprint = importConnectionFingerprint(
		row(data, "serviceInstances") as unknown as ServiceInstance,
	);
	row(data, "arrImportOperations").connectionFingerprint = fingerprint;
	row(data, "queueCleanerImportReceipts").connectionFingerprint = fingerprint;
	return {
		version,
		appVersion: "2.24.2",
		timestamp: date,
		data,
		secrets: { encryptionKey: sourceKey, sessionCookieSecret: "source-cookie-secret" },
	};
}
async function prepare(backup = fixture(), encryptor = destination) {
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-password"),
		password: "synthetic-password",
		destination: { encryptor, installationId: "destination-installation", stableForRestart: true },
	});
}

describe("authenticated inert preparation", () => {
	it("preserves frozen caller envelope and argument ownership through successful preparation", async () => {
		const backup = fixture();
		const envelope = await encryptBackupData(JSON.stringify(backup), "synthetic-password");
		const expectedEnvelope = JSON.stringify(envelope);
		Object.freeze(envelope.kdfParams);
		Object.freeze(envelope);
		const context = Object.freeze({
			encryptor: destination,
			installationId: "destination-installation",
			stableForRestart: true,
		});
		const args = Object.freeze({ envelope, password: "synthetic-password", destination: context });
		const prepared = await prepareRestoreData(args);
		expect(args.envelope).toBe(envelope);
		expect(args.destination).toBe(context);
		expect(args.password).toBe("synthetic-password");
		expect(JSON.stringify(envelope)).toBe(expectedEnvelope);
		const witness = originalPreparedRestoreRecords(prepared);
		const beforeIdentity = row(witness, "arrImportFileProofs").identityJson as Row;
		const translatedIdentity = row(prepared.records, "arrImportFileProofs").identityJson as Row;
		expect(beforeIdentity.movieId).toBe(7);
		expect(translatedIdentity.movieId).toBe(7);
		expect(beforeIdentity).not.toBe(translatedIdentity);
		expect(Object.isFrozen(beforeIdentity)).toBe(true);
		expect(Object.isFrozen(translatedIdentity)).toBe(true);
		expect(() => {
			beforeIdentity.movieId = 8;
		}).toThrow();
		expect(() => {
			translatedIdentity.movieId = 8;
		}).toThrow();
		expect(beforeIdentity.movieId).toBe(7);
		expect(translatedIdentity.movieId).toBe(7);
		assertPreparedRestoreData(prepared);
	});
	it("owns a frozen authenticated original ciphertext witness without sessions or secrets", async () => {
		const backup = fixture();
		const original = structuredClone(backup.data);
		const prepared = await prepare(backup);
		const witness = originalPreparedRestoreRecords(prepared);
		expect(witness).toEqual({ ...original, sessions: [] });
		expect(Object.isFrozen(witness)).toBe(true);
		expect(Object.isFrozen(witness.users[0])).toBe(true);
		expect(() => {
			(witness.users[0] as Row).username = "changed";
		}).toThrow();
		expect(row(witness, "serviceInstances").encryptedApiKey).not.toBe(
			row(prepared.records, "serviceInstances").encryptedApiKey,
		);
		expect(JSON.stringify(witness)).not.toContain(sourceKey);
		expect(JSON.stringify(witness)).not.toContain("source-cookie-secret");
		expect(JSON.stringify(witness)).not.toContain(plaintexts[0]);
		expect(() => originalPreparedRestoreRecords({ ...prepared })).toThrow();
		expect(() => originalPreparedRestoreRecords(JSON.parse(JSON.stringify(prepared)))).toThrow();
		row(backup.data, "users").username = "changed-input";
		expect(row(witness, "users").username).toBe("synthetic");
	});
	it("rejects oversized decoded salt before allocation even at permitted encoded length", async () => {
		const envelope = await encryptBackupData("{}", "synthetic-password");
		const oversized = "A".repeat(44); // Same encoded length as 32 bytes, but decodes to 33.
		const allocation = vi.spyOn(Buffer, "from");
		try {
			await expect(
				prepareRestoreData({
					envelope: { ...envelope, salt: oversized },
					password: "synthetic-password",
					destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
				}),
			).rejects.toMatchObject({ category: "invalid-envelope" });
			expect(allocation.mock.calls.some((args) => args[0] === oversized)).toBe(false);
		} finally {
			allocation.mockRestore();
		}
	});
	it("accepts authenticated legacy positive KDF iterations", async () => {
		const salt = randomBytes(32),
			iv = randomBytes(12),
			key = await deriveKey("synthetic-password", salt, 1);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(fixture()), "utf8"),
			cipher.final(),
		]);
		const envelope = {
			version: "1.0",
			kdfParams: { algorithm: "pbkdf2", hash: "sha256", iterations: 1, saltLength: 32 },
			salt: salt.toString("base64"),
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			cipherText: ciphertext.toString("base64"),
		};
		key.fill(0);
		const prepared = await prepareRestoreData({
			envelope,
			password: "synthetic-password",
			destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
		});
		expect(prepared.records.sessions).toEqual([]);
		expect(prepared.safetyCoverage).toBe("complete");
	});
	it("preserves detached terminal history and retained cursor without live rebinding", async () => {
		const backup = fixture();
		const operation = row(backup.data, "arrImportOperations");
		const fingerprint = operation.connectionFingerprint;
		Object.assign(operation, {
			instanceId: null,
			originalInstanceId: "deleted-arr",
			legacyReceiptId: "deleted-receipt",
			commandTerminal: true,
			commandState: "completed",
			state: "completed",
			verifiedFileCount: 1,
			reconcileToken: null,
			reconcileExpiresAt: null,
		});
		row(backup.data, "arrImportFileProofs").verifiedAt = date;
		backup.data.arrImportSourceClaims = [];
		backup.data.queueCleanerImportReceipts = [];
		const cursor = {
			version: 2,
			commandFingerprint: operation.commandFingerprint,
			commandId: 42,
			commandEndedAt: date,
			sourceIndex: 1,
			page: 1,
			pageSize: null,
			totalRecords: null,
			seenRecords: 0,
			witnesses: [],
			ambiguousFiles: [],
			retainedWitnesses: [
				{
					fileFingerprint: row(backup.data, "arrImportFileProofs").fileFingerprint,
					fileId: 33,
					episodeIds: [],
				},
			],
			retainedAmbiguousFiles: [],
		};
		operation.reconcileCursor = cursor;
		const prepared = await prepare(backup);
		expect(row(prepared.records, "arrImportOperations")).toMatchObject({
			instanceId: null,
			originalInstanceId: "deleted-arr",
			connectionFingerprint: fingerprint,
			state: "completed",
			reconcileCursor: cursor,
		});
		expect(
			prepared.connectionBindings.every((binding) => binding.serviceInstanceId !== "deleted-arr"),
		).toBe(true);
	});
	it("rejects source lookup beyond the 4 MiB bound", async () => {
		const backup = fixture();
		const encrypted = source.encrypt(" ".repeat(4 * 1024 * 1024 + 1));
		Object.assign(row(backup.data, "arrImportOperations"), {
			encryptedSources: encrypted.value,
			sourcesEncryptionIv: encrypted.iv,
		});
		await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
	});
	it("clears cleanup worker ownership while preserving unresolved outcomes and durable audit", async () => {
		const backup = fixture();
		backup.data.libraryCleanupConfig = [
			{ id: "config", userId: "owner", runClaimToken: "source-worker", runClaimedAt: date },
		];
		backup.data.libraryCleanupApproval = [
			{
				id: "approval",
				status: "executing",
				executionToken: "source-worker",
				executionAuditCorrelationId: "durable-audit",
				safetySnapshot: "durable-selection",
			},
		];
		backup.data.libraryCleanupMediaServerScan = [
			{ id: "scan", status: "triggering", executionToken: "source-worker", requestStartedAt: date },
		];
		const prepared = await prepare(backup);
		expect(row(prepared.records, "libraryCleanupConfig")).toMatchObject({
			runClaimToken: null,
			runClaimedAt: null,
		});
		expect(row(prepared.records, "libraryCleanupApproval")).toMatchObject({
			status: "executing",
			executionToken: null,
			executionAuditCorrelationId: "durable-audit",
			safetySnapshot: "durable-selection",
		});
		expect(row(prepared.records, "libraryCleanupMediaServerScan")).toMatchObject({
			status: "triggering",
			executionToken: null,
			requestStartedAt: date,
		});
	});
	for (const key of [destinationKey, sourceKey, Buffer.alloc(32, 3).toString("base64")])
		it(`translates all nine pairs using supplied effective key ${key.slice(0, 2)}`, async () => {
			const backup = fixture();
			const before = JSON.stringify(backup);
			const target = new Encryptor(key);
			const prepared = await prepare(backup, target);
			HISTORICAL_ENCRYPTED_FIELDS.forEach((pair, i) => {
				const translated = row(prepared.records, pair.payloadField);
				const original = row(backup.data, pair.payloadField);
				expect(
					target.decrypt({
						value: translated[pair.valueField] as string,
						iv: translated[pair.ivField] as string,
					}),
				).toBe(plaintexts[i]);
				expect(translated[pair.ivField]).not.toBe(original[pair.ivField]);
				expect(translated[pair.valueField]).not.toBe(original[pair.valueField]);
			});
			expect(JSON.stringify(backup)).toBe(before);
			expect(prepared.safetyCoverage).toBe("complete");
			expect(prepared.destinationInstallationId).toBe("destination-installation");
			expect(prepared.records.sessions).toEqual([]);
			expect(row(prepared.records, "users").hashedPassword).toBe("authentic-synthetic-hash");
			expect(prepared.records.oidcAccounts).toEqual(backup.data.oidcAccounts);
			expect(prepared.records.webAuthnCredentials).toEqual(backup.data.webAuthnCredentials);
			const serialized = JSON.stringify(prepared);
			for (const secret of [
				sourceKey,
				"source-cookie-secret",
				"synthetic-password",
				"arr-synthetic",
				file.path,
			])
				expect(serialized).not.toContain(secret);
			expect(prepared).not.toHaveProperty("secrets");
			expect(row(prepared.records, "arrImportOperations")).toMatchObject({
				state: "unknown",
				commandId: 42,
				reconcileToken: null,
				reconcileExpiresAt: null,
			});
			expect(prepared.records.arrImportSourceClaims).toEqual(backup.data.arrImportSourceClaims);
			assertPreparedRestoreData(prepared);
			expect(() => assertPreparedRestoreData({ ...prepared })).toThrow("invalid-backup");
			expect(() => assertPreparedRestoreData(JSON.parse(serialized))).toThrow("invalid-backup");
			expect(() => {
				row(prepared.records, "users").hashedPassword = "tamper";
			}).toThrow();
		});
	for (const version of ["1.0", "1.1", "1.2"] as const)
		it(`preserves incomplete coverage for legacy ${version}`, async () => {
			const backup = fixture(version);
			for (const field of PORTABLE_SAFETY_PAYLOAD_FIELDS) delete backup.data[field];
			const prepared = await prepare(backup);
			expect(prepared.safetyCoverage).toBe("legacy-incomplete");
			expect(prepared.formatVersion).toBe(version);
			expect(prepared.records.arrImportOperations).toBeUndefined();
		});
	it("preserves optional absent and null pairs", async () => {
		const backup = fixture();
		const user = row(backup.data, "users");
		delete user.encryptedTmdbApiKey;
		delete user.tmdbEncryptionIv;
		user.encryptedTraktAccessToken = null;
		user.traktTokenIv = null;
		const prepared = await prepare(backup);
		expect(row(prepared.records, "users")).not.toHaveProperty("encryptedTmdbApiKey");
		expect(row(prepared.records, "users")).toMatchObject({
			encryptedTraktAccessToken: null,
			traktTokenIv: null,
		});
	});
	for (const pair of HISTORICAL_ENCRYPTED_FIELDS) {
		it(`rejects half pair ${pair.valueField}`, async () => {
			const backup = fixture();
			delete row(backup.data, pair.payloadField)[pair.ivField];
			await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
		});
		it(`rejects malformed crypto ${pair.valueField}`, async () => {
			const backup = fixture();
			row(backup.data, pair.payloadField)[pair.ivField] = "bad-base64";
			await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
		});
		it(`rejects authenticated ciphertext corruption ${pair.valueField}`, async () => {
			const backup = fixture();
			const record = row(backup.data, pair.payloadField);
			const buffer = Buffer.from(record[pair.valueField] as string, "base64");
			buffer[buffer.length - 1] = buffer[buffer.length - 1]! ^ 1;
			record[pair.valueField] = buffer.toString("base64");
			if (pair.model === "ServiceInstance") {
				const fingerprint = importConnectionFingerprint(
					row(backup.data, "serviceInstances") as unknown as ServiceInstance,
				);
				row(backup.data, "arrImportOperations").connectionFingerprint = fingerprint;
				row(backup.data, "queueCleanerImportReceipts").connectionFingerprint = fingerprint;
			}
			await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
		});
		if (pair.required)
			it(`rejects absent required pair ${pair.valueField}`, async () => {
				const backup = fixture();
				delete row(backup.data, pair.payloadField)[pair.valueField];
				delete row(backup.data, pair.payloadField)[pair.ivField];
				await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
			});
	}
	it("rejects authentic envelope with a malformed lookup", async () => {
		const backup = fixture();
		const encrypted = source.encrypt(
			JSON.stringify({ version: 2, service: "radarr", files: [file] }),
		);
		Object.assign(row(backup.data, "arrImportOperations"), {
			encryptedSources: encrypted.value,
			sourcesEncryptionIv: encrypted.iv,
		});
		await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
	});
	for (const field of [
		"commandFingerprint",
		"fileFingerprint",
		"downloadKey",
		"pathHash",
		"movieId",
	])
		it(`rejects lookup proof mismatch ${field}`, async () => {
			const backup = fixture();
			if (field === "commandFingerprint")
				row(backup.data, "arrImportOperations")[field] = `v1:${"c".repeat(64)}`;
			else if (field === "pathHash" || field === "movieId")
				(row(backup.data, "arrImportFileProofs").identityJson as Row)[field] =
					field === "movieId" ? 8 : "d".repeat(64);
			else
				row(backup.data, "arrImportFileProofs")[field] =
					field === "fileFingerprint" ? `v1:${"d".repeat(64)}` : "d".repeat(64);
			if (field === "commandFingerprint")
				row(backup.data, "queueCleanerImportReceipts").commandFingerprint = row(
					backup.data,
					"arrImportOperations",
				).commandFingerprint;
			if (field === "downloadKey") {
				row(backup.data, "queueCleanerImportReceipts").downloadKey = "d".repeat(64);
				row(backup.data, "arrImportSourceClaims").downloadKey = "d".repeat(64);
			}
			await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-credential" });
		});
	it("rejects wrong password and tampered auth tag with bounded failure", async () => {
		const envelope = await encryptBackupData(JSON.stringify(fixture()), "synthetic-password");
		for (const args of [
			{ envelope, password: "wrong-secret" },
			{
				envelope: { ...envelope, tag: Buffer.alloc(16).toString("base64") },
				password: "synthetic-password",
			},
		]) {
			const failure = await prepareRestoreData({
				...args,
				destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
			}).catch((error) => error);
			expect(failure.category).toBe("authentication-failed");
			expect(failure.message).toBe("authentication-failed");
			expect(failure).not.toHaveProperty("cause");
			expect(JSON.stringify(failure)).not.toContain("secret");
		}
	});
	for (const iterations of [0, -1, 600001, NaN, Infinity, 1.5])
		it(`rejects unsafe KDF count ${iterations}`, async () => {
			const envelope = await encryptBackupData("{}", "synthetic-password");
			envelope.kdfParams.iterations = iterations;
			await expect(
				prepareRestoreData({
					envelope,
					password: "synthetic-password",
					destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
				}),
			).rejects.toMatchObject({ category: "invalid-envelope" });
		});
	it("rejects noncanonical envelope before authentication", async () => {
		const envelope = await encryptBackupData("{}", "synthetic-password");
		await expect(
			prepareRestoreData({
				envelope: { ...envelope, salt: `${envelope.salt}\n` },
				password: "synthetic-password",
				destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
			}),
		).rejects.toMatchObject({ category: "invalid-envelope" });
	});
	for (const context of [
		{ installationId: "", stableForRestart: true },
		{ installationId: "stable", stableForRestart: false },
	])
		it(`rejects unavailable destination ${JSON.stringify(context)}`, async () => {
			const envelope = await encryptBackupData(JSON.stringify(fixture()), "synthetic-password");
			await expect(
				prepareRestoreData({
					envelope,
					password: "synthetic-password",
					destination: { encryptor: destination, ...context },
				}),
			).rejects.toMatchObject({ category: "destination-unavailable" });
		});
	it("rejects incomplete current format", async () => {
		const backup = fixture();
		delete backup.data.quiActionClaims;
		await expect(prepare(backup)).rejects.toMatchObject({ category: "invalid-backup" });
	});
	for (const status of ["claimed", "sending", "unknown"] as const)
		it(`preserves label-sync hold and bounds ownership disposition ${status}`, async () => {
			const backup = fixture();
			const encrypted = source.encrypt("label-synthetic");
			backup.data.serviceInstances.push({
				id: "label-instance",
				userId: "owner",
				service: "JELLYFIN",
				baseUrl: "http://label.invalid",
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
			});
			backup.data.labelSyncRule = [
				{ id: "rule", userId: "owner", destInstanceId: "label-instance", destService: "jellyfin" },
			];
			const attempt = {
				id: "label-attempt",
				userId: "owner",
				ruleId: "rule",
				destinationInstanceId: "label-instance",
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
				activeOperationKey: "durable-hold",
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
			};
			backup.data.labelSyncMutationAttempts = [attempt];
			const prepared = await prepare(backup);
			expect(row(prepared.records, "labelSyncMutationAttempts")).toEqual({
				...attempt,
				status: "restored-held",
				reasonCode: "restore_uncertain",
				claimToken: null,
				restoreEvidence: JSON.stringify({
					version: 1,
					originalStatus: status,
					originalReasonCode: attempt.reasonCode,
					originalSendAttemptCount: attempt.sendAttemptCount,
					originalReconcileAttemptCount: attempt.reconcileAttemptCount,
					originalRequestStartedAt: attempt.requestStartedAt,
					originalLastObservedAt: null,
					originalCreatedAt: date,
					originalUpdatedAt: date,
				}),
			});
			expect(originalPreparedRestoreRecords(prepared).labelSyncMutationAttempts).toEqual([attempt]);
			expect(prepared.publicationBlockers).toEqual([]);
		});
	it("rejects oversized encoded ciphertext before allocating decoded buffers", async () => {
		const envelope = await encryptBackupData("{}", "synthetic-password");
		envelope.cipherText = "A".repeat(4 * Math.ceil((200 * 1024 * 1024) / 3) + 4);
		await expect(
			prepareRestoreData({
				envelope,
				password: "synthetic-password",
				destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
			}),
		).rejects.toMatchObject({ category: "invalid-envelope" });
	});
	it("prepares a measured synthetic payload of 10000 authenticated users", async () => {
		const backup = fixture();
		for (let i = 0; i < 10000; i++)
			backup.data.users.push({
				id: `synthetic-${i}`,
				username: `user-${i}`,
				hashedPassword: "synthetic-hash",
				createdAt: date,
				updatedAt: date,
			});
		const json = JSON.stringify(backup);
		const envelope = await encryptBackupData(json, "synthetic-password");
		const start = performance.now();
		const prepared = await prepareRestoreData({
			envelope,
			password: "synthetic-password",
			destination: { encryptor: destination, installationId: "stable", stableForRestart: true },
		});
		expect(prepared.records.users).toHaveLength(10001);
		process.stdout.write(
			JSON.stringify({
				measurement: "synthetic-preparation",
				jsonBytes: Buffer.byteLength(json),
				encodedCiphertextBytes: envelope.cipherText.length,
				users: 10001,
				elapsedMs: performance.now() - start,
				heapUsedBytes: process.memoryUsage().heapUsed,
				peakResidentBytes: process.resourceUsage().maxRSS * 1024,
			}) + "\n",
		);
	});
});
