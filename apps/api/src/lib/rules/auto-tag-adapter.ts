/**
 * Auto-tag → engine adapter (unified-rule-grammar §4 step 4 — "shared
 * evaluators make this nearly one step").
 *
 * Reproduces `evaluateAgainstRule` (execute-rule.ts) on the engine:
 * boolean result, pre-parsed v0 input (auto-tag callers parse JSON
 * before evaluation), no pre-filter pass here (the executor applies
 * excludeTags/excludeTitles itself before calling).
 *
 * Legacy quirks reproduced deliberately (parity-tested):
 *   - a composite with NULL or EMPTY conditions falls through to the
 *     single-condition path, where ruleType "composite" hits the
 *     dispatch default → no-match (different mechanism from cleanup's
 *     explicit guard, same outcome)
 *   - any non-"AND" operator gets OR semantics (the legacy
 *     `if (operator === "AND") … else OR` shape; the input type
 *     restricts to "AND" | "OR" but the runtime contract is pinned)
 */

import type { RuleNode } from "@arr/shared";
import type { AutoTagRuleInput } from "../auto-tag/execute-rule.js";
import { evaluateSingleCondition } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../library-cleanup/types.js";
import { evaluateDocument, type PredicateEvaluator } from "./engine.js";

/**
 * Engine-backed equivalent of auto-tag's `evaluateAgainstRule`.
 * Identical inputs, identical boolean — proven by the parity suite.
 */
export function autoTagRuleMatchesViaEngine(
	item: CacheItemForEval,
	rule: AutoTagRuleInput,
	instanceService: string,
	ctx: EvalContext,
): boolean {
	const plexLibFilter = rule.plexLibraryFilter ?? null;

	let root: RuleNode;
	if (rule.operator && rule.conditions && rule.conditions.length > 0) {
		const children: RuleNode[] = rule.conditions.map((c) => ({
			kind: c.ruleType,
			params: c.parameters,
		}));
		root = rule.operator === "AND" ? { all: children } : { any: children };
	} else {
		// Includes the empty-composite fall-through: kind "composite" hits
		// the dispatch default → no-match, matching legacy behavior.
		root = { kind: rule.ruleType, params: rule.parameters };
	}

	const evalPredicate: PredicateEvaluator = (predicate) =>
		evaluateSingleCondition(item, predicate.kind, predicate.params, ctx, plexLibFilter);

	void instanceService; // reserved for future per-service rule-routing (mirrors legacy)
	return evaluateDocument({ version: 1, root }, evalPredicate).matched;
}
