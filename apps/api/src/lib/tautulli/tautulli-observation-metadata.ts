import type { ProviderCoverageReceipt } from "@arr/shared";
import {
	evaluateProviderCoverageReceipt,
	evaluateProviderDomainCoverageMap,
} from "../provider-observation/coverage-receipt.js";

export interface TautulliObservationMetadataV1 {
	version: 1;
	publicationLevel: "positive-only";
	completeness: "partial";
	itemCount: number;
	windowStartedAt: string;
	windowEndedAt: string;
	coverageReceipt: ProviderCoverageReceipt;
}

type MetadataDecodeResult<T> = { ok: true; metadata: T } | { ok: false };

const INVALID_METADATA_ERROR = "Invalid Tautulli observation metadata";
const MAX_OBSERVATION_WINDOW_MS = 15 * 60 * 1000;

const METADATA_KEYS = [
	"version",
	"publicationLevel",
	"completeness",
	"itemCount",
	"windowStartedAt",
	"windowEndedAt",
	"coverageReceipt",
] as const;

function hasExactKeys(value: Record<string, unknown>): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...METADATA_KEYS].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
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

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function decodeReceipt(
	value: unknown,
	itemCount: number,
	windowEndedAt: string,
): ProviderCoverageReceipt | null {
	const evaluation = evaluateProviderCoverageReceipt(value);
	if (
		!evaluation.valid ||
		evaluation.provider !== "tautulli" ||
		evaluation.evidence !== "positive-only" ||
		evaluation.publishedCanonicalEntities !== itemCount
	) {
		return null;
	}

	const receipt = value as ProviderCoverageReceipt;
	if (receipt.units.length === 0) return null;
	if (!isCanonicalTimestamp(receipt.attemptStartedAt)) return null;
	if (Date.parse(receipt.attemptStartedAt) > Date.parse(windowEndedAt)) return null;
	if (receipt.observedAt !== windowEndedAt) return null;
	if (receipt.publishedCanonicalEntities === undefined) return null;
	if (receipt.version === 2) {
		if (
			receipt.domains.length !== 1 ||
			receipt.domains[0]?.domain !== "watch-count" ||
			receipt.domains[0]?.evidence !== "positive-only" ||
			receipt.domains[0]?.valueSemantics !== "lower-bound"
		) {
			return null;
		}
		const domains = evaluateProviderDomainCoverageMap(receipt);
		const watchCount = domains.get("watch-count");
		if (
			watchCount?.availability !== "current" ||
			watchCount.evidence !== "positive-only" ||
			watchCount.valueSemantics !== "lower-bound"
		) {
			return null;
		}
	}

	let canonicalEntities = 0;
	for (const unit of receipt.units) {
		if (unit.pagesAttempted !== unit.pagesCompleted || unit.fatalCount !== 0) return null;
		const acceptedSkips = unit.acceptedSkips.reduce(
			(total, acceptedSkip) => total + acceptedSkip.count,
			0,
		);
		if (unit.sourceBindings + acceptedSkips !== unit.rawObserved) {
			return null;
		}
		if (unit.canonicalEntities > unit.sourceBindings) return null;
		canonicalEntities += unit.canonicalEntities;
	}
	if (receipt.publishedCanonicalEntities > canonicalEntities) return null;

	return receipt;
}

export function decodeTautulliObservationMetadata(
	raw: unknown,
): MetadataDecodeResult<TautulliObservationMetadataV1> {
	const value = parseObject(raw);
	if (!value || !hasExactKeys(value)) return { ok: false };
	if (
		value.version !== 1 ||
		value.publicationLevel !== "positive-only" ||
		value.completeness !== "partial" ||
		!isSafeNonnegativeInteger(value.itemCount) ||
		!isCanonicalTimestamp(value.windowStartedAt) ||
		!isCanonicalTimestamp(value.windowEndedAt)
	) {
		return { ok: false };
	}

	const windowDuration = Date.parse(value.windowEndedAt) - Date.parse(value.windowStartedAt);
	if (windowDuration < 0 || windowDuration > MAX_OBSERVATION_WINDOW_MS) return { ok: false };

	const coverageReceipt = decodeReceipt(
		value.coverageReceipt,
		value.itemCount,
		value.windowEndedAt,
	);
	if (!coverageReceipt) return { ok: false };

	return {
		ok: true,
		metadata: { ...value, coverageReceipt } as TautulliObservationMetadataV1,
	};
}

export function encodeTautulliObservationMetadata(metadata: unknown): string {
	try {
		const encoded = JSON.stringify(metadata);
		if (!encoded || !decodeTautulliObservationMetadata(encoded).ok) {
			throw new Error(INVALID_METADATA_ERROR);
		}
		return encoded;
	} catch {
		throw new Error(INVALID_METADATA_ERROR);
	}
}
