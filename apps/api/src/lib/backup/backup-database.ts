/**
 * Backup Database Operations
 *
 * Export and restore database tables for backup/restore operations.
 * Uses Prisma transactions for atomic restore operations.
 */

import type { BackupData } from "@arr/shared";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import { BackupCompatibilityError } from "../errors.js";
import {
	isLabelSyncMutationUnresolved,
	parseLabelSyncMutationAttempt,
} from "../label-sync/jellyfin-mutation-state.js";
import { loggers } from "../logger.js";
import type { Prisma, PrismaClient, ServiceInstance, TrashBackup } from "../prisma.js";
import { importConnectionFingerprint } from "../queue-cleaner/import-receipt.js";
import { deploymentBackupStateSchema } from "../trash-guides/deployment-backup-state.js";
import { createDeploymentConnectionStateToken } from "../trash-guides/deployment-target.js";
import { assertPreparedLabelConservation } from "./backup-label-conservation.js";
import { validatePortableNotificationOutbox } from "./backup-notification-outbox.js";
import { BACKUP_MODEL_DISPOSITIONS, validatePortableSafetyState } from "./backup-portability.js";
import { validateOriginalRestoreBindings } from "./backup-restore-bindings.js";
import {
	assertPreparedRestoreData,
	originalPreparedRestoreRecords,
	type PreparedRestoreData,
	preparedRestoreConnectionMatches,
	preparedRestoreEncryptedFieldsMatch,
	preparedRestoreGrabBindingMatches,
	preparedRestoreNotificationBindingMatches,
	preparedRestoreTrashEndpointCurrent,
	RestorePreparationError,
} from "./backup-restore-preparation.js";
import {
	hasCompleteSafetyCoverage,
	isNonterminalRollback,
	isNonterminalUndeploy,
	LEGACY_RELATIONAL_CONFIG_DELEGATES,
	LEGACY_RELATIONAL_CONFIG_FIELDS,
	validateCoordinationEvidence,
	validateLabelSyncMutationAttempts,
	validateRecords,
	validateSingletonCollections,
} from "./backup-validation.js";
import {
	readRestoreRuntimeControl,
	writeRestoreRuntimeCommit,
} from "./restore-runtime-repository.js";
import {
	prepareRestoreRuntimeCommitRecord,
	type RestoreRuntimeCommitRequest,
} from "./restore-runtime-state.js";

const log = loggers.backup;
const publishingPreparedRestores = new WeakSet<PreparedRestoreData>();
const publishedPreparedRestores = new WeakSet<PreparedRestoreData>();

/** Internal only; public Restore remains disabled. */
export async function restorePreparedDatabase(
	prisma: PrismaClient,
	prepared: PreparedRestoreData,
	destinationInstallationId: string,
	runtime?: RestoreRuntimeCommitRequest,
): Promise<void> {
	let claimed = false;
	try {
		assertPreparedRestorePublication(prepared, destinationInstallationId);
		if (publishingPreparedRestores.has(prepared) || publishedPreparedRestores.has(prepared))
			throw new BackupCompatibilityError();
		publishingPreparedRestores.add(prepared);
		claimed = true;
		let admittedRuntime: Readonly<RestoreRuntimeCommitRequest> | undefined;
		let notificationProgress: NotificationRestoreProgress | undefined;
		await restoreDatabaseRecords(
			prisma,
			prepared.records,
			async (client) => {
				assertPreparedRestorePublication(prepared, destinationInstallationId);
				if (runtime !== undefined) {
					const marker = prepareRestoreRuntimeCommitRecord(
						await readRestoreRuntimeControl(client),
						admittedRuntime ?? runtime,
					);
					if (
						marker.destinationInstallationId !== destinationInstallationId ||
						marker.runtimeEpoch === null ||
						marker.activeRestoreId === null ||
						marker.lastCommittedAt === null
					)
						throw new BackupCompatibilityError();
					// Capture normalized primitives once; caller mutation cannot move
					// the admitted attempt or timestamp between preflight and commit.
					admittedRuntime ??= Object.freeze({
						runtimeEpoch: marker.runtimeEpoch,
						restoreId: marker.activeRestoreId,
						destinationInstallationId,
						committedAt: marker.lastCommittedAt,
					});
				}
				const original = originalPreparedRestoreRecords(prepared);
				// Preserve existing naming/cleanup/TRaSH/label gates against original
				// authenticated evidence, never freshly generated ciphertext.
				await assertPreparedLabelConservation(client, prepared);
				await assertNonLabelRestoreCompatibility(client, original, prepared);
				await assertDurableRestoreConservation(client, original, prepared);
				await assertGrabRestoreConservation(client, original, prepared);
				notificationProgress = await assertNotificationRestoreConservation(
					client,
					original,
					prepared,
				);
			},
			true,
			async (tx) => {
				if (admittedRuntime) await writeRestoreRuntimeCommit(tx, admittedRuntime);
			},
			() => notificationProgress,
		);
		publishedPreparedRestores.add(prepared);
	} catch {
		// Do not retain a raw Prisma/coordination cause containing private data.
		throw new BackupCompatibilityError();
	} finally {
		if (claimed) publishingPreparedRestores.delete(prepared);
	}
}

/** Pure preflight only: live destination ownership and conservation still require publication. */
export function assertPreparedRestorePublication(
	value: unknown,
	destinationInstallationId: string,
): asserts value is PreparedRestoreData {
	assertPreparedRestoreData(value);
	if (
		!hasCompleteSafetyCoverage(value.formatVersion) ||
		value.safetyCoverage !== "complete" ||
		value.publicationBlockers.length ||
		!destinationInstallationId ||
		value.destinationInstallationId !== destinationInstallationId
	)
		throw new BackupCompatibilityError();
	validatePortableSafetyState(value.records);
	validatePortableSafetyState(originalPreparedRestoreRecords(value));
	validateOriginalRestoreBindings(originalPreparedRestoreRecords(value));
	try {
		// Run the same deterministic insertion checks before terminal maintenance.
		// Execution-time ownership and live conservation still run at publication.
		validateSingletonCollections(value.records);
		validateRestoreRecords(value.records);
		prepareLibraryCleanupApprovals(value.records);
		prepareLibrarySyncSettings(value.records);
	} catch {
		// Never retain native validation details or private record values.
		throw new RestorePreparationError("invalid-backup");
	}
}

type DurableRow = Record<string, unknown>;
const DURABLE_RESTORE_TABLES = [
	["arrImportOperations", "arrImportOperation"],
	["arrImportFileProofs", "arrImportFileProof"],
	["arrImportSourceClaims", "arrImportSourceClaim"],
	["queueCleanerImportReceipts", "queueCleanerImportReceipt"],
	["quiActionClaims", "quiActionClaim"],
	["quiActionLogs", "quiActionLog"],
] as const;

function canonicalDurableValue(value: unknown, field = ""): unknown {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" && /At$/.test(field)) {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	if (Array.isArray(value)) return value.map((child) => canonicalDurableValue(child));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, canonicalDurableValue(child, key)]),
		);
	return value;
}
function durableEqual(current: unknown, incoming: unknown): boolean {
	return (
		JSON.stringify(canonicalDurableValue(current)) ===
		JSON.stringify(canonicalDurableValue(incoming))
	);
}
function quiTargetKey(row: DurableRow): string {
	return JSON.stringify([
		row.userId,
		row.serviceInstanceId,
		row.qbitInstanceId,
		typeof row.torrentHash === "string" ? row.torrentHash.toLowerCase() : null,
	]);
}
function requireDurableRow(
	current: DurableRow,
	incoming: DurableRow | undefined,
	field: (typeof DURABLE_RESTORE_TABLES)[number][0],
	prepared: PreparedRestoreData,
	connection?: { currentFingerprint: string; originalFingerprint: string },
): void {
	if (!incoming) throw new BackupCompatibilityError();
	const comparison = { ...current };
	if (field === "arrImportOperations" || field === "queueCleanerImportReceipts") {
		if (connection) {
			if (
				current.connectionFingerprint !== connection.currentFingerprint ||
				incoming.connectionFingerprint !== connection.originalFingerprint
			)
				throw new BackupCompatibilityError();
			comparison.connectionFingerprint = incoming.connectionFingerprint;
		}
		if (field === "arrImportOperations") {
			if (!preparedRestoreEncryptedFieldsMatch(prepared, field, current))
				throw new BackupCompatibilityError();
			comparison.encryptedSources = incoming.encryptedSources;
			comparison.sourcesEncryptionIv = incoming.sourcesEncryptionIv;
			// Publication clears only these installation-local worker leases. A
			// new/non-null current worker claim still has to match exactly.
			if (current.reconcileToken === null && current.reconcileExpiresAt === null) {
				comparison.reconcileToken = incoming.reconcileToken;
				comparison.reconcileExpiresAt = incoming.reconcileExpiresAt;
			}
		}
	}
	if (!durableEqual(comparison, incoming)) throw new BackupCompatibilityError();
}

async function assertDurableRestoreConservation(
	client: PrismaClient | Prisma.TransactionClient,
	original: BackupData["data"],
	prepared: PreparedRestoreData,
): Promise<void> {
	const db = client as unknown as Record<string, { findMany: () => Promise<DurableRow[]> }>;
	const current: Record<string, DurableRow[]> = {};
	for (const [field, delegate] of DURABLE_RESTORE_TABLES)
		current[field] = await db[delegate]!.findMany();
	const users = recordsById(await client.user.findMany());
	const instances = recordsById(await client.serviceInstance.findMany());
	const incomingUsers = recordsById(original.users);
	const incomingInstances = recordsById(original.serviceInstances);
	const verifiedConnections = new Map<
		string,
		{ currentFingerprint: string; originalFingerprint: string }
	>();
	const heldQuiKeys = new Set(
		current.quiActionClaims!.map((row) => JSON.stringify([quiTargetKey(row), row.attemptId])),
	);
	for (const [field] of DURABLE_RESTORE_TABLES) {
		const incomingRows = original[field] as DurableRow[];
		const incoming = new Map(
			incomingRows.map((row) => [
				field === "quiActionClaims" ? quiTargetKey(row) : String(row.id),
				row,
			]),
		);
		for (const row of current[field]!) {
			if (
				field === "quiActionLogs" &&
				row.status !== "pending" &&
				row.status !== "uncertain" &&
				!heldQuiKeys.has(JSON.stringify([quiTargetKey(row), row.attemptId]))
			)
				continue;
			let ownerId = row.userId;
			let connection: { currentFingerprint: string; originalFingerprint: string } | undefined;
			const instanceId =
				field === "quiActionClaims" || field === "quiActionLogs"
					? row.serviceInstanceId
					: row.instanceId;
			if (typeof instanceId === "string") {
				const instance = instances.get(instanceId),
					before = incomingInstances.get(instanceId);
				connection = verifiedConnections.get(instanceId);
				if (!connection) {
					if (!instance || !before || !preparedRestoreConnectionMatches(prepared, instance))
						throw new BackupCompatibilityError();
					connection = {
						currentFingerprint: importConnectionFingerprint(instance as unknown as ServiceInstance),
						originalFingerprint: importConnectionFingerprint(before as unknown as ServiceInstance),
					};
					verifiedConnections.set(instanceId, connection);
				}
				if (!instance) throw new BackupCompatibilityError();
				if (ownerId !== undefined && ownerId !== instance.userId)
					throw new BackupCompatibilityError();
				ownerId = instance.userId;
			}
			if (typeof ownerId === "string" && (!users.has(ownerId) || !incomingUsers.has(ownerId)))
				throw new BackupCompatibilityError();
			requireDurableRow(
				row,
				incoming.get(field === "quiActionClaims" ? quiTargetKey(row) : String(row.id)),
				field,
				prepared,
				connection,
			);
		}
	}
}

// Restores accept encrypted payloads up to 200 MB. Keep the destructive
// transaction bounded while allowing a supported populated restore to exceed
// Prisma's five-second interactive-transaction default on slower storage.
const RESTORE_TRANSACTION_TIMEOUT_MS = 5 * 60 * 1000;

type NotificationRestoreProgress = {
	events: Map<string, Date>;
	deliveries: Map<string, { completedAt: Date; updatedAt: Date }>;
};

function restoredNotificationDeliveryMatches(current: DurableRow, before: DurableRow): boolean {
	if (!["waiting", "ready", "retry-waiting", "submitting"].includes(String(before.state)))
		return false;
	return (
		current.state === (before.state === "submitting" ? "uncertain" : "canceled") &&
		current.outcomeCategory === "restored-not-replayed" &&
		current.completedAt !== null &&
		durableEqual(current.completedAt, current.updatedAt) &&
		durableEqual(
			{
				...current,
				state: before.state,
				outcomeCategory: before.outcomeCategory,
				completedAt: before.completedAt,
				updatedAt: before.updatedAt,
			},
			before,
		)
	);
}

/** Preserve unfinished work and its entire same-owner aggregation lineage. */
async function assertNotificationRestoreConservation(
	client: PrismaClient | Prisma.TransactionClient,
	original: BackupData["data"],
	prepared: PreparedRestoreData,
): Promise<NotificationRestoreProgress> {
	const events = await client.notificationOutboxEvent.findMany();
	const deliveries = await client.notificationOutboxDelivery.findMany();
	const users = await client.user.findMany();
	validatePortableNotificationOutbox({
		...original,
		users,
		notificationChannel: await client.notificationChannel.findMany(),
		notificationOutboxEvents: events,
		notificationOutboxDeliveries: deliveries,
	});
	const protectedIds = new Set(
		deliveries
			.filter((row) =>
				["waiting", "ready", "retry-waiting", "submitting", "uncertain"].includes(row.state),
			)
			.map((row) => row.eventId),
	);
	const connected = new Map<string, string[]>();
	for (const row of events) {
		if (!row.aggregateParentId) continue;
		for (const [from, to] of [
			[row.id, row.aggregateParentId],
			[row.aggregateParentId, row.id],
		]) {
			const links = connected.get(from!) ?? [];
			links.push(to!);
			connected.set(from!, links);
		}
	}
	// Traverse both ways: a digest's unfinished/uncertain result also retains
	// its retired members, and a held member cannot lose its digest evidence.
	const pending = [...protectedIds];
	for (let index = 0; index < pending.length; index++)
		for (const id of connected.get(pending[index]!) ?? []) {
			if (protectedIds.has(id)) continue;
			protectedIds.add(id);
			pending.push(id);
		}
	const incoming = recordsById(original.notificationOutboxEvents ?? []);
	const incomingDeliveries = recordsById(original.notificationOutboxDeliveries ?? []);
	const incomingUsers = recordsById(original.users);
	const byEvent = new Map<string, typeof deliveries>();
	const incomingByEvent = new Map<string, DurableRow[]>();
	for (const row of deliveries) {
		const selected = byEvent.get(row.eventId) ?? [];
		selected.push(row);
		byEvent.set(row.eventId, selected);
	}
	for (const row of incomingDeliveries.values()) {
		const selected = incomingByEvent.get(String(row.eventId)) ?? [];
		selected.push(row);
		incomingByEvent.set(String(row.eventId), selected);
	}
	const progress: NotificationRestoreProgress = { events: new Map(), deliveries: new Map() };
	for (const row of events) {
		const before = incoming.get(row.id);
		let matched = false;
		let previouslyRestored = false;
		if (
			before &&
			incomingUsers.has(row.userId) &&
			preparedRestoreNotificationBindingMatches(prepared, row)
		) {
			const comparison = {
				...row,
				encryptedPayload: before.encryptedPayload,
				payloadIv: before.payloadIv,
				dedupFingerprint: before.dedupFingerprint,
				scopeFingerprint: before.scopeFingerprint,
			};
			previouslyRestored =
				row.stage === "terminal" &&
				!["grouped", "terminal"].includes(String(before.stage)) &&
				durableEqual({ ...comparison, stage: before.stage, updatedAt: before.updatedAt }, before);
			const selected = byEvent.get(row.id) ?? [];
			matched =
				(durableEqual(comparison, before) || previouslyRestored) &&
				selected.length === (incomingByEvent.get(row.id) ?? []).length &&
				selected.every((delivery) => {
					const originalDelivery = incomingDeliveries.get(delivery.id);
					return (
						!!originalDelivery &&
						(durableEqual(delivery, originalDelivery) ||
							restoredNotificationDeliveryMatches(delivery, originalDelivery))
					);
				});
		}
		if (!matched) {
			if (protectedIds.has(row.id)) throw new BackupCompatibilityError();
			continue;
		}
		// A second preparation has a new quarantine timestamp. Keep the actual
		// previous Restore outcome instead of resetting its completion history.
		if (previouslyRestored) progress.events.set(row.id, row.updatedAt);
		for (const delivery of byEvent.get(row.id) ?? []) {
			const originalDelivery = incomingDeliveries.get(delivery.id)!;
			if (restoredNotificationDeliveryMatches(delivery, originalDelivery))
				progress.deliveries.set(delivery.id, {
					completedAt: delivery.completedAt!,
					updatedAt: delivery.updatedAt,
				});
		}
	}
	return progress;
}

/** Preserve every durable intent and exact hold at both publication boundaries. */
async function assertGrabRestoreConservation(
	client: PrismaClient | Prisma.TransactionClient,
	original: BackupData["data"],
	prepared: PreparedRestoreData,
): Promise<void> {
	const current = await client.searchGrabAttempt.findMany();
	const claims = await client.searchGrabClaim.findMany();
	const incoming = recordsById(original.searchGrabAttempts ?? []);
	const incomingClaims = new Map(
		(original.searchGrabClaims ?? []).map((value) => {
			const row = value as DurableRow;
			return [String(row.attemptId), row] as const;
		}),
	);
	const instances = recordsById(await client.serviceInstance.findMany());
	const originalInstances = recordsById(original.serviceInstances);
	for (const row of current) {
		const before = incoming.get(row.id);
		if (!before || !preparedRestoreEncryptedFieldsMatch(prepared, "searchGrabAttempts", row))
			throw new BackupCompatibilityError();
		const comparison: DurableRow = {
			...row,
			encryptedTarget: before.encryptedTarget,
			targetIv: before.targetIv,
		};
		// An imported null epoch cannot become source worker ownership again.
		if (row.workerEpoch === null) comparison.workerEpoch = before.workerEpoch;
		if (
			row.connectionFingerprint !== before.connectionFingerprint ||
			row.targetHash !== before.targetHash
		) {
			const instance = instances.get(row.serviceInstanceId),
				originalInstance = originalInstances.get(row.serviceInstanceId);
			if (
				!instance ||
				!originalInstance ||
				!preparedRestoreConnectionMatches(prepared, instance) ||
				createArrServiceFingerprint(instance as unknown as ServiceInstance) !==
					row.connectionFingerprint ||
				createArrServiceFingerprint(originalInstance as unknown as ServiceInstance) !==
					before.connectionFingerprint ||
				!preparedRestoreGrabBindingMatches(prepared, row)
			)
				throw new BackupCompatibilityError();
			comparison.connectionFingerprint = before.connectionFingerprint;
			comparison.targetHash = before.targetHash;
		}
		if (!durableEqual(comparison, before)) throw new BackupCompatibilityError();
	}
	const currentById = new Map(current.map((row) => [row.id, row]));
	for (const claim of claims) {
		const before = incomingClaims.get(claim.attemptId),
			attempt = currentById.get(claim.attemptId),
			originalAttempt = incoming.get(claim.attemptId),
			instance = instances.get(claim.serviceInstanceId);
		if (
			!before ||
			!attempt ||
			!originalAttempt ||
			!instance ||
			!preparedRestoreConnectionMatches(prepared, instance) ||
			claim.targetHash !== attempt.targetHash ||
			before.targetHash !== originalAttempt.targetHash ||
			!durableEqual({ ...claim, targetHash: before.targetHash }, before)
		)
			throw new BackupCompatibilityError();
	}
}
const LABEL_SYNC_MUTATION_ATTEMPT_FIELDS = {
	id: true,
	userId: true,
	ruleId: true,
	destinationInstanceId: true,
	provider: true,
	mediaType: true,
	tmdbId: true,
	connectionGeneration: true,
	identityGeneration: true,
	targetItemId: true,
	libraryId: true,
	intentFingerprint: true,
	ruleFingerprint: true,
	destinationTag: true,
	activeOperationKey: true,
	claimToken: true,
	sendAttemptCount: true,
	reconcileAttemptCount: true,
	requestStartedAt: true,
	lastObservedAt: true,
	completedAt: true,
	status: true,
	reasonCode: true,
	restoreEvidence: true,
	createdAt: true,
	updatedAt: true,
} as const;

export interface ExportDatabaseOptions {
	/** Include TRaSH ARR config snapshots (can be large) */
	includeTrashBackups?: boolean;
	/**
	 * Skip disposable operational history. Hunt history is omitted entirely;
	 * terminal TRaSH history is omitted while nonterminal rollback/undeploy rows
	 * and their referenced snapshots are always preserved. Defaults to true for
	 * scheduled and update backups (set by caller).
	 */
	excludeOperationalHistory?: boolean;
	/**
	 * When operational history IS included, cap each history table to the most
	 * recent N rows (ordered by timestamp DESC). Prevents a single user with
	 * months of accumulated history from blowing the heap. Default: 1000.
	 */
	historyRetentionLimit?: number;
}

async function targetHasDurableConfig(
	prisma: Prisma.TransactionClient | PrismaClient,
	missingFields: readonly string[],
): Promise<boolean> {
	const client = prisma as unknown as Record<string, { count?: () => Promise<number> }>;
	for (const [payloadField, delegate] of LEGACY_RELATIONAL_CONFIG_DELEGATES) {
		if (!missingFields.includes(payloadField)) continue;
		if (
			payloadField === "libraryCleanupApproval" ||
			payloadField === "libraryCleanupMediaServerScan"
		) {
			continue;
		}
		const accessor = client[delegate];
		if (accessor?.count && (await accessor.count()) > 0) return true;
	}
	return false;
}

/** Restore must never delete a row whose provider outcome is uncertain. */
async function targetHasUnresolvedLabelSyncMutation(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const model = (
		prisma as unknown as Record<string, { findMany?: (args: unknown) => Promise<unknown[]> }>
	).labelSyncMutationAttempt;
	if (!model?.findMany) throw new BackupCompatibilityError();
	let rows: unknown[];
	try {
		const result = await model.findMany({ select: LABEL_SYNC_MUTATION_ATTEMPT_FIELDS });
		if (!Array.isArray(result)) throw new Error("Invalid label sync mutation attempt rows");
		rows = result;
	} catch {
		throw new BackupCompatibilityError();
	}
	let hasUnresolved = false;
	for (const row of rows) {
		let parsed: ReturnType<typeof parseLabelSyncMutationAttempt>;
		try {
			parsed = parseLabelSyncMutationAttempt(row);
		} catch {
			throw new BackupCompatibilityError();
		}
		if (isLabelSyncMutationUnresolved(parsed.status)) {
			hasUnresolved = true;
		}
	}
	return hasUnresolved;
}

const ACTIVE_APPROVAL_STATUSES = [
	"pending",
	"approved",
	"retry_pending",
	"executing",
	"retry_executing",
] as const;
const ACTIVE_SCAN_STATUSES = ["pending", "triggering", "failed"] as const;

function activeCleanupApprovalWhere() {
	return {
		OR: [
			{ status: { in: [...ACTIVE_APPROVAL_STATUSES] } },
			{ status: "executed", terminalAuditRecordedAt: null },
		],
	};
}

async function targetHasUncoveredSingletonSecretState(
	prisma: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
): Promise<boolean> {
	const record = data as Record<string, unknown>;
	const client = prisma as unknown as Record<
		string,
		{
			findFirst?: (args: unknown) => Promise<Record<string, unknown> | null>;
		}
	>;
	if (!Array.isArray(record.backupSettings)) {
		const backupSettings = await client.backupSettings?.findFirst?.({
			select: { encryptedPassword: true, passwordIv: true },
		});
		if (backupSettings?.encryptedPassword != null || backupSettings?.passwordIv != null) {
			return true;
		}
	}

	if (!Array.isArray(record.vapidKeys)) {
		const vapidKeys = await client.vapidKeys?.findFirst?.({
			select: { encryptedPrivateKey: true, privateKeyIv: true },
		});
		if (vapidKeys?.encryptedPrivateKey != null || vapidKeys?.privateKeyIv != null) {
			return true;
		}
	}

	return false;
}

async function targetHasOmittedOidcProvider(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const provider = (prisma as unknown as Record<string, { count?: () => Promise<number> }>)
		.oIDCProvider;
	return provider?.count ? (await provider.count()) > 0 : false;
}

async function targetHasOmittedLibrarySyncSettings(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const model = (
		prisma as unknown as Record<
			string,
			{
				findMany?: (args: unknown) => Promise<unknown[]>;
			}
		>
	).librarySyncStatus;
	if (!model?.findMany) return false;
	const rows = await model.findMany({
		where: {
			OR: [{ pollingEnabled: false }, { pollingIntervalMins: { not: 15 } }],
		},
		select: { instanceId: true },
	});
	return rows.length > 0;
}

async function targetHasActiveCleanupCoordination(
	prisma: Prisma.TransactionClient | PrismaClient,
	missingFields: readonly string[],
): Promise<boolean> {
	const client = prisma as unknown as Record<
		string,
		{ findMany?: (args: unknown) => Promise<unknown[]> }
	>;
	const approval = client.libraryCleanupApproval;
	const scan = client.libraryCleanupMediaServerScan;
	let activeScans: Array<Record<string, unknown>> = [];

	if (missingFields.includes("libraryCleanupMediaServerScan") && scan?.findMany) {
		activeScans = (await scan.findMany({
			where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
			select: { id: true, approvalId: true },
		})) as Array<Record<string, unknown>>;
		if (activeScans.length > 0) return true;
	}

	if (!missingFields.includes("libraryCleanupApproval") || !approval?.findMany) return false;
	const activeApprovals = await approval.findMany({
		where: activeCleanupApprovalWhere(),
		select: { id: true },
	});
	if (activeApprovals.length > 0) return true;

	if (!scan?.findMany) return false;
	activeScans = (await scan.findMany({
		where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
		select: { approvalId: true },
	})) as Array<Record<string, unknown>>;
	const approvalIds = activeScans
		.map((row) => row.approvalId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (approvalIds.length === 0) return false;
	const parentApprovals = await approval.findMany({
		where: { id: { in: [...new Set(approvalIds)] } },
		select: { id: true },
	});
	return parentApprovals.length > 0;
}

async function targetHasActiveNamingRecovery(
	prisma: Prisma.TransactionClient | PrismaClient,
): Promise<boolean> {
	const model = (
		prisma as unknown as Record<string, { findMany?: (args: unknown) => Promise<unknown[]> }>
	).namingDeployHistory;
	if (!model?.findMany) return false;
	const rows = await model.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
		select: { id: true },
	});
	return rows.length > 0;
}

/**
 * Reject incomplete legacy payloads before restore mutation. Singleton rows
 * that do not carry secrets may be preserved, but omitted ciphertext must not
 * survive replacement of the installation encryption key.
 */
export async function assertRestoreCompatibility(
	prisma: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
): Promise<void> {
	// Only authenticated, translated preparation can replace Grab evidence.
	if (
		(await prisma.searchGrabAttempt.count()) > 0 ||
		(await prisma.searchGrabClaim.count()) > 0 ||
		(data.searchGrabAttempts?.length ?? 0) > 0 ||
		(data.searchGrabClaims?.length ?? 0) > 0
	)
		throw new BackupCompatibilityError();
	// Notification payloads and imported progress also require authenticated
	// preparation. The raw legacy path cannot silently discard current rows.
	if (
		(await prisma.notificationOutboxEvent.count()) > 0 ||
		(await prisma.notificationOutboxDelivery.count()) > 0 ||
		(data.notificationOutboxEvents?.length ?? 0) > 0 ||
		(data.notificationOutboxDeliveries?.length ?? 0) > 0
	)
		throw new BackupCompatibilityError();
	if (await targetHasUnresolvedLabelSyncMutation(prisma)) {
		throw new BackupCompatibilityError();
	}
	await assertNonLabelRestoreCompatibility(prisma, data);
}

/** Shared checks; only the branded prepared path supplies exact label conservation. */
async function assertNonLabelRestoreCompatibility(
	prisma: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
	prepared?: PreparedRestoreData,
): Promise<void> {
	const record = data as Record<string, unknown>;
	const missingFields = LEGACY_RELATIONAL_CONFIG_FIELDS.filter(
		(field) => !Array.isArray(record[field]),
	);
	if (missingFields.length > 0 && (await targetHasDurableConfig(prisma, missingFields))) {
		throw new BackupCompatibilityError();
	}
	if (await targetHasUncoveredSingletonSecretState(prisma, data)) {
		throw new BackupCompatibilityError();
	}
	if (!Array.isArray(record.oidcProviders) && (await targetHasOmittedOidcProvider(prisma))) {
		throw new BackupCompatibilityError();
	}
	if (
		!Array.isArray(record.librarySyncSettings) &&
		(await targetHasOmittedLibrarySyncSettings(prisma))
	) {
		throw new BackupCompatibilityError();
	}
	if (
		missingFields.some(
			(field) => field === "libraryCleanupApproval" || field === "libraryCleanupMediaServerScan",
		) &&
		(await targetHasActiveCleanupCoordination(prisma, missingFields))
	) {
		throw new BackupCompatibilityError();
	}
	if (!Array.isArray(record.namingDeployHistory) && (await targetHasActiveNamingRecovery(prisma))) {
		throw new BackupCompatibilityError();
	}
	try {
		await validateCurrentCoordinationPreserved(prisma, data, prepared);
	} catch (error) {
		if (error instanceof CoordinationMismatchError) {
			throw new BackupCompatibilityError(error);
		}
		throw error;
	}
}

type CoordinationKind = "rollback" | "undeploy";
type CoordinationRow = Record<string, unknown> & { id: string };

class CoordinationMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoordinationMismatchError";
	}
}

function isAuditOnlyUncertainSync(record: Record<string, unknown>): boolean {
	return (
		record.status === "UNCERTAIN" &&
		record.rollbackStatus == null &&
		record.backupId == null &&
		record.rolledBack !== true
	);
}

function shouldPreserveSyncHistory(record: Record<string, unknown>): boolean {
	return isNonterminalRollback(record) || isAuditOnlyUncertainSync(record);
}

const COORDINATION_FIELDS: Record<CoordinationKind, readonly string[]> = {
	rollback: [
		"userId",
		"instanceId",
		"templateId",
		"status",
		"rolledBack",
		"appliedConfigs",
		"rollbackStatus",
		"rollbackAttemptedAt",
		"rollbackProgress",
		"backupId",
		"startedAt",
	],
	undeploy: [
		"userId",
		"instanceId",
		"templateId",
		"status",
		"rolledBack",
		"canRollback",
		"appliedConfigs",
		"templateSnapshot",
		"undeployStatus",
		"undeployAttemptedAt",
		"undeployProgress",
		"backupId",
		"deployedAt",
	],
};

const SCORE_INTENT_FIELDS = [
	"userId",
	"instanceId",
	"qualityProfileId",
	"customFormatId",
	"score",
	"status",
	"intentOperation",
	"intendedScore",
	"connectionGeneration",
	"connectionStateToken",
	"createdAt",
	"updatedAt",
] as const;

const ACTIVE_NAMING_FIELDS = [
	"instanceId",
	"userId",
	"status",
	"selectedPresets",
	"resolvedPayload",
	"deployedHash",
	"previousConfig",
	"changedFields",
	"totalFields",
	"errorMessage",
	"rolledBack",
	"rolledBackAt",
	"deployedAt",
] as const;

const ACTIVE_NAMING_INSTANCE_FIELDS = [
	"userId",
	"service",
	"baseUrl",
	"encryptedApiKey",
	"encryptionIv",
	"encryptedHttpAuthCredentials",
	"httpAuthEncryptionIv",
] as const;

const ACTIVE_NAMING_EXPORT_CHANGED =
	"Cannot create backup: active naming recovery changed during export; retry";

const ACTIVE_APPROVAL_FIELDS = [
	"configId",
	"instanceId",
	"arrItemId",
	"itemType",
	"targetScope",
	"arrEpisodeId",
	"episodeFileId",
	"seasonNumber",
	"episodeNumber",
	"episodeTitle",
	"title",
	"matchedRuleId",
	"matchedRuleName",
	"reason",
	"action",
	"scanMediaServerAfterDelete",
	"sizeOnDisk",
	"year",
	"rating",
	"status",
	"executionToken",
	"executionAuditCorrelationId",
	"reconciledWithoutMutation",
	"safetySnapshot",
	"lastExecutionError",
	"reviewedAt",
	"executedAt",
	"expiresAt",
	"createdAt",
] as const;

const ACTIVE_SCAN_FIELDS = [
	"approvalId",
	"instanceId",
	"service",
	"serverIdentity",
	"mediaType",
	"plannedSectionIds",
	"targetKey",
	"status",
	"executionToken",
	"attemptCount",
	"completedSectionIds",
	"lastError",
	"nextAttemptAt",
	"requestStartedAt",
	"triggeredAt",
	"createdAt",
	"updatedAt",
] as const;

const COORDINATION_DATE_FIELDS = new Set([
	"startedAt",
	"rollbackAttemptedAt",
	"undeployAttemptedAt",
	"deployedAt",
	"createdAt",
	"updatedAt",
	"reviewedAt",
	"executedAt",
	"expiresAt",
	"nextAttemptAt",
	"requestStartedAt",
	"triggeredAt",
]);

function recordsById(value: unknown): Map<string, CoordinationRow> {
	const records = new Map<string, CoordinationRow>();
	if (!Array.isArray(value)) return records;
	for (const row of value) {
		if (
			typeof row === "object" &&
			row !== null &&
			"id" in row &&
			typeof row.id === "string" &&
			row.id.length > 0
		) {
			records.set(row.id, row as CoordinationRow);
		}
	}
	return records;
}

function coordinationJsonRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function preparedTemplateConfigMatches(
	current: CoordinationRow,
	incoming: CoordinationRow,
	prepared: PreparedRestoreData,
	instances: Map<string, CoordinationRow>,
): boolean {
	const before = coordinationJsonRecord(incoming.configData),
		after = coordinationJsonRecord(current.configData);
	if (!before || !after) return false;
	const beforeProfile = before.completeQualityProfile,
		afterProfile = after.completeQualityProfile;
	if (
		!beforeProfile ||
		typeof beforeProfile !== "object" ||
		Array.isArray(beforeProfile) ||
		(beforeProfile as Record<string, unknown>).sourceConnectionStateToken == null
	)
		return current.configData === incoming.configData; // Legacy evidence stays unbound.
	if (!afterProfile || typeof afterProfile !== "object" || Array.isArray(afterProfile))
		return false;
	const originalProfile = beforeProfile as Record<string, unknown>,
		currentProfile = afterProfile as Record<string, unknown>;
	if (
		typeof originalProfile.sourceInstanceId !== "string" ||
		currentProfile.sourceInstanceId !== originalProfile.sourceInstanceId
	)
		return false;
	const instance = instances.get(originalProfile.sourceInstanceId);
	if (
		!instance ||
		instance.userId !== current.userId ||
		!preparedRestoreConnectionMatches(prepared, instance) ||
		currentProfile.sourceConnectionStateToken !==
			createDeploymentConnectionStateToken(instance as unknown as ServiceInstance)
	)
		return false;
	return durableEqual(
		{
			...after,
			completeQualityProfile: {
				...currentProfile,
				sourceConnectionStateToken: originalProfile.sourceConnectionStateToken,
			},
		},
		before,
	);
}

function preparedRecoverySnapshotMatches(
	current: CoordinationRow,
	incoming: CoordinationRow,
	prepared: PreparedRestoreData,
	instances: Map<string, CoordinationRow>,
	originalInstances: Map<string, CoordinationRow>,
): boolean {
	if (typeof current.instanceId !== "string") return false;
	const instance = instances.get(current.instanceId),
		originalInstance = originalInstances.get(current.instanceId);
	if (
		!instance ||
		!originalInstance ||
		instance.userId !== current.userId ||
		!preparedRestoreConnectionMatches(prepared, instance)
	)
		return false;
	if (
		importConnectionFingerprint(instance as unknown as ServiceInstance) ===
			importConnectionFingerprint(originalInstance as unknown as ServiceInstance) &&
		current.backupData === incoming.backupData
	)
		return true;
	const before = coordinationJsonRecord(incoming.backupData),
		after = coordinationJsonRecord(current.backupData);
	if (!before || !after) return false;
	if (!("schemaVersion" in before) && !("schemaVersion" in after))
		return current.backupData === incoming.backupData;
	// Validate without projecting: schema parsing strips unknown evidence fields.
	if (
		before.schemaVersion !== 2 ||
		!deploymentBackupStateSchema.safeParse(after).success ||
		!preparedRestoreTrashEndpointCurrent(prepared, instance, after)
	)
		return false;
	return durableEqual(
		{
			...after,
			connectionStateToken: before.connectionStateToken,
			endpointKey: before.endpointKey,
		},
		before,
	);
}

function assertCurrentUndeployFallbackPreserved(
	current: CoordinationRow,
	incomingTemplates: Map<string, CoordinationRow>,
	prepared?: PreparedRestoreData,
	instances?: Map<string, CoordinationRow>,
): void {
	if (typeof current.templateSnapshot === "string" && current.templateSnapshot.length > 0) {
		return;
	}
	if (typeof current.templateId !== "string" || current.templateId.length === 0) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current nonterminal coordination row ${current.id} has no undeploy template authority`,
		);
	}
	const currentTemplate = current.template;
	if (typeof currentTemplate !== "object" || currentTemplate === null) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current undeploy fallback template ${current.templateId} is missing from the database`,
		);
	}
	const incomingTemplate = incomingTemplates.get(current.templateId);
	if (!incomingTemplate) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current undeploy fallback template ${current.templateId} is missing from incoming data`,
		);
	}
	for (const field of ["userId", "serviceType", "configData"] as const) {
		if (field === "configData" && prepared && instances) {
			if (
				!preparedTemplateConfigMatches(
					currentTemplate as CoordinationRow,
					incomingTemplate,
					prepared,
					instances,
				)
			)
				throw new CoordinationMismatchError(
					"Cannot restore backup: current undeploy fallback template evidence changed",
				);
			continue;
		}
		if (incomingTemplate[field] !== (currentTemplate as Record<string, unknown>)[field]) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current undeploy fallback template ${current.templateId} changed ${field}`,
			);
		}
	}
}

function comparableCoordinationValue(value: unknown, field?: string): unknown {
	if (field === "sizeOnDisk" && (typeof value === "bigint" || typeof value === "string")) {
		try {
			return BigInt(value).toString();
		} catch {
			return value;
		}
	}
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" && field && COORDINATION_DATE_FIELDS.has(field)) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return value;
}

function assertCurrentRowPreserved(
	kind: CoordinationKind,
	current: CoordinationRow,
	incomingRows: Map<string, CoordinationRow>,
): void {
	const incoming = incomingRows.get(current.id);
	if (!incoming) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current nonterminal coordination row ${current.id} is missing from incoming data`,
		);
	}

	for (const field of COORDINATION_FIELDS[kind]) {
		if (
			comparableCoordinationValue(incoming[field], field) !==
			comparableCoordinationValue(current[field], field)
		) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current nonterminal coordination row ${current.id} changed ${field}`,
			);
		}
	}
}

function assertCurrentSpecialRowPreserved(
	label: string,
	current: CoordinationRow,
	incomingRows: Map<string, CoordinationRow>,
	fields: readonly string[],
	restoredProjection?: CoordinationRow,
): void {
	const incoming = incomingRows.get(current.id);
	if (!incoming) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current ${label} ${current.id} is missing from incoming data`,
		);
	}
	// Only cleanup callers supply this branded preparation's inert projection.
	// Its sole projected evidence field is the cleared executionToken. A new
	// claim or any changed durable field must still match neither representation.
	if (
		current.executionToken === null &&
		restoredProjection?.executionToken === null &&
		fields.every(
			(field) =>
				comparableCoordinationValue(restoredProjection[field], field) ===
				comparableCoordinationValue(current[field], field),
		)
	)
		return;
	for (const field of fields) {
		if (
			comparableCoordinationValue(incoming[field], field) !==
			comparableCoordinationValue(current[field], field)
		) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current ${label} ${current.id} changed ${field}`,
			);
		}
	}
}

function namingInstanceFieldMatches(field: string, left: unknown, right: unknown): boolean {
	return field === "baseUrl" && typeof left === "string" && typeof right === "string"
		? `${left.replace(/\/$/, "")}/api/v3/config/naming` ===
				`${right.replace(/\/$/, "")}/api/v3/config/naming`
		: left === right;
}

function assertCurrentNamingInstancePreserved(
	history: CoordinationRow,
	currentInstances: Map<string, CoordinationRow>,
	incomingInstances: Map<string, CoordinationRow>,
	prepared?: PreparedRestoreData,
): void {
	if (typeof history.instanceId !== "string" || history.instanceId.length === 0) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current active naming recovery ${history.id} has no service instance identity`,
		);
	}
	const currentInstance = currentInstances.get(history.instanceId);
	if (!currentInstance) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current active naming recovery ${history.id} references missing service instance ${history.instanceId}`,
		);
	}
	const incomingInstance = incomingInstances.get(history.instanceId);
	if (!incomingInstance) {
		throw new CoordinationMismatchError(
			`Cannot restore backup: current active naming recovery ${history.id} service instance ${history.instanceId} is missing from incoming data`,
		);
	}
	if (prepared) {
		if (!preparedRestoreConnectionMatches(prepared, currentInstance))
			throw new CoordinationMismatchError(
				"Cannot restore backup: current active naming recovery connection changed",
			);
		return;
	}
	for (const field of ACTIVE_NAMING_INSTANCE_FIELDS) {
		const incomingValue = incomingInstance[field];
		const currentValue = currentInstance[field];
		if (!namingInstanceFieldMatches(field, incomingValue, currentValue)) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current active naming recovery ${history.id} changed service instance ${field}`,
			);
		}
	}
}

function assertActiveNamingExportStable(
	capturedHistory: CoordinationRow[],
	latestHistory: CoordinationRow[],
	capturedInstances: CoordinationRow[],
	latestInstances: CoordinationRow[],
): void {
	const capturedHistoryById = recordsById(capturedHistory);
	const latestHistoryById = recordsById(latestHistory);
	if (capturedHistoryById.size !== latestHistoryById.size) {
		throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
	}
	for (const captured of capturedHistoryById.values()) {
		const latest = latestHistoryById.get(captured.id);
		if (!latest) throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
		for (const field of ACTIVE_NAMING_FIELDS) {
			if (
				comparableCoordinationValue(captured[field], field) !==
				comparableCoordinationValue(latest[field], field)
			) {
				throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
			}
		}
	}

	const capturedInstancesById = recordsById(capturedInstances);
	const latestInstancesById = recordsById(latestInstances);
	for (const history of capturedHistoryById.values()) {
		if (typeof history.instanceId !== "string" || history.instanceId.length === 0) {
			throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
		}
		const captured = capturedInstancesById.get(history.instanceId);
		const latest = latestInstancesById.get(history.instanceId);
		if (!captured || !latest) throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
		for (const field of ACTIVE_NAMING_INSTANCE_FIELDS) {
			if (!namingInstanceFieldMatches(field, captured[field], latest[field])) {
				throw new Error(ACTIVE_NAMING_EXPORT_CHANGED);
			}
		}
	}
}

async function validateCurrentCoordinationPreserved(
	tx: Prisma.TransactionClient | PrismaClient,
	data: BackupData["data"],
	prepared?: PreparedRestoreData,
): Promise<void> {
	const db = tx as Prisma.TransactionClient;
	const optionalModels = tx as unknown as Record<
		string,
		{ findMany?: (args: unknown) => Promise<unknown[]> }
	>;
	if (
		!optionalModels.trashSyncHistory?.findMany ||
		!optionalModels.templateDeploymentHistory?.findMany ||
		!optionalModels.instanceQualityProfileOverride?.findMany ||
		!optionalModels.namingDeployHistory?.findMany ||
		!optionalModels.trashBackup?.findMany
	) {
		return;
	}
	const currentRollbackRows = (
		await db.trashSyncHistory.findMany({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		})
	).filter(shouldPreserveSyncHistory) as CoordinationRow[];
	const currentUndeployRows = (
		await db.templateDeploymentHistory.findMany({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
			include: {
				template: {
					select: { id: true, userId: true, serviceType: true, configData: true },
				},
			},
		})
	).filter(isNonterminalUndeploy) as CoordinationRow[];
	const currentScoreIntents = (await db.instanceQualityProfileOverride.findMany({
		where: { status: { in: ["PENDING", "UNCERTAIN"] } },
	})) as CoordinationRow[];
	const currentActiveNaming = (await db.namingDeployHistory.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
	})) as CoordinationRow[];
	const currentNamingInstances = recordsById(
		prepared
			? await db.serviceInstance.findMany()
			: currentActiveNaming.length > 0
				? await db.serviceInstance.findMany({
						where: {
							id: {
								in: [
									...new Set(
										currentActiveNaming
											.map((row) => row.instanceId)
											.filter((id): id is string => typeof id === "string" && id.length > 0),
									),
								],
							},
						},
					})
				: [],
	);
	const currentActiveApprovals = optionalModels.libraryCleanupApproval?.findMany
		? ((await optionalModels.libraryCleanupApproval.findMany({
				where: activeCleanupApprovalWhere(),
			})) as CoordinationRow[])
		: [];
	const currentActiveScans = optionalModels.libraryCleanupMediaServerScan?.findMany
		? ((await optionalModels.libraryCleanupMediaServerScan.findMany({
				where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
			})) as CoordinationRow[])
		: [];
	const scanApprovalIds = [
		...new Set(
			currentActiveScans
				.map((row) => row.approvalId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const currentScanParentApprovals =
		scanApprovalIds.length > 0 && optionalModels.libraryCleanupApproval?.findMany
			? ((await optionalModels.libraryCleanupApproval.findMany({
					where: { id: { in: scanApprovalIds } },
				})) as CoordinationRow[])
			: [];
	const incomingRollbackRows = recordsById(data.trashSyncHistory);
	const incomingUndeployRows = recordsById(data.templateDeploymentHistory);
	const incomingTemplates = recordsById(data.trashTemplates);
	const incomingScoreIntents = recordsById(data.instanceQualityProfileOverrides);
	const incomingActiveNaming = recordsById(data.namingDeployHistory);
	const incomingInstances = recordsById(data.serviceInstances);
	const incomingApprovals = recordsById(data.libraryCleanupApproval);
	const incomingScans = recordsById(data.libraryCleanupMediaServerScan);

	for (const row of currentRollbackRows) {
		assertCurrentRowPreserved("rollback", row, incomingRollbackRows);
	}
	for (const row of currentUndeployRows) {
		assertCurrentRowPreserved("undeploy", row, incomingUndeployRows);
		assertCurrentUndeployFallbackPreserved(
			row,
			incomingTemplates,
			prepared,
			currentNamingInstances,
		);
	}
	for (const row of currentScoreIntents) {
		let comparison = row;
		if (prepared) {
			const incoming = incomingScoreIntents.get(row.id),
				instance = currentNamingInstances.get(String(row.instanceId));
			if (
				!incoming ||
				!instance ||
				instance.userId !== row.userId ||
				!preparedRestoreConnectionMatches(prepared, instance)
			)
				throw new CoordinationMismatchError(
					"Cannot restore backup: current quality-score connection changed",
				);
			if (
				!(
					incoming.connectionStateToken == null &&
					(incoming.connectionGeneration ?? 0) === 0 &&
					row.connectionStateToken == null &&
					(row.connectionGeneration ?? 0) === 0
				)
			) {
				if (
					typeof incoming.connectionStateToken !== "string" ||
					row.connectionStateToken !==
						createDeploymentConnectionStateToken(instance as unknown as ServiceInstance)
				)
					throw new CoordinationMismatchError(
						"Cannot restore backup: current quality-score binding changed",
					);
				comparison = { ...row, connectionStateToken: incoming.connectionStateToken };
			}
		}
		assertCurrentSpecialRowPreserved(
			"pending or uncertain quality-score intent",
			comparison,
			incomingScoreIntents,
			SCORE_INTENT_FIELDS,
		);
	}
	for (const row of currentActiveNaming) {
		assertCurrentSpecialRowPreserved(
			"active naming recovery",
			row,
			incomingActiveNaming,
			ACTIVE_NAMING_FIELDS,
		);
		assertCurrentNamingInstancePreserved(row, currentNamingInstances, incomingInstances, prepared);
	}
	const preparedApprovals = prepared
		? recordsById(prepared.records.libraryCleanupApproval)
		: undefined;
	const preparedScans = prepared
		? recordsById(prepared.records.libraryCleanupMediaServerScan)
		: undefined;
	for (const row of [...currentActiveApprovals, ...currentScanParentApprovals]) {
		assertCurrentSpecialRowPreserved(
			"active cleanup approval",
			row,
			incomingApprovals,
			ACTIVE_APPROVAL_FIELDS,
			preparedApprovals?.get(row.id),
		);
	}
	for (const row of currentActiveScans) {
		assertCurrentSpecialRowPreserved(
			"active media-server scan",
			row,
			incomingScans,
			ACTIVE_SCAN_FIELDS,
			preparedScans?.get(row.id),
		);
	}

	const currentRecoveryRows = [
		...currentRollbackRows.filter((row) =>
			isNonterminalRollback({
				status: row.status,
				rolledBack: row.rolledBack,
				rollbackStatus: row.rollbackStatus,
			}),
		),
		...currentUndeployRows,
	];
	const requiredSnapshotIds = currentRecoveryRows.map((row) => {
		if (typeof row.backupId !== "string" || row.backupId.length === 0) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current nonterminal coordination row ${row.id} has no required recovery snapshot reference`,
			);
		}
		return row.backupId;
	});
	if (requiredSnapshotIds.length === 0) return;

	const currentSnapshots = recordsById(
		await db.trashBackup.findMany({ where: { id: { in: [...new Set(requiredSnapshotIds)] } } }),
	);
	const incomingSnapshots = recordsById(data.trashBackups);
	for (const snapshotId of new Set(requiredSnapshotIds)) {
		const current = currentSnapshots.get(snapshotId);
		if (!current) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current recovery snapshot ${snapshotId} is missing from the database`,
			);
		}
		const incoming = incomingSnapshots.get(snapshotId);
		if (!incoming) {
			throw new CoordinationMismatchError(
				`Cannot restore backup: current recovery snapshot ${snapshotId} is missing from incoming data`,
			);
		}
		for (const field of ["userId", "instanceId", "backupData"] as const) {
			if (field === "backupData" && prepared) {
				if (
					!preparedRecoverySnapshotMatches(
						current,
						incoming,
						prepared,
						currentNamingInstances,
						incomingInstances,
					)
				)
					throw new CoordinationMismatchError(
						"Cannot restore backup: current recovery snapshot evidence changed",
					);
				continue;
			}
			if (incoming[field] !== current[field]) {
				throw new CoordinationMismatchError(
					`Cannot restore backup: current recovery snapshot ${snapshotId} changed ${field}`,
				);
			}
		}
	}
}

function mergeRowsById<T extends { id: string }>(rows: T[], preservedRows: T[]): T[] {
	const merged = [...rows];
	const seen = new Set(rows.map((row) => row.id));
	for (const row of preservedRows) {
		if (!seen.has(row.id)) {
			merged.push(row);
			seen.add(row.id);
		}
	}
	return merged;
}

/**
 * Export all database tables.
 *
 * Tables are fetched sequentially (not in parallel) so each table's row data
 * lives only as long as needed before being assigned into the result object.
 * For scheduled backups, disposable operational history is skipped by default
 * to keep peak heap bounded. Nonterminal rollback/undeploy coordination is
 * always exported because it is required to resume safely after restore.
 */
async function exportDatabaseSnapshot(
	prisma: Prisma.TransactionClient,
	options: ExportDatabaseOptions,
) {
	const skipHistory = options.excludeOperationalHistory ?? false;
	const historyLimit = options.historyRetentionLimit ?? 1000;

	// Core authentication & services (always full)
	const users = await prisma.user.findMany();
	const sessions = await prisma.session.findMany();
	const serviceInstances = await prisma.serviceInstance.findMany();
	const serviceTags = await prisma.serviceTag.findMany();
	const serviceInstanceTags = await prisma.serviceInstanceTag.findMany();
	const oidcProviders = await prisma.oIDCProvider.findMany();
	const oidcAccounts = await prisma.oIDCAccount.findMany();
	const webAuthnCredentials = await prisma.webAuthnCredential.findMany();

	// System settings (singleton-ish)
	const systemSettings = await prisma.systemSettings.findMany();
	const backupSettings = await prisma.backupSettings.findMany();
	const vapidKeys = await prisma.vapidKeys.findMany();

	// TRaSH Guides configuration (always full — these are config, not history)
	const trashTemplates = await prisma.trashTemplate.findMany();
	const trashSettings = await prisma.trashSettings.findMany();
	const trashSyncSchedules = await prisma.trashSyncSchedule.findMany();
	const templateQualityProfileMappings = await prisma.templateQualityProfileMapping.findMany();
	const instanceQualityProfileOverrides = await prisma.instanceQualityProfileOverride.findMany();
	const standaloneCFDeployments = await prisma.standaloneCFDeployment.findMany();
	const qualitySizeMappings = await prisma.qualitySizeMapping.findMany();

	// Durable user and instance configuration (always full, including empty
	// arrays so v1.2 distinguishes complete coverage from legacy omission).
	const notificationChannel = await prisma.notificationChannel.findMany();
	const notificationSubscription = await prisma.notificationSubscription.findMany();
	const notificationRule = await prisma.notificationRule.findMany();
	const notificationAggregationConfig = await prisma.notificationAggregationConfig.findMany();
	// Accepted notification work and its complete recipient/aggregation graph
	// are durable state, never subject to the operational History cap.
	const notificationOutboxEvents = await prisma.notificationOutboxEvent.findMany();
	const notificationOutboxDeliveries = await prisma.notificationOutboxDelivery.findMany();
	const autoTagRule = await prisma.autoTagRule.findMany();
	const labelSyncRule = await prisma.labelSyncRule.findMany();
	// Active observation runs are disposable and restart from current authority after restore.
	// Durable mutation history is always exported in full, including terminal
	// rows, even when disposable operational history is excluded.
	const labelSyncMutationAttempts = await prisma.labelSyncMutationAttempt.findMany();
	const searchGrabAttempts = await prisma.searchGrabAttempt.findMany();
	const searchGrabClaims = await prisma.searchGrabClaim.findMany();
	// Import protection and qUI claims are durable safety evidence, not capped
	// operational history. Preserve every attempt, outcome and linked proof.
	const arrImportOperations = await prisma.arrImportOperation.findMany();
	const arrImportFileProofs = await prisma.arrImportFileProof.findMany();
	const arrImportSourceClaims = await prisma.arrImportSourceClaim.findMany();
	const queueCleanerImportReceipts = await prisma.queueCleanerImportReceipt.findMany();
	const quiActionClaims = await prisma.quiActionClaim.findMany();
	const quiBinding = (row: {
		userId: string;
		serviceInstanceId: string;
		qbitInstanceId: number;
		torrentHash: string;
		attemptId: string | null;
	}) =>
		JSON.stringify([
			row.userId,
			row.serviceInstanceId,
			row.qbitInstanceId,
			row.torrentHash.toLowerCase(),
			row.attemptId,
		]);
	const claimedBindings = new Set(quiActionClaims.map(quiBinding));
	const quiLogCandidates = await prisma.quiActionLog.findMany({
		where: {
			OR: [
				{ status: { in: ["pending", "uncertain"] } },
				{ attemptId: { in: [...new Set(quiActionClaims.map((claim) => claim.attemptId))] } },
			],
		},
	});
	// Logs can retain uppercase hashes while claims normalize them. Query by
	// attempt, then retain only exact normalized identity bindings. Unrelated
	// terminal history remains excluded, including siblings in a bulk attempt.
	const quiActionLogs = quiLogCandidates.filter(
		(row) =>
			row.status === "pending" ||
			row.status === "uncertain" ||
			claimedBindings.has(quiBinding(row)),
	);
	const queueCleanerConfig = await prisma.queueCleanerConfig.findMany();
	const libraryCleanupConfig = await prisma.libraryCleanupConfig.findMany();
	const libraryCleanupRule = await prisma.libraryCleanupRule.findMany();
	const librarySyncSettings = await prisma.librarySyncStatus.findMany({
		select: {
			instanceId: true,
			pollingEnabled: true,
			pollingIntervalMins: true,
		},
	});
	const namingConfig = await prisma.namingConfig.findMany();
	const userCustomFormat = await prisma.userCustomFormat.findMany();
	const activeCleanupApprovals = await prisma.libraryCleanupApproval.findMany({
		where: activeCleanupApprovalWhere(),
	});
	const activeCleanupScans = await prisma.libraryCleanupMediaServerScan.findMany({
		where: { status: { in: [...ACTIVE_SCAN_STATUSES] } },
	});
	const cleanupScanApprovalIds = [
		...new Set(
			activeCleanupScans
				.map((row) => row.approvalId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const cleanupScanParentApprovals =
		cleanupScanApprovalIds.length > 0
			? await prisma.libraryCleanupApproval.findMany({
					where: { id: { in: cleanupScanApprovalIds } },
				})
			: [];
	const serializeCleanupApproval = (row: (typeof activeCleanupApprovals)[number]) => ({
		...row,
		sizeOnDisk: row.sizeOnDisk.toString(),
		terminalAuditRecordedAt: null,
		terminalAuditRecoveryAttemptedAt: null,
	});
	const libraryCleanupApproval = mergeRowsById(
		activeCleanupApprovals.map(serializeCleanupApproval),
		cleanupScanParentApprovals.map(serializeCleanupApproval),
	);

	// TRaSH Guides history/audit — operational, capped or skipped.
	// When capped, log a warn so operators can correlate restore-time gaps to
	// the retention limit rather than silently losing the older history.
	const fetchCappedHistory = async <T>(
		tableName: string,
		count: () => Promise<number>,
		find: (take: number) => Promise<T[]>,
	): Promise<T[]> => {
		const total = await count();
		if (total > historyLimit) {
			log.warn(
				{ tableName, totalRows: total, kept: historyLimit, dropped: total - historyLimit },
				"Backup truncated history table to retention limit — older rows excluded",
			);
		}
		return find(historyLimit);
	};

	// Rollback/undeploy coordination is durable safety state, even though it is
	// stored in history tables. Fetch it independently so exclusion and row caps
	// can discard terminal audit rows without stranding resumable operations.
	const nonterminalRollbackHistory = (
		await prisma.trashSyncHistory.findMany({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		})
	).filter(shouldPreserveSyncHistory);
	const nonterminalUndeployHistory = (
		await prisma.templateDeploymentHistory.findMany({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
		})
	).filter(isNonterminalUndeploy);
	const activeNamingDeployHistory = await prisma.namingDeployHistory.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
	});

	const cappedTrashSyncHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"trashSyncHistory",
				() => prisma.trashSyncHistory.count(),
				(take) => prisma.trashSyncHistory.findMany({ take, orderBy: { startedAt: "desc" } }),
			);
	const cappedTemplateDeploymentHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"templateDeploymentHistory",
				() => prisma.templateDeploymentHistory.count(),
				(take) =>
					prisma.templateDeploymentHistory.findMany({ take, orderBy: { deployedAt: "desc" } }),
			);
	const trashSyncHistory = mergeRowsById(cappedTrashSyncHistory, nonterminalRollbackHistory);
	const templateDeploymentHistory = mergeRowsById(
		cappedTemplateDeploymentHistory,
		nonterminalUndeployHistory,
	);
	const cappedNamingDeployHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"namingDeployHistory",
				() => prisma.namingDeployHistory.count(),
				(take) => prisma.namingDeployHistory.findMany({ take, orderBy: { deployedAt: "desc" } }),
			);
	const namingDeployHistory = mergeRowsById(cappedNamingDeployHistory, activeNamingDeployHistory);

	// Hunting feature: configs are config (always full); logs/history are operational
	const huntConfigs = await prisma.huntConfig.findMany();
	const huntLogs = skipHistory
		? []
		: await fetchCappedHistory(
				"huntLog",
				() => prisma.huntLog.count(),
				(take) => prisma.huntLog.findMany({ take, orderBy: { startedAt: "desc" } }),
			);
	const huntSearchHistory = skipHistory
		? []
		: await fetchCappedHistory(
				"huntSearchHistory",
				() => prisma.huntSearchHistory.count(),
				(take) => prisma.huntSearchHistory.findMany({ take, orderBy: { searchedAt: "desc" } }),
			);

	// Optionally include recent TRaSH instance backups. Snapshots referenced by
	// nonterminal rollback/undeploy rows are added below regardless of age/expiry.
	let trashBackups: TrashBackup[] = [];
	if (options.includeTrashBackups) {
		const sevenDaysAgo = new Date();
		sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

		trashBackups = await prisma.trashBackup.findMany({
			where: {
				// Only include backups from the last 7 days
				createdAt: { gte: sevenDaysAgo },
				// Only include non-expired backups (expiresAt is null OR in the future)
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
		});
	}

	const requiredBackupIds = [
		...nonterminalRollbackHistory.filter(isNonterminalRollback),
		...nonterminalUndeployHistory,
	].map((row) => {
		if (typeof row.backupId !== "string" || row.backupId.length === 0) {
			throw new Error(
				`Cannot create backup: nonterminal coordination row ${row.id} has no referenced TRaSH backup snapshot`,
			);
		}
		return row.backupId;
	});
	const uniqueRequiredBackupIds = [...new Set(requiredBackupIds)];
	if (uniqueRequiredBackupIds.length > 0) {
		const requiredSnapshots = await prisma.trashBackup.findMany({
			where: { id: { in: uniqueRequiredBackupIds } },
		});
		trashBackups = mergeRowsById(trashBackups, requiredSnapshots);
	}

	validateCoordinationEvidence({
		serviceInstances,
		trashTemplates,
		trashSyncHistory,
		templateDeploymentHistory,
		trashBackups,
	});

	const data = {
		// Core authentication & services
		users,
		sessions,
		serviceInstances,
		serviceTags,
		serviceInstanceTags,
		oidcProviders,
		oidcAccounts,
		webAuthnCredentials,
		// System settings
		systemSettings,
		backupSettings,
		vapidKeys,
		// TRaSH Guides configuration
		trashTemplates,
		trashSettings,
		trashSyncSchedules,
		templateQualityProfileMappings,
		instanceQualityProfileOverrides,
		standaloneCFDeployments,
		// Quality size preset mappings
		qualitySizeMappings,
		// TRaSH Guides history/audit
		trashSyncHistory,
		templateDeploymentHistory,
		namingDeployHistory,
		// TRaSH instance backups (optional)
		trashBackups,
		// Hunting feature
		huntConfigs,
		huntLogs,
		huntSearchHistory,
		// Durable configuration
		notificationChannel,
		notificationSubscription,
		notificationRule,
		notificationAggregationConfig,
		notificationOutboxEvents,
		notificationOutboxDeliveries,
		autoTagRule,
		labelSyncRule,
		labelSyncMutationAttempts,
		searchGrabAttempts,
		searchGrabClaims,
		arrImportOperations,
		arrImportFileProofs,
		arrImportSourceClaims,
		queueCleanerImportReceipts,
		quiActionClaims,
		quiActionLogs,
		queueCleanerConfig,
		libraryCleanupConfig,
		libraryCleanupRule,
		librarySyncSettings,
		namingConfig,
		userCustomFormat,
		libraryCleanupApproval,
		libraryCleanupMediaServerScan: activeCleanupScans,
	};

	return { data, activeNamingDeployHistory, serviceInstances };
}

/**
 * Capture all portable tables from one coherent database snapshot, then
 * recheck active naming recovery authority at the publication boundary.
 */
export async function exportDatabase(prisma: PrismaClient, options: ExportDatabaseOptions = {}) {
	const snapshot = await prisma.$transaction((tx) => exportDatabaseSnapshot(tx, options), {
		isolationLevel: "Serializable",
		timeout: 60_000,
	});

	const latestActiveNamingDeployHistory = await prisma.namingDeployHistory.findMany({
		where: { status: { in: ["PENDING", "SUCCESS"] }, rolledBack: false },
	});
	const activeNamingInstanceIds = [
		...new Set(
			snapshot.activeNamingDeployHistory
				.map((row) => row.instanceId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const latestActiveNamingInstances =
		activeNamingInstanceIds.length > 0
			? await prisma.serviceInstance.findMany({
					where: { id: { in: activeNamingInstanceIds } },
				})
			: [];
	assertActiveNamingExportStable(
		snapshot.activeNamingDeployHistory as CoordinationRow[],
		latestActiveNamingDeployHistory as CoordinationRow[],
		snapshot.serviceInstances as CoordinationRow[],
		latestActiveNamingInstances as CoordinationRow[],
	);

	return snapshot.data;
}

function validateRestoreRecords(data: BackupData["data"]): void {
	if (data.users.length > 0) validateRecords(data.users, "user", ["id", "username"]);
	if (data.sessions.length > 0) {
		validateRecords(data.sessions, "session", ["id", "userId", "expiresAt"]);
	}
	if (data.oidcProviders && data.oidcProviders.length > 0) {
		validateRecords(data.oidcProviders, "oidcProvider", ["id", "clientId", "issuer"]);
	}
	if (data.oidcAccounts.length > 0) {
		validateRecords(data.oidcAccounts, "oidcAccount", ["id", "userId", "providerUserId"]);
	}
	if (data.webAuthnCredentials.length > 0) {
		validateRecords(data.webAuthnCredentials, "webAuthnCredential", ["id", "userId", "publicKey"]);
	}
	if (data.serviceInstances.length > 0) {
		validateRecords(data.serviceInstances, "serviceInstance", ["id", "service", "baseUrl"]);
	}
	if (data.serviceTags.length > 0) {
		validateRecords(data.serviceTags, "serviceTag", ["id", "name"]);
	}
	if (data.serviceInstanceTags.length > 0) {
		validateRecords(data.serviceInstanceTags, "serviceInstanceTag", ["instanceId", "tagId"]);
	}
	if (data.systemSettings && data.systemSettings.length > 0) {
		validateRecords(data.systemSettings, "systemSettings", ["id"]);
	}
	if (Array.isArray(data.backupSettings) && data.backupSettings.length > 0) {
		validateRecords(data.backupSettings, "backupSettings", ["id"]);
	}
	if (Array.isArray(data.vapidKeys) && data.vapidKeys.length > 0) {
		validateRecords(data.vapidKeys, "vapidKeys", ["id", "publicKey"]);
	}
	if (data.trashSettings && data.trashSettings.length > 0) {
		validateRecords(data.trashSettings, "trashSettings", ["id", "userId"]);
	}
	if (data.trashTemplates && data.trashTemplates.length > 0) {
		validateRecords(data.trashTemplates, "trashTemplate", ["id", "name", "serviceType"]);
	}
	if (data.trashSyncSchedules && data.trashSyncSchedules.length > 0) {
		validateRecords(data.trashSyncSchedules, "trashSyncSchedule", ["id", "userId"]);
	}
	if (data.trashBackups && data.trashBackups.length > 0) {
		validateRecords(data.trashBackups, "trashBackup", ["id", "instanceId", "userId"]);
	}
	if (data.templateQualityProfileMappings && data.templateQualityProfileMappings.length > 0) {
		validateRecords(data.templateQualityProfileMappings, "templateQualityProfileMapping", [
			"id",
			"templateId",
			"instanceId",
		]);
	}
	if (data.instanceQualityProfileOverrides && data.instanceQualityProfileOverrides.length > 0) {
		validateRecords(data.instanceQualityProfileOverrides, "instanceQualityProfileOverride", [
			"id",
			"instanceId",
		]);
	}
	if (data.standaloneCFDeployments && data.standaloneCFDeployments.length > 0) {
		validateRecords(data.standaloneCFDeployments, "standaloneCFDeployment", [
			"id",
			"instanceId",
			"cfTrashId",
		]);
	}
	if (data.qualitySizeMappings && data.qualitySizeMappings.length > 0) {
		validateRecords(data.qualitySizeMappings, "qualitySizeMapping", ["id", "instanceId", "userId"]);
	}
	if (data.trashSyncHistory && data.trashSyncHistory.length > 0) {
		validateRecords(data.trashSyncHistory, "trashSyncHistory", ["id", "instanceId", "userId"]);
	}
	if (data.templateDeploymentHistory && data.templateDeploymentHistory.length > 0) {
		validateRecords(data.templateDeploymentHistory, "templateDeploymentHistory", [
			"id",
			"templateId",
			"instanceId",
		]);
	}
	if (data.namingDeployHistory && data.namingDeployHistory.length > 0) {
		validateRecords(data.namingDeployHistory, "namingDeployHistory", [
			"id",
			"instanceId",
			"userId",
			"status",
		]);
	}
	if (data.huntConfigs && data.huntConfigs.length > 0) {
		validateRecords(data.huntConfigs, "huntConfig", ["id", "instanceId"]);
	}
	if (data.huntLogs && data.huntLogs.length > 0) {
		validateRecords(data.huntLogs, "huntLog", ["id", "instanceId"]);
	}
	if (data.huntSearchHistory && data.huntSearchHistory.length > 0) {
		validateRecords(data.huntSearchHistory, "huntSearchHistory", ["id", "configId"]);
	}
	if (data.notificationChannel && data.notificationChannel.length > 0) {
		validateRecords(data.notificationChannel, "notificationChannel", ["id", "userId"]);
	}
	if (data.notificationSubscription && data.notificationSubscription.length > 0) {
		validateRecords(data.notificationSubscription, "notificationSubscription", [
			"channelId",
			"eventType",
		]);
	}
	if (data.notificationRule && data.notificationRule.length > 0) {
		validateRecords(data.notificationRule, "notificationRule", ["id", "userId"]);
	}
	if (data.notificationAggregationConfig && data.notificationAggregationConfig.length > 0) {
		validateRecords(data.notificationAggregationConfig, "notificationAggregationConfig", [
			"id",
			"userId",
		]);
	}
	if (data.autoTagRule && data.autoTagRule.length > 0) {
		validateRecords(data.autoTagRule, "autoTagRule", ["id", "userId"]);
	}
	if (data.labelSyncRule && data.labelSyncRule.length > 0) {
		validateRecords(data.labelSyncRule, "labelSyncRule", ["id", "userId"]);
	}
	if (data.labelSyncMutationAttempts !== undefined) {
		validateLabelSyncMutationAttempts(
			data.labelSyncMutationAttempts,
			data.users,
			data.labelSyncRule,
			data.serviceInstances,
		);
	}
	if (data.queueCleanerConfig && data.queueCleanerConfig.length > 0) {
		validateRecords(data.queueCleanerConfig, "queueCleanerConfig", ["id", "instanceId"]);
	}
	if (data.libraryCleanupConfig && data.libraryCleanupConfig.length > 0) {
		validateRecords(data.libraryCleanupConfig, "libraryCleanupConfig", ["id", "userId"]);
	}
	if (data.libraryCleanupRule && data.libraryCleanupRule.length > 0) {
		validateRecords(data.libraryCleanupRule, "libraryCleanupRule", ["id", "configId"]);
	}
	if (data.librarySyncSettings && data.librarySyncSettings.length > 0) {
		validateRecords(data.librarySyncSettings, "librarySyncSettings", [
			"instanceId",
			"pollingEnabled",
			"pollingIntervalMins",
		]);
	}
	if (data.libraryCleanupApproval && data.libraryCleanupApproval.length > 0) {
		validateRecords(data.libraryCleanupApproval, "libraryCleanupApproval", [
			"id",
			"configId",
			"instanceId",
			"status",
			"sizeOnDisk",
			"expiresAt",
		]);
	}
	if (data.libraryCleanupMediaServerScan && data.libraryCleanupMediaServerScan.length > 0) {
		validateRecords(data.libraryCleanupMediaServerScan, "libraryCleanupMediaServerScan", [
			"id",
			"approvalId",
			"instanceId",
			"service",
			"mediaType",
			"targetKey",
			"status",
		]);
	}
	if (data.namingConfig && data.namingConfig.length > 0) {
		validateRecords(data.namingConfig, "namingConfig", ["id", "instanceId", "userId"]);
	}
	if (data.userCustomFormat && data.userCustomFormat.length > 0) {
		validateRecords(data.userCustomFormat, "userCustomFormat", ["id", "userId"]);
	}
}

function prepareLibraryCleanupApprovals(
	data: BackupData["data"],
): Prisma.LibraryCleanupApprovalCreateManyInput[] {
	if (!data.libraryCleanupApproval) return [];
	return data.libraryCleanupApproval.map((row) => ({
		...(row as Prisma.LibraryCleanupApprovalCreateManyInput),
		terminalAuditRecordedAt: null,
		terminalAuditRecoveryAttemptedAt: null,
		sizeOnDisk:
			typeof (row as Record<string, unknown>).sizeOnDisk === "string"
				? BigInt((row as Record<string, unknown>).sizeOnDisk as string)
				: (row as Prisma.LibraryCleanupApprovalCreateManyInput).sizeOnDisk,
	}));
}

function prepareLibrarySyncSettings(
	data: BackupData["data"],
): Prisma.LibrarySyncStatusCreateManyInput[] {
	if (!data.librarySyncSettings) return [];
	const seenInstanceIds = new Set<string>();
	return data.librarySyncSettings.map((row, index) => {
		if (typeof row !== "object" || row === null) {
			throw new Error(`Invalid librarySyncSettings record at index ${index}: not an object`);
		}
		const record = row as Record<string, unknown>;
		if (typeof record.instanceId !== "string" || record.instanceId.length === 0) {
			throw new Error(
				`Invalid librarySyncSettings record at index ${index}: instanceId must be a non-empty string`,
			);
		}
		if (seenInstanceIds.has(record.instanceId)) {
			throw new Error(
				`Invalid backup format: duplicate librarySyncSettings instanceId ${record.instanceId}`,
			);
		}
		if (typeof record.pollingEnabled !== "boolean") {
			throw new Error(
				`Invalid librarySyncSettings record at index ${index}: pollingEnabled must be a boolean`,
			);
		}
		if (
			typeof record.pollingIntervalMins !== "number" ||
			!Number.isInteger(record.pollingIntervalMins) ||
			record.pollingIntervalMins < 5 ||
			record.pollingIntervalMins > 1440
		) {
			throw new Error(
				`Invalid librarySyncSettings record at index ${index}: pollingIntervalMins must be an integer from 5 to 1440`,
			);
		}

		seenInstanceIds.add(record.instanceId);
		return {
			instanceId: record.instanceId,
			pollingEnabled: record.pollingEnabled,
			pollingIntervalMins: record.pollingIntervalMins,
		};
	});
}

/**
 * Restore database from backup data
 * Uses bulk inserts for better performance and validates data before restoration
 *
 * CURRENT IMPLEMENTATION: In-memory bulk restore
 * - Performs bulk createMany() operations for all records in a single transaction
 * - Transaction ensures atomicity but can be long-running for large datasets
 */
export async function restoreDatabase(prisma: PrismaClient, data: BackupData["data"]) {
	await restoreDatabaseRecords(prisma, data);
}

async function restoreDatabaseRecords(
	prisma: PrismaClient,
	data: BackupData["data"],
	compatibility: (client: PrismaClient | Prisma.TransactionClient) => Promise<void> = (client) =>
		assertRestoreCompatibility(client, data),
	prepared = false,
	beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>,
	getNotificationProgress?: () => NotificationRestoreProgress | undefined,
) {
	validateSingletonCollections(data);
	validateRestoreRecords(data);
	const libraryCleanupApprovals = prepareLibraryCleanupApprovals(data);
	const librarySyncSettings = prepareLibrarySyncSettings(data);
	const labelSyncMutationAttempts = data.labelSyncMutationAttempts
		? validateLabelSyncMutationAttempts(
				data.labelSyncMutationAttempts,
				data.users,
				data.labelSyncRule,
				data.serviceInstances,
			).map((attempt) =>
				attempt.status === "unknown" ? { ...attempt, claimToken: null } : attempt,
			)
		: [];
	// Preflight on the root client so malformed/future current ledger rows fail
	// before opening the destructive transaction. Repeat inside the transaction
	// below to close the race between this read and the first delete.
	await compatibility(prisma);
	// Use a transaction to ensure atomicity
	await prisma.$transaction(
		async (tx) => {
			// Recheck inside the transaction immediately before any delete. The
			// service-level preflight closes the filesystem TOCTOU window; this check
			// protects direct callers and races between preflight and transaction.
			await compatibility(tx);
			if (prepared) {
				await tx.notificationOutboxDelivery.deleteMany();
				await tx.notificationOutboxEvent.updateMany({ data: { aggregateParentId: null } });
				await tx.notificationOutboxEvent.deleteMany();
				await tx.searchGrabClaim.deleteMany();
				// Break restrictive predecessor edges only inside this atomic replacement.
				await tx.searchGrabAttempt.updateMany({ data: { predecessorId: null } });
				await tx.searchGrabAttempt.deleteMany();
				// qUI's service relation is RESTRICT. Explicitly remove durable
				// children before their parents; insert translated evidence below.
				await tx.quiActionClaim.deleteMany();
				await tx.quiActionLog.deleteMany();
				await tx.arrImportFileProof.deleteMany();
				await tx.arrImportSourceClaim.deleteMany();
				await tx.arrImportOperation.deleteMany();
				await tx.queueCleanerImportReceipt.deleteMany();
				// Discard source leases/cache, but preserve the destination-local
				// journal explicitly; it is never part of portable backup data.
				const models = tx as unknown as Record<string, { deleteMany: () => Promise<unknown> }>;
				for (const [model, disposition] of Object.entries(BACKUP_MODEL_DISPOSITIONS).reverse()) {
					if (disposition.disposition !== "portable" && !disposition.preserveOnRestore)
						await models[model[0]!.toLowerCase() + model.slice(1)]!.deleteMany();
				}
			}

			// =================================================================
			// DELETE all existing data (in reverse order of dependencies)
			// =================================================================

			// Hunting feature (HuntSearchHistory → HuntLog → HuntConfig)
			await tx.huntSearchHistory.deleteMany();
			await tx.huntLog.deleteMany();
			await tx.huntConfig.deleteMany();

			// TRaSH history/audit (depends on templates, instances, backups)
			await tx.templateDeploymentHistory.deleteMany();
			await tx.trashSyncHistory.deleteMany();
			await tx.namingDeployHistory.deleteMany();
			await tx.trashCache.deleteMany();

			// TRaSH configuration (depends on templates, instances)
			await tx.qualitySizeMapping.deleteMany();
			await tx.templateQualityProfileMapping.deleteMany();
			await tx.instanceQualityProfileOverride.deleteMany();
			await tx.standaloneCFDeployment.deleteMany();
			await tx.trashBackup.deleteMany();
			await tx.trashSyncSchedule.deleteMany();
			await tx.trashTemplate.deleteMany();
			await tx.trashSettings.deleteMany();

			// Durable configuration, children before parents.
			await tx.libraryCleanupMediaServerScanLease.deleteMany();
			await tx.libraryCleanupMediaServerScan.deleteMany();
			await tx.libraryCleanupApproval.deleteMany();
			await tx.notificationLog.deleteMany();
			await tx.notificationSubscription.deleteMany();
			await tx.libraryCleanupRule.deleteMany();
			await tx.notificationChannel.deleteMany();
			await tx.notificationRule.deleteMany();
			await tx.notificationAggregationConfig.deleteMany();
			await tx.autoTagRule.deleteMany();
			await tx.labelSyncMutationAttempt.deleteMany();
			await tx.labelSyncRule.deleteMany();
			await tx.queueCleanerConfig.deleteMany();
			await tx.libraryCleanupConfig.deleteMany();
			await tx.namingConfig.deleteMany();
			await tx.userCustomFormat.deleteMany();

			// These singleton rows are not removed by user/instance cascades. Each
			// incoming array independently authorizes replacement of its own model.
			if (Array.isArray(data.backupSettings)) {
				await tx.backupSettings.deleteMany();
			}
			if (Array.isArray(data.vapidKeys)) {
				await tx.vapidKeys.deleteMany();
			}

			// System settings are independent of user/instance cascades. Preserve
			// them for legacy files that predate this payload coverage.
			if (Array.isArray(data.systemSettings)) {
				await tx.systemSettings.deleteMany();
			}

			// Core tables (existing)
			await tx.serviceInstanceTag.deleteMany();
			await tx.serviceTag.deleteMany();
			await tx.serviceInstance.deleteMany();
			await tx.webAuthnCredential.deleteMany();
			await tx.oIDCAccount.deleteMany();
			// OIDC providers are independent of the user/instance cascades too.
			// Legacy files may omit them, so do not turn omission into deletion.
			if (Array.isArray(data.oidcProviders)) {
				await tx.oIDCProvider.deleteMany();
			}
			await tx.session.deleteMany();
			await tx.user.deleteMany();

			// =================================================================
			// RESTORE data (in order of dependencies)
			// =================================================================

			// --- Core authentication (no dependencies) ---

			if (data.users.length > 0) {
				await tx.user.createMany({
					data: data.users as Prisma.UserCreateManyInput[],
				});
			}

			if (data.sessions.length > 0) {
				await tx.session.createMany({
					data: data.sessions as Prisma.SessionCreateManyInput[],
				});
			}

			if (data.oidcProviders && data.oidcProviders.length > 0) {
				const providerData = data.oidcProviders[0] as Prisma.OIDCProviderCreateInput;
				await tx.oIDCProvider.create({
					data: { ...providerData, id: 1 },
				});
			}

			if (data.oidcAccounts.length > 0) {
				await tx.oIDCAccount.createMany({
					data: data.oidcAccounts as Prisma.OIDCAccountCreateManyInput[],
				});
			}

			if (data.webAuthnCredentials.length > 0) {
				await tx.webAuthnCredential.createMany({
					data: data.webAuthnCredentials as Prisma.WebAuthnCredentialCreateManyInput[],
				});
			}

			// --- Service instances & tags ---

			if (data.serviceInstances.length > 0) {
				await tx.serviceInstance.createMany({
					data: data.serviceInstances as Prisma.ServiceInstanceCreateManyInput[],
				});
			}

			if (data.serviceTags.length > 0) {
				await tx.serviceTag.createMany({
					data: data.serviceTags as Prisma.ServiceTagCreateManyInput[],
				});
			}

			if (data.serviceInstanceTags.length > 0) {
				await tx.serviceInstanceTag.createMany({
					data: data.serviceInstanceTags as Prisma.ServiceInstanceTagCreateManyInput[],
				});
			}

			if (librarySyncSettings.length > 0) {
				await tx.librarySyncStatus.createMany({
					data: librarySyncSettings,
				});
			}

			// --- System settings (singleton) ---

			if (data.systemSettings && data.systemSettings.length > 0) {
				const settingsData = data.systemSettings[0] as Prisma.SystemSettingsCreateInput;
				await tx.systemSettings.create({
					data: { ...settingsData, id: 1 },
				});
			}

			if (Array.isArray(data.backupSettings) && data.backupSettings.length > 0) {
				const settings = data.backupSettings[0] as Prisma.BackupSettingsCreateInput;
				await tx.backupSettings.create({ data: { ...settings, id: 1 } });
			}

			if (Array.isArray(data.vapidKeys) && data.vapidKeys.length > 0) {
				const keys = data.vapidKeys[0] as Prisma.VapidKeysCreateInput;
				await tx.vapidKeys.create({ data: { ...keys, id: 1 } });
			}

			// --- TRaSH Guides configuration ---

			if (data.trashSettings && data.trashSettings.length > 0) {
				await tx.trashSettings.createMany({
					data: data.trashSettings as Prisma.TrashSettingsCreateManyInput[],
				});
			}

			if (data.trashTemplates && data.trashTemplates.length > 0) {
				await tx.trashTemplate.createMany({
					data: data.trashTemplates as Prisma.TrashTemplateCreateManyInput[],
				});
			}

			if (data.trashSyncSchedules && data.trashSyncSchedules.length > 0) {
				await tx.trashSyncSchedule.createMany({
					data: data.trashSyncSchedules as Prisma.TrashSyncScheduleCreateManyInput[],
				});
			}

			if (data.trashBackups && data.trashBackups.length > 0) {
				await tx.trashBackup.createMany({
					data: data.trashBackups as Prisma.TrashBackupCreateManyInput[],
				});
			}

			if (data.templateQualityProfileMappings && data.templateQualityProfileMappings.length > 0) {
				await tx.templateQualityProfileMapping.createMany({
					data: data.templateQualityProfileMappings as Prisma.TemplateQualityProfileMappingCreateManyInput[],
				});
			}

			if (data.instanceQualityProfileOverrides && data.instanceQualityProfileOverrides.length > 0) {
				await tx.instanceQualityProfileOverride.createMany({
					data: data.instanceQualityProfileOverrides as Prisma.InstanceQualityProfileOverrideCreateManyInput[],
				});
			}

			if (data.standaloneCFDeployments && data.standaloneCFDeployments.length > 0) {
				await tx.standaloneCFDeployment.createMany({
					data: data.standaloneCFDeployments as Prisma.StandaloneCFDeploymentCreateManyInput[],
				});
			}

			if (data.qualitySizeMappings && data.qualitySizeMappings.length > 0) {
				await tx.qualitySizeMapping.createMany({
					data: data.qualitySizeMappings as Prisma.QualitySizeMappingCreateManyInput[],
				});
			}

			// --- TRaSH Guides history/audit ---

			if (data.trashSyncHistory && data.trashSyncHistory.length > 0) {
				await tx.trashSyncHistory.createMany({
					data: data.trashSyncHistory as Prisma.TrashSyncHistoryCreateManyInput[],
				});
			}

			if (data.templateDeploymentHistory && data.templateDeploymentHistory.length > 0) {
				await tx.templateDeploymentHistory.createMany({
					data: data.templateDeploymentHistory as Prisma.TemplateDeploymentHistoryCreateManyInput[],
				});
			}

			if (data.namingDeployHistory && data.namingDeployHistory.length > 0) {
				await tx.namingDeployHistory.createMany({
					data: data.namingDeployHistory as Prisma.NamingDeployHistoryCreateManyInput[],
				});
			}

			// --- Hunting feature ---

			if (data.huntConfigs && data.huntConfigs.length > 0) {
				await tx.huntConfig.createMany({
					data: data.huntConfigs as Prisma.HuntConfigCreateManyInput[],
				});
			}

			if (data.huntLogs && data.huntLogs.length > 0) {
				await tx.huntLog.createMany({
					data: data.huntLogs as Prisma.HuntLogCreateManyInput[],
				});
			}

			if (data.huntSearchHistory && data.huntSearchHistory.length > 0) {
				await tx.huntSearchHistory.createMany({
					data: data.huntSearchHistory as Prisma.HuntSearchHistoryCreateManyInput[],
				});
			}

			// Durable configuration (dependency order).
			if (data.notificationChannel && data.notificationChannel.length > 0) {
				await tx.notificationChannel.createMany({
					data: data.notificationChannel as Prisma.NotificationChannelCreateManyInput[],
				});
			}
			if (data.notificationSubscription && data.notificationSubscription.length > 0) {
				await tx.notificationSubscription.createMany({
					data: data.notificationSubscription as Prisma.NotificationSubscriptionCreateManyInput[],
				});
			}
			if (data.notificationRule && data.notificationRule.length > 0) {
				await tx.notificationRule.createMany({
					data: data.notificationRule as Prisma.NotificationRuleCreateManyInput[],
				});
			}
			if (data.notificationAggregationConfig && data.notificationAggregationConfig.length > 0) {
				await tx.notificationAggregationConfig.createMany({
					data: data.notificationAggregationConfig as Prisma.NotificationAggregationConfigCreateManyInput[],
				});
			}
			if (data.autoTagRule && data.autoTagRule.length > 0) {
				await tx.autoTagRule.createMany({
					data: data.autoTagRule as Prisma.AutoTagRuleCreateManyInput[],
				});
			}
			if (data.labelSyncRule && data.labelSyncRule.length > 0) {
				await tx.labelSyncRule.createMany({
					data: data.labelSyncRule as Prisma.LabelSyncRuleCreateManyInput[],
				});
			}
			if (labelSyncMutationAttempts.length > 0) {
				await tx.labelSyncMutationAttempt.createMany({
					data: labelSyncMutationAttempts,
				});
			}
			if (data.queueCleanerConfig && data.queueCleanerConfig.length > 0) {
				await tx.queueCleanerConfig.createMany({
					data: data.queueCleanerConfig as Prisma.QueueCleanerConfigCreateManyInput[],
				});
			}
			if (data.libraryCleanupConfig && data.libraryCleanupConfig.length > 0) {
				await tx.libraryCleanupConfig.createMany({
					data: data.libraryCleanupConfig as Prisma.LibraryCleanupConfigCreateManyInput[],
				});
			}
			if (data.libraryCleanupRule && data.libraryCleanupRule.length > 0) {
				await tx.libraryCleanupRule.createMany({
					data: data.libraryCleanupRule as Prisma.LibraryCleanupRuleCreateManyInput[],
				});
			}
			if (libraryCleanupApprovals.length > 0) {
				await tx.libraryCleanupApproval.createMany({
					data: libraryCleanupApprovals,
				});
			}
			if (data.libraryCleanupMediaServerScan && data.libraryCleanupMediaServerScan.length > 0) {
				await tx.libraryCleanupMediaServerScan.createMany({
					data: data.libraryCleanupMediaServerScan as Prisma.LibraryCleanupMediaServerScanCreateManyInput[],
				});
			}
			if (data.namingConfig && data.namingConfig.length > 0) {
				await tx.namingConfig.createMany({
					data: data.namingConfig as Prisma.NamingConfigCreateManyInput[],
				});
			}
			if (data.userCustomFormat && data.userCustomFormat.length > 0) {
				await tx.userCustomFormat.createMany({
					data: data.userCustomFormat as Prisma.UserCustomFormatCreateManyInput[],
				});
			}
			if (prepared) {
				const previous = getNotificationProgress?.();
				const notificationEvents = (
					(data.notificationOutboxEvents ?? []) as Prisma.NotificationOutboxEventCreateManyInput[]
				).map((row) => ({
					...row,
					updatedAt: previous?.events.get(row.id!) ?? row.updatedAt,
				}));
				if (notificationEvents.length)
					await tx.notificationOutboxEvent.createMany({
						data: notificationEvents.map((row) => ({ ...row, aggregateParentId: null })),
					});
				for (const row of notificationEvents) {
					if (!row.aggregateParentId) continue;
					const linked = await tx.notificationOutboxEvent.updateMany({
						where: { id: row.id, userId: row.userId },
						data: { aggregateParentId: row.aggregateParentId, updatedAt: row.updatedAt },
					});
					if (linked.count !== 1) throw new BackupCompatibilityError();
				}
				if (data.notificationOutboxDeliveries?.length)
					await tx.notificationOutboxDelivery.createMany({
						data: (
							data.notificationOutboxDeliveries as Prisma.NotificationOutboxDeliveryCreateManyInput[]
						).map((row) => ({
							...row,
							...previous?.deliveries.get(row.id!),
						})),
					});
				if (data.arrImportOperations!.length)
					await tx.arrImportOperation.createMany({
						data: data.arrImportOperations as Prisma.ArrImportOperationCreateManyInput[],
					});
				// Insert all historical nodes before installing same-owner predecessor
				// edges. This is independent of export order on both native engines.
				const grabAttempts = (data.searchGrabAttempts ??
					[]) as Prisma.SearchGrabAttemptCreateManyInput[];
				if (grabAttempts.length)
					await tx.searchGrabAttempt.createMany({
						data: grabAttempts.map((row) => ({ ...row, predecessorId: null, workerEpoch: null })),
					});
				for (const row of grabAttempts) {
					if (!row.predecessorId) continue;
					const linked = await tx.searchGrabAttempt.updateMany({
						where: { id: row.id, userId: row.userId },
						data: { predecessorId: row.predecessorId, updatedAt: row.updatedAt },
					});
					if (linked.count !== 1) throw new BackupCompatibilityError();
				}
				if (data.searchGrabClaims?.length)
					await tx.searchGrabClaim.createMany({
						data: data.searchGrabClaims as Prisma.SearchGrabClaimCreateManyInput[],
					});
				if (data.arrImportFileProofs!.length)
					await tx.arrImportFileProof.createMany({
						data: data.arrImportFileProofs as Prisma.ArrImportFileProofCreateManyInput[],
					});
				if (data.arrImportSourceClaims!.length)
					await tx.arrImportSourceClaim.createMany({
						data: data.arrImportSourceClaims as Prisma.ArrImportSourceClaimCreateManyInput[],
					});
				if (data.queueCleanerImportReceipts!.length)
					await tx.queueCleanerImportReceipt.createMany({
						data: data.queueCleanerImportReceipts as Prisma.QueueCleanerImportReceiptCreateManyInput[],
					});
				if (data.quiActionLogs!.length)
					await tx.quiActionLog.createMany({
						data: data.quiActionLogs as Prisma.QuiActionLogCreateManyInput[],
					});
				if (data.quiActionClaims!.length)
					await tx.quiActionClaim.createMany({
						data: data.quiActionClaims as Prisma.QuiActionClaimCreateManyInput[],
					});
			}
			// Positive outcome evidence shares the replacement transaction. A
			// failed marker/fence aborts every insert, delete and session revocation.
			await beforeCommit?.(tx);
		},
		{
			isolationLevel: "Serializable",
			timeout: RESTORE_TRANSACTION_TIMEOUT_MS,
		},
	);
}
