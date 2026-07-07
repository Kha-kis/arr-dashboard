/**
 * v1 → v0 serializers — the WRITE-side inverse of v0-mappers.ts.
 *
 * The composer authors rules as a v1 RuleDocument in memory, but 3.0 stores
 * them in the EXISTING per-domain v0 columns (docs/design/unified-rule-grammar.md
 * §3: parse-time versioning, no eager rewrites — v0 storage stays permanently
 * valid, and the live evaluators keep reading it). So on save the composer
 * down-converts the document to the v0 payload the existing routes accept, and
 * these functions are that down-conversion.
 *
 * They produce the API PAYLOAD shape (params/conditions as OBJECTS, not the
 * stringified storage form) — the same shape the per-domain dialogs already
 * POST. Round-trip parity with the mappers is the correctness contract:
 * `serialize(map(v0)) === v0` and `map(serialize(v1)) === v1` for every
 * authorable rule (see __tests__/v1-serializer.test.ts).
 *
 * v1 is depth-1 (§2.1), so a composite's children must all be predicates;
 * a nested group throws. Empty groups also throw: an empty composite is not a
 * meaningful authored rule and would serialize to a no-op `{kind:"composite"}`
 * / `{all:[]}` shape — the form must reject it before it reaches here.
 */

import { FIELD_MATCH_KIND } from "./field-match.js";
import {
	groupChildren,
	isRulePredicate,
	type RuleDocument,
	type RulePredicate,
} from "./grammar.js";

export class V1SerializerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V1SerializerError";
	}
}

// ── Criteria surface (library-cleanup / auto-tag) ───────────────────

/** The v0 API payload for a cleanup/auto-tag rule's condition half. */
export interface CriteriaV0Payload {
	ruleType: string;
	parameters: Record<string, unknown>;
	operator: "AND" | "OR" | null;
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null;
}

/**
 * Down-convert a criteria (cleanup/auto-tag) document to its v0 payload.
 * - predicate root → single rule `{ ruleType, parameters, operator:null, conditions:null }`
 * - group root     → composite `{ ruleType:"composite", parameters:{}, operator, conditions[] }`
 */
export function serializeCriteriaDocumentToV0(doc: RuleDocument): CriteriaV0Payload {
	const root = doc.root;

	if (isRulePredicate(root)) {
		return {
			ruleType: root.kind,
			parameters: root.params,
			operator: null,
			conditions: null,
		};
	}

	const children = groupChildren(root);
	if (children.length === 0) {
		throw new V1SerializerError("composite rule has no conditions");
	}

	const conditions = children.map((child, i) => {
		if (!isRulePredicate(child)) {
			throw new V1SerializerError(
				`composite condition[${i}] is a nested group — v1 rules are depth-1`,
			);
		}
		return { ruleType: child.kind, parameters: child.params };
	});

	return {
		ruleType: "composite",
		parameters: {},
		operator: "all" in root ? "AND" : "OR",
		conditions,
	};
}

// ── Notifications surface ───────────────────────────────────────────

/** A v0 notification condition (flat implicit-AND element). */
export interface NotificationV0Condition {
	field: string;
	operator: string;
	value: unknown;
}

/**
 * Down-convert a notifications document to its flat v0 conditions array.
 *
 * v0 notifications are an implicit-AND list of `{ field, operator, value }`, so
 * the document root is expected to be an `all` group of `field_match`
 * predicates (or a lone `field_match` predicate). An `any` (OR) group has no v0
 * representation and is rejected — OR isn't authorable for notifications in v1.
 * An empty `all` group serializes to `[]` (matches every event — the one legal
 * empty case, preserved from 2.x).
 */
export function serializeNotificationsDocumentToV0(doc: RuleDocument): NotificationV0Condition[] {
	const root = doc.root;

	let predicates: RulePredicate[];
	if (isRulePredicate(root)) {
		predicates = [root];
	} else if ("all" in root) {
		predicates = root.all.map((child, i) => {
			if (!isRulePredicate(child)) {
				throw new V1SerializerError(
					`notification condition[${i}] is a nested group — not representable in v0`,
				);
			}
			return child;
		});
	} else {
		throw new V1SerializerError(
			"notification rules use implicit AND; an 'any' (OR) group is not representable in v0",
		);
	}

	return predicates.map((p, i) => {
		if (p.kind !== FIELD_MATCH_KIND) {
			throw new V1SerializerError(
				`notification condition[${i}] must be a ${FIELD_MATCH_KIND} predicate, got "${p.kind}"`,
			);
		}
		const field = p.params.field;
		const operator = p.params.operator;
		if (typeof field !== "string" || typeof operator !== "string") {
			throw new V1SerializerError(`notification condition[${i}] missing field/operator`);
		}
		return { field, operator, value: p.params.value };
	});
}
