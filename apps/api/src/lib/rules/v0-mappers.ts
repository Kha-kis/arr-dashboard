/**
 * v0 → v1 document mappers — the parse-time versioning core
 * (docs/design/unified-rule-grammar.md §3).
 *
 * Format unification never rewrites stored rows. These mappers convert
 * legacy (v0) rule documents to grammar nodes IN MEMORY at load time;
 * rows are written in v1 only when created or edited (lazy
 * convergence). All v0 shape knowledge is quarantined here — nothing
 * outside this module should ever inspect a legacy document.
 *
 * The three legacy shapes (§1):
 *   - cleanup/auto-tag SINGLE:    ruleType + parameters JSON
 *   - cleanup/auto-tag COMPOSITE: ruleType="composite" + operator
 *                                 ("AND"|"OR") + conditions JSON array
 *                                 of { ruleType, parameters }
 *   - notifications:              conditions JSON array of
 *                                 { field, operator, value } — flat
 *                                 implicit AND
 *
 * Mapping is purely STRUCTURAL (§2.2 tier 2): retired kinds (e.g. a
 * disabled tautulli_* rule whose document the 3.0 pass deliberately
 * preserved) map like any other — annotation and no-match handling are
 * the engine's job, never the mapper's.
 */

import {
	FIELD_MATCH_KIND,
	type RuleDocument,
	type RuleNode,
	ruleDocumentSchema,
} from "@arr/shared";

// ============================================================================
// Version detection
// ============================================================================

export type DetectedVersion = "v1" | "v0-criteria" | "v0-notifications" | "unrecognized";

/**
 * Detect the serialization version of a parsed JSON value.
 *
 * v1 documents are self-describing (`version: 1`). Legacy shapes are
 * detected structurally: top-level `ruleType` (criteria single rule),
 * or a bare array (notifications conditions / criteria composite
 * conditions are both arrays — callers know which surface they hold).
 */
export function detectDocumentVersion(value: unknown): DetectedVersion {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		if (obj.version === 1) return "v1";
		if (typeof obj.ruleType === "string") return "v0-criteria";
		return "unrecognized";
	}
	if (Array.isArray(value)) return "v0-notifications";
	return "unrecognized";
}

// ============================================================================
// Criteria surface (library-cleanup / auto-tag)
// ============================================================================

/** The v0 row fields the mapper needs (matches both rule tables). */
export interface CriteriaV0Row {
	ruleType: string;
	/** JSON object string (may be "{}"). */
	parameters: string;
	/** "AND" | "OR" for composite rules. */
	operator: string | null;
	/** JSON array string of { ruleType, parameters } for composite rules. */
	conditions: string | null;
}

export class V0MapperError extends Error {
	constructor(
		message: string,
		public readonly detail?: unknown,
	) {
		super(message);
		this.name = "V0MapperError";
	}
}

function parseJsonObject(raw: string, what: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new V0MapperError(`${what} is not valid JSON`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new V0MapperError(`${what} is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Map a cleanup/auto-tag v0 row to a v1 document (near-identity, §3).
 *
 * - Single rule  → { version: 1, root: { kind, params } }
 * - Composite    → { version: 1, root: { all|any: [predicates…] } }
 *
 * Throws V0MapperError on structurally unparseable documents — callers
 * (the engine / normalizers) translate that to the same "unparseable"
 * handling the Tautulli pass used: rule untouched, surfaced, never a
 * crashed boot or a 500'd list.
 */
export function mapCriteriaV0ToDocument(row: CriteriaV0Row): RuleDocument {
	if (row.ruleType !== "composite") {
		const doc: RuleDocument = {
			version: 1,
			root: {
				kind: row.ruleType,
				params: parseJsonObject(row.parameters || "{}", "rule parameters"),
			},
		};
		return ruleDocumentSchema.parse(doc);
	}

	if (row.operator !== "AND" && row.operator !== "OR") {
		throw new V0MapperError(`composite rule has invalid operator: ${String(row.operator)}`);
	}

	let conditions: unknown;
	try {
		conditions = JSON.parse(row.conditions ?? "");
	} catch {
		throw new V0MapperError("composite conditions is not valid JSON");
	}
	if (!Array.isArray(conditions)) {
		throw new V0MapperError("composite conditions is not an array");
	}

	const children: RuleNode[] = conditions.map((cond, i) => {
		if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
			throw new V0MapperError(`composite condition[${i}] is not an object`);
		}
		const c = cond as Record<string, unknown>;
		if (typeof c.ruleType !== "string" || c.ruleType.length === 0) {
			throw new V0MapperError(`composite condition[${i}] has no ruleType`);
		}
		const params = c.parameters;
		if (params === null || typeof params !== "object" || Array.isArray(params)) {
			throw new V0MapperError(`composite condition[${i}] has invalid parameters`);
		}
		return { kind: c.ruleType, params: params as Record<string, unknown> };
	});

	const doc: RuleDocument = {
		version: 1,
		root: row.operator === "AND" ? { all: children } : { any: children },
	};
	return ruleDocumentSchema.parse(doc);
}

// ============================================================================
// Notifications surface
// ============================================================================

/**
 * Map a notifications v0 conditions array to a v1 document.
 *
 * v0 is a flat implicit-AND array of { field, operator, value } (§1.2);
 * v1 expresses that as one `all` group of `field_match` predicates. An
 * EMPTY conditions array is legal in 2.x (rule matches every event) and
 * maps to `{ all: [] }`, which evaluates vacuously true — semantics
 * preserved.
 */
export function mapNotificationsV0ToDocument(conditions: unknown): RuleDocument {
	if (!Array.isArray(conditions)) {
		throw new V0MapperError("notification conditions is not an array");
	}

	const children: RuleNode[] = conditions.map((cond, i) => {
		if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
			throw new V0MapperError(`notification condition[${i}] is not an object`);
		}
		const c = cond as Record<string, unknown>;
		if (typeof c.field !== "string" || typeof c.operator !== "string") {
			throw new V0MapperError(`notification condition[${i}] missing field/operator`);
		}
		// Structural mapping only — operator/value validity is the write
		// path's job for new documents; stored v0 values pass through so
		// evaluation can reproduce 2.x behavior exactly.
		return {
			kind: FIELD_MATCH_KIND,
			params: { field: c.field, operator: c.operator, value: c.value },
		};
	});

	const doc: RuleDocument = { version: 1, root: { all: children } };
	return ruleDocumentSchema.parse(doc);
}
