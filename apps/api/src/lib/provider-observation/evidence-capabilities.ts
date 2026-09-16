import type {
	ProviderObservationDomain,
	ProviderObservationStatus,
	ProviderObservationValueSemantics,
} from "@arr/shared";

export interface ProviderEvidenceCapabilityRequest {
	domain: ProviderObservationDomain;
	use: "display" | "positive-predicate" | "negative-predicate" | "arithmetic" | "mutation";
	field: "membership" | "watch-count" | "watched-by" | "last-watched" | "on-deck";
	operator?: "greater_than" | "less_than" | "equals" | "contains";
	threshold?: number;
	observedValue?: number;
	targetObserved: boolean;
}

export type ProviderEvidenceCapabilityDecision =
	| { authorized: true; basis: "exact" | "observed-lower-bound" }
	| {
			authorized: false;
			reason:
				| "domain-unavailable"
				| "current-evidence-required"
				| "exact-evidence-required"
				| "target-unobserved"
				| "operator-not-monotone"
				| "predicate-not-proven";
	  };

function deny(
	reason: Exclude<ProviderEvidenceCapabilityDecision, { authorized: true }>["reason"],
): ProviderEvidenceCapabilityDecision {
	return { authorized: false, reason };
}

function isNumeric(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function basis(
	valueSemantics: ProviderObservationValueSemantics,
): "exact" | "observed-lower-bound" {
	return valueSemantics === "exact" ? "exact" : "observed-lower-bound";
}

function predicateIsTrue(
	operator: ProviderEvidenceCapabilityRequest["operator"],
	observedValue: number,
	threshold: number,
): boolean {
	switch (operator) {
		case "greater_than":
			return observedValue > threshold;
		case "less_than":
			return observedValue < threshold;
		case "equals":
			return observedValue === threshold;
		default:
			return false;
	}
}

export function authorizeProviderEvidenceUse(
	status: ProviderObservationStatus,
	request: ProviderEvidenceCapabilityRequest,
): ProviderEvidenceCapabilityDecision {
	const domain = status.domains?.find((candidate) => candidate.domain === request.domain);
	if (
		!domain ||
		domain.availability === "unavailable" ||
		domain.evidence === "unknown" ||
		domain.valueSemantics === "unknown" ||
		status.evidence === "unknown" ||
		status.availability === "unavailable" ||
		status.reasonCodes.includes("identity-changed") ||
		status.reasonCodes.includes("identity-unverified") ||
		domain.reasonCodes.includes("identity-changed") ||
		domain.reasonCodes.includes("identity-unverified")
	) {
		return deny("domain-unavailable");
	}

	const exact = domain.valueSemantics === "exact";
	if (exact && domain.evidence !== "complete") return deny("exact-evidence-required");
	const current = domain.availability === "current" && status.availability !== "last-known";
	const mutationCurrent = status.availability === "current" && current;
	if (request.use === "display") {
		if (!request.targetObserved) return deny("target-unobserved");
		if (domain.availability !== "current" && domain.availability !== "last-known") {
			return deny("current-evidence-required");
		}
		return { authorized: true, basis: basis(domain.valueSemantics) };
	}

	if (request.use === "arithmetic") {
		if (!exact) return deny("exact-evidence-required");
		if (!current) return deny("current-evidence-required");
		if (!request.targetObserved) return deny("target-unobserved");
		if (!isNumeric(request.observedValue) || request.observedValue < 0) {
			return deny("predicate-not-proven");
		}
		return { authorized: true, basis: "exact" };
	}

	if (request.use === "positive-predicate" || request.use === "mutation") {
		if (!current || (request.use === "mutation" && !mutationCurrent)) {
			return deny("current-evidence-required");
		}
		if (!request.targetObserved) return deny("target-unobserved");
		if (request.field !== "watch-count" || request.operator !== "greater_than") {
			return exact ? deny("predicate-not-proven") : deny("operator-not-monotone");
		}
		if (!isNumeric(request.threshold) || request.threshold < 0) {
			return deny("predicate-not-proven");
		}
		if (!isNumeric(request.observedValue) || request.observedValue < 0) {
			return deny("predicate-not-proven");
		}
		if (!predicateIsTrue(request.operator, request.observedValue, request.threshold)) {
			return deny("predicate-not-proven");
		}
		return { authorized: true, basis: basis(domain.valueSemantics) };
	}

	if (!exact) return deny("exact-evidence-required");
	if (!current) return deny("current-evidence-required");
	if (!request.targetObserved) return deny("target-unobserved");
	if (!isNumeric(request.threshold) || request.threshold < 0) {
		return deny("predicate-not-proven");
	}
	if (!isNumeric(request.observedValue) || request.observedValue < 0) {
		return deny("predicate-not-proven");
	}
	if (
		request.field !== "watch-count" ||
		(request.operator !== "less_than" &&
			request.operator !== "equals" &&
			request.operator !== "greater_than")
	) {
		return deny("operator-not-monotone");
	}
	return predicateIsTrue(request.operator, request.observedValue, request.threshold)
		? { authorized: true, basis: "exact" }
		: deny("predicate-not-proven");
}

/**
 * A deliberately narrow escape hatch for a reader that has already bound one
 * exact cache row to one intact, current provider target ledger. It does not
 * make aggregate partial evidence generally usable: callers must retain that
 * target proof and use this only for the positive monotone watch-count shape.
 */
export function authorizeTargetScopedWatchCountMutation(
	status: ProviderObservationStatus,
	request: ProviderEvidenceCapabilityRequest,
): ProviderEvidenceCapabilityDecision {
	if (
		request.use !== "mutation" ||
		request.domain !== "watch-count" ||
		request.field !== "watch-count" ||
		request.operator !== "greater_than"
	) {
		return deny("operator-not-monotone");
	}
	const domain = status.domains?.find((candidate) => candidate.domain === "watch-count");
	if (
		!domain ||
		status.availability === "unavailable" ||
		status.availability === "last-known" ||
		domain.availability !== "current" ||
		status.reasonCodes.includes("identity-changed") ||
		status.reasonCodes.includes("identity-unverified") ||
		domain.reasonCodes.includes("identity-changed") ||
		domain.reasonCodes.includes("identity-unverified")
	) {
		return deny("current-evidence-required");
	}
	if (domain.evidence !== "complete" || domain.valueSemantics !== "exact") {
		return deny("exact-evidence-required");
	}
	if (!request.targetObserved) return deny("target-unobserved");
	if (
		!isNumeric(request.threshold) ||
		request.threshold < 0 ||
		!isNumeric(request.observedValue) ||
		request.observedValue < 0
	) {
		return deny("predicate-not-proven");
	}
	return predicateIsTrue(request.operator, request.observedValue, request.threshold)
		? { authorized: true, basis: "exact" }
		: deny("predicate-not-proven");
}
