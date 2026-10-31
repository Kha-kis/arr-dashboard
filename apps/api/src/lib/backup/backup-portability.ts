/** Portable evidence preserves intention and holds; it grants no replay authority. */

import { createHash } from "node:crypto";
import {
	type BackupData,
	manualImportServiceSchema,
	manualImportSubmissionFileSchema,
} from "@arr/shared";
import { z } from "zod";
import { parseImportReconcileCursor } from "../arr/import-operations/reconciliation-lease.js";
import type { OwnedImportAttempt } from "../arr/import-operations/repository.js";
import { importCommandFingerprint } from "../arr/manual-import-command.js";
import type { Prisma } from "../prisma.js";
import { queueDownloadKey } from "../queue-cleaner/import-receipt.js";
import { validatePortableNotificationOutbox } from "./backup-notification-outbox.js";
import { validatePortableGrabSafety } from "./backup-search-grab.js";

type ModelDisposition = {
	disposition: "portable" | "disposable" | "installation-local";
	reason: string;
	payloadField?: keyof BackupData["data"];
	preserveOnRestore?: true;
};
const portable = (payloadField: keyof BackupData["data"], reason: string): ModelDisposition => ({
	disposition: "portable",
	payloadField,
	reason,
});
const disposable = (reason: string): ModelDisposition => ({ disposition: "disposable", reason });
const local = (reason: string): ModelDisposition => ({ disposition: "installation-local", reason });

/** Explicit inventory: adding a schema model requires a considered disposition. */
export const BACKUP_MODEL_DISPOSITIONS = {
	RestoreRuntimeControl: {
		disposition: "installation-local",
		preserveOnRestore: true,
		reason: "Destination-local runtime journal; never exported or replaced by source evidence",
	},
	SqliteRestoreStorageBinding: {
		disposition: "installation-local",
		preserveOnRestore: true,
		reason: "Original destination coordination identity; source evidence cannot replace it",
	},
	User: portable("users", "Authentication and encrypted user credentials"),
	Session: portable(
		"sessions",
		"Source authentication records; future restore must revoke sessions",
	),
	ServiceTag: portable("serviceTags", "Service organization"),
	ServiceInstance: portable("serviceInstances", "Owned connection configuration and ciphertext"),
	HistoryObservation: disposable("Provider history is rebuilt; omission never proves absence"),
	HistorySourceStatus: disposable("History collection freshness is installation specific"),
	HistoryCollectionLease: local("Worker lease cannot transfer ownership"),
	InodeIndexCache: disposable("Filesystem identity must be rediscovered"),
	ServiceInstanceTag: portable("serviceInstanceTags", "Service organization links"),
	OIDCProvider: portable("oidcProviders", "Authentication provider configuration and ciphertext"),
	OIDCAccount: portable("oidcAccounts", "Owned external authentication links"),
	WebAuthnCredential: portable("webAuthnCredentials", "Passkey authentication records"),
	BackupSettings: portable("backupSettings", "Backup policy and password ciphertext"),
	SystemSettings: portable("systemSettings", "Installation preferences"),
	TrashCache: disposable("TRaSH catalog is refetched"),
	TrashTemplate: portable("trashTemplates", "User templates"),
	TrashSyncHistory: portable(
		"trashSyncHistory",
		"All active coordination; unrelated history may be capped",
	),
	TrashBackup: portable("trashBackups", "Required recovery snapshots; optional recent snapshots"),
	TrashSyncSchedule: portable("trashSyncSchedules", "Sync policy"),
	TrashSettings: portable("trashSettings", "User TRaSH preferences"),
	TemplateQualityProfileMapping: portable("templateQualityProfileMappings", "Deployment mappings"),
	InstanceQualityProfileOverride: portable(
		"instanceQualityProfileOverrides",
		"Overrides and unresolved intent",
	),
	TemplateDeploymentHistory: portable(
		"templateDeploymentHistory",
		"Active recovery; unrelated history may be capped",
	),
	StandaloneCFDeployment: portable("standaloneCFDeployments", "Deployment ownership"),
	QualitySizeMapping: portable("qualitySizeMappings", "User quality mappings"),
	HuntConfig: portable("huntConfigs", "Hunting policy"),
	HuntLog: portable("huntLogs", "Optional bounded operational history"),
	HuntSearchHistory: portable("huntSearchHistory", "Optional bounded search history"),
	LibraryCache: disposable("Provider library inventory must be refreshed"),
	EpisodeFileCache: disposable("Provider file evidence must be refreshed"),
	LibrarySyncStatus: portable(
		"librarySyncSettings",
		"Polling policy only; volatile sync ownership is excluded",
	),
	DashboardStatisticsSnapshot: disposable("Derived dashboard statistics"),
	UserCustomFormat: portable("userCustomFormat", "User custom formats"),
	QueueCleanerConfig: portable("queueCleanerConfig", "Queue cleanup policy"),
	QueueCleanerLog: disposable(
		"Ordinary cleanup history; import protection lives in durable receipts",
	),
	QueueCleanerStrike: disposable("Ephemeral strikes; never import completion authority"),
	QueueCleanerImportReceipt: portable(
		"queueCleanerImportReceipts",
		"Uncapped import command identity and protection",
	),
	ArrImportOperation: portable(
		"arrImportOperations",
		"Uncapped import intention, outcome and encrypted lookup",
	),
	ArrImportFileProof: portable("arrImportFileProofs", "Exactly linked positive import evidence"),
	ArrImportSourceClaim: portable(
		"arrImportSourceClaims",
		"Durable source holds; not worker ownership",
	),
	LibraryCleanupConfig: portable("libraryCleanupConfig", "Cleanup policy"),
	LibraryCleanupRule: portable("libraryCleanupRule", "Cleanup rules"),
	LibraryCleanupApproval: portable(
		"libraryCleanupApproval",
		"Active approval and pending terminal audit coordination",
	),
	LibraryCleanupMediaServerScan: portable(
		"libraryCleanupMediaServerScan",
		"Active scan coordination and required parents",
	),
	LibraryCleanupMediaServerScanLease: local("Nonportable scan worker lease"),
	LibraryCleanupLog: disposable("Terminal cleanup history"),
	LibraryCleanupAuditEvent: disposable(
		"Terminal cleanup audit; pending audit remains in approvals",
	),
	NotificationChannel: portable("notificationChannel", "Delivery configuration and ciphertext"),
	NotificationSubscription: portable("notificationSubscription", "Channel subscriptions"),
	NotificationLog: disposable("Installation delivery history cannot be replayed"),
	NotificationOutboxEvent: portable(
		"notificationOutboxEvents",
		"Uncapped encrypted accepted work and aggregation lineage; never Restore replay authority",
	),
	NotificationOutboxDelivery: portable(
		"notificationOutboxDeliveries",
		"Exact historical recipients, remaining retries and uncertain outcomes; never Restore replay authority",
	),
	VapidKeys: portable("vapidKeys", "Push signing credentials"),
	NotificationRule: portable("notificationRule", "Notification policy"),
	NotificationAggregationConfig: portable(
		"notificationAggregationConfig",
		"Notification aggregation policy",
	),
	PlexCache: disposable("Provider display evidence must be refreshed"),
	PlexGenerationTarget: disposable("Provider generation must be re-established"),
	PlexEpisodeCache: disposable("Provider episode evidence must be refreshed"),
	JellyfinCache: disposable("Provider display evidence must be refreshed"),
	JellyfinEpisodeCache: disposable("Provider episode evidence must be refreshed"),
	JellyfinEpisodeGenerationRow: disposable("Provider episode generation must be refreshed"),
	JellyfinEpisodeGenerationShowReceipt: disposable("Provider generation receipt must be refreshed"),
	JellyfinEpisodePreparation: disposable("Provider preparation must be re-established"),
	JellyfinNativeWatchPublication: disposable("Watch publication is bound to the source generation"),
	JellyfinNativeWatchScopeReceipt: disposable("Watch completeness must be re-established"),
	JellyfinNativeWatchRow: disposable("Watch evidence must be refreshed; absence remains unknown"),
	JellyfinPositiveWatchRow: disposable("Positive display evidence must be refreshed"),
	TautulliCache: disposable("Provider history must be refreshed"),
	CacheRefreshStatus: disposable("Refresh freshness and progress are not portable"),
	ProviderObservationRun: disposable("Observation generation must be re-established"),
	ProviderNativeInventoryRun: disposable("Inventory generation must be re-established"),
	ProviderNativeInventoryPass: disposable("Inventory pass must be re-established"),
	ProviderNativeInventoryPageReceipt: disposable("Inventory pagination evidence must be refreshed"),
	ProviderNativeInventorySeenItem: disposable("Inventory staging is rebuildable"),
	ProviderNativeInventoryStageItem: disposable("Inventory staging is rebuildable"),
	ProviderNativeInventorySnapshot: disposable(
		"Source-bound inventory publication must be refreshed",
	),
	ProviderNativeInventoryItem: disposable("Source-bound inventory evidence must be refreshed"),
	ProviderObservationUnit: disposable("Observation unit must be refreshed"),
	PlexEpisodeObservationStage: disposable("Episode staging is rebuildable"),
	JellyfinEpisodeObservationStage: disposable("Episode staging is rebuildable"),
	JellyfinEpisodeObservationExclusion: disposable("Generation exclusions must be re-established"),
	SessionSnapshot: disposable("Playback observation history"),
	NamingConfig: portable("namingConfig", "Naming policy"),
	NamingDeployHistory: portable(
		"namingDeployHistory",
		"Active recovery; unrelated history may be capped",
	),
	SeerrActionLog: disposable("Ordinary request audit cannot authorize replay"),
	LabelSyncRule: portable("labelSyncRule", "Label desired-state policy"),
	LabelSyncMutationAttempt: portable(
		"labelSyncMutationAttempts",
		"Uncapped provider outcome and uncertain holds",
	),
	AutoTagRule: portable("autoTagRule", "Automatic tag policy"),
	TmdbListCache: disposable("List inventory is refetched"),
	TraktListCache: disposable("List inventory is refetched"),
	ListCacheRefreshStatus: disposable("List freshness is installation specific"),
	QuiActivityLog: disposable("Ordinary observed activity"),
	QuiObservationPublication: disposable("Source-bound qUI publication must be refreshed"),
	QuiTorrentObservation: disposable("qUI inventory observations must be refreshed"),
	QuiActionLog: portable("quiActionLogs", "Uncapped action intention and outcome evidence"),
	QuiActionClaim: portable("quiActionClaims", "Durable exact-target holds; not replay authority"),
	QuiEventLog: disposable("Inbound event history cannot be replayed"),
	SearchGrabAttempt: portable("searchGrabAttempts", "Uncapped Grab intention and outcome evidence"),
	SearchGrabClaim: portable("searchGrabClaims", "Exact-target Grab holds; never replay authority"),
} satisfies Record<Prisma.ModelName, ModelDisposition>;

export const ENCRYPTED_BACKUP_FIELDS = [
	{
		model: "User",
		payloadField: "users",
		valueField: "encryptedTmdbApiKey",
		ivField: "tmdbEncryptionIv",
		required: false,
	},
	{
		model: "User",
		payloadField: "users",
		valueField: "encryptedTraktAccessToken",
		ivField: "traktTokenIv",
		required: false,
	},
	{
		model: "ServiceInstance",
		payloadField: "serviceInstances",
		valueField: "encryptedApiKey",
		ivField: "encryptionIv",
		required: true,
	},
	{
		model: "ServiceInstance",
		payloadField: "serviceInstances",
		valueField: "encryptedHttpAuthCredentials",
		ivField: "httpAuthEncryptionIv",
		required: false,
	},
	{
		model: "OIDCProvider",
		payloadField: "oidcProviders",
		valueField: "encryptedClientSecret",
		ivField: "clientSecretIv",
		required: true,
	},
	{
		model: "BackupSettings",
		payloadField: "backupSettings",
		valueField: "encryptedPassword",
		ivField: "passwordIv",
		required: false,
	},
	{
		model: "NotificationChannel",
		payloadField: "notificationChannel",
		valueField: "encryptedConfig",
		ivField: "configIv",
		required: true,
	},
	{
		model: "VapidKeys",
		payloadField: "vapidKeys",
		valueField: "encryptedPrivateKey",
		ivField: "privateKeyIv",
		required: true,
	},
	{
		model: "ArrImportOperation",
		payloadField: "arrImportOperations",
		valueField: "encryptedSources",
		ivField: "sourcesEncryptionIv",
		required: true,
	},
	{
		model: "SearchGrabAttempt",
		payloadField: "searchGrabAttempts",
		valueField: "encryptedTarget",
		ivField: "targetIv",
		required: true,
	},
	{
		model: "NotificationOutboxEvent",
		payloadField: "notificationOutboxEvents",
		valueField: "encryptedPayload",
		ivField: "payloadIv",
		required: true,
	},
] as const;

export const PORTABLE_SAFETY_PAYLOAD_FIELDS = [
	"arrImportOperations",
	"arrImportFileProofs",
	"arrImportSourceClaims",
	"queueCleanerImportReceipts",
	"quiActionClaims",
	"quiActionLogs",
	"labelSyncMutationAttempts",
] as const;

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^v1:[a-f0-9]{64}$/);
const torrentHash = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const date = z.union([z.date(), z.string()]).refine((v) => Number.isFinite(new Date(v).getTime()));
const importService = z.enum(["SONARR", "RADARR", "LIDARR", "READARR"]);
const operationSchema = z
	.object({
		id: text,
		userId: text,
		instanceId: text.nullable(),
		originalInstanceId: text,
		connectionFingerprint: hash,
		service: importService,
		origin: z.enum(["manual", "queue-cleaner"]),
		mode: z.enum(["Move", "Copy"]),
		idempotencyKey: text,
		requestFingerprint: fingerprint,
		commandFingerprint: fingerprint,
		encryptedSources: text,
		sourcesEncryptionIv: text,
		legacyReceiptId: text.nullable(),
		state: z.enum([
			"preparing",
			"submitting",
			"pending",
			"unknown",
			"partial",
			"completed",
			"failed",
			"not-submitted",
		]),
		reason: z.string().nullable(),
		commandId: positive.nullable(),
		commandState: z.enum(["pending", "unknown", "completed", "failed"]).nullable(),
		commandTerminal: z.boolean(),
		selectedFileCount: positive.max(1000),
		verifiedFileCount: integer,
		preparationExpiresAt: date,
		submissionStartedAt: date.nullable(),
		lastCheckedAt: date.nullable(),
		nextCheckAt: date.nullable(),
		reconcileToken: text.nullable(),
		reconcileExpiresAt: date.nullable(),
		reconcileCursor: z.unknown(),
		revision: integer,
		createdAt: date,
		updatedAt: date,
	})
	.passthrough();
const fileSchema = z
	.object({
		id: text,
		operationId: text,
		fileFingerprint: fingerprint,
		downloadKey: hash,
		identityJson: z.record(z.string(), z.unknown()),
		verifiedAt: date.nullable(),
		createdAt: date,
	})
	.passthrough();
const sourceSchema = z
	.object({
		id: text,
		userId: text,
		downloadKey: hash,
		activeOperationId: text.nullable(),
		createdAt: date,
		updatedAt: date,
	})
	.passthrough();
const receiptSchema = z
	.object({
		id: text,
		instanceId: text,
		downloadKey: hash,
		queueId: positive,
		downloadTitle: z.string(),
		connectionFingerprint: hash,
		commandFingerprint: fingerprint,
		commandId: positive.nullable(),
		state: z.enum(["submitting", "pending", "unknown", "completed", "failed"]),
		lastAttemptAt: date,
		createdAt: date,
		updatedAt: date,
	})
	.passthrough();
const claimSchema = z
	.object({
		userId: text,
		serviceInstanceId: text,
		qbitInstanceId: positive,
		torrentHash: torrentHash.refine((v) => v === v.toLowerCase()),
		attemptId: text,
		createdAt: date,
	})
	.passthrough();
const logSchema = z
	.object({
		id: text,
		userId: text,
		serviceInstanceId: text,
		qbitInstanceId: positive,
		torrentHash,
		action: text,
		payload: z.string().nullable(),
		status: z.enum([
			"pending",
			"success",
			"failed",
			"uncertain",
			"operator_verified_applied",
			"operator_verified_not_applied",
		]),
		error: z.string().nullable(),
		attemptId: text.nullable(),
		requestedAt: date,
		completedAt: date.nullable(),
	})
	.passthrough();
type Operation = z.infer<typeof operationSchema>;
type FileProof = z.infer<typeof fileSchema>;
type RecordRow = Record<string, unknown>;

function invalid(): never {
	throw new Error("Invalid portable safety backup state");
}
function check(condition: unknown): asserts condition {
	if (!condition) invalid();
}
function records(value: unknown): RecordRow[] {
	check(Array.isArray(value));
	return value.map((row) => {
		check(row && typeof row === "object" && !Array.isArray(row));
		return row;
	});
}
function parseRows<T extends z.ZodType>(schema: T, value: unknown): z.infer<T>[] {
	const result = z.array(schema).safeParse(value);
	check(result.success);
	return result.data;
}
function unique<T>(rows: T[], key: (row: T) => unknown): Map<string, T> {
	const map = new Map<string, T>();
	for (const row of rows) {
		const value = key(row);
		check(typeof value === "string" && value.length > 0 && !map.has(value));
		map.set(value, row);
	}
	return map;
}
function sameOwner(instance: RecordRow | undefined, userId: string, service?: string): void {
	check(
		instance &&
			instance.userId === userId &&
			(service === undefined || instance.service === service),
	);
}
function identityValid(service: Operation["service"], identity: RecordRow): boolean {
	if (!hash.safeParse(identity.pathHash).success) return false;
	const fields = {
		SONARR: ["seriesId", "episodeIds", "episodeFileId"],
		RADARR: ["movieId", "movieFileId"],
		LIDARR: ["artistId", "albumId", "trackIds", "trackFileId", "albumReleaseId"],
		READARR: ["authorId", "bookId", "bookFileId"],
	}[service];
	if (Object.keys(identity).some((field) => field !== "pathHash" && !fields.includes(field)))
		return false;
	const required = {
		SONARR: ["seriesId", "episodeIds"],
		RADARR: ["movieId"],
		LIDARR: ["artistId", "albumId"],
		READARR: ["authorId", "bookId"],
	}[service];
	return fields.every((field) => {
		const value = identity[field];
		if (value === undefined) return !required.includes(field);
		if (field.endsWith("Ids"))
			return (
				Array.isArray(value) &&
				value.length > 0 &&
				value.every((id) => positive.safeParse(id).success) &&
				new Set(value).size === value.length
			);
		return (required.includes(field) ? positive : integer).safeParse(value).success;
	});
}
function terminalState(operation: Operation): string {
	if (operation.verifiedFileCount === operation.selectedFileCount) return "completed";
	if (operation.verifiedFileCount > 0) return "partial";
	return operation.commandState === "failed" ? "failed" : "unknown";
}
function detachedTerminal(operation: Operation): boolean {
	return (
		operation.commandTerminal &&
		operation.commandId !== null &&
		(operation.commandState === "completed" || operation.commandState === "failed") &&
		operation.state === terminalState(operation) &&
		operation.submissionStartedAt !== null &&
		operation.lastCheckedAt !== null &&
		new Date(operation.lastCheckedAt) >= new Date(operation.submissionStartedAt) &&
		new Date(operation.lastCheckedAt) <= new Date(operation.updatedAt) &&
		operation.reconcileToken === null &&
		operation.reconcileExpiresAt === null
	);
}

/** Narrow historical classification; callers must still validate all portable links. */
export function isDetachedTerminalImport(value: unknown): boolean {
	const parsed = operationSchema.safeParse(value);
	return parsed.success && parsed.data.instanceId === null && detachedTerminal(parsed.data);
}

const sourceLookupSchema = z
	.object({
		version: z.literal(1),
		service: manualImportServiceSchema,
		files: z.array(manualImportSubmissionFileSchema.strict()).min(1).max(1000),
	})
	.strict();

/** Pure equivalent of reconciliation's lookup proof, without provider reconciliation. */
export function validatePortableImportLookup(
	data: BackupData["data"],
	operationId: string,
	plaintext: string,
): void {
	check(Buffer.byteLength(plaintext, "utf8") <= 4 * 1024 * 1024);
	const parsed = sourceLookupSchema.safeParse(JSON.parse(plaintext));
	check(parsed.success);
	const operation = parseRows(operationSchema, data.arrImportOperations).find(
		(row) => row.id === operationId,
	);
	check(operation);
	const files = parseRows(fileSchema, data.arrImportFileProofs).filter(
		(row) => row.operationId === operationId,
	);
	check(
		parsed.data.service === operation.service.toLowerCase() &&
			parsed.data.files.length === operation.selectedFileCount &&
			files.length === operation.selectedFileCount &&
			importCommandFingerprint(parsed.data.files) === operation.commandFingerprint,
	);
	const proofs = new Map(files.map((file) => [file.fileFingerprint, file]));
	const seen = new Set<string>();
	for (const file of parsed.data.files) {
		const fingerprint = importCommandFingerprint([file]);
		const proof = fingerprint ? proofs.get(fingerprint) : undefined;
		check(
			fingerprint &&
				!seen.has(fingerprint) &&
				proof &&
				queueDownloadKey(file) === proof.downloadKey &&
				proof.identityJson.pathHash === createHash("sha256").update(file.path).digest("hex"),
		);
		for (const [key, expected] of Object.entries(proof.identityJson)) {
			if (key === "pathHash") continue;
			const actual = (file as Record<string, unknown>)[key];
			check(
				Array.isArray(expected) && Array.isArray(actual)
					? JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort())
					: expected === actual,
			);
		}
		seen.add(fingerprint);
	}
}

/** The existing parser consumes Dates; hydration is transient, never a payload rewrite. */
function validateCursor(operation: Operation, files: FileProof[]): void {
	if (operation.reconcileCursor === null) return;
	const nullableDate = (value: string | Date | null) => (value === null ? null : new Date(value));
	const view = {
		...operation,
		preparationExpiresAt: new Date(operation.preparationExpiresAt),
		submissionStartedAt: nullableDate(operation.submissionStartedAt),
		lastCheckedAt: nullableDate(operation.lastCheckedAt),
		nextCheckAt: nullableDate(operation.nextCheckAt),
		reconcileExpiresAt: nullableDate(operation.reconcileExpiresAt),
		createdAt: new Date(operation.createdAt),
		updatedAt: new Date(operation.updatedAt),
		files: files.map((file) => ({
			...file,
			createdAt: new Date(file.createdAt),
			verifiedAt: nullableDate(file.verifiedAt),
		})),
	} as OwnedImportAttempt;
	check(
		parseImportReconcileCursor(view, operation.reconcileCursor, new Date(operation.updatedAt)) !==
			null,
	);
}

/** Validate rows and immutable safety links without disclosing any record content. */
export function validatePortableSafetyState(data: BackupData["data"]): void {
	validatePortableGrabSafety(data);
	validatePortableNotificationOutbox(data);
	const users = unique(records(data.users), (row) => row.id);
	const instances = unique(records(data.serviceInstances), (row) => row.id);
	for (const instance of instances.values()) check(users.has(String(instance.userId)));
	const operations = parseRows(operationSchema, data.arrImportOperations);
	const operationById = unique(operations, (row) => row.id);
	unique(operations, (row) => JSON.stringify([row.userId, row.idempotencyKey]));
	unique(
		operations.filter((row) => row.legacyReceiptId !== null),
		(row) => row.legacyReceiptId,
	);
	const files = parseRows(fileSchema, data.arrImportFileProofs);
	unique(files, (row) => row.id);
	unique(files, (row) => JSON.stringify([row.operationId, row.fileFingerprint]));
	const filesByOperation = new Map<string, FileProof[]>();
	for (const file of files) {
		const operation = operationById.get(file.operationId);
		check(operation);
		check(identityValid(operation.service, file.identityJson));
		const owned = filesByOperation.get(file.operationId) ?? [];
		owned.push(file);
		filesByOperation.set(file.operationId, owned);
		if (file.verifiedAt !== null)
			check(
				operation.commandId !== null &&
					operation.submissionStartedAt !== null &&
					new Date(file.verifiedAt) >= new Date(operation.submissionStartedAt) &&
					new Date(file.verifiedAt) <= new Date(operation.updatedAt),
			);
	}
	const receipts = parseRows(receiptSchema, data.queueCleanerImportReceipts);
	const receiptById = unique(receipts, (row) => row.id);
	unique(receipts, (row) => JSON.stringify([row.instanceId, row.downloadKey]));
	for (const receipt of receipts) {
		const instance = instances.get(receipt.instanceId);
		check(instance && importService.safeParse(instance.service).success);
	}
	for (const operation of operations) {
		check(users.has(operation.userId));
		const ownedFiles = filesByOperation.get(operation.id) ?? [];
		check(
			operation.selectedFileCount === ownedFiles.length &&
				operation.verifiedFileCount === ownedFiles.filter((row) => row.verifiedAt !== null).length,
		);
		check(operation.reconcileCursor !== undefined);
		validateCursor(operation, ownedFiles);
		check((operation.reconcileToken === null) === (operation.reconcileExpiresAt === null));
		if (operation.instanceId === null) check(detachedTerminal(operation));
		else {
			check(operation.originalInstanceId === operation.instanceId);
			sameOwner(instances.get(operation.instanceId), operation.userId, operation.service);
		}
		if (operation.commandTerminal)
			check(
				operation.commandId !== null &&
					["completed", "failed"].includes(operation.commandState ?? "") &&
					operation.state === terminalState(operation),
			);
		if (operation.legacyReceiptId !== null) {
			const receipt = receiptById.get(operation.legacyReceiptId);
			if (!receipt) {
				check(operation.instanceId === null && detachedTerminal(operation));
				continue;
			}
			check(
				operation.origin === "queue-cleaner" &&
					operation.mode === "Move" &&
					receipt.instanceId === operation.originalInstanceId &&
					receipt.connectionFingerprint === operation.connectionFingerprint &&
					receipt.commandFingerprint === operation.commandFingerprint &&
					(receipt.commandId === null || receipt.commandId === operation.commandId) &&
					ownedFiles.every((file) => file.downloadKey === receipt.downloadKey),
			);
			sameOwner(instances.get(receipt.instanceId), operation.userId, operation.service);
		}
	}
	const sources = parseRows(sourceSchema, data.arrImportSourceClaims);
	unique(sources, (row) => row.id);
	unique(sources, (row) => JSON.stringify([row.userId, row.downloadKey]));
	for (const source of sources) {
		check(users.has(source.userId));
		if (source.activeOperationId === null) continue;
		const operation = operationById.get(source.activeOperationId);
		check(
			operation &&
				operation.userId === source.userId &&
				operation.instanceId !== null &&
				filesByOperation.get(operation.id)?.some((file) => file.downloadKey === source.downloadKey),
		);
	}
	const logs = parseRows(logSchema, data.quiActionLogs);
	unique(logs, (row) => row.id);
	const claims = parseRows(claimSchema, data.quiActionClaims);
	const targetKey = (row: z.infer<typeof claimSchema> | z.infer<typeof logSchema>) =>
		JSON.stringify([
			row.userId,
			row.serviceInstanceId,
			row.qbitInstanceId,
			row.torrentHash.toLowerCase(),
		]);
	const claimsByTarget = unique(claims, targetKey);
	unique(claims, (row) => row.torrentHash);
	const logsByBinding = new Map<string, Array<z.infer<typeof logSchema>>>();
	for (const log of logs) {
		check(users.has(log.userId));
		sameOwner(instances.get(log.serviceInstanceId), log.userId, "QUI");
		const key = JSON.stringify([targetKey(log), log.attemptId]);
		const linked = logsByBinding.get(key) ?? [];
		linked.push(log);
		logsByBinding.set(key, linked);
		if (["pending", "uncertain"].includes(log.status) && log.attemptId !== null) {
			check(claimsByTarget.get(targetKey(log))?.attemptId === log.attemptId);
		}
	}
	for (const claim of claims) {
		check(users.has(claim.userId));
		sameOwner(instances.get(claim.serviceInstanceId), claim.userId, "QUI");
		check(logsByBinding.get(JSON.stringify([targetKey(claim), claim.attemptId]))?.length === 1);
	}
	for (const pair of ENCRYPTED_BACKUP_FIELDS) {
		if (pair.model === "SearchGrabAttempt" && data.searchGrabAttempts === undefined) continue;
		if (pair.model === "NotificationOutboxEvent" && data.notificationOutboxEvents === undefined)
			continue;
		for (const row of records(data[pair.payloadField])) {
			const value = row[pair.valueField],
				iv = row[pair.ivField];
			check(
				(!pair.required && value == null && iv == null) ||
					(typeof value === "string" &&
						value.length > 0 &&
						typeof iv === "string" &&
						iv.length > 0),
			);
		}
	}
}
