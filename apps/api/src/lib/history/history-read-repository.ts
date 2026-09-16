import {
	HISTORY_DISPLAY_TEXT_MAX_LENGTH,
	HISTORY_EVENT_TYPE_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
	HISTORY_SOURCE_MAX_COUNT,
	type HistoryResponseV2,
	type HistoryService,
	historyResponseV2Schema,
} from "@arr/shared";
import type { Encryptor } from "../auth/encryption.js";
import { decodeHistoryNormalizedPayload } from "../dashboard/history-utils.js";
import {
	deriveHistoryRowAuthority,
	type HistoryReadFilter,
	type HistoryReadQuery,
	type HistorySourceState,
	historyFilterDigest,
	historySourceStateDigest,
} from "./history-read-contract.js";
import {
	advanceHistoryCursor,
	decodeHistoryCursor,
	encodeHistoryCursor,
} from "./history-read-cursor.js";
import { projectHistorySourceStatus } from "./history-source-status-projection.js";

const TRANSACTION_TIMEOUT_MS = 10_000;
const SUPPORTED_SERVICE_TYPES = ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] as const;
const SERVICE_BY_TYPE: Record<(typeof SUPPORTED_SERVICE_TYPES)[number], HistoryService> = {
	SONARR: "sonarr",
	RADARR: "radarr",
	PROWLARR: "prowlarr",
	LIDARR: "lidarr",
	READARR: "readarr",
};
const URL_LIKE = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/iu;

type SupportedServiceType = (typeof SUPPORTED_SERVICE_TYPES)[number];
type Dialect = "sqlite" | "postgresql";
type UnknownRecord = Record<string, unknown>;

type ReadTransaction = {
	$queryRawUnsafe(query: string): Promise<unknown>;
	serviceInstance: { findMany(args: UnknownRecord): Promise<unknown> };
	historyObservation: {
		findFirst(args: UnknownRecord): Promise<unknown>;
		findMany(args: UnknownRecord): Promise<unknown>;
		count(args: UnknownRecord): Promise<unknown>;
	};
};

type ReadPrisma = {
	$transaction(
		operation: (transaction: ReadTransaction) => Promise<unknown>,
		options: { isolationLevel: "Serializable"; timeout: number },
	): Promise<unknown>;
};

export type HistoryReadRepositoryInput = {
	prisma: unknown;
	encryptor: Pick<Encryptor, "encrypt" | "decrypt">;
	dialect: Dialect;
	ownerId: string;
	query: HistoryReadQuery;
};

export type HistoryReadRepositoryResult =
	| { kind: "ok"; response: HistoryResponseV2 }
	| { kind: "cursor-invalid" }
	| { kind: "cursor-stale" }
	| { kind: "unavailable" };

type ValidSource = {
	id: string;
	label: string;
	serviceType: SupportedServiceType;
	service: HistoryService;
	connectionGeneration: number;
	status: UnknownRecord | null;
	projection: ReturnType<typeof projectHistorySourceStatus>;
	publicationRevision: number | null;
	retentionEpoch: number | null;
	rowAuthority: "positive" | "unavailable";
};

type ValidObservation = {
	id: string;
	instanceId: string;
	connectionGeneration: number;
	providerEventId: number;
	eventAt: Date;
	eventTypeKey: string;
	searchText: string;
	normalizedPayload: string;
	firstObservedAt: Date;
	lastObservedAt: Date;
};

type SourceCore = {
	id: string;
	label: string;
	service: SupportedServiceType;
	connectionGeneration: number;
	historySourceStatus: UnknownRecord | null;
};

const SOURCE_STATUS_SELECT = {
	connectionGeneration: true,
	publishedAt: true,
	publicationMetadata: true,
	retainedObservationCount: true,
	lastAttemptAt: true,
	lastAttemptResult: true,
	lastAttemptReason: true,
	publicationRevision: true,
	retentionEpoch: true,
} as const;

const SOURCE_SELECT = {
	id: true,
	label: true,
	service: true,
	connectionGeneration: true,
	historySourceStatus: { select: SOURCE_STATUS_SELECT },
} as const;

const OBSERVATION_SELECT = {
	id: true,
	instanceId: true,
	connectionGeneration: true,
	providerEventId: true,
	eventAt: true,
	eventTypeKey: true,
	searchText: true,
	normalizedPayload: true,
	firstObservedAt: true,
	lastObservedAt: true,
} as const;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	);
}

function safeIdentifier(value: unknown): value is string {
	return safeText(value, HISTORY_IDENTIFIER_TEXT_MAX_LENGTH) && !URL_LIKE.test(value);
}

function safeDisplay(value: unknown): value is string {
	return safeText(value, HISTORY_DISPLAY_TEXT_MAX_LENGTH);
}

function safeSearch(value: unknown): value is string {
	return safeText(value, HISTORY_SEARCH_TEXT_MAX_LENGTH) && value === value.toLowerCase();
}

function safeEventType(value: unknown): value is string {
	return safeText(value, HISTORY_EVENT_TYPE_MAX_LENGTH) && value === value.toLowerCase();
}

function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function parseDatabaseTimestamp(value: unknown): Date | null {
	if (validDate(value)) return new Date(value.getTime());
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return validDate(parsed) ? parsed : null;
}

function timestampRow(value: unknown): Date | null {
	if (!Array.isArray(value) || value.length !== 1) return null;
	const [row] = value;
	if (!isRecord(row) || Object.keys(row).length !== 1 || !Object.hasOwn(row, "now")) return null;
	return parseDatabaseTimestamp(row.now);
}

function serviceType(value: unknown): value is SupportedServiceType {
	return (
		typeof value === "string" && SUPPORTED_SERVICE_TYPES.includes(value as SupportedServiceType)
	);
}

function statusShape(value: unknown): value is UnknownRecord {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) => key === "instanceId" || Object.keys(SOURCE_STATUS_SELECT).includes(key),
		) &&
		Object.keys(SOURCE_STATUS_SELECT).every((key) => Object.hasOwn(value, key))
	);
}

function sourceCore(value: unknown): value is SourceCore {
	return (
		isRecord(value) &&
		safeIdentifier(value.id) &&
		safeDisplay(value.label) &&
		serviceType(value.service) &&
		safeInteger(value.connectionGeneration) &&
		(value.historySourceStatus === null || statusShape(value.historySourceStatus))
	);
}

function numericStatusField(status: UnknownRecord | null, key: string): number | null {
	if (!status || !statusShape(status) || !safeInteger(status[key])) return null;
	return status[key];
}

function statusForProjection(status: UnknownRecord | null): UnknownRecord | null {
	return statusShape(status) ? status : null;
}

function observationCore(value: unknown): value is ValidObservation {
	return (
		isRecord(value) &&
		safeIdentifier(value.id) &&
		safeIdentifier(value.instanceId) &&
		safeInteger(value.connectionGeneration) &&
		safeInteger(value.providerEventId) &&
		validDate(value.eventAt) &&
		safeEventType(value.eventTypeKey) &&
		safeSearch(value.searchText) &&
		typeof value.normalizedPayload === "string" &&
		validDate(value.firstObservedAt) &&
		validDate(value.lastObservedAt)
	);
}

function sourceState(sources: readonly ValidSource[]): string | null {
	const states: HistorySourceState[] = sources.map((source) => ({
		instanceId: source.id,
		service: source.service,
		connectionGeneration: source.connectionGeneration,
		publicationRevision: source.publicationRevision,
		retentionEpoch: source.retentionEpoch,
		rowAuthority: source.rowAuthority,
	}));
	return historySourceStateDigest(states);
}

function sourceWhere(ownerId: string): UnknownRecord {
	return {
		userId: ownerId,
		enabled: true,
		service: { in: SUPPORTED_SERVICE_TYPES },
	};
}

function tupleWhere(sources: readonly ValidSource[]): UnknownRecord {
	return {
		OR: sources.map((source) => ({
			instanceId: source.id,
			connectionGeneration: source.connectionGeneration,
		})),
	};
}

function filterWhere(filter: HistoryReadFilter): UnknownRecord[] {
	const predicates: UnknownRecord[] = [];
	if (filter.startDate) predicates.push({ eventAt: { gte: new Date(filter.startDate) } });
	if (filter.endDate) predicates.push({ eventAt: { lte: new Date(filter.endDate) } });
	if (filter.search) predicates.push({ searchText: { contains: filter.search } });
	if (filter.service) predicates.push({ instance: { service: filter.service.toUpperCase() } });
	if (filter.instanceId) predicates.push({ instanceId: filter.instanceId });
	if (filter.eventType) predicates.push({ eventTypeKey: filter.eventType });
	if (filter.hideProwlarrRss) {
		predicates.push({
			NOT: {
				instance: { service: "PROWLARR" },
				eventTypeKey: { contains: "rss" },
			},
		});
	}
	return predicates;
}

function observationWhere(
	ownerId: string,
	sources: readonly ValidSource[],
	filter: HistoryReadFilter,
	snapshotAt: Date,
	anchor: { eventAt: Date; id: string } | null,
): UnknownRecord {
	const filters = filterWhere(filter);
	const predicates: UnknownRecord[] = [
		{ instance: { userId: ownerId } },
		{ firstObservedAt: { lte: snapshotAt } },
		tupleWhere(sources),
		...filters,
	];
	if (anchor) {
		predicates.push({
			OR: [{ eventAt: { lt: anchor.eventAt } }, { eventAt: anchor.eventAt, id: { lt: anchor.id } }],
		});
	}
	const direct: UnknownRecord = { instance: { userId: ownerId } };
	for (const predicate of filters) {
		for (const [key, value] of Object.entries(predicate)) {
			if (key === "instance" && isRecord(value) && isRecord(direct.instance)) {
				direct.instance = { ...direct.instance, ...value };
			} else if (isRecord(value) && isRecord(direct[key])) {
				direct[key] = { ...direct[key], ...value };
			} else direct[key] = value;
		}
	}
	return { AND: predicates, ...direct };
}

function anchorWhere(
	ownerId: string,
	sources: readonly ValidSource[],
	filter: HistoryReadFilter,
	snapshotAt: Date,
	anchor: { eventAt: Date; id: string },
): UnknownRecord {
	return {
		...observationWhere(ownerId, sources, filter, snapshotAt, null),
		id: anchor.id,
		eventAt: anchor.eventAt,
	};
}

function sourceProjection(source: ValidSource) {
	const retained =
		source.rowAuthority === "positive"
			? numericStatusField(source.status, "retainedObservationCount")
			: 0;
	if (retained === null) return null;
	return {
		instanceId: source.id,
		instanceName: source.label,
		service: source.service,
		providerStatus: source.projection,
		retainedObservationCount: retained,
	};
}

function projectItem(row: ValidObservation, source: ValidSource): UnknownRecord | null {
	const decoded = decodeHistoryNormalizedPayload(row.normalizedPayload);
	if (!decoded.ok) return null;
	const payload = decoded.payload;
	if (
		payload.service !== source.service ||
		payload.providerEventId !== row.providerEventId ||
		payload.eventAt !== row.eventAt.toISOString() ||
		payload.eventType !== row.eventTypeKey
	)
		return null;
	const { version: _version, ...safePayload } = payload;
	return { ...safePayload, id: row.id, instanceId: row.instanceId, instanceName: source.label };
}

function sourceStatusProjection(source: UnknownRecord, now: Date): ValidSource | null {
	if (!sourceCore(source)) return null;
	const type = source.service;
	const service = SERVICE_BY_TYPE[type];
	const status = statusForProjection(source.historySourceStatus);
	const currentStatus =
		status && status.connectionGeneration === source.connectionGeneration ? status : null;
	const statusNumbersValid =
		currentStatus === null ||
		["retainedObservationCount", "publicationRevision", "retentionEpoch"].every(
			(key) => numericStatusField(currentStatus, key) !== null,
		);
	const projection = projectHistorySourceStatus({
		service,
		connectionGeneration: source.connectionGeneration,
		status: statusNumbersValid ? (currentStatus as never) : null,
		now,
	});
	const authority = deriveHistoryRowAuthority(projection);
	const publicationRevision =
		statusNumbersValid && currentStatus
			? numericStatusField(currentStatus, "publicationRevision")
			: null;
	const retentionEpoch =
		statusNumbersValid && currentStatus
			? numericStatusField(currentStatus, "retentionEpoch")
			: null;
	return {
		id: source.id,
		label: source.label,
		serviceType: type,
		service,
		connectionGeneration: source.connectionGeneration,
		status: currentStatus,
		projection,
		publicationRevision,
		retentionEpoch,
		rowAuthority: authority,
	};
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
	return (
		Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
	);
}

function validateRepositoryResult(value: unknown): HistoryReadRepositoryResult {
	if (!isRecord(value) || typeof value.kind !== "string") return { kind: "unavailable" };
	if (value.kind === "ok") {
		if (!exactKeys(value, ["kind", "response"])) return { kind: "unavailable" };
		return historyResponseV2Schema.safeParse(value.response).success
			? (value as HistoryReadRepositoryResult)
			: { kind: "unavailable" };
	}
	if (
		(value.kind === "cursor-invalid" ||
			value.kind === "cursor-stale" ||
			value.kind === "unavailable") &&
		exactKeys(value, ["kind"])
	)
		return value as HistoryReadRepositoryResult;
	return { kind: "unavailable" };
}

async function readInTransaction(
	tx: ReadTransaction,
	input: HistoryReadRepositoryInput,
): Promise<HistoryReadRepositoryResult> {
	const timestampSql =
		input.dialect === "postgresql" || input.dialect === "sqlite"
			? "SELECT CURRENT_TIMESTAMP AS now"
			: null;
	if (!timestampSql) return { kind: "unavailable" };
	const now = timestampRow(await tx.$queryRawUnsafe(timestampSql));
	if (!now) return { kind: "unavailable" };
	const rawSources = await tx.serviceInstance.findMany({
		where: sourceWhere(input.ownerId),
		orderBy: { id: "asc" },
		take: HISTORY_SOURCE_MAX_COUNT + 1,
		select: SOURCE_SELECT,
	});
	if (!Array.isArray(rawSources) || rawSources.length > HISTORY_SOURCE_MAX_COUNT)
		return { kind: "unavailable" };
	const sources: ValidSource[] = [];
	for (const raw of rawSources) {
		const projected = sourceStatusProjection(raw, now);
		if (!projected) return { kind: "unavailable" };
		sources.push(projected);
	}
	const digest = sourceState(sources);
	if (!digest) return { kind: "unavailable" };

	let snapshotAt = now;
	let issuedAt = now;
	let expiresAt = new Date(now.getTime() + 1_800_000);
	let anchor: { eventAt: Date; id: string } | null = null;
	if (input.query.cursor !== null) {
		const decoded = decodeHistoryCursor(input.encryptor, input.query.cursor, {
			now,
			expectedOwnerId: input.ownerId,
			expectedFilterDigest: historyFilterDigest(input.query.filter),
			expectedLimit: input.query.limit,
			expectedSourceStateDigest: digest,
		});
		if (decoded.kind === "invalid") return { kind: "cursor-invalid" };
		if (decoded.kind === "stale") return { kind: "cursor-stale" };
		issuedAt = new Date(decoded.cursor.issuedAt);
		snapshotAt = new Date(decoded.cursor.snapshotAt);
		expiresAt = new Date(decoded.cursor.expiresAt);
		anchor = decoded.cursor.anchor
			? { eventAt: new Date(decoded.cursor.anchor.eventAt), id: decoded.cursor.anchor.id }
			: null;
		if (!anchor) return { kind: "cursor-invalid" };
	}

	const authorizedSources = sources.filter((source) => source.rowAuthority === "positive");
	const catalog = sources.map(sourceProjection);
	if (catalog.some((source) => source === null)) return { kind: "unavailable" };
	if (authorizedSources.length === 0) {
		const response: HistoryResponseV2 = {
			version: 2,
			items: [],
			sources: catalog as HistoryResponseV2["sources"],
			pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
		};
		const validation = historyResponseV2Schema.safeParse(response);
		return validation.success ? { kind: "ok", response } : { kind: "unavailable" };
	}

	if (anchor) {
		const anchorRow = await tx.historyObservation.findFirst({
			where: anchorWhere(input.ownerId, authorizedSources, input.query.filter, snapshotAt, anchor),
			select: OBSERVATION_SELECT,
		});
		if (anchorRow === null || anchorRow === undefined) return { kind: "cursor-invalid" };
	}
	const where = observationWhere(
		input.ownerId,
		authorizedSources,
		input.query.filter,
		snapshotAt,
		anchor,
	);
	const [rawRows, rawCount] = await Promise.all([
		tx.historyObservation.findMany({
			where,
			orderBy: [{ eventAt: "desc" }, { id: "desc" }],
			take: input.query.limit + 1,
			select: OBSERVATION_SELECT,
		}),
		tx.historyObservation.count({
			where: observationWhere(
				input.ownerId,
				authorizedSources,
				input.query.filter,
				snapshotAt,
				null,
			),
		}),
	]);
	if (!Array.isArray(rawRows) || !safeInteger(rawCount)) return { kind: "unavailable" };
	if (rawRows.length > input.query.limit + 1) return { kind: "unavailable" };
	const validatedItems: UnknownRecord[] = [];
	for (const rawRow of rawRows) {
		if (!observationCore(rawRow) || rawRow.firstObservedAt.getTime() > snapshotAt.getTime())
			return { kind: "unavailable" };
		const source = authorizedSources.find(
			(candidate) =>
				candidate.id === rawRow.instanceId &&
				candidate.connectionGeneration === rawRow.connectionGeneration,
		);
		if (!source) return { kind: "unavailable" };
		const item = projectItem(rawRow, source);
		if (!item) return { kind: "unavailable" };
		validatedItems.push(item);
	}
	const hasNextPage = validatedItems.length > input.query.limit;
	const pageRows = rawRows.slice(0, input.query.limit);
	const items = validatedItems.slice(0, input.query.limit);

	let nextCursor: string | null = null;
	if (hasNextPage) {
		const last = pageRows.at(-1);
		if (!last || !observationCore(last)) return { kind: "unavailable" };
		const advanced = advanceHistoryCursor(
			{
				version: 1,
				ownerId: input.ownerId,
				issuedAt: issuedAt.toISOString(),
				expiresAt: expiresAt.toISOString(),
				snapshotAt: snapshotAt.toISOString(),
				filterDigest: historyFilterDigest(input.query.filter),
				limit: input.query.limit,
				anchor: null,
				sourceStateDigest: digest,
			},
			{ eventAt: last.eventAt.toISOString(), id: last.id },
		);
		if (!advanced) return { kind: "unavailable" };
		nextCursor = encodeHistoryCursor(input.encryptor, advanced);
		if (!nextCursor) return { kind: "unavailable" };
	}
	const response: HistoryResponseV2 = {
		version: 2,
		items: items as HistoryResponseV2["items"],
		sources: catalog as HistoryResponseV2["sources"],
		pageInfo: { nextCursor, hasNextPage, matchingObservedCount: rawCount },
	};
	const validation = historyResponseV2Schema.safeParse(response);
	return validation.success ? { kind: "ok", response } : { kind: "unavailable" };
}

export async function readHistoryRepository(
	input: HistoryReadRepositoryInput,
): Promise<HistoryReadRepositoryResult> {
	try {
		if (!isRecord(input) || !safeIdentifier(input.ownerId) || !isRecord(input.query))
			return { kind: "unavailable" };
		const prisma = input.prisma as ReadPrisma;
		const result = await prisma.$transaction((tx) => readInTransaction(tx, input), {
			isolationLevel: "Serializable",
			timeout: TRANSACTION_TIMEOUT_MS,
		});
		return validateRepositoryResult(result);
	} catch {
		return { kind: "unavailable" };
	}
}
