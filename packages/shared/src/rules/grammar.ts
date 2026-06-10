/**
 * Unified rule grammar — serialization v1.
 *
 * docs/design/unified-rule-grammar.md §2.1. One predicate shape
 * (kind + params) composed by all/any groups, wrapped in a versioned
 * document envelope stored in the existing JSON rule columns.
 *
 * Naming note: the design doc calls these Condition / ConditionGroup /
 * ConditionNode. They are exported as RulePredicate / RuleGroup /
 * RuleNode because `Condition` is already a live export from
 * criteria.ts (the v0 condition shape) and both vocabularies coexist
 * in the @arr/shared barrel for the whole strangler period.
 *
 * Kind-legality is deliberately NOT part of these schemas (§2.2 as
 * amended, §6.1): stored documents legally contain retired kinds
 * (e.g. disabled tautulli_* rules whose documents the 3.0 pass
 * preserves). Structural validation here; legality is enforced
 * strictly at write time and permissively (null / annotation) at
 * evaluation time.
 */

import { z } from "zod";

// ============================================================================
// Nodes
// ============================================================================

export interface RulePredicate {
	/** Condition kind, e.g. "plex_last_watched", "field_match". */
	kind: string;
	/** Validated by the kind's Zod schema at write time. */
	params: Record<string, unknown>;
	/**
	 * Normalization annotation (API output only, never stored): set when
	 * the kind is not registered for the document's context — retired
	 * kinds (tautulli_*) or vocabulary drift. The UI badges these;
	 * evaluation treats them as no-match (permissive null).
	 */
	unavailableKind?: boolean;
}

export type RuleGroup = { all: RuleNode[] } | { any: RuleNode[] };

export type RuleNode = RulePredicate | RuleGroup;

/** The stored document envelope (per rule row, in existing JSON columns). */
export interface RuleDocument {
	version: 1;
	root: RuleNode;
}

// ============================================================================
// Zod schemas (structural — see header note on kind-legality)
// ============================================================================

export const rulePredicateSchema: z.ZodType<RulePredicate> = z.object({
	kind: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
	unavailableKind: z.boolean().optional(),
});

export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
	z.union([rulePredicateSchema, ruleGroupSchema]),
);

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
	z.union([z.object({ all: z.array(ruleNodeSchema) }), z.object({ any: z.array(ruleNodeSchema) })]),
);

export const ruleDocumentSchema: z.ZodType<RuleDocument> = z.object({
	version: z.literal(1),
	root: ruleNodeSchema,
});

// ============================================================================
// Node helpers
// ============================================================================

export function isRuleGroup(node: RuleNode): node is RuleGroup {
	return "all" in node || "any" in node;
}

export function isRulePredicate(node: RuleNode): node is RulePredicate {
	return "kind" in node;
}

/** Children of a group, regardless of all/any variant. */
export function groupChildren(group: RuleGroup): RuleNode[] {
	return "all" in group ? group.all : group.any;
}

/** Depth of a node tree; a bare predicate is depth 0, one group level is 1. */
export function nodeDepth(node: RuleNode): number {
	if (isRulePredicate(node)) return 0;
	const children = groupChildren(node);
	if (children.length === 0) return 1;
	return 1 + Math.max(...children.map(nodeDepth));
}

/**
 * v1 documents are restricted to depth 1 (matching every existing rule;
 * §2.1 — depth is a future unlock, not a migration burden). Write paths
 * call this; the structural schema deliberately permits recursion.
 */
export const RULE_DOCUMENT_V1_MAX_DEPTH = 1;

export function validateV1Depth(doc: RuleDocument): string | null {
	const depth = nodeDepth(doc.root);
	return depth > RULE_DOCUMENT_V1_MAX_DEPTH
		? `Rule document exceeds v1 depth limit (${depth} > ${RULE_DOCUMENT_V1_MAX_DEPTH})`
		: null;
}

/** Walk every predicate in a document (depth-first). */
export function* walkPredicates(node: RuleNode): Generator<RulePredicate> {
	if (isRulePredicate(node)) {
		yield node;
		return;
	}
	for (const child of groupChildren(node)) {
		yield* walkPredicates(child);
	}
}
