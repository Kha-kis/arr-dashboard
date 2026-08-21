import type { PlexEvidenceSummary } from "@arr/shared";
import { ApiError } from "./api-client/base";

export function isCurrentAuthoritativePlexEvidence(
	evidence: PlexEvidenceSummary | null | undefined,
): boolean {
	return (
		evidence?.publicationLevel === "authoritative" &&
		evidence.completeness === "complete" &&
		evidence.reasonCodes.length === 0 &&
		(evidence.availability === undefined || evidence.availability === "current") &&
		(evidence.authority === undefined || evidence.authority === "authoritative")
	);
}

export function getPlexEvidenceFromError(error: unknown): PlexEvidenceSummary | undefined {
	if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== "object") {
		return undefined;
	}
	const evidence = (error.payload as { evidence?: unknown }).evidence;
	if (!evidence || typeof evidence !== "object") return undefined;
	const summary = evidence as Partial<PlexEvidenceSummary>;
	if (
		(summary.publicationLevel !== "authoritative" &&
			summary.publicationLevel !== "positive-only" &&
			summary.publicationLevel !== "unavailable") ||
		(summary.completeness !== "complete" &&
			summary.completeness !== "partial" &&
			summary.completeness !== "unknown") ||
		!Array.isArray(summary.reasonCodes)
	) {
		return undefined;
	}
	return summary as PlexEvidenceSummary;
}
