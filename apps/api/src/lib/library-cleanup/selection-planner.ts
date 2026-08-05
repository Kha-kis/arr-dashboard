export type CleanupSelectionDisposition =
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

export interface CleanupSelectionDecision<T> {
	candidate: CleanupSelectionCandidate<T>;
	disposition: CleanupSelectionDisposition;
	reason: string;
}

export interface CleanupSelectionPlan<TFresh, TRetry> {
	selectedFresh: Array<CleanupSelectionCandidate<TFresh>>;
	selectedRetries: Array<CleanupSelectionRetry<TRetry>>;
	decisions: Array<CleanupSelectionDecision<TFresh | TRetry>>;
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

interface ApprovalSelectionInput<TFresh, TRetry> {
	mode: "approval";
	limit: number;
	fresh: Array<CleanupSelectionCandidate<TFresh>>;
	approvalExclusions: Map<string, string>;
	nonterminalRetryKeys: Set<string>;
	/** Existing executing retries are visible but never consume approval-run budget. */
	inFlightRetries: Array<CleanupSelectionRetry<TRetry>>;
	/** False means neither approval exclusions nor retry ownership can be trusted. */
	retryStateLoaded: boolean;
}

interface DirectSelectionInput<TFresh, TRetry> {
	mode: "direct";
	limit: number;
	fresh: Array<CleanupSelectionCandidate<TFresh>>;
	pendingRetries: Array<CleanupSelectionRetry<TRetry>>;
	inFlightRetries: Array<CleanupSelectionRetry<TRetry>>;
	previousRunStartedAt?: Date;
	retryStateLoaded: boolean;
}

export type CleanupSelectionInput<TFresh, TRetry> =
	| ApprovalSelectionInput<TFresh, TRetry>
	| DirectSelectionInput<TFresh, TRetry>;

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
	decisions: Array<CleanupSelectionDecision<TFresh | TRetry>>,
	retryState: "complete" | "unavailable" = "complete",
): CleanupSelectionPlan<TFresh, TRetry>["counts"] {
	const count = (disposition: CleanupSelectionDisposition) =>
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
 * Side-effect-free next-run selection.
 *
 * The caller supplies candidates in deterministic execution order. The
 * planner fixes the selected set before any safety inspection or mutation, so
 * a selected item that later fails closed never causes a later item to be
 * silently pulled into the same run.
 */
export function planCleanupSelection<TFresh, TRetry = never>(
	input: CleanupSelectionInput<TFresh, TRetry>,
): CleanupSelectionPlan<TFresh, TRetry> {
	const limit = normalizedLimit(input.limit);
	const decisions: Array<CleanupSelectionDecision<TFresh | TRetry>> = [];

	if (input.mode === "approval") {
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

		for (const retry of [...input.inFlightRetries].sort(compareRetryOrder)) {
			decisions.push({
				candidate: retry,
				disposition: "in_flight",
				reason: IN_FLIGHT_REASON,
			});
		}

		const eligible: Array<CleanupSelectionCandidate<TFresh>> = [];
		const eligibleKeys = new Set<string>();
		for (const candidate of input.fresh) {
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

	const orderedPendingRetries = [...input.pendingRetries].sort(compareRetryOrder);
	const orderedInFlightRetries = [...input.inFlightRetries].sort(compareRetryOrder);
	const inFlightKeys = new Set(orderedInFlightRetries.map((retry) => retry.key));

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

	for (const retry of orderedInFlightRetries) {
		decisions.push({ candidate: retry, disposition: "in_flight", reason: IN_FLIGHT_REASON });
	}

	const duplicatePendingRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	const uniquePendingRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	const pendingKeys = new Set<string>();
	for (const retry of orderedPendingRetries) {
		if (pendingKeys.has(retry.key)) {
			duplicatePendingRetries.push(retry);
		} else {
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
		if (
			pendingKeys.has(candidate.key) ||
			inFlightKeys.has(candidate.key) ||
			freshKeys.has(candidate.key)
		) {
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
	const hasDistinctFreshCandidate = freshCandidates.length > 0;

	const fairnessDeferred: Array<CleanupSelectionRetry<TRetry>> = [];
	const inFlightTargetDeferred: Array<CleanupSelectionRetry<TRetry>> = [];
	const eligibleRetries: Array<CleanupSelectionRetry<TRetry>> = [];
	for (const retry of uniquePendingRetries) {
		if (inFlightKeys.has(retry.key)) {
			inFlightTargetDeferred.push(retry);
		} else if (
			hasDistinctFreshCandidate &&
			input.previousRunStartedAt &&
			retry.reviewedAt &&
			retry.reviewedAt >= input.previousRunStartedAt
		) {
			fairnessDeferred.push(retry);
		} else {
			eligibleRetries.push(retry);
		}
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

	const freshBudget = Math.max(0, limit - selectedRetries.length);
	const selectedFresh = freshCandidates.slice(0, freshBudget);
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
