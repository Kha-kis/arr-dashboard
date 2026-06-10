/**
 * Unified rule grammar — data layer (docs/design/unified-rule-grammar.md).
 *
 * Grammar types + per-kind Zod schemas + context registry. Behavior
 * (evaluators, v0 mappers, eval-input builders) lives in
 * apps/api/src/lib/rules/ per §5.1 — the frontend consumes only this
 * data half (composer palette, validation, labels).
 */

export * from "./contexts.js";
export * from "./criteria.js";
export * from "./field-match.js";
export * from "./grammar.js";
