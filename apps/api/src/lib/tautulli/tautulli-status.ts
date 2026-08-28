import { isCanonicalTautulliNonNegativeSafeInteger } from "./tautulli-canonical-numbers.js";
import {
	decodeTautulliGenerationMetadata,
	sanitizeTautulliReason,
	type TautulliReasonCode,
} from "./tautulli-generation-metadata.js";

type Status = {
	lastResult: string;
	lastRefreshedAt: Date;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptErrorMessage: string | null;
	lastErrorMessage: string | null;
	generationId: string | null;
	generationMetadata: string | null;
	itemCount: number;
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

function attemptResult(
	value: string | null,
): "success" | "partial" | "error" | "in_progress" | "unknown" {
	if (value === "success" || value === "partial" || value === "error") return value;
	if (typeof value === "string" && /^in_progress:[^:]+$/.test(value)) return "in_progress";
	return "unknown";
}

export function projectTautulliCacheStatus(
	status: Status | null,
	physicalCount: number,
	physicalIntegrityVerified = true,
) {
	const physicalCountValid = isCanonicalTautulliNonNegativeSafeInteger(physicalCount);
	const exposedPhysicalCount = physicalCountValid ? physicalCount : 0;
	if (!status) {
		return {
			cachedItems: exposedPhysicalCount,
			hasCacheData: physicalCountValid && physicalCount > 0,
			publicationState: "unavailable" as const,
			reasonCode: physicalCountValid ? "publication_missing" : "publication_integrity_mismatch",
			attempt: null,
		};
	}
	const result = attemptResult(status.lastAttemptResult);
	const attemptReason =
		status.lastAttemptErrorMessage === null
			? null
			: sanitizeTautulliReason(status.lastAttemptErrorMessage);
	let publicationState: "current" | "last-known" | "unavailable" = "unavailable";
	let reasonCode: string | null = null;
	const numericIntegrityVerified =
		physicalCountValid &&
		isCanonicalTautulliNonNegativeSafeInteger(status.itemCount) &&
		isCanonicalTautulliNonNegativeSafeInteger(status.connectionGeneration) &&
		isCanonicalTautulliNonNegativeSafeInteger(status.identityGeneration);
	if (!numericIntegrityVerified || (result === "partial" && !physicalIntegrityVerified)) {
		publicationState = "unavailable";
		reasonCode = "publication_integrity_mismatch";
	} else if (result === "error" || result === "partial" || result === "in_progress") {
		publicationState = physicalCount > 0 ? "last-known" : "unavailable";
		reasonCode = attemptReason;
	} else if (result === "success") {
		const decoded = decodeTautulliGenerationMetadata(status.generationMetadata);
		if (
			physicalIntegrityVerified &&
			decoded.ok &&
			status.generationId === decoded.metadata.generationId &&
			status.itemCount === physicalCount &&
			status.connectionGeneration === decoded.metadata.connectionGeneration &&
			status.identityGeneration === decoded.metadata.identityGeneration
		) {
			publicationState =
				decoded.metadata.publicationLevel === "authoritative" ? "current" : "last-known";
		} else {
			reasonCode = "publication_integrity_mismatch";
		}
	} else {
		reasonCode = "attempt_state_unknown";
	}
	return {
		cachedItems: exposedPhysicalCount,
		hasCacheData: physicalCountValid && physicalCount > 0,
		publicationState,
		reasonCode,
		attempt: {
			at: status.lastAttemptAt?.toISOString() ?? null,
			result,
			reasonCode: attemptReason as TautulliReasonCode | null,
		},
	};
}
