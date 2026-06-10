/**
 * Notification condition predicate — the single source of truth for
 * field_match operator semantics, in a LEAF module so both the legacy
 * RuleEngine and the unified-engine adapter (lib/rules/) import it
 * without a cycle.
 *
 * Documented sharp edge (the REAL one — an earlier survey claimed a
 * String(undefined)→"undefined" coercion that does not exist): an
 * ABSENT field fails EVERY operator, including `not_equals`. A rule
 * "metadata.instanceName not_equals X" does NOT match events that have
 * no instanceName at all. Preserved exactly; changing it is a semantic
 * break reserved for a future document-version bump.
 *
 * Operator semantics (preserved, §1.3.5): equals/not_equals are
 * case-SENSITIVE String comparisons; contains is case-INsensitive;
 * greater_than coerces both sides with Number(); in matches String()
 * of the field against a string array (non-array value → false).
 */

import type { NotificationPayload } from "./types.js";

export interface RuleCondition {
	field: string;
	operator: "equals" | "not_equals" | "contains" | "greater_than" | "in";
	value: string | number | string[];
}

export function matchNotificationCondition(
	payload: NotificationPayload,
	condition: RuleCondition,
): boolean {
	const fieldValue = getNotificationFieldValue(payload, condition.field);
	if (fieldValue === undefined) return false;

	switch (condition.operator) {
		case "equals":
			return String(fieldValue) === String(condition.value);
		case "not_equals":
			return String(fieldValue) !== String(condition.value);
		case "contains":
			return String(fieldValue).toLowerCase().includes(String(condition.value).toLowerCase());
		case "greater_than":
			return Number(fieldValue) > Number(condition.value);
		case "in":
			if (Array.isArray(condition.value)) {
				return condition.value.includes(String(fieldValue));
			}
			return false;
		default:
			return false;
	}
}

export function getNotificationFieldValue(payload: NotificationPayload, field: string): unknown {
	if (field === "eventType") return payload.eventType;
	if (field === "title") return payload.title;
	if (field === "body") return payload.body;
	if (field.startsWith("metadata.") && payload.metadata) {
		const key = field.slice("metadata.".length);
		return (payload.metadata as Record<string, unknown>)[key];
	}
	return undefined;
}
