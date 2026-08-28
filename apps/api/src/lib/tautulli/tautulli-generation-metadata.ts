import { isCanonicalTautulliNonNegativeSafeInteger } from "./tautulli-canonical-numbers.js";
import type { TautulliGenerationRoot } from "./tautulli-generation-observations.js";

export const TAUTULLI_GENERATION_METADATA_VERSION = 1 as const;

export const TAUTULLI_REASON_CODES = [
	"catalog_unavailable",
	"catalog_changed",
	"catalog_total_mismatch",
	"catalog_duplicate_target",
	"metadata_unavailable",
	"metadata_identity_mismatch",
	"metadata_tmdb_unmapped",
	"observation_count_unavailable",
	"credential_unavailable",
	"history_changed",
	"history_partial",
	"publication_superseded",
	"provider_identity_changed",
	"unknown_failure",
	"legacy_error_redacted",
] as const;

export type TautulliReasonCode = (typeof TAUTULLI_REASON_CODES)[number];
export type TautulliCapability = "exact-target-observations" | "positive-watch-count";

export type TautulliGenerationMetadata = {
	version: typeof TAUTULLI_GENERATION_METADATA_VERSION;
	provider: "tautulli";
	generationId: string;
	publicationLevel: "authoritative" | "positive-only";
	completeness: {
		targetCatalog: TautulliGenerationRoot;
		observations: TautulliGenerationRoot;
		aggregate: TautulliGenerationRoot;
	};
	connectionGeneration: number;
	identityGeneration: number;
	capabilities: TautulliCapability[];
	partialReasons: Array<{ code: TautulliReasonCode; count: number }>;
};

const reasonCodes = new Set<string>(TAUTULLI_REASON_CODES);
const capabilities = new Set<TautulliCapability>([
	"exact-target-observations",
	"positive-watch-count",
]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function nonnegative(value: unknown): value is number {
	return isCanonicalTautulliNonNegativeSafeInteger(value);
}

function root(value: unknown): value is TautulliGenerationRoot {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		exactKeys(value as Record<string, unknown>, ["version", "count", "digest"]) &&
		(value as TautulliGenerationRoot).version === 1 &&
		nonnegative((value as TautulliGenerationRoot).count) &&
		/^[a-f0-9]{64}$/.test((value as TautulliGenerationRoot).digest)
	);
}

function normalize(value: unknown): TautulliGenerationMetadata | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!exactKeys(record, [
			"version",
			"provider",
			"generationId",
			"publicationLevel",
			"completeness",
			"connectionGeneration",
			"identityGeneration",
			"capabilities",
			"partialReasons",
		]) ||
		record.version !== 1 ||
		record.provider !== "tautulli" ||
		!nonempty(record.generationId) ||
		(record.publicationLevel !== "authoritative" && record.publicationLevel !== "positive-only") ||
		!nonnegative(record.connectionGeneration) ||
		!nonnegative(record.identityGeneration)
	)
		return null;
	if (
		typeof record.completeness !== "object" ||
		record.completeness === null ||
		Array.isArray(record.completeness)
	)
		return null;
	const completeness = record.completeness as Record<string, unknown>;
	if (
		!exactKeys(completeness, ["targetCatalog", "observations", "aggregate"]) ||
		!root(completeness.targetCatalog) ||
		!root(completeness.observations) ||
		!root(completeness.aggregate)
	)
		return null;
	if (
		!Array.isArray(record.capabilities) ||
		record.capabilities.length < 1 ||
		record.capabilities.length > 2
	)
		return null;
	const normalizedCapabilities: TautulliCapability[] = [];
	let previousCapability = "";
	for (const capability of record.capabilities) {
		if (
			typeof capability !== "string" ||
			!capabilities.has(capability as TautulliCapability) ||
			capability <= previousCapability
		)
			return null;
		previousCapability = capability;
		normalizedCapabilities.push(capability as TautulliCapability);
	}
	if (
		!Array.isArray(record.partialReasons) ||
		record.partialReasons.length > TAUTULLI_REASON_CODES.length
	)
		return null;
	const partialReasons: Array<{ code: TautulliReasonCode; count: number }> = [];
	let previousReason = "";
	for (const reason of record.partialReasons) {
		if (
			typeof reason !== "object" ||
			reason === null ||
			Array.isArray(reason) ||
			!exactKeys(reason as Record<string, unknown>, ["code", "count"])
		)
			return null;
		const entry = reason as Record<string, unknown>;
		if (
			typeof entry.code !== "string" ||
			!reasonCodes.has(entry.code) ||
			entry.code <= previousReason ||
			!isCanonicalTautulliNonNegativeSafeInteger(entry.count) ||
			entry.count < 1
		)
			return null;
		previousReason = entry.code;
		partialReasons.push({ code: entry.code as TautulliReasonCode, count: entry.count as number });
	}
	if (record.publicationLevel === "authoritative") {
		if (
			partialReasons.length !== 0 ||
			normalizedCapabilities.length !== 1 ||
			normalizedCapabilities[0] !== "exact-target-observations"
		)
			return null;
	} else if (
		partialReasons.length === 0 ||
		normalizedCapabilities.includes("exact-target-observations")
	)
		return null;
	return {
		version: 1,
		provider: "tautulli",
		generationId: record.generationId,
		publicationLevel: record.publicationLevel,
		completeness: {
			targetCatalog: completeness.targetCatalog,
			observations: completeness.observations,
			aggregate: completeness.aggregate,
		},
		connectionGeneration: record.connectionGeneration,
		identityGeneration: record.identityGeneration,
		capabilities: normalizedCapabilities,
		partialReasons,
	};
}

export function encodeTautulliGenerationMetadata(metadata: TautulliGenerationMetadata): string {
	const normalized = normalize(metadata);
	if (!normalized) throw new Error("Invalid Tautulli generation metadata");
	return JSON.stringify(normalized);
}

export function decodeTautulliGenerationMetadata(
	raw: string | null | undefined,
):
	| { ok: true; metadata: TautulliGenerationMetadata }
	| { ok: false; reasonCode: "metadata_invalid" } {
	if (!raw) return { ok: false, reasonCode: "metadata_invalid" };
	try {
		const metadata = normalize(JSON.parse(raw));
		return metadata ? { ok: true, metadata } : { ok: false, reasonCode: "metadata_invalid" };
	} catch {
		return { ok: false, reasonCode: "metadata_invalid" };
	}
}

type Status = {
	lastResult: string;
	lastRefreshedAt: Date;
	lastAttemptAt?: Date | null;
	lastAttemptResult?: string | null;
	lastAttemptErrorMessage?: string | null;
	generationId?: string | null;
	generationMetadata?: string | null;
	itemCount: number;
	connectionGeneration?: number | null;
	identityGeneration?: number | null;
};

export function evaluateTautulliExactPublication(
	status: Status,
	authority: { connectionGeneration: number; identityGeneration: number },
):
	| { available: true; metadata: TautulliGenerationMetadata }
	| { available: false; reasonCode: string } {
	if (status.lastAttemptResult === "error")
		return { available: false, reasonCode: "latest_attempt_failed" };
	const decoded = decodeTautulliGenerationMetadata(status.generationMetadata);
	if (!decoded.ok) return { available: false, reasonCode: decoded.reasonCode };
	const metadata = decoded.metadata;
	if (
		!isCanonicalTautulliNonNegativeSafeInteger(status.itemCount) ||
		!isCanonicalTautulliNonNegativeSafeInteger(status.connectionGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(status.identityGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(authority.connectionGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(authority.identityGeneration)
	)
		return { available: false, reasonCode: "metadata_invalid" };
	if (
		metadata.publicationLevel !== "authoritative" ||
		!metadata.capabilities.includes("exact-target-observations")
	)
		return { available: false, reasonCode: "publication_not_authoritative" };
	if (status.lastAttemptErrorMessage != null)
		return { available: false, reasonCode: "latest_attempt_failed" };
	if (status.lastAttemptResult !== "success")
		return { available: false, reasonCode: "latest_attempt_not_successful" };
	if (
		status.generationId !== metadata.generationId ||
		status.connectionGeneration !== authority.connectionGeneration ||
		status.identityGeneration !== authority.identityGeneration ||
		metadata.connectionGeneration !== authority.connectionGeneration ||
		metadata.identityGeneration !== authority.identityGeneration ||
		status.itemCount !== metadata.completeness.aggregate.count ||
		!(status.lastAttemptAt instanceof Date) ||
		status.lastAttemptAt.getTime() !== status.lastRefreshedAt.getTime()
	)
		return { available: false, reasonCode: "metadata_invalid" };
	return { available: true, metadata };
}

export function evaluateTautulliPositivePublication(
	status: Status,
	authority: { connectionGeneration: number; identityGeneration: number },
):
	| { available: true; metadata: TautulliGenerationMetadata }
	| { available: false; reasonCode: string } {
	if (status.lastAttemptResult === "error")
		return { available: false, reasonCode: "latest_attempt_failed" };
	const decoded = decodeTautulliGenerationMetadata(status.generationMetadata);
	if (!decoded.ok) return { available: false, reasonCode: decoded.reasonCode };
	const metadata = decoded.metadata;
	if (
		!isCanonicalTautulliNonNegativeSafeInteger(status.itemCount) ||
		!isCanonicalTautulliNonNegativeSafeInteger(status.connectionGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(status.identityGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(authority.connectionGeneration) ||
		!isCanonicalTautulliNonNegativeSafeInteger(authority.identityGeneration)
	)
		return { available: false, reasonCode: "metadata_invalid" };
	if (
		metadata.publicationLevel !== "positive-only" ||
		!metadata.capabilities.includes("positive-watch-count")
	)
		return { available: false, reasonCode: "publication_not_positive" };
	const reason = sanitizeTautulliReason(status.lastAttemptErrorMessage);
	if (
		status.lastResult !== "success" ||
		status.lastAttemptResult !== "partial" ||
		reason === "legacy_error_redacted" ||
		!metadata.partialReasons.some((entry) => entry.code === reason) ||
		status.generationId !== metadata.generationId ||
		status.connectionGeneration !== authority.connectionGeneration ||
		status.identityGeneration !== authority.identityGeneration ||
		metadata.connectionGeneration !== authority.connectionGeneration ||
		metadata.identityGeneration !== authority.identityGeneration ||
		status.itemCount !== metadata.completeness.aggregate.count ||
		!(status.lastAttemptAt instanceof Date) ||
		status.lastAttemptAt.getTime() !== status.lastRefreshedAt.getTime()
	)
		return { available: false, reasonCode: "metadata_invalid" };
	return { available: true, metadata };
}

export function sanitizeTautulliReason(value: unknown): TautulliReasonCode {
	return typeof value === "string" && reasonCodes.has(value)
		? (value as TautulliReasonCode)
		: "legacy_error_redacted";
}

export function describeTautulliReason(value: unknown): string {
	return `Tautulli refresh failed (${sanitizeTautulliReason(value)}).`;
}
