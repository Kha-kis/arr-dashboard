import type { NotificationRuleResponse } from "@arr/shared";
import { projectNotificationRules } from "./notification-list-projection";

function isRuleSaveTimestamp(value: string) {
	// The rule routes emit Date.toISOString(). Roundtrip also rejects calendar
	// rollover strings that Date.parse alone normalizes into a different date.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Admit and copy public metadata without applying creation policy to legacy
 * partial-update rows or treating request-name equality as save authority. */
export function projectNotificationRuleAcknowledgment(
	value: unknown,
	expectedId?: string,
): NotificationRuleResponse | undefined {
	const rule = projectNotificationRules([value])?.[0];
	if (
		!rule ||
		(expectedId !== undefined && rule.id !== expectedId) ||
		!isRuleSaveTimestamp(rule.createdAt) ||
		!isRuleSaveTimestamp(rule.updatedAt)
	)
		return undefined;
	return rule;
}
