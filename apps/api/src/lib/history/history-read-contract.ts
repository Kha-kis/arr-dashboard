import { createHash } from "node:crypto";
import {
	HISTORY_CURSOR_MAX_LENGTH,
	HISTORY_EVENT_TYPE_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_PAGE_MAX_ITEMS,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
	HISTORY_SOURCE_MAX_COUNT,
	type HistoryService,
	historyServiceSchema,
} from "@arr/shared";
import { isValidHistoryPublicationRevision } from "./history-source-attempt.js";

export { HISTORY_CURSOR_MAX_LENGTH, HISTORY_SEARCH_TEXT_MAX_LENGTH } from "@arr/shared";

export type HistoryReadFilter = {
	startDate: string | null;
	endDate: string | null;
	search: string | null;
	service: HistoryService | null;
	instanceId: string | null;
	eventType: string | null;
	hideProwlarrRss: boolean;
};

export type HistoryReadQuery = {
	limit: number;
	cursor: string | null;
	filter: HistoryReadFilter;
};

export type HistorySourceState = {
	instanceId: string;
	service: HistoryService;
	connectionGeneration: number;
	publicationRevision: number | null;
	retentionEpoch: number | null;
	rowAuthority: "positive" | "unavailable";
};

export type HistoryReadQueryResult = { ok: true; query: HistoryReadQuery } | { ok: false };

const QUERY_KEYS = [
	"limit",
	"cursor",
	"startDate",
	"endDate",
	"search",
	"service",
	"instanceId",
	"eventType",
	"hideProwlarrRss",
] as const;
const SOURCE_KEYS = [
	"instanceId",
	"service",
	"connectionGeneration",
	"publicationRevision",
	"retentionEpoch",
	"rowAuthority",
] as const;
const SERVICES: readonly HistoryService[] = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"];
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const URL_LIKE = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/iu;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
	);
}

function isSafeText(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= max &&
		value === value.trim() &&
		![...value].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) &&
		!URL_LIKE.test(value)
	);
}

function isCanonicalDate(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_DATE.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSearch(value: unknown): string | null | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
	if (
		!normalized ||
		normalized.length > HISTORY_SEARCH_TEXT_MAX_LENGTH ||
		URL_LIKE.test(normalized)
	)
		return undefined;
	if (
		[...normalized].some((character) => {
			const code = character.charCodeAt(0);
			return (code < 32 && ![9, 10, 11, 12, 13].includes(code)) || code === 127;
		})
	)
		return undefined;
	return normalized;
}

function optionalString(record: RecordValue, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function parseHistoryReadQuery(input: unknown): HistoryReadQueryResult {
	if (!isRecord(input)) return { ok: false };
	const keys = Object.keys(input);
	if (keys.some((key) => !QUERY_KEYS.includes(key as (typeof QUERY_KEYS)[number])))
		return { ok: false };
	for (const key of keys) if (typeof input[key] !== "string") return { ok: false };

	const rawLimit = optionalString(input, "limit");
	let limit = 50;
	if (rawLimit !== undefined) {
		if (
			typeof rawLimit !== "string" ||
			!/^[1-9]\d*$/.test(rawLimit) ||
			Number(rawLimit) > HISTORY_PAGE_MAX_ITEMS
		)
			return { ok: false };
		limit = Number(rawLimit);
	}
	const rawCursor = optionalString(input, "cursor");
	if (
		rawCursor !== undefined &&
		(typeof rawCursor !== "string" ||
			rawCursor.length === 0 ||
			rawCursor.length > HISTORY_CURSOR_MAX_LENGTH ||
			[...rawCursor].some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			))
	)
		return { ok: false };
	const cursor = rawCursor === undefined ? null : (rawCursor as string);

	const startDate = optionalString(input, "startDate");
	const endDate = optionalString(input, "endDate");
	if (startDate !== undefined && !isCanonicalDate(startDate)) return { ok: false };
	if (endDate !== undefined && !isCanonicalDate(endDate)) return { ok: false };
	if (
		startDate !== undefined &&
		endDate !== undefined &&
		Date.parse(startDate as string) > Date.parse(endDate as string)
	)
		return { ok: false };

	const search = optionalString(input, "search");
	if (
		search !== undefined &&
		(typeof search !== "string" ||
			search.length > HISTORY_SEARCH_TEXT_MAX_LENGTH ||
			[...search].some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			))
	)
		return { ok: false };
	const canonicalSearch = search === undefined ? null : normalizeSearch(search);
	if (canonicalSearch === undefined) return { ok: false };
	const service = optionalString(input, "service");
	if (
		service !== undefined &&
		(!historyServiceSchema.safeParse(service).success || service !== String(service).toLowerCase())
	)
		return { ok: false };
	const instanceId = optionalString(input, "instanceId");
	if (instanceId !== undefined && !isSafeText(instanceId, HISTORY_IDENTIFIER_TEXT_MAX_LENGTH))
		return { ok: false };
	const eventType = optionalString(input, "eventType");
	let canonicalEventType: string | null = null;
	if (eventType !== undefined) {
		if (typeof eventType !== "string") return { ok: false };
		if (eventType.length > HISTORY_EVENT_TYPE_MAX_LENGTH) return { ok: false };
		if (
			[...eventType].some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			)
		)
			return { ok: false };
		canonicalEventType = eventType.trim().toLowerCase();
		if (!isSafeText(canonicalEventType, HISTORY_EVENT_TYPE_MAX_LENGTH)) return { ok: false };
	}
	const hide = optionalString(input, "hideProwlarrRss");
	if (hide !== undefined && hide !== "true" && hide !== "false") return { ok: false };

	const filter: HistoryReadFilter = {
		startDate: startDate === undefined ? null : (startDate as string),
		endDate: endDate === undefined ? null : (endDate as string),
		search: canonicalSearch ?? null,
		service: service === undefined ? null : (service as HistoryService),
		instanceId: instanceId === undefined ? null : (instanceId as string),
		eventType: canonicalEventType,
		hideProwlarrRss: hide === "true",
	};
	return { ok: true, query: { limit, cursor, filter } };
}

export function historyFilterDigest(filter: HistoryReadFilter): string {
	const projection = {
		startDate: filter.startDate,
		endDate: filter.endDate,
		search: filter.search,
		service: filter.service,
		instanceId: filter.instanceId,
		eventType: filter.eventType,
		hideProwlarrRss: filter.hideProwlarrRss,
	};
	return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
}

export function deriveHistoryRowAuthority(status: unknown): "positive" | "unavailable" {
	if (!isRecord(status)) return "unavailable";
	return (status.availability === "partial" || status.availability === "last-known") &&
		status.evidence === "positive-only"
		? "positive"
		: "unavailable";
}

export function historySourceStateDigest(input: unknown): string | null {
	if (!Array.isArray(input) || input.length > HISTORY_SOURCE_MAX_COUNT) return null;
	const states: HistorySourceState[] = [];
	const ids = new Set<string>();
	for (const candidate of input) {
		if (!isRecord(candidate) || !hasExactKeys(candidate, SOURCE_KEYS)) return null;
		if (
			!isSafeText(candidate.instanceId, HISTORY_IDENTIFIER_TEXT_MAX_LENGTH) ||
			ids.has(candidate.instanceId)
		)
			return null;
		if (
			!historyServiceSchema.safeParse(candidate.service).success ||
			!SERVICES.includes(candidate.service as HistoryService)
		)
			return null;
		if (!isSafeInteger(candidate.connectionGeneration)) return null;
		const revisionNull = candidate.publicationRevision === null;
		const epochNull = candidate.retentionEpoch === null;
		if (revisionNull !== epochNull) return null;
		if (!revisionNull && !isValidHistoryPublicationRevision(candidate.publicationRevision))
			return null;
		if (candidate.retentionEpoch !== null && !isSafeInteger(candidate.retentionEpoch)) return null;
		if (candidate.rowAuthority !== "positive" && candidate.rowAuthority !== "unavailable")
			return null;
		if (candidate.rowAuthority === "positive" && revisionNull) return null;
		ids.add(candidate.instanceId);
		states.push({
			instanceId: candidate.instanceId,
			service: candidate.service as HistoryService,
			connectionGeneration: candidate.connectionGeneration,
			publicationRevision: candidate.publicationRevision as number | null,
			retentionEpoch: candidate.retentionEpoch as number | null,
			rowAuthority: candidate.rowAuthority,
		});
	}
	states.sort((left, right) =>
		left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
	);
	return createHash("sha256").update(JSON.stringify(states), "utf8").digest("hex");
}

export const calculateHistoryFilterDigest = historyFilterDigest;
export const calculateHistorySourceStateDigest = historySourceStateDigest;
