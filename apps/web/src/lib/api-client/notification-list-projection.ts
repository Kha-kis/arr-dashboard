import type {
	NotificationChannelResponse,
	NotificationRuleResponse,
	RuleCondition,
} from "@arr/shared";

type PublicChannel = NotificationChannelResponse & {
	lastSentAt?: string | null;
	lastSendResult?: "success" | "failed" | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const item of value) {
		if (typeof item !== "string") return false;
	}
	return true;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isChannelTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isPublicStatus(value: unknown): value is "success" | "failed" | null {
	return value === null || value === "success" || value === "failed";
}

/** Admit the complete ordinary read before publishing fresh public metadata.
 * Legacy string tags are preserved; they do not establish mutation authority. */
export function projectNotificationChannels(
	value: unknown,
): NotificationChannelResponse[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const channels: PublicChannel[] = [];
	const ids = new Set<string>();
	for (const row of value) {
		if (
			!isRecord(row) ||
			!isNonblankString(row.id) ||
			ids.has(row.id) ||
			typeof row.name !== "string" ||
			row.name.length === 0 ||
			!isNonblankString(row.type) ||
			typeof row.enabled !== "boolean" ||
			!isChannelTimestamp(row.createdAt) ||
			!isChannelTimestamp(row.updatedAt) ||
			(row.lastTestedAt !== null && !isChannelTimestamp(row.lastTestedAt)) ||
			!isPublicStatus(row.lastTestResult) ||
			!isStringArray(row.subscriptions) ||
			!row.subscriptions.every(isNonblankString) ||
			(row.lastSentAt !== undefined &&
				row.lastSentAt !== null &&
				!isChannelTimestamp(row.lastSentAt)) ||
			(row.lastSendResult !== undefined && !isPublicStatus(row.lastSendResult))
		) {
			return undefined;
		}
		ids.add(row.id);
		const channel: PublicChannel = {
			id: row.id,
			name: row.name,
			// The read contract retains nonblank historical tags beyond creation enums.
			type: row.type as NotificationChannelResponse["type"],
			enabled: row.enabled,
			lastTestedAt: row.lastTestedAt,
			lastTestResult: row.lastTestResult,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			subscriptions: [...row.subscriptions] as NotificationChannelResponse["subscriptions"],
		};
		if (row.lastSentAt !== undefined) channel.lastSentAt = row.lastSentAt;
		if (row.lastSendResult !== undefined) channel.lastSendResult = row.lastSendResult;
		channels.push(channel);
	}
	return channels;
}

function isRuleAction(value: unknown): value is NotificationRuleResponse["action"] {
	return (
		value === "suppress" || value === "throttle" || value === "route" || value === "quiet_hours"
	);
}

function isConditionOperator(value: unknown): value is RuleCondition["operator"] {
	return (
		value === "equals" ||
		value === "not_equals" ||
		value === "contains" ||
		value === "greater_than" ||
		value === "in"
	);
}

function projectConditions(value: unknown): RuleCondition[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const conditions: RuleCondition[] = [];
	for (const condition of value) {
		if (
			!isRecord(condition) ||
			typeof condition.field !== "string" ||
			!isConditionOperator(condition.operator) ||
			!(
				typeof condition.value === "string" ||
				isFiniteNumber(condition.value) ||
				isStringArray(condition.value)
			)
		) {
			return undefined;
		}
		conditions.push({
			field: condition.field,
			operator: condition.operator,
			value: Array.isArray(condition.value) ? [...condition.value] : condition.value,
		});
	}
	return conditions;
}

/** Structural read admission is deliberately not rule creation-policy validation. */
export function projectNotificationRules(value: unknown): NotificationRuleResponse[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rules: NotificationRuleResponse[] = [];
	const ids = new Set<string>();
	for (const row of value) {
		if (
			!isRecord(row) ||
			!isNonblankString(row.id) ||
			ids.has(row.id) ||
			typeof row.name !== "string" ||
			typeof row.enabled !== "boolean" ||
			!isFiniteNumber(row.priority) ||
			!isRuleAction(row.action) ||
			(row.targetChannelIds !== null && !isStringArray(row.targetChannelIds)) ||
			(row.throttleMinutes !== null && !isFiniteNumber(row.throttleMinutes)) ||
			(row.quietHoursStart !== null && typeof row.quietHoursStart !== "string") ||
			(row.quietHoursEnd !== null && typeof row.quietHoursEnd !== "string") ||
			(row.quietHoursTimezone !== null && typeof row.quietHoursTimezone !== "string") ||
			typeof row.createdAt !== "string" ||
			typeof row.updatedAt !== "string"
		) {
			return undefined;
		}
		const conditions = projectConditions(row.conditions);
		if (conditions === undefined) return undefined;
		ids.add(row.id);
		rules.push({
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			priority: row.priority,
			action: row.action,
			conditions,
			targetChannelIds: row.targetChannelIds === null ? null : [...row.targetChannelIds],
			throttleMinutes: row.throttleMinutes,
			quietHoursStart: row.quietHoursStart,
			quietHoursEnd: row.quietHoursEnd,
			quietHoursTimezone: row.quietHoursTimezone,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});
	}
	return rules;
}
