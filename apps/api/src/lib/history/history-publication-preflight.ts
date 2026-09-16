import type {
	HistoryNormalizedPayloadV1,
	HistoryService,
	ProviderCoverageReceiptV1,
} from "@arr/shared";
import {
	buildHistorySearchText,
	decodeHistoryNormalizedPayload,
	type NormalizedHistoryObservation,
} from "../dashboard/history-utils.js";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import {
	decodeHistoryObservationMetadata,
	encodeHistoryObservationMetadata,
} from "./history-observation-metadata.js";
import {
	HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS,
	type HistorySourceAttemptFailureReason,
} from "./history-source-attempt.js";
import {
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_COLLECTION_PAGE_SIZE,
	HISTORY_OBSERVATION_RECEIPT_SCOPE,
	historyServiceToCoverageProvider,
} from "./history-source-contract.js";

export const HISTORY_OBSERVATION_RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type HistoryPublicationPreflightInput = {
	service: HistoryService;
	connectionGeneration: number;
	databaseNow: Date;
	attemptStartedAt: Date;
	normalizedRows: readonly NormalizedHistoryObservation[];
	rawObserved: number;
	pagesAttempted: number;
	pagesCompleted: number;
	fatalCount: number;
	outcome: { result: "success" } | { result: "error"; reason: HistorySourceAttemptFailureReason };
};

export type CanonicalHistoryPublicationRow = {
	providerEventId: number;
	eventAt: Date;
	eventTypeKey: string;
	searchText: string;
	normalizedPayload: string;
};

export type CanonicalHistoryObservedIdentity = {
	providerEventId: number;
	eventAt: Date;
};

export type HistoryPublicationPreflightResult =
	| {
			kind: "publish";
			rows: readonly CanonicalHistoryPublicationRow[];
			observedIdentities: readonly CanonicalHistoryObservedIdentity[];
			observedAt: Date;
			publishedObservationCount: number;
			publicationMetadata: string;
			finish:
				| { result: "success"; reason: null }
				| { result: "error"; reason: "provider-unavailable" | "provider-limit" };
	  }
	| { kind: "preserve"; reason: HistorySourceAttemptFailureReason };

type RevalidatedObservation = {
	providerEventId: number;
	eventAt: Date;
	eventTypeKey: string;
	searchText: string;
	normalizedPayload: string;
};

const PRESERVE_RECEIPT_INVALID = { kind: "preserve", reason: "receipt-invalid" } as const;
const PRESERVE_ROWS_INCONSISTENT = { kind: "preserve", reason: "rows-inconsistent" } as const;
const HISTORY_SERVICES: readonly HistoryService[] = [
	"sonarr",
	"radarr",
	"prowlarr",
	"lidarr",
	"readarr",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHistoryService(value: unknown): value is HistoryService {
	return typeof value === "string" && HISTORY_SERVICES.includes(value as HistoryService);
}

function isFailureReason(value: unknown): value is HistorySourceAttemptFailureReason {
	return (
		typeof value === "string" &&
		(HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS as readonly string[]).includes(value)
	);
}

function isFiniteDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function revalidateRow(
	row: unknown,
	service: HistoryService,
	databaseNow: Date,
): RevalidatedObservation | null {
	if (!isRecord(row) || !hasExactKeys(row, ["payload", "normalizedPayload", "searchText"])) {
		return null;
	}
	if (typeof row.normalizedPayload !== "string" || typeof row.searchText !== "string") return null;
	const decoded = decodeHistoryNormalizedPayload(row.normalizedPayload);
	if (!decoded.ok || !isRecord(row.payload)) return null;
	try {
		if (JSON.stringify(row.payload) !== row.normalizedPayload) return null;
	} catch {
		return null;
	}
	const payload: HistoryNormalizedPayloadV1 = decoded.payload;
	if (payload.service !== service || row.searchText !== buildHistorySearchText(payload))
		return null;
	const eventAtMs = Date.parse(payload.eventAt);
	if (!Number.isFinite(eventAtMs) || eventAtMs > databaseNow.getTime()) return null;
	return {
		providerEventId: payload.providerEventId,
		eventAt: new Date(eventAtMs),
		eventTypeKey: payload.eventType,
		searchText: row.searchText,
		normalizedPayload: row.normalizedPayload,
	};
}

function conflicts(left: RevalidatedObservation, right: RevalidatedObservation): boolean {
	return (
		left.eventAt.getTime() !== right.eventAt.getTime() ||
		left.normalizedPayload !== right.normalizedPayload ||
		left.searchText !== right.searchText
	);
}

function createPublicationMetadata(
	service: HistoryService,
	connectionGeneration: number,
	attemptStartedAt: Date,
	databaseNow: Date,
	rows: readonly RevalidatedObservation[],
	rawObserved: number,
	pagesAttempted: number,
	pagesCompleted: number,
	fatalCount: number,
): string | null {
	const lowerBound = databaseNow.getTime() - HISTORY_OBSERVATION_RETENTION_WINDOW_MS;
	const eligible = rows.filter((row) => row.eventAt.getTime() >= lowerBound);
	const oldCount = rows.length - eligible.length;
	const uniqueEligible = new Map<number, RevalidatedObservation>();
	for (const row of eligible) {
		if (!uniqueEligible.has(row.providerEventId)) uniqueEligible.set(row.providerEventId, row);
	}
	const canonicalEntities = uniqueEligible.size;
	const receipt: ProviderCoverageReceiptV1 = {
		version: 1,
		provider: historyServiceToCoverageProvider(service),
		attemptStartedAt: attemptStartedAt.toISOString(),
		observedAt: databaseNow.toISOString(),
		evidence: "positive-only",
		units: [
			{
				scopeKey: HISTORY_OBSERVATION_RECEIPT_SCOPE,
				expectedRawCount: null,
				pagesAttempted,
				pagesCompleted,
				rawObserved,
				sourceBindings: eligible.length,
				canonicalEntities,
				acceptedSkips: oldCount ? [{ reason: "bounded-window-truncation", count: oldCount }] : [],
				fatalCount,
			},
		],
		publishedCanonicalEntities: canonicalEntities,
	};
	const evaluation = evaluateProviderCoverageReceipt(receipt);
	if (
		!evaluation.valid ||
		evaluation.provider !== historyServiceToCoverageProvider(service) ||
		evaluation.evidence !== "positive-only" ||
		evaluation.rawObserved !== rawObserved ||
		evaluation.sourceBindings !== eligible.length ||
		evaluation.canonicalEntities !== canonicalEntities ||
		evaluation.publishedCanonicalEntities !== canonicalEntities ||
		evaluation.acceptedSkipCount !== oldCount
	) {
		return null;
	}
	try {
		const metadata = encodeHistoryObservationMetadata(
			{
				version: 1,
				service,
				connectionGeneration,
				publicationLevel: "positive-only",
				completeness: "partial",
				observedAt: databaseNow.toISOString(),
				publishedObservationCount: canonicalEntities,
				coverageReceipt: receipt,
			},
			databaseNow,
		);
		return decodeHistoryObservationMetadata(metadata, databaseNow).ok ? metadata : null;
	} catch {
		return null;
	}
}

function preflight(input: unknown): HistoryPublicationPreflightResult {
	if (!isRecord(input)) return PRESERVE_RECEIPT_INVALID;
	const {
		service,
		connectionGeneration,
		databaseNow,
		attemptStartedAt,
		normalizedRows,
		rawObserved,
		pagesAttempted,
		pagesCompleted,
		fatalCount,
		outcome,
	} = input;
	if (!isHistoryService(service) || !isSafeCount(connectionGeneration))
		return PRESERVE_RECEIPT_INVALID;
	if (!isFiniteDate(databaseNow) || !isFiniteDate(attemptStartedAt))
		return PRESERVE_RECEIPT_INVALID;
	if (attemptStartedAt.getTime() > databaseNow.getTime()) return PRESERVE_RECEIPT_INVALID;
	if (!Array.isArray(normalizedRows)) return PRESERVE_RECEIPT_INVALID;
	if (
		!isSafeCount(rawObserved) ||
		!isSafeCount(pagesAttempted) ||
		!isSafeCount(pagesCompleted) ||
		!isSafeCount(fatalCount)
	) {
		return PRESERVE_RECEIPT_INVALID;
	}
	if (
		pagesAttempted > HISTORY_COLLECTION_MAX_REQUESTS ||
		pagesCompleted > HISTORY_COLLECTION_MAX_REQUESTS ||
		rawObserved > HISTORY_COLLECTION_MAX_RAW_ROWS ||
		normalizedRows.length > HISTORY_COLLECTION_MAX_RAW_ROWS
	) {
		return { kind: "preserve", reason: "provider-limit" };
	}
	if (
		pagesCompleted > pagesAttempted ||
		fatalCount > 1 ||
		rawObserved > pagesCompleted * HISTORY_COLLECTION_PAGE_SIZE
	) {
		return PRESERVE_RECEIPT_INVALID;
	}
	if (normalizedRows.length !== rawObserved) return PRESERVE_ROWS_INCONSISTENT;
	if (!isRecord(outcome) || (outcome.result !== "success" && outcome.result !== "error")) {
		return PRESERVE_RECEIPT_INVALID;
	}
	let reason: HistorySourceAttemptFailureReason | null = null;
	if (outcome.result === "error") {
		if (!isFailureReason(outcome.reason)) return PRESERVE_RECEIPT_INVALID;
		reason = outcome.reason;
	}

	const revalidated: RevalidatedObservation[] = [];
	const byId = new Map<number, RevalidatedObservation>();
	for (const row of normalizedRows) {
		const canonical = revalidateRow(row, service, databaseNow);
		if (!canonical) return PRESERVE_ROWS_INCONSISTENT;
		const previous = byId.get(canonical.providerEventId);
		if (previous && conflicts(previous, canonical)) return PRESERVE_ROWS_INCONSISTENT;
		if (!previous) byId.set(canonical.providerEventId, canonical);
		revalidated.push(canonical);
	}

	if (outcome.result === "error" && pagesCompleted === 0) {
		if (pagesAttempted === 0 && fatalCount === 0 && reason === "provider-limit") {
			return { kind: "preserve", reason };
		}
		if (pagesAttempted === 1 && fatalCount === 1 && reason !== null) {
			return { kind: "preserve", reason };
		}
		return PRESERVE_RECEIPT_INVALID;
	}
	if (pagesCompleted === 0) return PRESERVE_RECEIPT_INVALID;

	let finish:
		| { result: "success"; reason: null }
		| { result: "error"; reason: "provider-unavailable" | "provider-limit" };
	if (outcome.result === "success") {
		if (pagesAttempted !== pagesCompleted || fatalCount !== 0) return PRESERVE_RECEIPT_INVALID;
		finish = { result: "success", reason: null };
	} else if (
		reason === "rows-inconsistent" ||
		reason === "receipt-invalid" ||
		reason === "unknown-failure"
	) {
		return { kind: "preserve", reason };
	} else if (
		reason === "provider-unavailable" &&
		pagesAttempted === pagesCompleted + 1 &&
		fatalCount === 1
	) {
		finish = { result: "error", reason };
	} else if (
		reason === "provider-limit" &&
		((pagesAttempted === pagesCompleted + 1 && fatalCount === 1) ||
			(pagesAttempted === pagesCompleted && fatalCount === 0))
	) {
		finish = { result: "error", reason };
	} else {
		return PRESERVE_RECEIPT_INVALID;
	}

	const lowerBound = databaseNow.getTime() - HISTORY_OBSERVATION_RETENTION_WINDOW_MS;
	const eligible = new Map<number, RevalidatedObservation>();
	for (const row of revalidated) {
		if (row.eventAt.getTime() >= lowerBound && !eligible.has(row.providerEventId)) {
			eligible.set(row.providerEventId, row);
		}
	}
	const rows = [...eligible.values()]
		.sort((left, right) => left.providerEventId - right.providerEventId)
		.map((row) => ({
			providerEventId: row.providerEventId,
			eventAt: new Date(row.eventAt),
			eventTypeKey: row.eventTypeKey,
			searchText: row.searchText,
			normalizedPayload: row.normalizedPayload,
		}));
	const observedIdentities = [...byId.values()]
		.sort((left, right) => left.providerEventId - right.providerEventId)
		.map((row) => ({ providerEventId: row.providerEventId, eventAt: new Date(row.eventAt) }));
	const publicationMetadata = createPublicationMetadata(
		service,
		connectionGeneration,
		attemptStartedAt,
		databaseNow,
		revalidated,
		rawObserved,
		pagesAttempted,
		pagesCompleted,
		fatalCount,
	);
	if (!publicationMetadata) return PRESERVE_RECEIPT_INVALID;
	return {
		kind: "publish",
		rows,
		observedIdentities,
		observedAt: new Date(databaseNow),
		publishedObservationCount: rows.length,
		publicationMetadata,
		finish,
	};
}

export function buildHistoryPublicationPreflight(
	input: HistoryPublicationPreflightInput,
): HistoryPublicationPreflightResult {
	try {
		return preflight(input);
	} catch {
		return PRESERVE_RECEIPT_INVALID;
	}
}
