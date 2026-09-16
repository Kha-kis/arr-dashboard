import type { HistoryService, ProviderCoverageReceiptV1 } from "@arr/shared";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import {
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_OBSERVATION_METADATA_MAX_BYTES,
	HISTORY_OBSERVATION_RECEIPT_SCOPE,
	historyServiceToCoverageProvider,
} from "./history-source-contract.js";

export interface HistoryObservationPublicationMetadataV1 {
	version: 1;
	service: HistoryService;
	connectionGeneration: number;
	publicationLevel: "positive-only";
	completeness: "partial";
	observedAt: string;
	publishedObservationCount: number;
	coverageReceipt: ProviderCoverageReceiptV1;
}

type MetadataDecodeResult =
	| { ok: true; metadata: HistoryObservationPublicationMetadataV1 }
	| { ok: false };

const INVALID_METADATA_ERROR = "Invalid History observation metadata";
const METADATA_KEYS = [
	"version",
	"service",
	"connectionGeneration",
	"publicationLevel",
	"completeness",
	"observedAt",
	"publishedObservationCount",
	"coverageReceipt",
] as const;
const HISTORY_SERVICES: readonly HistoryService[] = [
	"sonarr",
	"radarr",
	"prowlarr",
	"lidarr",
	"readarr",
];

function hasExactKeys(value: Record<string, unknown>): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...METADATA_KEYS].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	if (new TextEncoder().encode(raw).byteLength > HISTORY_OBSERVATION_METADATA_MAX_BYTES) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isSafeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHistoryService(value: unknown): value is HistoryService {
	return typeof value === "string" && HISTORY_SERVICES.includes(value as HistoryService);
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function timestampMs(value: string): number {
	return Date.parse(value);
}

function validNowMs(value: unknown): number | null {
	if (value === undefined) return Date.now();
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isFinite(time) ? time : null;
	}
	if (typeof value === "string") {
		const time = Date.parse(value);
		return Number.isFinite(time) ? time : null;
	}
	return null;
}

function decodeReceipt(
	value: unknown,
	service: HistoryService,
	publishedObservationCount: number,
	observedAt: string,
): ProviderCoverageReceiptV1 | null {
	const evaluation = evaluateProviderCoverageReceipt(value);
	if (
		!evaluation.valid ||
		evaluation.provider !== historyServiceToCoverageProvider(service) ||
		evaluation.evidence !== "positive-only" ||
		evaluation.publishedCanonicalEntities !== publishedObservationCount
	) {
		return null;
	}

	const receipt = value as ProviderCoverageReceiptV1;
	if (
		receipt.units.length !== 1 ||
		receipt.observedAt !== observedAt ||
		!canonicalTimestamp(receipt.attemptStartedAt) ||
		!canonicalTimestamp(receipt.observedAt) ||
		timestampMs(receipt.attemptStartedAt) > timestampMs(observedAt)
	) {
		return null;
	}

	const [unit] = receipt.units;
	if (
		!unit ||
		unit.scopeKey !== HISTORY_OBSERVATION_RECEIPT_SCOPE ||
		unit.expectedRawCount !== null
	) {
		return null;
	}
	if (
		unit.pagesAttempted > HISTORY_COLLECTION_MAX_REQUESTS ||
		unit.pagesCompleted > HISTORY_COLLECTION_MAX_REQUESTS ||
		unit.pagesCompleted > unit.pagesAttempted ||
		unit.fatalCount > HISTORY_COLLECTION_MAX_REQUESTS ||
		unit.rawObserved > HISTORY_COLLECTION_MAX_RAW_ROWS ||
		unit.sourceBindings > HISTORY_COLLECTION_MAX_RAW_ROWS ||
		unit.canonicalEntities > HISTORY_COLLECTION_MAX_RAW_ROWS ||
		unit.canonicalEntities > unit.sourceBindings
	) {
		return null;
	}

	let acceptedSkipCount = 0;
	for (const acceptedSkip of unit.acceptedSkips) {
		if (acceptedSkip.count > HISTORY_COLLECTION_MAX_RAW_ROWS) return null;
		acceptedSkipCount += acceptedSkip.count;
	}
	if (acceptedSkipCount > HISTORY_COLLECTION_MAX_RAW_ROWS) return null;
	if (unit.sourceBindings + acceptedSkipCount !== unit.rawObserved) return null;

	return receipt;
}

export function decodeHistoryObservationMetadata(
	raw: unknown,
	now?: unknown,
): MetadataDecodeResult {
	const value = parseObject(raw);
	const nowMs = validNowMs(now);
	if (!value || nowMs === null || !hasExactKeys(value)) return { ok: false };
	if (
		value.version !== 1 ||
		!isHistoryService(value.service) ||
		value.publicationLevel !== "positive-only" ||
		value.completeness !== "partial" ||
		!isSafeNonnegativeInteger(value.connectionGeneration) ||
		!canonicalTimestamp(value.observedAt) ||
		!isSafeNonnegativeInteger(value.publishedObservationCount) ||
		value.publishedObservationCount > HISTORY_COLLECTION_MAX_RAW_ROWS ||
		Date.parse(value.observedAt) > nowMs
	) {
		return { ok: false };
	}

	const coverageReceipt = decodeReceipt(
		value.coverageReceipt,
		value.service,
		value.publishedObservationCount,
		value.observedAt,
	);
	if (!coverageReceipt) return { ok: false };

	return {
		ok: true,
		metadata: {
			version: 1,
			service: value.service,
			connectionGeneration: value.connectionGeneration,
			publicationLevel: "positive-only",
			completeness: "partial",
			observedAt: value.observedAt,
			publishedObservationCount: value.publishedObservationCount,
			coverageReceipt,
		},
	};
}

export function encodeHistoryObservationMetadata(metadata: unknown, now?: unknown): string {
	try {
		const encoded = JSON.stringify(metadata);
		if (typeof encoded !== "string" || !decodeHistoryObservationMetadata(encoded, now).ok) {
			throw new Error(INVALID_METADATA_ERROR);
		}
		return encoded;
	} catch {
		throw new Error(INVALID_METADATA_ERROR);
	}
}
