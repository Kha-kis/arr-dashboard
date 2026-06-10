/**
 * Notifications → engine adapter (unified-rule-grammar §4 step 5).
 *
 * No storage change (§3): stored rows stay flat v0 condition arrays;
 * the v0 mapper converts to one `all` group of `field_match` predicates
 * in memory, and the legacy `matchNotificationCondition` predicate is
 * injected — single source of truth for operator semantics, mirroring
 * the cleanup/auto-tag adapter pattern.
 *
 * Semantics preserved exactly (parity-tested):
 *   - empty conditions array → matches every event (vacuous truth on
 *     the empty `all` group — here this IS the domain semantic, unlike
 *     cleanup where the adapter guards empties to no-match)
 *   - absent field fails EVERY operator incl. not_equals (the REAL
 *     sharp edge — see matchNotificationCondition)
 *   - rule-level behavior (priority sort, first-match-wins, quiet-hours
 *     windowing, critical-event bypass) stays in RuleEngine.evaluate —
 *     actions are out of grammar scope (§1.3.4)
 *
 * Unrepresentable rows (condition missing field/operator) match
 * nothing rather than throwing mid-dispatch — same safer-than-legacy
 * delta as the cleanup adapter, documented here.
 */

import type { RuleDocument } from "@arr/shared";
import {
	matchNotificationCondition,
	type RuleCondition,
} from "../notifications/condition-matcher.js";
import type { NotificationPayload } from "../notifications/types.js";
import { evaluateDocument, type PredicateEvaluator } from "./engine.js";
import { mapNotificationsV0ToDocument } from "./v0-mappers.js";

/**
 * Engine-backed equivalent of RuleEngine's private
 * `matchesAllConditions` (flat implicit-AND over the conditions array).
 */
export function notificationConditionsMatchViaEngine(
	payload: NotificationPayload,
	conditions: RuleCondition[],
): boolean {
	let doc: RuleDocument;
	try {
		doc = mapNotificationsV0ToDocument(conditions);
	} catch {
		// Unrepresentable conditions row — match nothing (see header).
		return false;
	}

	const evalPredicate: PredicateEvaluator = (predicate) =>
		matchNotificationCondition(payload, predicate.params as unknown as RuleCondition)
			? "match"
			: null;

	return evaluateDocument(doc, evalPredicate).matched;
}
