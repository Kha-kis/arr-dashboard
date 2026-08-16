/**
 * Unified rule grammar — serialization v1.
 *
 * docs/design/unified-rule-grammar.md §2.1. One predicate shape
 * (kind + params) composed by all/any/not nodes, wrapped in a versioned
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

export type RuleNot = { not: RuleNode };

export type RuleGroup = { all: RuleNode[] } | { any: RuleNode[] };

export type RuleNode = RulePredicate | RuleGroup | RuleNot;

/** The stored document envelope (per rule row, in existing JSON columns). */
export interface RuleDocument {
	version: 1;
	root: RuleNode;
}

// ============================================================================
// Zod schemas (structural — see header note on kind-legality)
// ============================================================================

export const rulePredicateSchema: z.ZodType<RulePredicate> = z
	.object({
		kind: z.string().min(1),
		params: z.record(z.string(), z.unknown()),
		unavailableKind: z.boolean().optional(),
	})
	.strict();

export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
	z.union([rulePredicateSchema, ruleGroupSchema, ruleNotSchema]),
);

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
	z.union([
		z.object({ all: z.array(ruleNodeSchema) }).strict(),
		z.object({ any: z.array(ruleNodeSchema) }).strict(),
	]),
);

export const ruleNotSchema: z.ZodType<RuleNot> = z.lazy(() =>
	z.object({ not: ruleNodeSchema }).strict(),
);

export const RULE_DOCUMENT_V1_MAX_DEPTH = 8;
export const RULE_DOCUMENT_V1_MAX_NODES = 64;

interface RuleDocumentInspection {
	error: string | null;
	maxDepth: number;
	nodeCount: number;
}

interface RuleDocumentInspectionLimits {
	maxDepth: number;
	maxNodes: number;
}

type RuleNodeWork =
	| { action: "enter"; value: unknown; depth: number; path: string }
	| { action: "exit"; value: object };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

/**
 * Validate and measure the recursive tree without recursive function calls.
 * The ancestor set detects cycles while still allowing a shared acyclic node
 * object to appear in separate branches (equivalent to duplicated JSON).
 */
function inspectRuleDocument(
	value: unknown,
	limits: RuleDocumentInspectionLimits,
): RuleDocumentInspection {
	const invalid = (error: string, maxDepth = 0, nodeCount = 0): RuleDocumentInspection => ({
		error,
		maxDepth,
		nodeCount,
	});

	if (!isRecord(value) || !hasExactKeys(value, ["version", "root"])) {
		return invalid("Rule document envelope must contain exactly version and root");
	}
	if (value.version !== 1) return invalid("Rule document version must be 1");

	const ancestors = new Set<object>();
	const stack: RuleNodeWork[] = [{ action: "enter", value: value.root, depth: 0, path: "root" }];
	let maxDepth = 0;
	let nodeCount = 0;

	while (stack.length > 0) {
		const work = stack.pop();
		if (!work) break;
		if (work.action === "exit") {
			ancestors.delete(work.value);
			continue;
		}

		const node = work.value;
		if (!isRecord(node)) {
			return invalid(`${work.path} must be a rule node object`, maxDepth, nodeCount);
		}
		if (ancestors.has(node)) {
			return invalid(`${work.path} contains a cycle`, maxDepth, nodeCount);
		}

		const isPredicate = Object.hasOwn(node, "kind");
		const isAll = Object.hasOwn(node, "all");
		const isAny = Object.hasOwn(node, "any");
		const isNot = Object.hasOwn(node, "not");
		const variantCount = Number(isPredicate) + Number(isAll) + Number(isAny) + Number(isNot);
		if (variantCount !== 1) {
			return invalid(
				`${work.path} must contain exactly one of kind, all, any, or not`,
				maxDepth,
				nodeCount,
			);
		}

		const currentDepth = isPredicate ? work.depth : work.depth + 1;
		maxDepth = Math.max(maxDepth, currentDepth);
		nodeCount += 1;
		if (maxDepth > limits.maxDepth) {
			return invalid(
				`Rule document exceeds v1 depth limit (${maxDepth} > ${limits.maxDepth})`,
				maxDepth,
				nodeCount,
			);
		}
		if (nodeCount > limits.maxNodes) {
			return invalid(
				`Rule document exceeds v1 node limit (${nodeCount} > ${limits.maxNodes})`,
				maxDepth,
				nodeCount,
			);
		}

		ancestors.add(node);
		stack.push({ action: "exit", value: node });

		if (isPredicate) {
			if (!hasExactKeys(node, ["kind", "params"], ["unavailableKind"])) {
				return invalid(`${work.path} predicate has unexpected fields`, maxDepth, nodeCount);
			}
			if (typeof node.kind !== "string" || node.kind.length === 0) {
				return invalid(`${work.path}.kind must be a non-empty string`, maxDepth, nodeCount);
			}
			if (!isRecord(node.params)) {
				return invalid(`${work.path}.params must be an object`, maxDepth, nodeCount);
			}
			if (Object.hasOwn(node, "unavailableKind") && typeof node.unavailableKind !== "boolean") {
				return invalid(`${work.path}.unavailableKind must be a boolean`, maxDepth, nodeCount);
			}
			continue;
		}

		if (isNot) {
			if (!hasExactKeys(node, ["not"])) {
				return invalid(`${work.path} NOT node has unexpected fields`, maxDepth, nodeCount);
			}
			stack.push({
				action: "enter",
				value: node.not,
				depth: work.depth + 1,
				path: `${work.path}.not`,
			});
			continue;
		}

		const key = isAll ? "all" : "any";
		if (!hasExactKeys(node, [key])) {
			return invalid(`${work.path} ${key} node has unexpected fields`, maxDepth, nodeCount);
		}
		const children = node[key];
		if (!Array.isArray(children)) {
			return invalid(`${work.path}.${key} must be an array`, maxDepth, nodeCount);
		}
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push({
				action: "enter",
				value: children[index],
				depth: work.depth + 1,
				path: `${work.path}.${key}[${index}]`,
			});
		}
	}

	return { error: null, maxDepth, nodeCount };
}

const boundedRuleDocumentSchema = z
	.unknown()
	.superRefine((value, ctx) => {
		const inspection = inspectRuleDocument(value, {
			maxDepth: RULE_DOCUMENT_V1_MAX_DEPTH,
			maxNodes: RULE_DOCUMENT_V1_MAX_NODES,
		});
		if (inspection.error) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: inspection.error });
		}
	})
	.transform((value) => value as RuleDocument);

/** Strict, cycle-safe, bounded parser for stored rule documents. */
export const ruleDocumentSchema: z.ZodType<RuleDocument> = boundedRuleDocumentSchema;

// ============================================================================
// Node helpers
// ============================================================================

export function isRuleGroup(node: RuleNode): node is RuleGroup {
	return "all" in node || "any" in node;
}

export function isRulePredicate(node: RuleNode): node is RulePredicate {
	return "kind" in node;
}

export function isRuleNot(node: RuleNode): node is RuleNot {
	return "not" in node;
}

/**
 * Children of a composition node. NOT remains a distinct node variant but is
 * exposed as a one-child composition for generic tree walkers.
 */
export function groupChildren(group: RuleGroup | RuleNot): RuleNode[] {
	if ("all" in group) return group.all;
	if ("any" in group) return group.any;
	return [group.not];
}

/** Depth of a node tree; a bare predicate is depth 0, one group level is 1. */
export function nodeDepth(node: RuleNode): number {
	const inspection = inspectRuleDocument(
		{ version: 1, root: node },
		{ maxDepth: Number.POSITIVE_INFINITY, maxNodes: Number.POSITIVE_INFINITY },
	);
	if (inspection.error) throw new TypeError(inspection.error);
	return inspection.maxDepth;
}

/**
 * Recursive v1 documents are bounded at write/parse boundaries. Kind legality
 * remains permissive so retired predicates can be annotated and safely
 * no-match rather than discarded or rewritten.
 */
export function validateV1Depth(doc: RuleDocument): string | null {
	return inspectRuleDocument(doc, {
		maxDepth: RULE_DOCUMENT_V1_MAX_DEPTH,
		maxNodes: Number.POSITIVE_INFINITY,
	}).error;
}

/** Count every predicate and composition node in a document tree. */
export function nodeCount(node: RuleNode): number {
	const inspection = inspectRuleDocument(
		{ version: 1, root: node },
		{ maxDepth: Number.POSITIVE_INFINITY, maxNodes: Number.POSITIVE_INFINITY },
	);
	if (inspection.error) throw new TypeError(inspection.error);
	return inspection.nodeCount;
}

/** Apply both v1 recursion guards at a storage or write boundary. */
export function validateV1Bounds(doc: RuleDocument): string | null {
	return inspectRuleDocument(doc, {
		maxDepth: RULE_DOCUMENT_V1_MAX_DEPTH,
		maxNodes: RULE_DOCUMENT_V1_MAX_NODES,
	}).error;
}

/** Walk every predicate in a document (depth-first). */
export function* walkPredicates(node: RuleNode): Generator<RulePredicate> {
	if (isRulePredicate(node)) {
		yield node;
		return;
	}
	if (isRuleNot(node)) {
		yield* walkPredicates(node.not);
		return;
	}
	for (const child of groupChildren(node)) {
		yield* walkPredicates(child);
	}
}
