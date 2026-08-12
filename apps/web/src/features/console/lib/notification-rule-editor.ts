/**
 * Pure notification composer state and v1↔editor↔v0 transforms. Notification
 * storage is a flat implicit-AND list, so the editor deliberately exposes no OR
 * mode and rejects empty documents under the current route contract.
 */

import {
	FIELD_MATCH_KIND,
	fieldMatchParamsSchema,
	isKindLegalForContext,
	isRuleNot,
	isRulePredicate,
	type RuleCondition,
	type RuleDocument,
	serializeNotificationsDocumentToV0,
	validateV1Depth,
} from "@arr/shared";

export interface NotificationEditorCondition {
	id: string;
	field: string;
	operator: string;
	value: unknown;
}

export interface NotificationEditorState {
	conditions: NotificationEditorCondition[];
}

export function buildNotificationDocument(state: NotificationEditorState): RuleDocument {
	return {
		version: 1,
		root: {
			all: state.conditions.map(({ field, operator, value }) => ({
				kind: FIELD_MATCH_KIND,
				params: { field, operator, value },
			})),
		},
	};
}

export function decomposeNotificationDocument(doc: RuleDocument): NotificationEditorState {
	const root = doc.root;
	if (isRuleNot(root)) {
		throw new Error("NOT expressions are not editable in notification v0 storage");
	}
	const nodes = isRulePredicate(root) ? [root] : "all" in root ? root.all : root.any;
	if (!nodes.every(isRulePredicate)) {
		throw new Error("Recursive expressions are not editable in notification v0 storage");
	}

	return {
		conditions: nodes.map((node, index) => ({
			id: `condition-${index}`,
			field: isRulePredicate(node) ? String(node.params.field ?? "") : "",
			operator: isRulePredicate(node) ? String(node.params.operator ?? "") : "",
			value: isRulePredicate(node) ? node.params.value : "",
		})),
	};
}

export function validateNotificationEditor(state: NotificationEditorState): string | null {
	if (state.conditions.length === 0) return "Add at least one condition.";

	const doc = buildNotificationDocument(state);
	const depthError = validateV1Depth(doc);
	if (depthError) return depthError;

	if (!isKindLegalForContext("notifications", FIELD_MATCH_KIND)) {
		return "Notification conditions are not available in this rule context.";
	}

	for (const [index, condition] of state.conditions.entries()) {
		const parsed = fieldMatchParamsSchema.safeParse(condition);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return `Condition ${index + 1}: ${issue?.message ?? "invalid field match"}.`;
		}
		if (typeof parsed.data.value === "string" && !parsed.data.value.trim()) {
			return `Condition ${index + 1}: enter a value.`;
		}
		if (Array.isArray(parsed.data.value) && parsed.data.value.length === 0) {
			return `Condition ${index + 1}: enter at least one value.`;
		}
	}

	return null;
}

export function toNotificationsV0Conditions(
	state: NotificationEditorState,
): { conditions: RuleCondition[]; error?: undefined } | { conditions?: undefined; error: string } {
	const error = validateNotificationEditor(state);
	if (error) return { error };
	return {
		conditions: serializeNotificationsDocumentToV0(buildNotificationDocument(state)).map(
			(condition) => fieldMatchParamsSchema.parse(condition),
		),
	};
}
