import type {
	ProviderDomainObservationStatus,
	ProviderObservationAttemptState,
	ProviderObservationAvailability,
	ProviderObservationDomain,
	ProviderObservationEvidence,
	ProviderObservationReasonCode,
	ProviderObservationStatus,
} from "@arr/shared";
import type {
	ProviderCoverageDomainEvaluation,
	ProviderCoverageEvaluation,
} from "./coverage-receipt";

export type ProviderIdentityState = "current" | "changed" | "unverified";

export type ProviderObservationPublication = {
	observedAt: Date;
	evaluation: ProviderCoverageEvaluation;
};

export type ProviderObservationLatestAttempt = {
	state: Exclude<ProviderObservationAttemptState, "idle">;
	attemptedAt: Date;
};

export type ProviderStatusProjectionInput = {
	identity: ProviderIdentityState;
	publication: ProviderObservationPublication | null;
	latestAttempt: ProviderObservationLatestAttempt | null;
	now: Date;
	maxAgeMs: number;
};

const PROVIDER_OBSERVATION_REASON_CODES = new Set<ProviderObservationReasonCode>([
	"no-publication",
	"identity-unverified",
	"identity-changed",
	"refresh-running",
	"refresh-failed",
	"publication-superseded",
	"receipt-invalid",
	"coverage-incomplete",
	"accepted-skips",
	"provider-limit",
	"provider-unavailable",
	"publication-stale",
	"rows-inconsistent",
	"positive-only",
	"unknown-failure",
]);

const PROVIDER_OBSERVATION_DOMAIN_ORDER: readonly ProviderObservationDomain[] = [
	"library-inventory",
	"mapping",
	"watch-count",
	"watch-attribution",
	"on-deck",
	"episode-inventory",
];

function projectDomainStatuses(
	domains: ReadonlyMap<ProviderObservationDomain, ProviderCoverageDomainEvaluation>,
	availability: ProviderObservationAvailability,
): ProviderDomainObservationStatus[] {
	return [...domains.values()]
		.sort(
			(left, right) =>
				PROVIDER_OBSERVATION_DOMAIN_ORDER.indexOf(left.domain) -
				PROVIDER_OBSERVATION_DOMAIN_ORDER.indexOf(right.domain),
		)
		.map((domain) => ({
			domain: domain.domain,
			availability:
				domain.availability === "unavailable"
					? "unavailable"
					: availability === "last-known"
						? "last-known"
						: availability === "unavailable"
							? "unavailable"
							: domain.availability,
			evidence: domain.evidence,
			valueSemantics: domain.valueSemantics,
			observedAt: domain.observedAt,
			reasonCodes: uniqueReasons(domain.reasonCodes),
		}));
}

function isValidDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isSafeNonnegativeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function uniqueReasons(
	reasons: readonly ProviderObservationReasonCode[],
): ProviderObservationReasonCode[] {
	const result: ProviderObservationReasonCode[] = [];
	const seen = new Set<ProviderObservationReasonCode>();
	for (const reason of reasons) {
		if (PROVIDER_OBSERVATION_REASON_CODES.has(reason) && !seen.has(reason)) {
			seen.add(reason);
			result.push(reason);
		}
	}
	return result;
}

function status(
	availability: ProviderObservationStatus["availability"],
	evidence: ProviderObservationEvidence,
	observedAt: string | null,
	ageSeconds: number | null,
	latestAttempt: ProviderObservationAttemptState,
	reasonCodes: readonly ProviderObservationReasonCode[],
	domainEvaluations?: ReadonlyMap<ProviderObservationDomain, ProviderCoverageDomainEvaluation>,
): ProviderObservationStatus {
	const result: ProviderObservationStatus = {
		availability,
		evidence,
		observedAt,
		ageSeconds,
		latestAttempt,
		reasonCodes: uniqueReasons(reasonCodes),
	};
	if (domainEvaluations !== undefined) {
		result.domains = projectDomainStatuses(domainEvaluations, availability);
	}
	return result;
}

function unavailable(
	reasonCodes: readonly ProviderObservationReasonCode[],
	latestAttempt: ProviderObservationAttemptState = "idle",
): ProviderObservationStatus {
	return status("unavailable", "unknown", null, null, latestAttempt, reasonCodes);
}

function hasConservedCompleteEvaluation(evaluation: ProviderCoverageEvaluation): boolean {
	if (
		!evaluation.valid ||
		!evaluation.complete ||
		evaluation.evidence !== "complete" ||
		!isSafeNonnegativeInteger(evaluation.rawObserved) ||
		!isSafeNonnegativeInteger(evaluation.sourceBindings) ||
		!isSafeNonnegativeInteger(evaluation.canonicalEntities) ||
		!isSafeNonnegativeInteger(evaluation.acceptedSkipCount) ||
		!isSafeNonnegativeInteger(evaluation.fatalCount) ||
		!isSafeNonnegativeInteger(evaluation.pagesAttempted) ||
		!isSafeNonnegativeInteger(evaluation.pagesCompleted)
	) {
		return false;
	}

	return (
		evaluation.rawObserved === evaluation.sourceBindings + evaluation.acceptedSkipCount &&
		evaluation.fatalCount === 0 &&
		evaluation.pagesAttempted === evaluation.pagesCompleted
	);
}

function hasSafeEvaluationTotals(evaluation: ProviderCoverageEvaluation): boolean {
	return (
		evaluation.valid &&
		isSafeNonnegativeInteger(evaluation.rawObserved) &&
		isSafeNonnegativeInteger(evaluation.sourceBindings) &&
		isSafeNonnegativeInteger(evaluation.canonicalEntities) &&
		isSafeNonnegativeInteger(evaluation.acceptedSkipCount) &&
		isSafeNonnegativeInteger(evaluation.fatalCount) &&
		isSafeNonnegativeInteger(evaluation.pagesAttempted) &&
		isSafeNonnegativeInteger(evaluation.pagesCompleted)
	);
}

function isBlockingCompleteReason(reason: ProviderObservationReasonCode): boolean {
	return (
		reason === "receipt-invalid" ||
		reason === "coverage-incomplete" ||
		reason === "provider-limit" ||
		reason === "provider-unavailable" ||
		reason === "rows-inconsistent" ||
		reason === "positive-only"
	);
}

function evaluationReasons(
	evaluation: ProviderCoverageEvaluation,
): ProviderObservationReasonCode[] {
	return uniqueReasons(evaluation.reasonCodes);
}

function publicationAge(
	publication: ProviderObservationPublication,
	now: Date,
): { observedAt: string; ageSeconds: number; ageMs: number } | null {
	if (!isValidDate(publication.observedAt) || !isValidDate(now)) return null;
	const ageMs = now.getTime() - publication.observedAt.getTime();
	if (ageMs < 0) return null;
	return {
		observedAt: publication.observedAt.toISOString(),
		ageSeconds: Math.floor(ageMs / 1000),
		ageMs,
	};
}

function newerAttempt(
	publication: ProviderObservationPublication,
	latestAttempt: ProviderObservationLatestAttempt | null,
): ProviderObservationLatestAttempt | null {
	if (
		latestAttempt === null ||
		(latestAttempt.state !== "running" && latestAttempt.state !== "failed") ||
		!isValidDate(latestAttempt.attemptedAt) ||
		!isValidDate(publication.observedAt) ||
		latestAttempt.attemptedAt.getTime() <= publication.observedAt.getTime()
	) {
		return null;
	}
	return latestAttempt;
}

export function projectProviderObservationStatus(
	input: ProviderStatusProjectionInput,
): ProviderObservationStatus {
	if (input.identity === "changed") {
		return unavailable(["identity-changed"]);
	}
	if (input.identity === "unverified") {
		return unavailable(["identity-unverified"]);
	}
	if (input.identity !== "current") {
		return unavailable(["identity-unverified"]);
	}

	const latestAttemptState = input.latestAttempt?.state;
	const validFirstAttempt =
		input.latestAttempt !== null &&
		(input.latestAttempt.state === "running" || input.latestAttempt.state === "failed") &&
		isValidDate(input.latestAttempt.attemptedAt);

	if (input.publication === null) {
		if (validFirstAttempt && input.latestAttempt) {
			return unavailable(
				[
					"no-publication",
					`refresh-${input.latestAttempt.state}` as "refresh-running" | "refresh-failed",
				],
				input.latestAttempt.state,
			);
		}
		return unavailable(["no-publication"]);
	}
	const age = publicationAge(input.publication, input.now);
	if (age === null) return unavailable(["unknown-failure"]);

	const evaluation = input.publication.evaluation;
	if (!evaluation.valid) {
		return unavailable(["receipt-invalid"]);
	}
	if (!hasSafeEvaluationTotals(evaluation)) {
		return unavailable(["coverage-incomplete"]);
	}
	if (!hasConservedCompleteEvaluation(evaluation)) {
		if (evaluation.complete && evaluation.evidence === "complete") {
			return unavailable(["coverage-incomplete"]);
		}
		const reasons = evaluationReasons(evaluation);
		if (evaluation.evidence === "positive-only" && !reasons.includes("positive-only")) {
			reasons.push("positive-only");
		}
		if (!reasons.includes("coverage-incomplete")) reasons.push("coverage-incomplete");
		if (
			evaluation.evidence !== "complete" &&
			evaluation.evidence !== "partial" &&
			evaluation.evidence !== "positive-only"
		) {
			return unavailable(reasons);
		}
		if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
			return unavailable(reasons);
		}
		const projectedEvidence = evaluation.evidence === "positive-only" ? "positive-only" : "partial";
		const latestAttempt =
			latestAttemptState === "running" ||
			latestAttemptState === "failed" ||
			latestAttemptState === "successful"
				? latestAttemptState
				: "idle";
		const newer = newerAttempt(input.publication, input.latestAttempt);
		const stale = age.ageMs > input.maxAgeMs;
		if (newer || stale) {
			return status(
				"last-known",
				projectedEvidence,
				age.observedAt,
				age.ageSeconds,
				newer?.state ?? latestAttempt,
				[
					...reasons,
					...(stale ? (["publication-stale"] as const) : []),
					...(newer
						? ([`refresh-${newer.state}`] as ("refresh-running" | "refresh-failed")[])
						: []),
				],
				evaluation.domains,
			);
		}
		return status(
			"partial",
			projectedEvidence,
			age.observedAt,
			age.ageSeconds,
			latestAttempt,
			reasons,
			evaluation.domains,
		);
	}

	if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
		return unavailable(["unknown-failure"]);
	}

	const reasons = evaluationReasons(evaluation);
	if (reasons.some(isBlockingCompleteReason)) {
		return unavailable(["coverage-incomplete"]);
	}

	const newer = newerAttempt(input.publication, input.latestAttempt);
	if (newer) {
		return status(
			"last-known",
			"complete",
			age.observedAt,
			age.ageSeconds,
			newer.state,
			[...reasons, `refresh-${newer.state}` as "refresh-running" | "refresh-failed"],
			evaluation.domains,
		);
	}

	const latestAttempt =
		latestAttemptState === "running" ||
		latestAttemptState === "failed" ||
		latestAttemptState === "successful"
			? latestAttemptState
			: "idle";
	if (age.ageMs > input.maxAgeMs) {
		return status(
			"last-known",
			"complete",
			age.observedAt,
			age.ageSeconds,
			latestAttempt,
			[...reasons, "publication-stale"],
			evaluation.domains,
		);
	}

	return status(
		"current",
		"complete",
		age.observedAt,
		age.ageSeconds,
		latestAttempt,
		reasons,
		evaluation.domains,
	);
}
