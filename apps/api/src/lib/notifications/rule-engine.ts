/**
 * Rule Engine for notification filtering/routing.
 *
 * Evaluates user-defined rules against notification payloads.
 * Rules are evaluated in priority order (lower number = higher priority).
 * First matching rule wins.
 */

import type { NotificationPayload } from "./types.js";

export interface RuleCondition {
	field: string;
	operator: "equals" | "not_equals" | "contains" | "greater_than" | "in";
	value: string | number | string[];
}

export interface NotificationRule {
	id: string;
	enabled: boolean;
	priority: number;
	action: "suppress" | "throttle" | "route";
	conditions: RuleCondition[];
	targetChannelIds: string[] | null;
	throttleMinutes: number | null;
}

export interface RuleResult {
	action: "suppress" | "throttle" | "route";
	targetChannelIds?: string[];
	throttleMinutes?: number;
	ruleId: string;
}

export class RuleEngine {
	evaluate(payload: NotificationPayload, rules: NotificationRule[]): RuleResult | null {
		const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

		for (const rule of sorted) {
			if (this.matchesAllConditions(payload, rule.conditions)) {
				return {
					action: rule.action,
					targetChannelIds: rule.targetChannelIds ?? undefined,
					throttleMinutes: rule.throttleMinutes ?? undefined,
					ruleId: rule.id,
				};
			}
		}

		return null;
	}

	private matchesAllConditions(payload: NotificationPayload, conditions: RuleCondition[]): boolean {
		return conditions.every((cond) => this.matchCondition(payload, cond));
	}

	private matchCondition(payload: NotificationPayload, condition: RuleCondition): boolean {
		const fieldValue = this.getFieldValue(payload, condition.field);
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

	private getFieldValue(payload: NotificationPayload, field: string): unknown {
		if (field === "eventType") return payload.eventType;
		if (field === "title") return payload.title;
		if (field === "body") return payload.body;
		if (field.startsWith("metadata.") && payload.metadata) {
			const key = field.slice("metadata.".length);
			return (payload.metadata as Record<string, unknown>)[key];
		}
		return undefined;
	}
}
