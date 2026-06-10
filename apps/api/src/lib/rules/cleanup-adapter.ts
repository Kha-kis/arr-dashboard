/**
 * Cleanup/auto-tag → engine adapter
 * (docs/design/unified-rule-grammar.md §4 step 4, strangler shape).
 *
 * Reproduces `evaluateRule`'s exact decision surface on top of the
 * unified engine: same pre-filters (imported, never duplicated), same
 * composite reason semantics (engine pins them), same domain quirks —
 * all reproduced deliberately and parity-tested:
 *
 *   - empty/unparseable composite conditions → no-match (legacy guard
 *     `if (!conditions?.length) return null`)
 *   - unparseable single-rule parameters → no-match (legacy
 *     `parseParams` returning null)
 *   - retired/unknown kinds → no-match via the injected dispatch's
 *     `default: return null` (tier-3 permissive null, §2.2)
 *
 * One documented, intentional delta: structurally unrepresentable rows
 * (a composite condition without `ruleType`, parameters that aren't an
 * object) map to no-match here, where the legacy path could THROW from
 * inside an evaluator mid-run. Such rows cannot be produced by any
 * write path; no-match is strictly safer than an aborted cleanup run.
 *
 * Cutover = swapping `evaluateRule` call sites to
 * `evaluateRuleViaEngine` once the differential parity suite is green.
 */

import type { RuleDocument } from "@arr/shared";
import {
	evaluateSingleCondition,
	passesInstanceFilter,
	passesServiceFilter,
	passesTagExclusion,
	passesTitleExclusion,
} from "../library-cleanup/rule-evaluators.js";
import type {
	CacheItemForEval,
	EvalContext,
	RuleAction,
	RuleMatch,
} from "../library-cleanup/types.js";
import type { LibraryCleanupRule } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import { evaluateDocument, type PredicateEvaluator } from "./engine.js";
import { mapCriteriaV0ToDocument } from "./v0-mappers.js";

/**
 * Engine-backed equivalent of `evaluateRule` (rule-evaluators.ts).
 * Identical inputs, identical outputs — proven by the parity suite.
 */
export function evaluateRuleViaEngine(
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
	instanceService: string,
	ctx: EvalContext,
): RuleMatch | null {
	if (!rule.enabled) return null;

	// Pre-filters — the legacy functions, not copies.
	if (!passesServiceFilter(instanceService, rule.serviceFilter)) return null;
	if (!passesInstanceFilter(item.instanceId, rule.instanceFilter)) return null;
	if (!passesTagExclusion(item, rule.excludeTags)) return null;
	if (!passesTitleExclusion(item.title, rule.excludeTitles)) return null;

	const plexLibFilter = safeJsonParse(rule.plexLibraryFilter) as string[] | null;
	const action = (rule.action ?? "delete") as RuleAction;

	// Domain quirk guards (rule-level policy, deliberately NOT in the
	// engine — see engine.ts header on empty-group semantics).
	if (rule.operator && rule.conditions) {
		const conditions = safeJsonParse(rule.conditions) as unknown[] | null;
		if (!conditions?.length) return null;
	} else {
		const params = safeJsonParse(rule.parameters) as Record<string, unknown> | null;
		if (!params) return null;
	}

	let doc: RuleDocument;
	try {
		doc = mapCriteriaV0ToDocument(rule);
	} catch {
		// Unrepresentable row (see header) — no-match, never a thrown run.
		return null;
	}

	const evalPredicate: PredicateEvaluator = (predicate) =>
		evaluateSingleCondition(item, predicate.kind, predicate.params, ctx, plexLibFilter);

	const result = evaluateDocument(doc, evalPredicate);
	return result.matched
		? { ruleId: rule.id, ruleName: rule.name, reason: result.reason, action }
		: null;
}
