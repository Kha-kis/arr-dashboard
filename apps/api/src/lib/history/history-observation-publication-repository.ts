import type { Prisma, PrismaClientInstance } from "../prisma.js";
import { withHistoryCollectionLeaseAuthority } from "./history-collection-lease.js";
import {
	buildHistoryPublicationPreflight,
	type CanonicalHistoryObservedIdentity,
	type CanonicalHistoryPublicationRow,
} from "./history-publication-preflight.js";
import {
	HISTORY_PUBLICATION_REVISION_MAX,
	type HistorySourceAttempt,
	type HistorySourceAttemptFailureReason,
	type HistorySourceProviderStartedAttempt,
	isStartedHistorySourceAttemptForClaim,
	isValidHistoryPublicationRevision,
} from "./history-source-attempt.js";
import {
	HISTORY_SERVICE_TYPES,
	historyServiceTypeToService,
	isHistoryServiceType,
} from "./history-source-contract.js";
import {
	deriveHistorySourceFailureSuccessor,
	deriveHistorySourcePageResult,
	type HistorySourcePageReceipt,
	historySourceScheduleToDatabase,
} from "./history-source-schedule.js";

const RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 10_000;
const BATCH_SIZE = 250;
const ID_MAX_BYTES = 256;
const TOKEN_MAX_BYTES = 128;
const CURRENT_TIMESTAMP_SQL = {
	sqlite: "SELECT CURRENT_TIMESTAMP AS now",
	postgresql: "SELECT CURRENT_TIMESTAMP AS now",
} as const;

export type HistoryObservationPublicationInput = {
	attempt: HistorySourceProviderStartedAttempt;
	leaseClaim: Pick<HistoryCollectionLeaseClaimLike, "userId" | "claimToken">;
	receipt: HistoryObservationPageReceipt;
};

export type HistoryObservationPageReceipt =
	| ({ kind: "completed" } & HistorySourcePageReceipt)
	| { kind: "adapter-invalid"; rawRecordCount: number };

export type HistoryObservationPublicationResult =
	| {
			kind: "published";
			finish:
				| { result: "success"; reason: null }
				| { result: "error"; reason: "provider-unavailable" | "provider-limit" };
			publishedObservationCount: number;
			retainedObservationCount: number;
			deletedObservationCount: number;
	  }
	| {
			kind: "preserved";
			finish: "recorded";
			reason: HistorySourceAttemptFailureReason;
	  }
	| { kind: "superseded" }
	| { kind: "failed" };

type HistoryCollectionLeaseClaimLike = { userId: string; claimToken: string };
type PublicationPrisma = Pick<
	PrismaClientInstance,
	| "$queryRawUnsafe"
	| "$executeRawUnsafe"
	| "$transaction"
	| "serviceInstance"
	| "historySourceStatus"
	| "historyObservation"
>;
type TransactionClient = Prisma.TransactionClient;
type Dialect = "sqlite" | "postgresql";
type TimestampRow = { now: unknown };
type InstanceAuthority = {
	id: string;
	userId: string;
	service: string;
	connectionGeneration: number;
};
type StatusAuthority = {
	instanceId: string;
	connectionGeneration: number;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptReason: string | null;
	retentionEpoch: number;
	publicationRevision: number;
	collectHeadNext: boolean;
	nextBackfillPage: number;
	activeCollectionPage: number | null;
};
type ExistingObservation = {
	id: string;
	providerEventId: number;
	eventAt: Date;
	firstObservedAt: Date;
};

class PublicationRollbackError extends Error {
	constructor() {
		super("History observation publication transaction was not recorded");
		this.name = "PublicationRollbackError";
	}
}

export async function publishHistoryObservations(
	input: HistoryObservationPublicationInput,
	prisma: PublicationPrisma,
): Promise<HistoryObservationPublicationResult> {
	if (!isValidInput(input)) return { kind: "failed" };
	const dialect = resolveDialect();
	try {
		const result = await withHistoryCollectionLeaseAuthority<HistoryObservationPublicationResult>(
			prisma,
			input.leaseClaim,
			async (tx) => await publishInTransaction(tx, input, dialect),
			{ dialect },
		);
		return result.matched ? result.value : { kind: "superseded" };
	} catch {
		return { kind: "failed" };
	}
}

async function publishInTransaction(
	tx: TransactionClient,
	input: HistoryObservationPublicationInput,
	dialect: Dialect,
): Promise<HistoryObservationPublicationResult> {
	const databaseNow = await readDatabaseTimestamp(tx, dialect);
	if (!databaseNow) return { kind: "failed" };

	const instance = (await tx.serviceInstance.findFirst({
		where: {
			id: input.attempt.instanceId,
			userId: input.leaseClaim.userId,
			enabled: true,
			service: { in: [...HISTORY_SERVICE_TYPES] },
		},
		select: { id: true, userId: true, service: true, connectionGeneration: true },
	})) as InstanceAuthority | null;
	if (
		!instance ||
		!isHistoryServiceType(instance.service) ||
		!isSafeGeneration(instance.connectionGeneration) ||
		instance.connectionGeneration !== input.attempt.connectionGeneration
	) {
		return { kind: "superseded" };
	}

	const status = (await tx.historySourceStatus.findUnique({
		where: { instanceId: instance.id },
		select: {
			instanceId: true,
			connectionGeneration: true,
			lastAttemptAt: true,
			lastAttemptResult: true,
			lastAttemptReason: true,
			retentionEpoch: true,
			publicationRevision: true,
			collectHeadNext: true,
			nextBackfillPage: true,
			activeCollectionPage: true,
		},
	})) as StatusAuthority | null;
	if (!isExactRunningStatus(status, instance, input.attempt)) return { kind: "superseded" };
	if (!isValidHistoryPublicationRevision(status.publicationRevision)) return { kind: "failed" };
	if (status.lastAttemptAt.getTime() > databaseNow.getTime()) return { kind: "failed" };
	const attempt: HistorySourceProviderStartedAttempt = {
		userId: input.leaseClaim.userId,
		instanceId: instance.id,
		connectionGeneration: instance.connectionGeneration,
		attemptedAt: new Date(status.lastAttemptAt!.getTime()),
		resultMarker: input.attempt.resultMarker,
		phase: input.attempt.phase,
		collectionPage: input.attempt.collectionPage,
		backfillPage: input.attempt.backfillPage,
	};
	if (
		status.collectHeadNext !== (attempt.phase === "head") ||
		status.nextBackfillPage !== attempt.backfillPage ||
		status.activeCollectionPage !== attempt.collectionPage
	)
		return { kind: "superseded" };

	const parsedReceipt = parsePublicationReceipt(input.receipt);
	if (!parsedReceipt.valid) {
		if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, "receipt-invalid")))
			throw new PublicationRollbackError();
		return { kind: "preserved", finish: "recorded", reason: "receipt-invalid" };
	}
	const receipt = parsedReceipt.receipt;
	if (receipt.kind === "adapter-invalid") {
		const reason =
			isSafeCount(receipt.rawRecordCount) && receipt.rawRecordCount > 100
				? "provider-limit"
				: "receipt-invalid";
		if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, reason)))
			throw new PublicationRollbackError();
		return { kind: "preserved", finish: "recorded", reason };
	}
	if (isSafeCount(receipt.rawRecordCount) && receipt.rawRecordCount > 100) {
		if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, "provider-limit")))
			throw new PublicationRollbackError();
		return { kind: "preserved", finish: "recorded", reason: "provider-limit" };
	}
	const pageResult = deriveHistorySourcePageResult(attempt, receipt);
	if (pageResult.result === "error") {
		if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, pageResult.reason)))
			throw new PublicationRollbackError();
		return { kind: "preserved", finish: "recorded", reason: pageResult.reason };
	}

	const preflight = buildHistoryPublicationPreflight({
		service: historyServiceTypeToService(instance.service),
		connectionGeneration: instance.connectionGeneration,
		databaseNow,
		attemptStartedAt: attempt.attemptedAt,
		normalizedRows: receipt.normalizedRows,
		rawObserved: receipt.rawRecordCount,
		pagesAttempted: 1,
		pagesCompleted: 1,
		fatalCount: 0,
		outcome: pageResult.finish ?? { result: "success" },
	});

	if (preflight.kind === "preserve") {
		if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, preflight.reason)))
			throw new PublicationRollbackError();
		return { kind: "preserved", finish: "recorded", reason: preflight.reason };
	}
	if (status.publicationRevision === HISTORY_PUBLICATION_REVISION_MAX) return { kind: "failed" };

	const existing = await findObservedIdentities(
		tx,
		input.leaseClaim.userId,
		instance.id,
		instance.connectionGeneration,
		preflight.observedIdentities,
	);
	for (const identity of preflight.observedIdentities) {
		const prior = existing.get(identity.providerEventId);
		if (prior && prior.eventAt.getTime() !== identity.eventAt.getTime()) {
			if (!(await finishFailureCas(tx, attempt, input.leaseClaim, status, "rows-inconsistent")))
				throw new PublicationRollbackError();
			return { kind: "preserved", finish: "recorded", reason: "rows-inconsistent" };
		}
	}

	await reconcileRows(
		tx,
		input.leaseClaim.userId,
		instance.id,
		instance.connectionGeneration,
		preflight.rows,
		existing,
		dialect,
		preflight.observedAt,
	);

	const postReconciliationCount = await countRows(
		tx,
		input.leaseClaim.userId,
		instance.id,
		instance.connectionGeneration,
	);
	const deletedObservationCount =
		receipt.rawRecordCount === 0
			? 0
			: await applyRetention(
					tx,
					input.leaseClaim.userId,
					instance.id,
					instance.connectionGeneration,
					databaseNow,
					postReconciliationCount,
				);
	const retainedObservationCount =
		receipt.rawRecordCount === 0
			? postReconciliationCount
			: await countRows(tx, input.leaseClaim.userId, instance.id, instance.connectionGeneration);
	if (
		retainedObservationCount !== postReconciliationCount - deletedObservationCount ||
		(receipt.rawRecordCount > 0 && retainedObservationCount > MAX_ROWS)
	) {
		throw new PublicationRollbackError();
	}

	const successorDatabaseSchedule = historySourceScheduleToDatabase(pageResult.successor, null);
	if (!successorDatabaseSchedule) throw new PublicationRollbackError();
	const publicationChanged = await tx.historySourceStatus.updateMany({
		where: exactStatusWhere(input.leaseClaim.userId, instance, attempt, status),
		data: {
			publishedAt: databaseNow,
			publicationMetadata: preflight.publicationMetadata,
			retainedObservationCount,
			retentionEpoch: status.retentionEpoch + (deletedObservationCount > 0 ? 1 : 0),
			publicationRevision: { increment: 1 },
			lastAttemptResult: preflight.finish.result,
			lastAttemptReason: preflight.finish.reason,
			collectHeadNext: successorDatabaseSchedule.collectHeadNext,
			nextBackfillPage: successorDatabaseSchedule.nextBackfillPage,
			activeCollectionPage: null,
		},
	});
	if (publicationChanged.count !== 1) throw new PublicationRollbackError();
	return {
		kind: "published",
		finish: preflight.finish,
		publishedObservationCount: preflight.publishedObservationCount,
		retainedObservationCount,
		deletedObservationCount,
	};
}

async function findObservedIdentities(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	identities: readonly CanonicalHistoryObservedIdentity[],
): Promise<Map<number, ExistingObservation>> {
	const existing = new Map<number, ExistingObservation>();
	for (let offset = 0; offset < identities.length; offset += BATCH_SIZE) {
		const ids = identities
			.slice(offset, offset + BATCH_SIZE)
			.map((identity) => identity.providerEventId);
		const rows = (await tx.historyObservation.findMany({
			where: {
				instanceId,
				connectionGeneration,
				providerEventId: { in: ids },
				instance: { id: instanceId, userId },
			},
			select: { id: true, providerEventId: true, eventAt: true, firstObservedAt: true },
		})) as ExistingObservation[];
		for (const row of rows) existing.set(row.providerEventId, row);
	}
	return existing;
}

async function reconcileRows(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	rows: readonly CanonicalHistoryPublicationRow[],
	existing: Map<number, ExistingObservation>,
	dialect: Dialect,
	observedAt: Date,
): Promise<void> {
	const creates: Array<{
		instanceId: string;
		connectionGeneration: number;
		providerEventId: number;
		eventAt: Date;
		eventTypeKey: string;
		searchText: string;
		normalizedPayload: string;
		firstObservedAt: Date;
		lastObservedAt: Date;
	}> = [];
	const updates: CanonicalHistoryPublicationRow[] = [];
	for (const row of rows) {
		if (existing.has(row.providerEventId)) updates.push(row);
		else {
			creates.push({
				instanceId,
				connectionGeneration,
				providerEventId: row.providerEventId,
				eventAt: new Date(row.eventAt),
				eventTypeKey: row.eventTypeKey,
				searchText: row.searchText,
				normalizedPayload: row.normalizedPayload,
				firstObservedAt: new Date(observedAt),
				lastObservedAt: new Date(observedAt),
			});
		}
	}
	for (let offset = 0; offset < creates.length; offset += BATCH_SIZE) {
		await tx.historyObservation.createMany({ data: creates.slice(offset, offset + BATCH_SIZE) });
	}
	for (let offset = 0; offset < updates.length; offset += BATCH_SIZE) {
		await bulkUpdateRows(
			tx,
			userId,
			instanceId,
			connectionGeneration,
			updates.slice(offset, offset + BATCH_SIZE),
			dialect,
			observedAt,
		);
	}
}

async function bulkUpdateRows(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	rows: readonly CanonicalHistoryPublicationRow[],
	dialect: Dialect,
	observedAt: Date,
): Promise<void> {
	if (rows.length === 0) return;
	const values: unknown[] = [];
	const placeholder = (): string => {
		if (dialect === "sqlite") return "?";
		return `$${values.length + 1}`;
	};
	const caseExpression = (
		field: string,
		value: (row: CanonicalHistoryPublicationRow) => unknown,
	) => {
		const parts: string[] = [];
		for (const row of rows) {
			const idPlaceholder = placeholder();
			values.push(row.providerEventId);
			const valuePlaceholder = placeholder();
			values.push(value(row));
			parts.push(`WHEN ${idPlaceholder} THEN ${valuePlaceholder}`);
		}
		return `CASE "providerEventId" ${parts.join(" ")} ELSE "${field}" END`;
	};
	const eventType = caseExpression("eventTypeKey", (row) => row.eventTypeKey);
	const search = caseExpression("searchText", (row) => row.searchText);
	const payload = caseExpression("normalizedPayload", (row) => row.normalizedPayload);
	const lastObserved = caseExpression("lastObservedAt", () => observedAt);
	const instancePlaceholder = placeholder();
	values.push(instanceId);
	const generationPlaceholder = placeholder();
	values.push(connectionGeneration);
	const ownerPlaceholder = placeholder();
	values.push(userId);
	const idPlaceholders = rows.map((row) => {
		const next = placeholder();
		values.push(row.providerEventId);
		return next;
	});
	const sql = `UPDATE "history_observations"
SET "eventTypeKey" = ${eventType}, "searchText" = ${search},
    "normalizedPayload" = ${payload}, "lastObservedAt" = ${lastObserved}
WHERE "instanceId" = ${instancePlaceholder}
  AND "connectionGeneration" = ${generationPlaceholder}
  AND EXISTS (SELECT 1 FROM "ServiceInstance" AS "si"
              WHERE "si"."id" = "history_observations"."instanceId"
                AND "si"."userId" = ${ownerPlaceholder})
  AND "providerEventId" IN (${idPlaceholders.join(", ")})`;
	const changed = await tx.$executeRawUnsafe(sql, ...values);
	if (changed !== rows.length) throw new PublicationRollbackError();
}

async function applyRetention(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	databaseNow: Date,
	startingCount: number,
): Promise<number> {
	let deleted = 0;
	const cutoff = new Date(databaseNow.getTime() - RETENTION_WINDOW_MS);
	while (true) {
		const ids = await selectOldestIds(tx, userId, instanceId, connectionGeneration, {
			eventAt: { lt: cutoff },
		});
		if (ids.length === 0) break;
		await deleteExactRows(tx, userId, instanceId, connectionGeneration, ids);
		deleted += ids.length;
	}
	let remaining = startingCount - deleted;
	while (remaining > MAX_ROWS) {
		const ids = await selectOldestIds(tx, userId, instanceId, connectionGeneration);
		if (ids.length === 0) throw new PublicationRollbackError();
		const overflow = ids.slice(0, Math.min(ids.length, remaining - MAX_ROWS));
		await deleteExactRows(tx, userId, instanceId, connectionGeneration, overflow);
		deleted += overflow.length;
		remaining -= overflow.length;
	}
	return deleted;
}

async function selectOldestIds(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	whereExtra: Record<string, unknown> = {},
): Promise<string[]> {
	const rows = await tx.historyObservation.findMany({
		where: {
			instanceId,
			connectionGeneration,
			instance: { id: instanceId, userId },
			...whereExtra,
		},
		orderBy: [{ eventAt: "asc" }, { id: "asc" }],
		take: BATCH_SIZE,
		select: { id: true },
	});
	return rows.map((row) => row.id);
}

async function deleteExactRows(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	ids: readonly string[],
): Promise<void> {
	if (ids.length === 0 || ids.length > BATCH_SIZE) throw new PublicationRollbackError();
	const changed = await tx.historyObservation.deleteMany({
		where: {
			id: { in: [...ids] },
			instanceId,
			connectionGeneration,
			instance: { id: instanceId, userId },
		},
	});
	if (changed.count !== ids.length) throw new PublicationRollbackError();
}

async function countRows(
	tx: TransactionClient,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
): Promise<number> {
	return await tx.historyObservation.count({
		where: { instanceId, connectionGeneration, instance: { id: instanceId, userId } },
	});
}

async function finishFailureCas(
	tx: TransactionClient,
	attempt: HistorySourceProviderStartedAttempt,
	leaseClaim: HistoryCollectionLeaseClaimLike,
	status: StatusAuthority,
	reason: HistorySourceAttemptFailureReason,
): Promise<boolean> {
	const successor = deriveHistorySourceFailureSuccessor(attempt);
	const successorDatabaseSchedule = historySourceScheduleToDatabase(successor, null);
	const originalDatabaseSchedule = historySourceScheduleToDatabase(attempt, attempt.collectionPage);
	if (!successorDatabaseSchedule || !originalDatabaseSchedule) return false;
	const changed = await tx.historySourceStatus.updateMany({
		where: {
			instanceId: attempt.instanceId,
			connectionGeneration: attempt.connectionGeneration,
			lastAttemptAt: status.lastAttemptAt,
			lastAttemptResult: attempt.resultMarker,
			lastAttemptReason: null,
			collectHeadNext: status.collectHeadNext,
			nextBackfillPage: status.nextBackfillPage,
			activeCollectionPage: status.activeCollectionPage,
			publicationRevision: status.publicationRevision,
			instance: {
				id: attempt.instanceId,
				userId: leaseClaim.userId,
				enabled: true,
				service: { in: [...HISTORY_SERVICE_TYPES] },
				connectionGeneration: attempt.connectionGeneration,
			},
		},
		data: {
			lastAttemptResult: "error",
			lastAttemptReason: reason,
			collectHeadNext: successorDatabaseSchedule.collectHeadNext,
			nextBackfillPage: successorDatabaseSchedule.nextBackfillPage,
			activeCollectionPage: null,
		},
	});
	return changed.count === 1;
}

function exactStatusWhere(
	userId: string,
	instance: InstanceAuthority,
	attempt: HistorySourceProviderStartedAttempt,
	status: StatusAuthority,
) {
	return {
		instanceId: instance.id,
		connectionGeneration: instance.connectionGeneration,
		lastAttemptAt: status.lastAttemptAt,
		lastAttemptResult: attempt.resultMarker,
		lastAttemptReason: null,
		collectHeadNext: status.collectHeadNext,
		nextBackfillPage: status.nextBackfillPage,
		activeCollectionPage: status.activeCollectionPage,
		publicationRevision: status.publicationRevision,
		instance: {
			id: instance.id,
			userId,
			enabled: true,
			service: { in: [...HISTORY_SERVICE_TYPES] },
			connectionGeneration: instance.connectionGeneration,
		},
	};
}

function isExactRunningStatus(
	status: StatusAuthority | null,
	instance: InstanceAuthority,
	attempt: HistorySourceAttempt,
): status is StatusAuthority & { lastAttemptAt: Date } {
	return (
		status !== null &&
		status.instanceId === instance.id &&
		status.connectionGeneration === instance.connectionGeneration &&
		status.lastAttemptAt instanceof Date &&
		Number.isFinite(status.lastAttemptAt.getTime()) &&
		status.lastAttemptAt.getTime() === attempt.attemptedAt.getTime() &&
		status.lastAttemptResult === attempt.resultMarker &&
		status.lastAttemptReason === null &&
		status.collectHeadNext === (attempt.phase === "head") &&
		status.nextBackfillPage === attempt.backfillPage &&
		status.activeCollectionPage === attempt.collectionPage
	);
}

async function readDatabaseTimestamp(
	tx: TransactionClient,
	dialect: Dialect,
): Promise<Date | null> {
	const rows = await tx.$queryRawUnsafe<TimestampRow[]>(CURRENT_TIMESTAMP_SQL[dialect]);
	const value = rows[0]?.now;
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isValidInput(input: unknown): input is HistoryObservationPublicationInput {
	if (!isRecord(input)) return false;
	const attempt = input.attempt;
	const claim = input.leaseClaim;
	const receipt = input.receipt;
	if (!isRecord(attempt) || !isRecord(claim) || !isRecord(receipt)) return false;
	if (!isSafeIdentifier(claim.userId) || !isSafeToken(claim.claimToken)) return false;
	if (!isSafeIdentifier(attempt.userId) || attempt.userId !== claim.userId) return false;
	if (!isSafeIdentifier(attempt.instanceId) || !isSafeGeneration(attempt.connectionGeneration))
		return false;
	if (!(attempt.attemptedAt instanceof Date) || !Number.isFinite(attempt.attemptedAt.getTime()))
		return false;
	if (!isStartedHistorySourceAttemptForClaim(attempt as HistorySourceAttempt, claim.claimToken))
		return false;
	if (
		typeof attempt.phase !== "string" ||
		!Number.isSafeInteger(attempt.collectionPage) ||
		!Number.isSafeInteger(attempt.backfillPage)
	)
		return false;
	return true;
}

type ParsedPublicationReceipt =
	| { valid: true; receipt: HistoryObservationPageReceipt }
	| { valid: false };

function parsePublicationReceipt(value: Record<string, unknown>): ParsedPublicationReceipt {
	if (value.kind === "adapter-invalid") {
		if (!hasExactKeys(value, ["kind", "rawRecordCount"]) || !isSafeCount(value.rawRecordCount)) {
			return { valid: false };
		}
		return {
			valid: true,
			receipt: { kind: "adapter-invalid", rawRecordCount: value.rawRecordCount },
		};
	}
	if (value.kind !== "completed") return { valid: false };
	if (
		!hasExactKeys(value, ["kind", "rawRecordCount", "normalizedRows", "totalRecordsHint"]) ||
		!isSafeCount(value.rawRecordCount) ||
		!Array.isArray(value.normalizedRows) ||
		(value.totalRecordsHint !== null && !isSafeCount(value.totalRecordsHint))
	) {
		return { valid: false };
	}
	return {
		valid: true,
		receipt: {
			kind: "completed",
			rawRecordCount: value.rawRecordCount,
			normalizedRows: value.normalizedRows as HistorySourcePageReceipt["normalizedRows"],
			totalRecordsHint: value.totalRecordsHint,
		},
	};
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!containsControl(value) &&
		Buffer.byteLength(value, "utf8") <= ID_MAX_BYTES
	);
}

function isSafeToken(value: unknown): value is string {
	return isSafeIdentifier(value) && Buffer.byteLength(value, "utf8") <= TOKEN_MAX_BYTES;
}

function isSafeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function containsControl(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDialect(): Dialect {
	return /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL ?? "") ? "postgresql" : "sqlite";
}
