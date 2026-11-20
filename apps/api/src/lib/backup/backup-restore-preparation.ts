import type { BackupData, BackupFormatVersion } from "@arr/shared";
import { ArrClientFactory } from "../arr/client-factory.js";
import { Encryptor } from "../auth/encryption.js";
import { prepareRestoredLabelSyncMutationAttempt } from "../label-sync/jellyfin-mutation-restore.js";
import type { ServiceInstance } from "../prisma.js";
import { isDeploymentBackupEndpointIdentityCurrent } from "../trash-guides/deployment-target.js";
import {
	decryptBackupData,
	type EncryptedBackupEnvelope,
	PBKDF2_ITERATIONS,
} from "./backup-crypto.js";
import { translatePortableNotificationOutbox } from "./backup-notification-outbox.js";
import {
	ENCRYPTED_BACKUP_FIELDS,
	PORTABLE_SAFETY_PAYLOAD_FIELDS,
	validatePortableImportLookup,
	validatePortableSafetyState,
} from "./backup-portability.js";
import {
	type PreparedConnectionBinding,
	translateRestoreBindings,
	validateOriginalRestoreBindings,
} from "./backup-restore-bindings.js";
import { translatePortableGrabSafety, validatePortableGrabTarget } from "./backup-search-grab.js";
import {
	hasCompleteGrabCoverage,
	hasCompleteNotificationOutboxCoverage,
	hasCompleteSafetyCoverage,
	isEncryptedBackupEnvelope,
	normalizeBackupForRestore,
	validateBackup,
} from "./backup-validation.js";

export type RestorePreparationFailure =
	| "invalid-envelope"
	| "authentication-failed"
	| "invalid-backup"
	| "destination-unavailable"
	| "invalid-credential"
	| "invalid-binding";
export class RestorePreparationError extends Error {
	constructor(readonly category: RestorePreparationFailure) {
		super(category);
	}
}
export interface RestoreDestinationContext {
	encryptor: Encryptor;
	installationId: string;
	stableForRestart: boolean;
}
export interface PreparedRestoreData {
	readonly records: BackupData["data"];
	readonly formatVersion: BackupFormatVersion;
	readonly safetyCoverage: "complete" | "legacy-incomplete";
	/** Historical import/qUI/label coverage does not imply Grab coverage. */
	readonly grabSafetyCoverage: "complete" | "legacy-incomplete";
	/** Present additive legacy rows do not establish complete notification coverage. */
	readonly notificationOutboxCoverage: "complete" | "legacy-incomplete";
	readonly destinationInstallationId: string;
	readonly connectionBindings: readonly PreparedConnectionBinding[];
	readonly publicationBlockers: readonly "label-sync-worker-state-untranslated"[];
}
const MAX_BYTES = 200 * 1024 * 1024;
const preparedValues = new WeakSet<object>();
// Authenticated historical ciphertext/action evidence, retained solely for
// conservation. Never contains envelope secrets, sessions or decrypted values.
const originalRecords = new WeakMap<object, BackupData["data"]>();
type Row = Record<string, unknown>;
type ConservedCredentialField =
	| "serviceInstances"
	| "arrImportOperations"
	| "searchGrabAttempts"
	| "notificationOutboxEvents";
// Destination-local capability only: never part of records, serialization or
// the historical witness. It dies with the genuine preparation, not the process.
const conservationCredentials = new WeakMap<
	object,
	{
		encryptor: Encryptor;
		indexes: Map<
			ConservedCredentialField,
			{ original: Map<string, Row>; translated: Map<string, Row> }
		>;
	}
>();
function fail(category: RestorePreparationFailure): never {
	throw new RestorePreparationError(category);
}
function base64(
	value: unknown,
	minimum: number,
	maximum: number,
	category: RestorePreparationFailure,
): void {
	if (
		typeof value !== "string" ||
		value.length > 4 * Math.ceil(maximum / 3) ||
		value.length % 4 !== 0
	)
		fail(category);
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const decodedLength = (value.length / 4) * 3 - padding;
	if (decodedLength < minimum || decodedLength > maximum || /[^A-Za-z0-9+/=]/.test(value))
		fail(category);
	const buffer = Buffer.from(value, "base64");
	const valid =
		buffer.length >= minimum && buffer.length <= maximum && buffer.toString("base64") === value;
	buffer.fill(0);
	if (!valid) fail(category);
}
function envelopeCopy(value: unknown): EncryptedBackupEnvelope {
	if (
		!isEncryptedBackupEnvelope(value) ||
		value.version !== "1.0" ||
		value.kdfParams.algorithm !== "pbkdf2" ||
		value.kdfParams.hash !== "sha256" ||
		value.kdfParams.saltLength !== 32 ||
		!Number.isSafeInteger(value.kdfParams.iterations) ||
		value.kdfParams.iterations <= 0 ||
		value.kdfParams.iterations > PBKDF2_ITERATIONS
	)
		fail("invalid-envelope");
	base64(value.salt, 32, 32, "invalid-envelope");
	base64(value.iv, 12, 12, "invalid-envelope");
	base64(value.tag, 16, 16, "invalid-envelope");
	base64(value.cipherText, 1, MAX_BYTES, "invalid-envelope");
	return {
		version: value.version,
		kdfParams: { ...value.kdfParams },
		salt: value.salt,
		iv: value.iv,
		tag: value.tag,
		cipherText: value.cipherText,
	};
}
function records(value: unknown): Row[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail("invalid-backup");
	return value.map((row) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) fail("invalid-backup");
		return row;
	});
}
function validateCredentialPairs(data: BackupData["data"]): void {
	for (const pair of ENCRYPTED_BACKUP_FIELDS)
		for (const row of records(data[pair.payloadField])) {
			const value = row[pair.valueField],
				iv = row[pair.ivField];
			if (!pair.required && value == null && iv == null) continue;
			base64(value, 16, MAX_BYTES, "invalid-credential");
			base64(iv, 12, 12, "invalid-credential");
		}
}
function freezeGraph(value: unknown): void {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeGraph(child);
	Object.freeze(value);
}

/** Parsed JSON has immutable primitive leaves. Copy containers, not string payloads. */
function copyRecordContainers<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => copyRecordContainers(item)) as T;
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, copyRecordContainers(item)]),
		) as T;
	return value;
}
export async function prepareRestoreData(args: {
	envelope: unknown;
	password: string;
	destination: RestoreDestinationContext;
}): Promise<PreparedRestoreData> {
	try {
		const envelope = envelopeCopy(args.envelope);
		// Rebind our own argument; never mutate the caller's object or envelope.
		args = { ...args, envelope: undefined };
		const { encryptor, installationId, stableForRestart } = args.destination;
		if (
			!(encryptor instanceof Encryptor) ||
			typeof installationId !== "string" ||
			!installationId.trim() ||
			stableForRestart !== true
		)
			fail("destination-unavailable");
		let plaintext: string;
		try {
			plaintext = await decryptBackupData(envelope, args.password);
		} catch {
			fail("authentication-failed");
		} finally {
			// GCM has settled. The owned copy's ciphertext is no longer needed
			// while parsing plaintext; caller-owned encrypted input stays intact.
			envelope.cipherText = "";
		}
		if (Buffer.byteLength(plaintext, "utf8") > MAX_BYTES) fail("invalid-backup");
		let backup: unknown;
		try {
			backup = JSON.parse(plaintext);
		} catch {
			fail("invalid-backup");
		}
		plaintext = ""; // Best effort only; JavaScript strings cannot be guaranteed erased.
		if (
			!backup ||
			typeof backup !== "object" ||
			!("data" in backup) ||
			!backup.data ||
			typeof backup.data !== "object"
		)
			fail("invalid-backup");
		validateCredentialPairs(backup.data as BackupData["data"]);
		try {
			validateBackup(backup);
		} catch {
			fail("invalid-backup");
		}
		const normalized = normalizeBackupForRestore(backup);
		const original = normalized.data;
		// Additive legacy evidence is checked when present, without inventing coverage.
		if (
			!hasCompleteSafetyCoverage(backup.version) &&
			PORTABLE_SAFETY_PAYLOAD_FIELDS.some((field) => original[field] !== undefined)
		) {
			try {
				validatePortableSafetyState({
					...Object.fromEntries(PORTABLE_SAFETY_PAYLOAD_FIELDS.map((field) => [field, []])),
					...original,
				});
			} catch {
				fail("invalid-backup");
			}
		}
		try {
			validateOriginalRestoreBindings(original);
		} catch {
			fail("invalid-binding");
		}
		let source: Encryptor;
		try {
			source = new Encryptor(backup.secrets.encryptionKey);
		} catch {
			fail("invalid-credential");
		}
		const translated = copyRecordContainers(original);
		const witness = copyRecordContainers(original);
		witness.sessions = [];
		freezeGraph(witness);
		for (const pair of ENCRYPTED_BACKUP_FIELDS) {
			const incoming = records(original[pair.payloadField]),
				outgoing = records(translated[pair.payloadField]);
			for (let index = 0; index < incoming.length; index++) {
				const before = incoming[index]!,
					after = outgoing[index]!;
				if (!pair.required && before[pair.valueField] == null && before[pair.ivField] == null)
					continue;
				try {
					const cleartext = source.decrypt({
						value: before[pair.valueField] as string,
						iv: before[pair.ivField] as string,
					});
					if (pair.model === "ArrImportOperation")
						validatePortableImportLookup(original, before.id as string, cleartext);
					if (pair.model === "SearchGrabAttempt") validatePortableGrabTarget(before, cleartext);
					const encrypted = encryptor.encrypt(cleartext);
					base64(encrypted.value, 16, MAX_BYTES, "invalid-credential");
					base64(encrypted.iv, 12, 12, "invalid-credential");
					if (encrypted.iv === before[pair.ivField] || encryptor.decrypt(encrypted) !== cleartext)
						fail("invalid-credential");
					after[pair.valueField] = encrypted.value;
					after[pair.ivField] = encrypted.iv;
				} catch {
					fail("invalid-credential");
				}
			}
		}
		let connectionBindings: PreparedConnectionBinding[];
		try {
			connectionBindings = translateRestoreBindings(original, translated, source, encryptor);
			translatePortableGrabSafety(original, translated, source, encryptor);
			translatePortableNotificationOutbox(original, translated, source, encryptor);
		} catch {
			fail("invalid-binding");
		}
		translated.sessions = [];
		for (const operation of records(translated.arrImportOperations)) {
			operation.reconcileToken = null;
			operation.reconcileExpiresAt = null;
		}
		const publicationBlockers: Array<"label-sync-worker-state-untranslated"> = [];
		if (translated.labelSyncMutationAttempts !== undefined) {
			// Keep immutable, JSON-shaped records: freezing a Date would not freeze
			// its internal time value. The strict pure mapper validates before this copy.
			translated.labelSyncMutationAttempts = records(translated.labelSyncMutationAttempts).map(
				(attempt) => JSON.parse(JSON.stringify(prepareRestoredLabelSyncMutationAttempt(attempt))),
			);
		}
		for (const config of records(translated.libraryCleanupConfig)) {
			if ("runClaimToken" in config) config.runClaimToken = null;
			if ("runClaimedAt" in config) config.runClaimedAt = null;
		}
		for (const field of ["libraryCleanupApproval", "libraryCleanupMediaServerScan"] as const)
			for (const row of records(translated[field])) {
				if ("executionToken" in row) row.executionToken = null;
			}
		const prepared: PreparedRestoreData = {
			records: translated,
			formatVersion: backup.version,
			safetyCoverage: hasCompleteSafetyCoverage(backup.version) ? "complete" : "legacy-incomplete",
			grabSafetyCoverage: hasCompleteGrabCoverage(backup.version)
				? "complete"
				: "legacy-incomplete",
			notificationOutboxCoverage: hasCompleteNotificationOutboxCoverage(backup.version)
				? "complete"
				: "legacy-incomplete",
			destinationInstallationId: installationId,
			connectionBindings,
			publicationBlockers,
		};
		freezeGraph(prepared);
		preparedValues.add(prepared);
		originalRecords.set(prepared, witness);
		conservationCredentials.set(prepared, { encryptor, indexes: new Map() });
		return prepared;
	} catch (error) {
		if (error instanceof RestorePreparationError) throw error;
		fail("invalid-backup");
	}
}
export function assertPreparedRestoreData(value: unknown): asserts value is PreparedRestoreData {
	if (!value || typeof value !== "object" || !preparedValues.has(value) || !Object.isFrozen(value))
		fail("invalid-backup");
}

/** Internal conservation-only accessor; never insertion data. */
export function originalPreparedRestoreRecords(value: unknown): BackupData["data"] {
	assertPreparedRestoreData(value);
	const witness = originalRecords.get(value);
	if (!witness) fail("invalid-backup");
	return witness;
}

/** Conservation only; no plaintext/key output and no execution fingerprint changes. */
export function preparedRestoreEncryptedFieldsMatch(
	value: unknown,
	field: ConservedCredentialField,
	current: Row,
): boolean {
	assertPreparedRestoreData(value);
	const capability = conservationCredentials.get(value);
	if (!capability || typeof current.id !== "string") return false;
	let index = capability.indexes.get(field);
	if (!index) {
		const indexed = (rows: readonly Row[]) => {
			const result = new Map<string, Row>();
			for (const row of rows) {
				if (typeof row.id !== "string" || result.has(row.id)) fail("invalid-backup");
				result.set(row.id, row);
			}
			return result;
		};
		index = {
			original: indexed(records(originalPreparedRestoreRecords(value)[field])),
			translated: indexed(records(value.records[field])),
		};
		capability.indexes.set(field, index);
	}
	const original = index.original.get(current.id),
		translated = index.translated.get(current.id);
	if (!original || !translated) return false;
	for (const pair of ENCRYPTED_BACKUP_FIELDS) {
		if (pair.payloadField !== field) continue;
		const ciphertext = current[pair.valueField],
			iv = current[pair.ivField];
		if (!pair.required && original[pair.valueField] == null && original[pair.ivField] == null) {
			if (ciphertext != null || iv != null) return false;
			continue;
		}
		if (ciphertext === original[pair.valueField] && iv === original[pair.ivField]) continue;
		if (typeof ciphertext !== "string" || typeof iv !== "string") return false;
		try {
			base64(ciphertext, 16, MAX_BYTES, "invalid-credential");
			base64(iv, 12, 12, "invalid-credential");
			if (
				capability.encryptor.decrypt({ value: ciphertext, iv }) !==
				capability.encryptor.decrypt({
					value: translated[pair.valueField] as string,
					iv: translated[pair.ivField] as string,
				})
			)
				return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Same held connection authority; display/account metadata may have advanced. */
export function preparedRestoreConnectionMatches(value: unknown, current: Row): boolean {
	if (!preparedRestoreEncryptedFieldsMatch(value, "serviceInstances", current)) return false;
	assertPreparedRestoreData(value);
	const original = conservationCredentials
		.get(value)
		?.indexes.get("serviceInstances")
		?.original.get(String(current.id));
	return (
		!!original &&
		[
			"id",
			"userId",
			"service",
			"baseUrl",
			"enabled",
			"storageGroupId",
			"hasLocalFilesystemAccess",
			"pathPrefix",
			"connectionGeneration",
			"expectedIdentity",
			"identityKind",
			"identityStatus",
			"identityGeneration",
		].every((field) => current[field] === original[field])
	);
}

/** A current representation must still prove the exact encrypted target tuple. */
export function preparedRestoreGrabBindingMatches(value: unknown, current: Row): boolean {
	assertPreparedRestoreData(value);
	const capability = conservationCredentials.get(value);
	if (!capability || !preparedRestoreEncryptedFieldsMatch(value, "searchGrabAttempts", current))
		return false;
	try {
		validatePortableGrabTarget(
			current,
			capability.encryptor.decrypt({
				value: current.encryptedTarget as string,
				iv: current.targetIv as string,
			}),
		);
		return true;
	} catch {
		return false;
	}
}

/** Only original or genuinely translated key-dependent notification tuples match. */
export function preparedRestoreNotificationBindingMatches(value: unknown, current: Row): boolean {
	if (!preparedRestoreEncryptedFieldsMatch(value, "notificationOutboxEvents", current))
		return false;
	assertPreparedRestoreData(value);
	const index = conservationCredentials.get(value)?.indexes.get("notificationOutboxEvents");
	const original = index?.original.get(String(current.id));
	const translated = index?.translated.get(String(current.id));
	return [original, translated].some(
		(row) =>
			!!row &&
			current.dedupFingerprint === row.dedupFingerprint &&
			current.scopeFingerprint === row.scopeFingerprint,
	);
}

/** Verify current TRaSH evidence without exporting a key or credential identity. */
export function preparedRestoreTrashEndpointCurrent(
	value: unknown,
	current: Row,
	state: Row,
): boolean {
	if (!preparedRestoreConnectionMatches(value, current)) return false;
	assertPreparedRestoreData(value);
	const capability = conservationCredentials.get(value);
	if (
		!capability ||
		typeof state.endpointKey !== "string" ||
		typeof state.connectionStateToken !== "string"
	)
		return false;
	try {
		const instance = current as unknown as ServiceInstance;
		return isDeploymentBackupEndpointIdentityCurrent({
			userId: instance.userId,
			instance,
			backupEndpointKey: state.endpointKey,
			backupConnectionStateToken: state.connectionStateToken,
			credentialIdentity: new ArrClientFactory(
				capability.encryptor,
			).createConnectionCredentialIdentity(instance),
		});
	} catch {
		return false;
	}
}
