/**
 * Context registry — which condition kinds are legal in which domain
 * (docs/design/unified-rule-grammar.md §2.2).
 *
 * This is the DATA half (kind sets); the behavior half (eval-input
 * builders, evaluators) lives in apps/api/src/lib/rules/ per §5.1.
 *
 * Legality enforcement is three-tier (§2.2 as amended 2026-06-10):
 * strict at write time, structural-with-annotation at parse time,
 * permissive null at evaluation. These sets are consulted by all
 * three tiers but only the write path REJECTS on them.
 */

import { ruleParamSchemaMap, ruleTypeSchema } from "./criteria.js";
import { FIELD_MATCH_KIND } from "./field-match.js";

export const RULE_CONTEXT_IDS = [
	"library-cleanup",
	"auto-tag",
	"notifications",
	"queue-cleaner",
	"hunting",
] as const;

export type RuleContextId = (typeof RULE_CONTEXT_IDS)[number];

/**
 * The cleanup/auto-tag criteria vocabulary: every concrete kind from the
 * criteria enum. "composite" is excluded — composition is expressed by
 * grammar groups in v1, not by a kind.
 */
const CRITERIA_KINDS: ReadonlySet<string> = new Set(
	ruleTypeSchema.options.filter((k) => k !== "composite"),
);

/**
 * Kinds legal per context. Queue-cleaner and hunting register their
 * internal adapter kinds when those adapters land (§4 step 6); empty
 * sets here mean "no user-authored documents on this domain", which is
 * also the §5.3 product stance (their flat config UIs are permanent).
 */
export const CONTEXT_KINDS: Record<RuleContextId, ReadonlySet<string>> = {
	// Shared 52-kind vocabulary (the existing shared-evaluator
	// relationship, formalized). Auto-tag additionally registers
	// list-membership eval inputs on the behavior side.
	"library-cleanup": CRITERIA_KINDS,
	"auto-tag": CRITERIA_KINDS,
	// Intentionally tiny and event-shaped (§2.2).
	notifications: new Set([FIELD_MATCH_KIND]),
	"queue-cleaner": new Set<string>(),
	hunting: new Set<string>(),
};

/** Write-time strict check (tier 1). */
export function isKindLegalForContext(contextId: RuleContextId, kind: string): boolean {
	return CONTEXT_KINDS[contextId].has(kind);
}

/**
 * Sanity invariant: every criteria kind has a param schema. Exported so
 * a shared test can pin vocabulary/schema-map drift (the survey's count
 * went stale once already — §6.2).
 */
export function listKindsMissingParamSchemas(): string[] {
	return [...CRITERIA_KINDS].filter((k) => !(k in ruleParamSchemaMap));
}
