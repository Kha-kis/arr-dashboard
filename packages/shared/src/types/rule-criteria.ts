/**
 * Compatibility shim — the criteria vocabulary moved to
 * `packages/shared/src/rules/criteria.ts` as part of the unified rule
 * grammar (Bucket A4, docs/design/unified-rule-grammar.md §5.1: the
 * rules module SUBSUMES rule-criteria.ts rather than paralleling it).
 *
 * Existing imports keep working through this re-export; new code should
 * import from the rules module (everything is also surfaced through the
 * @arr/shared barrel either way).
 */
export * from "../rules/criteria.js";
