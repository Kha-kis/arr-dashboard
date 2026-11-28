import type { BackupData } from "@arr/shared";
import { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { ServiceInstance } from "../prisma.js";
import { importConnectionFingerprint } from "../queue-cleaner/import-receipt.js";
import {
	deploymentBackupStateSchema,
	shouldRetainDeploymentBackup,
} from "../trash-guides/deployment-backup-state.js";
import {
	createDeploymentConnectionBinding,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	isCurrentDeploymentConnectionMapping,
	isDeploymentBackupEndpointIdentityCurrent,
	isVerifiedClonedProfileSourceConnection,
} from "../trash-guides/deployment-target.js";
import { isDetachedTerminalImport } from "./backup-portability.js";
export interface PreparedConnectionBinding {
	readonly serviceInstanceId: string;
	readonly originalFingerprint: string;
	readonly translatedFingerprint: string;
}
type Row = Record<string, unknown>;
function invalid(): never {
	throw new Error("invalid-binding");
}
function check(condition: unknown): asserts condition {
	if (!condition) invalid();
}
function rows(value: unknown): Row[] {
	if (value === undefined) return [];
	check(Array.isArray(value));
	return value.map((row) => {
		check(row && typeof row === "object" && !Array.isArray(row));
		return row;
	});
}
function instances(data: BackupData["data"]): Map<string, Row> {
	const result = new Map<string, Row>();
	for (const row of rows(data.serviceInstances)) {
		check(
			typeof row.id === "string" &&
				row.id.length > 0 &&
				!result.has(row.id) &&
				typeof row.userId === "string" &&
				row.userId.length > 0 &&
				typeof row.service === "string" &&
				typeof row.baseUrl === "string" &&
				row.baseUrl.length > 0,
		);
		result.set(row.id, row);
	}
	return result;
}
function fingerprint(instance: Row): string {
	return importConnectionFingerprint(instance as unknown as ServiceInstance);
}

function indexedRows(value: unknown): Map<string, Row> {
	const result = new Map<string, Row>();
	for (const row of rows(value)) {
		check(typeof row.id === "string" && row.id.length > 0 && !result.has(row.id));
		result.set(row.id, row);
	}
	return result;
}

function parseJson(value: unknown): unknown {
	check(typeof value === "string");
	try {
		return JSON.parse(value);
	} catch {
		invalid();
	}
}

function record(value: unknown): Row {
	check(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Row;
}

/** Translate only bindings proved against the original exact owned ARR connection. */
function translateTrashBindings(
	original: BackupData["data"],
	translated: BackupData["data"],
	incoming: Map<string, Row>,
	outgoing: Map<string, Row>,
	source: Encryptor,
	destination: Encryptor,
): void {
	const owners = indexedRows(original.users);
	const templates = indexedRows(original.trashTemplates);
	const sourceFactory = new ArrClientFactory(source);
	const destinationFactory = new ArrClientFactory(destination);
	function connection(instanceId: unknown, userId: unknown, service?: unknown) {
		check(typeof instanceId === "string" && typeof userId === "string" && owners.has(userId));
		const before = incoming.get(instanceId),
			after = outgoing.get(instanceId);
		check(
			before &&
				after &&
				before.userId === userId &&
				["RADARR", "SONARR"].includes(String(before.service)) &&
				(service === undefined || before.service === service) &&
				Number.isSafeInteger(before.connectionGeneration ?? 0) &&
				Number(before.connectionGeneration ?? 0) >= 0,
		);
		return {
			before: before as unknown as ServiceInstance,
			after: after as unknown as ServiceInstance,
		};
	}
	for (const field of [
		"templateQualityProfileMappings",
		"instanceQualityProfileOverrides",
		"trashBackups",
		"trashTemplates",
	] as const) {
		const beforeRows = indexedRows(original[field]),
			afterRows = indexedRows(translated[field]);
		check(beforeRows.size === afterRows.size);
		for (const [id, beforeRow] of beforeRows) {
			const afterRow = afterRows.get(id);
			check(afterRow && JSON.stringify(beforeRow) === JSON.stringify(afterRow));
			if (field === "trashTemplates") {
				const config = record(parseJson(beforeRow.configData));
				if (config.completeQualityProfile == null) continue;
				const profile = record(config.completeQualityProfile);
				// Legacy source metadata remains non-authoritative, including a missing source token.
				if (profile.sourceConnectionStateToken == null) continue;
				check(
					typeof profile.sourceConnectionStateToken === "string" &&
						profile.sourceConnectionStateToken.length > 0 &&
						typeof beforeRow.serviceType === "string",
				);
				const { before, after } = connection(
					profile.sourceInstanceId,
					beforeRow.userId,
					beforeRow.serviceType,
				);
				try {
					check(
						isVerifiedClonedProfileSourceConnection({
							sourceInstanceId: before.id,
							sourceConnectionStateToken: profile.sourceConnectionStateToken,
							sourceInstance: before,
							equivalentInstanceIds: [before.id],
						}),
					);
				} catch {
					invalid();
				}
				profile.sourceConnectionStateToken = createDeploymentConnectionStateToken(after);
				afterRow.configData = JSON.stringify(config);
				continue;
			}
			if (field === "trashBackups") {
				const { before, after } = connection(beforeRow.instanceId, beforeRow.userId);
				const raw = parseJson(beforeRow.backupData);
				if (
					raw === null ||
					typeof raw !== "object" ||
					Array.isArray(raw) ||
					!("schemaVersion" in raw)
				) {
					check(!shouldRetainDeploymentBackup(beforeRow.backupData as string));
					continue;
				}
				// Use the schema only to validate. Its parsed projection strips unknown JSON fields.
				const state = record(raw);
				const validated = deploymentBackupStateSchema.safeParse(state);
				check(validated.success);
				try {
					check(
						isDeploymentBackupEndpointIdentityCurrent({
							userId: before.userId,
							instance: before,
							backupEndpointKey: validated.data.endpointKey,
							backupConnectionStateToken: validated.data.connectionStateToken,
							credentialIdentity: sourceFactory.createConnectionCredentialIdentity(before),
						}),
					);
					state.endpointKey = createDeploymentEndpointKey(after.userId, {
						...after,
						credentialIdentity: destinationFactory.createConnectionCredentialIdentity(after),
					});
				} catch {
					invalid();
				}
				state.connectionStateToken = createDeploymentConnectionStateToken(after);
				afterRow.backupData = JSON.stringify(state);
				continue;
			}
			const template =
				field === "templateQualityProfileMappings"
					? templates.get(String(beforeRow.templateId))
					: undefined;
			if (field === "templateQualityProfileMappings")
				check(template && typeof template.serviceType === "string");
			const { before, after } = connection(
				beforeRow.instanceId,
				template ? template.userId : beforeRow.userId,
				template?.serviceType,
			);
			// Only genuinely unbound legacy records remain unbound. Partial/stale bindings reject.
			if (beforeRow.connectionStateToken == null && (beforeRow.connectionGeneration ?? 0) === 0)
				continue;
			check(
				isCurrentDeploymentConnectionMapping(
					beforeRow as unknown as Parameters<typeof isCurrentDeploymentConnectionMapping>[0],
					[createDeploymentConnectionBinding(before)],
				),
			);
			afterRow.connectionStateToken = createDeploymentConnectionStateToken(after);
		}
	}
}

/** Must run on original ciphertext before any translation is attempted. */
export function validateOriginalRestoreBindings(data: BackupData["data"]): void {
	const original = instances(data);
	for (const operation of rows(data.arrImportOperations)) {
		if (operation.instanceId === null) {
			check(isDetachedTerminalImport(operation));
			continue;
		}
		const instance = original.get(String(operation.instanceId));
		check(
			instance &&
				operation.originalInstanceId === instance.id &&
				operation.userId === instance.userId &&
				operation.service === instance.service &&
				operation.connectionFingerprint === fingerprint(instance),
		);
	}
	for (const receipt of rows(data.queueCleanerImportReceipts)) {
		const instance = original.get(String(receipt.instanceId));
		check(
			instance &&
				["SONARR", "RADARR", "LIDARR", "READARR"].includes(String(instance.service)) &&
				receipt.connectionFingerprint === fingerprint(instance),
		);
	}
}

/** Representation migration only: no command dispatch, retry, or authority promotion. */
export function translateRestoreBindings(
	original: BackupData["data"],
	translated: BackupData["data"],
	source: Encryptor,
	destination: Encryptor,
): PreparedConnectionBinding[] {
	validateOriginalRestoreBindings(original);
	const incoming = instances(original),
		outgoing = instances(translated);
	check(incoming.size === outgoing.size);
	const bindings: PreparedConnectionBinding[] = [];
	for (const [id, before] of incoming) {
		const after = outgoing.get(id);
		check(
			after &&
				["id", "userId", "service", "baseUrl", "connectionGeneration"].every(
					(field) => before[field] === after[field],
				),
		);
		for (const [value, iv] of [
			["encryptedApiKey", "encryptionIv"],
			["encryptedHttpAuthCredentials", "httpAuthEncryptionIv"],
		] as const) {
			if (before[value] == null && before[iv] == null) {
				check(after[value] === before[value] && after[iv] === before[iv]);
				continue;
			}
			try {
				check(
					typeof before[value] === "string" &&
						typeof before[iv] === "string" &&
						typeof after[value] === "string" &&
						typeof after[iv] === "string",
				);
				check(
					source.decrypt({ value: before[value], iv: before[iv] }) ===
						destination.decrypt({ value: after[value], iv: after[iv] }),
				);
			} catch {
				invalid();
			}
		}
		bindings.push({
			serviceInstanceId: id,
			originalFingerprint: fingerprint(before),
			translatedFingerprint: fingerprint(after),
		});
	}
	const mapping = new Map(bindings.map((binding) => [binding.serviceInstanceId, binding]));
	for (const field of ["arrImportOperations", "queueCleanerImportReceipts"] as const) {
		const before = rows(original[field]),
			after = rows(translated[field]);
		check(before.length === after.length);
		for (let index = 0; index < before.length; index++) {
			const sourceRow = before[index]!,
				destinationRow = after[index]!;
			check(
				sourceRow.id === destinationRow.id &&
					sourceRow.instanceId === destinationRow.instanceId &&
					sourceRow.connectionFingerprint === destinationRow.connectionFingerprint,
			);
			if (field === "arrImportOperations" && sourceRow.instanceId === null) continue;
			const binding = mapping.get(String(sourceRow.instanceId));
			check(binding && sourceRow.connectionFingerprint === binding.originalFingerprint);
			destinationRow.connectionFingerprint = binding.translatedFingerprint;
		}
	}
	translateTrashBindings(original, translated, incoming, outgoing, source, destination);
	return bindings;
}
