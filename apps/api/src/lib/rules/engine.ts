/**
 * Unified rule engine — composition core
 * (docs/design/unified-rule-grammar.md §4 step 2, as refined at the
 * implementation checkpoint).
 *
 * The engine is PURE COMPOSITION over grammar nodes; per-kind predicate
 * evaluation is injected. This is the strangler shape: the existing
 * 79 KB `rule-evaluators.ts` is not copied or decomposed — its
 * `evaluateSingleCondition` dispatch IS the injected evaluator for the
 * cleanup/auto-tag context, wrapped at cutover (§4 step 4). The
 * decomposition the design doc sketched becomes optional polish, not a
 * migration step.
 *
 * Reason-string semantics mirror the legacy composite path EXACTLY
 * (parity-tested):
 *   - `all`: every child must match; reasons joined with " AND "
 *   - `any`: FIRST matching child's reason only
 *
 * Empty-group semantics are deliberately standard logic here
 * (`all: []` → vacuous true, `any: []` → false) because the surfaces
 * disagree: notifications' empty condition list matches every event
 * (Array.every on []), while cleanup rejects empty composites BEFORE
 * evaluation (`if (!conditions?.length) return null`). That cleanup
 * guard is rule-level domain policy and lives in the cleanup adapter,
 * never in the engine.
 *
 * Kind-legality tier 3 (permissive null) lives in the INJECTED
 * evaluators — the legacy dispatch's `default: return null` and the
 * `source:"tautulli"` fail-safe ride along unchanged. The engine never
 * inspects kinds; tier-2 annotation is `normalizeDocument` below.
 */

import {
	groupChildren,
	isRulePredicate,
	type RuleDocument,
	type RuleGroup,
	type RuleNode,
	type RulePredicate,
} from "@arr/shared";

// ============================================================================
// Evaluation
// ============================================================================

/**
 * A predicate evaluator returns the human-readable match reason, or
 * null for no-match. Unknown/retired kinds and stale params MUST return
 * null (tier-3 permissive null), never throw.
 */
export type PredicateEvaluator = (predicate: RulePredicate) => string | null;

export type EvalResult = { matched: true; reason: string } | { matched: false };

const NO_MATCH: EvalResult = { matched: false };

export function evaluateNode(node: RuleNode, evalPredicate: PredicateEvaluator): EvalResult {
	if (isRulePredicate(node)) {
		const reason = evalPredicate(node);
		return reason === null ? NO_MATCH : { matched: true, reason };
	}
	return evaluateGroup(node, evalPredicate);
}

function evaluateGroup(group: RuleGroup, evalPredicate: PredicateEvaluator): EvalResult {
	const children = groupChildren(group);

	if ("all" in group) {
		// Vacuous truth on []: notifications' "no conditions = match all
		// events". Cleanup never reaches here with [] (adapter guard).
		const reasons: string[] = [];
		for (const child of children) {
			const result = evaluateNode(child, evalPredicate);
			if (!result.matched) return NO_MATCH;
			reasons.push(result.reason);
		}
		return { matched: true, reason: reasons.join(" AND ") };
	}

	// any: first matching child's reason only (legacy OR semantics)
	for (const child of children) {
		const result = evaluateNode(child, evalPredicate);
		if (result.matched) return result;
	}
	return NO_MATCH;
}

export function evaluateDocument(doc: RuleDocument, evalPredicate: PredicateEvaluator): EvalResult {
	return evaluateNode(doc.root, evalPredicate);
}

// ============================================================================
// Normalization annotation (tier 2)
// ============================================================================

/**
 * Return a copy of the document with `unavailableKind: true` set on
 * every predicate whose kind is not in the context's legal set —
 * retired kinds (tautulli_*) or vocabulary drift. Never mutates the
 * input; never rejects (stored documents legally contain retired
 * kinds — §2.2 as amended). API rule GET endpoints serve this so the
 * UI can badge unavailable conditions instead of silently no-matching.
 */
export function normalizeDocument(
	doc: RuleDocument,
	legalKinds: ReadonlySet<string>,
): RuleDocument {
	return { version: 1, root: annotateNode(doc.root, legalKinds) };
}

function annotateNode(node: RuleNode, legalKinds: ReadonlySet<string>): RuleNode {
	if (isRulePredicate(node)) {
		if (legalKinds.has(node.kind)) {
			// Strip any stale stored annotation — availability is computed,
			// never trusted from input.
			if (node.unavailableKind === undefined) return node;
			const { unavailableKind: _stale, ...rest } = node;
			return rest;
		}
		return { ...node, unavailableKind: true };
	}
	if ("all" in node) {
		return { all: node.all.map((child) => annotateNode(child, legalKinds)) };
	}
	return { any: node.any.map((child) => annotateNode(child, legalKinds)) };
}

/** List the kinds in a document that are not legal for the context. */
export function listUnavailableKinds(doc: RuleDocument, legalKinds: ReadonlySet<string>): string[] {
	const found = new Set<string>();
	const walk = (node: RuleNode): void => {
		if (isRulePredicate(node)) {
			if (!legalKinds.has(node.kind)) found.add(node.kind);
			return;
		}
		for (const child of groupChildren(node)) walk(child);
	};
	walk(doc.root);
	return [...found];
}
