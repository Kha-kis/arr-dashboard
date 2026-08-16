export type DirectCleanupSelectionDisposition =
	| "selected"
	| "deferred_budget"
	| "deferred_approval"
	| "deferred_retry_fairness"
	| "deferred_in_flight_target"
	| "deferred_duplicate_target"
	| "in_flight"
	| "retry_state_unavailable";

export interface CleanupSelectionCandidate<T> {
	key: string;
	value: T;
}

export interface CleanupSelectionRetry<T> extends CleanupSelectionCandidate<T> {
	id: string;
	reviewedAt: Date | null;
	createdAt: Date;
}

export interface DirectCleanupSelectionDecision<T> {
	candidate: CleanupSelectionCandidate<T>;
	disposition: DirectCleanupSelectionDisposition;
	reason: string;
}

export interface DirectCleanupSelectionPlan<TFresh, TRetry> {
	selectedFresh: Array<CleanupSelectionCandidate<TFresh>>;
	selectedRetries: Array<CleanupSelectionRetry<TRetry>>;
	decisions: Array<DirectCleanupSelectionDecision<TFresh | TRetry>>;
	counts: {
		selectedFresh: number;
		selectedRetries: number;
		deferredBudget: number;
		deferredApproval: number;
		deferredRetryFairness: number;
		deferredInFlightTarget: number;
		deferredDuplicateTarget: number;
		inFlight: number;
		retryStateUnavailable: number;
		retryState: "complete" | "unavailable";
		total: number;
	};
}

export interface DirectCleanupSelectionInput<TFresh, TRetry> {
	limit: number;
	fresh: Array<CleanupSelectionCandidate<TFresh>>;
	pendingRetries: Array<CleanupSelectionRetry<TRetry>>;
	inFlightRetries: Array<CleanupSelectionRetry<TRetry>>;
	previousRunStartedAt?: Date;
	retryStateLoaded: boolean;
}

export interface ApprovalCleanupSelectionInput<TFresh, TRetry> {
	limit: number;
	fresh: Array<CleanupSelectionCandidate<TFresh>>;
	approvalExclusions: Map<string, string>;
	nonterminalRetryKeys: Set<string>;
	inFlightRetries: Array<CleanupSelectionRetry<TRetry>>;
	retryStateLoaded: boolean;
}

const RUN_BUDGET_REASON = "Deferred: the next cleanup run budget is full";
const RETRY_FAIRNESS_REASON =
	"Deferred for one run after its previous attempt so fresh cleanup work can make progress";
const IN_FLIGHT_TARGET_REASON =
	"Deferred: another durable cleanup retry for this target is already executing";
const IN_FLIGHT_REASON = "Deferred: another cleanup run is already executing this durable retry.";
const DUPLICATE_TARGET_REASON =
	"Deferred: another candidate already owns this cleanup target for the next run";
const RETRY_STATE_UNAVAILABLE_REASON =
	"Deferred: durable cleanup retry state could not be loaded safely";

function normalizedLimit(limit: number): number {
	return Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 0;
}

function compareRetryOrder<T>(
	left: CleanupSelectionRetry<T>,
	right: CleanupSelectionRetry<T>,
): number {
	const leftReviewedAt = left.reviewedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
	const rightReviewedAt = right.reviewedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
	return (
		leftReviewedAt - rightReviewedAt ||
		left.createdAt.getTime() - right.createdAt.getTime() ||
		left.id.localeCompare(right.id)
	);
}

function buildCounts<TFresh, TRetry>(
	selectedFresh: Array<CleanupSelectionCandidate<TFresh>>,
	selectedRetries: Array<CleanupSelectionRetry<TRetry>>,
	decisions: Array<DirectCleanupSelectionDecision<TFresh | TRetry>>,
	retryState: "complete" | "unavailable" = "complete",
): DirectCleanupSelectionPlan<TFresh, TRetry>["counts"] {
	const count = (disposition: DirectCleanupSelectionDisposition) =>
		decisions.filter((decision) => decision.disposition === disposition).length;
	return {
		selectedFresh: selectedFresh.length,
		selectedRetries: selectedRetries.length,
		deferredBudget: count("deferred_budget"),
		deferredApproval: count("deferred_approval"),
		deferredRetryFairness: count("deferred_retry_fairness"),
		deferredInFlightTarget: count("deferred_in_flight_target"),
		deferredDuplicateTarget: count("deferred_duplicate_target"),
		inFlight: count("in_flight"),
		retryStateUnavailable: count("retry_state_unavailable"),
		retryState,
		total: decisions.length,
	};
}

/**
 * Side-effect-free approval-run selection. Existing approvals and durable
 * retry ownership are applied before the hard run budget, so excluded targets
 * cannot consume slots that should go to later eligible candidates.
 */
export function planApprovalCleanupSelection<TFresh, TRetry = never>(
	input: ApprovalCleanupSelectionInput<TFresh, TRetry>,
): DirectCleanupSelectionPlan<TFresh, TRetry> {
	const limit = normalizedLimit(input.limit);
	const decisions: Array<DirectCleanupSelectionDecision<TFresh | TRetry>> = [];

	if (!input.retryStateLoaded) {
		for (const candidate of input.fresh) {
			decisions.push({
				candidate,
				disposition: "retry_state_unavailable",
				reason: RETRY_STATE_UNAVAILABLE_REASON,
			});
		}
		return {
			selectedFresh: [],
			selectedRetries: [],
			decisions,
			counts: buildCounts([], [], decisions, "unavailable"),
		};
	}

	const inFlightByTarget = new Map<string, CleanupSelectionRetry<TRetry>>();
	for (const retry of [...input.inFlightRetries].sort(compareRetryOrder)) {
		if (!inFlightByTarget.has(retry.key)) inFlightByTarget.set(retry.key, retry);
	}
	for (const retry of inFlightByTarget.values()) {
		decisions.push({ candidate: retry, disposition: "in_flight", reason: IN_FLIGHT_REASON });
	}
	const inFlightKeys = new Set(inFlightByTarget.keys());

	const eligible: Array<CleanupSelectionCandidate<TFresh>> = [];
	const eligibleKeys = new Set<string>();
	for (const candidate of input.fresh) {
		if (inFlightKeys.has(candidate.key)) continue;
		const approvalReason = input.approvalExclusions.get(candidate.key);
		if (approvalReason) {
			decisions.push({
				candidate,
				disposition: "deferred_approval",
				reason: approvalReason,
			});
		} else if (input.nonterminalRetryKeys.has(candidate.key)) {
			decisions.push({
				candidate,
				disposition: "deferred_approval",
				reason: "Deferred: a durable cleanup retry already exists for this target",
			});
		} else if (eligibleKeys.has(candidate.key)) {
			decisions.push({
				candidate,
				disposition: "deferred_duplicate_target",
				reason: DUPLICATE_TARGET_REASON,
			});
		} else {
			eligibleKeys.add(candidate.key);
			eligible.push(candidate);
		}
	}

	const selectedFresh = eligible.slice(0, limit);
	for (const [index, candidate] of eligible.entries()) {
		decisions.push(
			index < selectedFresh.length
				? { candidate, disposition: "selected", reason: "Selected for the next approval run" }
				: { candidate, disposition: "deferred_budget", reason: RUN_BUDGET_REASON },
		);
	}
	return {
		selectedFresh,
		selectedRetries: [],
		decisions,
		counts: buildCounts(selectedFresh, [], decisions),
	};
}

/**
 * Side-effect-free direct-run selection. The selected set is fixed before any
 * safety inspection or mutation, so a selected item that later fails closed
 * never causes a later candidate to be pulled into the same run.
 */
export function planDirectCleanupSelection<TFresh, TRetry = never>(
	input: DirectCleanupSelectionInput<TFresh, TRetry>,
): DirectCleanupSelectionPlan<TFresh, TRetry> {
	const limit = normalizedLimit(input.limit);
	const decisions: Array<DirectCleanupSelectionDecision<TFresh | TRetry>> = [];

	if (!input.retryStateLoaded) {
		for (const candidate of input.fresh) {
			decisions.push({
				candidate,
				disposition: "retry_state_unavailable",
				reason: RETRY_STATE_UNAVAILABLE_REASON,
			});
		}
		return {
			selectedFresh: [],
			selectedRetries: [],
			decisions,
			counts: buildCounts([], [], decisions, "unavailable"),
		};
	}

	const orderedPendingRetries = [...input.pendingRetries].sort(compareRetryOrder);
	const orderedInFlightRetries = [...input.inFlightRetries].sort(compareRetryOrder);
	const inFlightKeys = new Set(orderedInFlightRetries.map((retry) => retry.key));

	for (const retry of orderedInFlightRetries) {
		decisions.push({ candidate: retry, disposition: "in_flight", reason: IN_FLIGHT_REASON });
	}

	const duplicatePendingRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	const uniquePendingRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	const pendingKeys = new Set<string>();
	for (const retry of orderedPendingRetries) {
		if (pendingKeys.has(retry.key)) duplicatePendingRetries.push(retry);
		else {
			pendingKeys.add(retry.key);
			uniquePendingRetries.push(retry);
		}
	}
	for (const retry of duplicatePendingRetries) {
		decisions.push({
			candidate: retry,
			disposition: "deferred_duplicate_target",
			reason: DUPLICATE_TARGET_REASON,
		});
	}

	const freshCandidates: Array<CleanupSelectionCandidate<TFresh>> = [];
	const freshKeys = new Set<string>();
	for (const candidate of input.fresh) {
		if (inFlightKeys.has(candidate.key)) {
			decisions.push({
				candidate,
				disposition: "deferred_in_flight_target",
				reason: IN_FLIGHT_TARGET_REASON,
			});
		} else if (pendingKeys.has(candidate.key) || freshKeys.has(candidate.key)) {
			decisions.push({
				candidate,
				disposition: "deferred_duplicate_target",
				reason: DUPLICATE_TARGET_REASON,
			});
		} else {
			freshKeys.add(candidate.key);
			freshCandidates.push(candidate);
		}
	}

	const fairnessDeferred: Array<CleanupSelectionRetry<TRetry>> = [];
	const inFlightTargetDeferred: Array<CleanupSelectionRetry<TRetry>> = [];
	const eligibleRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	for (const retry of uniquePendingRetries) {
		if (inFlightKeys.has(retry.key)) inFlightTargetDeferred.push(retry);
		else if (
			freshCandidates.length > 0 &&
			input.previousRunStartedAt &&
			retry.reviewedAt &&
			retry.reviewedAt >= input.previousRunStartedAt
		) {
			fairnessDeferred.push(retry);
		} else eligibleRetries.push(retry);
	}
	for (const retry of inFlightTargetDeferred) {
		decisions.push({
			candidate: retry,
			disposition: "deferred_in_flight_target",
			reason: IN_FLIGHT_TARGET_REASON,
		});
	}
	for (const retry of fairnessDeferred) {
		decisions.push({
			candidate: retry,
			disposition: "deferred_retry_fairness",
			reason: RETRY_FAIRNESS_REASON,
		});
	}

	const selectedRetries = eligibleRetries.slice(0, limit);
	const selectedRetryIds = new Set(selectedRetries.map((retry) => retry.id));
	for (const retry of eligibleRetries) {
		decisions.push(
			selectedRetryIds.has(retry.id)
				? {
						candidate: retry,
						disposition: "selected",
						reason: "Selected for a retry attempt in the next cleanup run",
					}
				: { candidate: retry, disposition: "deferred_budget", reason: RUN_BUDGET_REASON },
		);
	}

	const selectedFresh = freshCandidates.slice(0, Math.max(0, limit - selectedRetries.length));
	for (const [index, candidate] of freshCandidates.entries()) {
		decisions.push(
			index < selectedFresh.length
				? { candidate, disposition: "selected", reason: "Selected for the next cleanup run" }
				: { candidate, disposition: "deferred_budget", reason: RUN_BUDGET_REASON },
		);
	}

	return {
		selectedFresh,
		selectedRetries,
		decisions,
		counts: buildCounts(selectedFresh, selectedRetries, decisions),
	};
}
