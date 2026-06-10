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

import type { DataSourceDependency, RuleDocument } from "@arr/shared";
import {
	evaluateSingleCondition,
	getFilterReason,
	passesInstanceFilter,
	passesServiceFilter,
	passesTagExclusion,
	passesTitleExclusion,
	shouldSkipForFailedSource,
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

/**
 * Engine-backed equivalent of `evaluateItemAgainstRules` — the same
 * two-phase loop (retention rules protect first, then cleanup rules
 * first-match-wins by caller-provided order) and the same
 * failed-source skip (the C1 safety fix), delegating per-rule
 * evaluation to the engine.
 */
export function evaluateItemAgainstRulesViaEngine(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
	failedSources?: Set<DataSourceDependency>,
): RuleMatch | null {
	// Phase 1: retention rules — any match protects the item
	for (const rule of rules) {
		if (!rule.retentionMode) continue;
		if (shouldSkipForFailedSource(rule, failedSources)) continue;
		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		if (match) return null;
	}

	// Phase 2: cleanup rules — first match wins
	for (const rule of rules) {
		if (rule.retentionMode) continue;
		if (shouldSkipForFailedSource(rule, failedSources)) continue;
		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		if (match) return match;
	}
	return null;
}

/** Per-rule breakdown row for the explain endpoint. */
export interface ExplainRuleResult {
	ruleId: string;
	ruleName: string;
	matched: boolean;
	reason: string | null;
	filteredBy:
		| "service_filter"
		| "instance_filter"
		| "tag_exclusion"
		| "title_exclusion"
		| "disabled"
		| null;
	retentionMode: boolean;
}

/**
 * Engine-backed equivalent of `explainItemAgainstRules` — identical
 * per-rule breakdown (disabled / which pre-filter blocked / match with
 * reason), delegating evaluation to the engine.
 */
export function explainItemAgainstRulesViaEngine(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
): ExplainRuleResult[] {
	const results: ExplainRuleResult[] = [];

	for (const rule of rules) {
		if (!rule.enabled) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy: "disabled",
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		const filteredBy = getFilterReason(item, rule, instanceService);
		if (filteredBy) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy,
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		results.push({
			ruleId: rule.id,
			ruleName: rule.name,
			matched: match !== null,
			reason: match?.reason ?? null,
			filteredBy: null,
			retentionMode: rule.retentionMode,
		});
	}

	return results;
}
