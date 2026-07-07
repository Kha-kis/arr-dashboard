/**
 * Composer authoring — the pure state layer for editing a criteria (library-
 * cleanup / auto-tag) rule's CONDITION half as a v1 {@link RuleDocument}.
 *
 * The composer edits an in-memory v1 document, then down-converts to the v0
 * payload the existing per-domain routes accept (docs/design/unified-rule-
 * grammar.md §3; serializer = packages/shared/src/rules/v1-serializer.ts). This
 * module owns the ergonomic middle: a flat editor state the UI binds to, the
 * two transforms between it and a RuleDocument, and the strict write-time
 * validation choke point.
 *
 * Validation is the FIRST line of the write path (the serializer is the last):
 * depth ≤ 1, every predicate kind legal for the context, params satisfy the
 * kind's schema, and — fix (c) — an empty composite is rejected here at the
 * form so the write path never emits a no-op `{kind:"composite"}` / `{all:[]}`.
 *
 * Deliberately React-free so it unit-tests without a DOM. `getDefaultCondition
 * Params` (the per-kind seed) lives in the UI layer; this module never seeds.
 */

import {
	type CriteriaV0Payload,
	isKindLegalForContext,
	isRulePredicate,
	type RuleContextId,
	type RuleDocument,
	type RuleNode,
	ruleParamSchemaMap,
	serializeCriteriaDocumentToV0,
	validateV1Depth,
} from "@arr/shared";
import { humanizeKind } from "./describe-predicate";

// ── Editor state ────────────────────────────────────────────────────

/** One authored predicate row. `id` is a stable React key, never serialized. */
export interface EditorCondition {
	id: string;
	kind: string;
	params: Record<string, unknown>;
}

/**
 * Single = a lone predicate (v0 `operator`/`conditions` are null). Composite =
 * an all/any group. Mirrors the existing cleanup dialog's isComposite +
 * compositeOperator + conditions[] shape, so the reused ConditionParamsFields
 * binds unchanged.
 */
export type EditorMode = "single" | "composite";

export interface CriteriaEditorState {
	mode: EditorMode;
	/** all = AND, any = OR. Only meaningful in composite mode. */
	operator: "all" | "any";
	conditions: EditorCondition[];
}

// ── Transforms ──────────────────────────────────────────────────────

/**
 * Editor state → v1 document. Single mode uses the first condition as the root
 * predicate; composite wraps the conditions in an all/any group. Callers must
 * validate first ({@link validateCriteriaEditor}); this assumes a well-formed
 * state (single has ≥1 condition).
 */
export function buildCriteriaDocument(state: CriteriaEditorState): RuleDocument {
	if (state.mode === "single") {
		const first = state.conditions[0];
		return {
			version: 1,
			root: { kind: first?.kind ?? "", params: first?.params ?? {} },
		};
	}

	const children: RuleNode[] = state.conditions.map((c) => ({ kind: c.kind, params: c.params }));
	return {
		version: 1,
		root: state.operator === "all" ? { all: children } : { any: children },
	};
}

/**
 * v1 document → editor state (edit prefill). A predicate root is single mode; a
 * group is composite with operator + child predicates. Retired-kind predicates
 * (annotated `unavailableKind` by the read API) are KEPT verbatim so the edit
 * preserves them — validation later forces the operator to fix them before save
 * rather than silently dropping a condition.
 */
export function decomposeCriteriaDocument(doc: RuleDocument): CriteriaEditorState {
	const root = doc.root;
	if (isRulePredicate(root)) {
		return {
			mode: "single",
			operator: "all",
			conditions: [{ id: "cond-0", kind: root.kind, params: root.params }],
		};
	}

	const isAll = "all" in root;
	const children = isAll ? root.all : root.any;
	return {
		mode: "composite",
		operator: isAll ? "all" : "any",
		conditions: children.map((child, i) => ({
			id: `cond-${i}`,
			// Depth-1: children are predicates. A stray nested group (shouldn't
			// occur from the read API) collapses to an empty predicate row that
			// validation then flags.
			kind: isRulePredicate(child) ? child.kind : "",
			params: isRulePredicate(child) ? child.params : {},
		})),
	};
}

// ── Validation (the write-path first line) ──────────────────────────

/**
 * Strict pre-serialize validation for a criteria editor state under its
 * context. Returns the first human-readable error, or null when the state is a
 * legal, serializable rule.
 *
 * Order: structural (condition counts / empty composite = fix c) → depth →
 * per-predicate kind legality (tier-1 write-strict, §2.2) → per-predicate param
 * schema. Mirrors the server's own write-time checks (defense in depth).
 */
export function validateCriteriaEditor(
	state: CriteriaEditorState,
	context: RuleContextId,
): string | null {
	// Structural — an authored rule must actually match something.
	if (state.mode === "single") {
		const first = state.conditions[0];
		if (!first || !first.kind) return "Choose a condition type.";
	} else if (state.conditions.length === 0) {
		// Fix (c): reject the empty composite at the form, before the serializer's
		// last-line guard. An empty group serializes to a no-op that never matches.
		return "Add at least one condition, or switch to a single condition.";
	}

	const doc = buildCriteriaDocument(state);

	const depthError = validateV1Depth(doc);
	if (depthError) return depthError;

	// Per-predicate legality + params.
	const nodes: EditorCondition[] = state.conditions;
	for (const cond of nodes) {
		const label = cond.kind ? humanizeKind(cond.kind) : "This condition";
		if (!cond.kind) return "Choose a type for every condition.";
		if (!isKindLegalForContext(context, cond.kind)) {
			return `"${label}" is not available for this rule type — remove or replace it.`;
		}
		const schema = ruleParamSchemaMap[cond.kind];
		if (schema) {
			const result = schema.safeParse(cond.params);
			if (!result.success) {
				const issue = result.error.issues[0];
				const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
				const message = issue?.message ?? "invalid parameters";
				return `${label}: ${message}${where}.`;
			}
		}
	}

	return null;
}

/**
 * Convenience for the save path: validate, then down-convert to the v0 payload
 * the per-domain create/update routes accept. Returns either the payload or the
 * first validation error — never both.
 */
export function toCriteriaV0Payload(
	state: CriteriaEditorState,
	context: RuleContextId,
): { payload: CriteriaV0Payload; error?: undefined } | { payload?: undefined; error: string } {
	const error = validateCriteriaEditor(state, context);
	if (error) return { error };
	return { payload: serializeCriteriaDocumentToV0(buildCriteriaDocument(state)) };
}
