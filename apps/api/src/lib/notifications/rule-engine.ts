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
	action: "suppress" | "throttle" | "route" | "quiet_hours";
	conditions: RuleCondition[];
	targetChannelIds: string[] | null;
	throttleMinutes: number | null;
	quietHoursStart: string | null;
	quietHoursEnd: string | null;
	quietHoursTimezone: string | null;
}

export interface RuleResult {
	action: "suppress" | "throttle" | "route" | "quiet_hours" | "defer";
	targetChannelIds?: string[];
	throttleMinutes?: number;
	/** For defer action: when the quiet hours window ends (ISO string) */
	deferUntil?: string;
	ruleId: string;
}

/** Events that always bypass quiet hours — security and system-critical */
const CRITICAL_EVENT_TYPES = new Set([
	"SYSTEM_ERROR",
	"SYSTEM_STARTUP",
	"ACCOUNT_LOCKED",
	"LOGIN_FAILED",
	"SERVICE_CONNECTION_FAILED",
	"BACKUP_FAILED",
]);

export class RuleEngine {
	evaluate(payload: NotificationPayload, rules: NotificationRule[]): RuleResult | null {
		const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

		for (const rule of sorted) {
			if (this.matchesAllConditions(payload, rule.conditions)) {
				// Quiet hours: defer non-critical events, let critical events through
				if (rule.action === "quiet_hours") {
					if (
						rule.quietHoursStart &&
						rule.quietHoursEnd &&
						isWithinQuietHours(rule.quietHoursStart, rule.quietHoursEnd, rule.quietHoursTimezone)
					) {
						// Critical events always bypass quiet hours
						if (CRITICAL_EVENT_TYPES.has(payload.eventType)) {
							continue; // Skip this rule, let the notification through
						}
						// Non-critical: defer until quiet hours end
						return {
							action: "defer",
							deferUntil: computeDeferUntil(rule.quietHoursEnd, rule.quietHoursTimezone),
							ruleId: rule.id,
						};
					}
					// Outside quiet hours — rule doesn't match, continue to next rule
					continue;
				}

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

/**
 * Check if the current time falls within a quiet hours window.
 * Handles overnight ranges (e.g., 22:00 → 06:00) correctly.
 */
/**
 * Check if the current time falls within a quiet hours window.
 * Handles overnight ranges (e.g., 22:00 → 06:00) correctly.
 *
 * Fails CLOSED (returns true = suppress) when configuration is broken,
 * because the user explicitly asked not to be disturbed.
 */
function isWithinQuietHours(start: string, end: string, timezone: string | null): boolean {
	try {
		// Get current time in the specified timezone
		const now = new Date();
		const formatter = new Intl.DateTimeFormat("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: timezone ?? "UTC",
		});
		const parts = formatter.formatToParts(now);
		const hourPart = parts.find((p) => p.type === "hour")?.value;
		const minutePart = parts.find((p) => p.type === "minute")?.value;
		if (!hourPart || !minutePart) return true; // Can't determine time — fail closed
		const currentMinutes = Number(hourPart) * 60 + Number(minutePart);

		// Parse and validate start/end times as minutes-since-midnight
		const startParts = start.split(":").map(Number);
		const endParts = end.split(":").map(Number);
		const startH = startParts[0];
		const startM = startParts[1];
		const endH = endParts[0];
		const endM = endParts[1];
		if (
			startH === undefined || startM === undefined ||
			endH === undefined || endM === undefined ||
			!Number.isFinite(startH) || !Number.isFinite(startM) ||
			!Number.isFinite(endH) || !Number.isFinite(endM) ||
			startH < 0 || startH > 23 || startM < 0 || startM > 59 ||
			endH < 0 || endH > 23 || endM < 0 || endM > 59
		) {
			return true; // Malformed time config — fail closed
		}
		const startMinutes = startH * 60 + startM;
		const endMinutes = endH * 60 + endM;

		// Handle overnight range (e.g., 22:00 → 06:00)
		if (startMinutes <= endMinutes) {
			// Same-day range (e.g., 09:00 → 17:00)
			return currentMinutes >= startMinutes && currentMinutes < endMinutes;
		}
		// Overnight range (e.g., 22:00 → 06:00)
		return currentMinutes >= startMinutes || currentMinutes < endMinutes;
	} catch {
		// Invalid timezone or other error — fail closed (suppress notification)
		// The user explicitly configured quiet hours, so suppressing is safer than notifying.
		return true;
	}
}

/**
 * Compute an ISO timestamp for when quiet hours end (next occurrence of the end time).
 * Timezone-aware: converts the user's local end time to a UTC timestamp.
 */
function computeDeferUntil(endTime: string, timezone: string | null): string {
	try {
		const endParts = endTime.split(":").map(Number);
		const endH = endParts[0];
		const endM = endParts[1];
		if (endH === undefined || endM === undefined || !Number.isFinite(endH) || !Number.isFinite(endM)) {
			return new Date(Date.now() + 8 * 60 * 60_000).toISOString();
		}

		// Get the current time in the user's timezone to compute offset
		const tz = timezone ?? "UTC";
		const now = new Date();
		const formatter = new Intl.DateTimeFormat("en-US", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: tz,
		});
		const parts = formatter.formatToParts(now);
		const localYear = Number(parts.find((p) => p.type === "year")?.value);
		const localMonth = Number(parts.find((p) => p.type === "month")?.value);
		const localDay = Number(parts.find((p) => p.type === "day")?.value);
		const localHour = Number(parts.find((p) => p.type === "hour")?.value);
		const localMinute = Number(parts.find((p) => p.type === "minute")?.value);

		// Build a local datetime string at the end time, then find the UTC equivalent
		// by computing the offset between local and UTC
		const localNowMinutes = localHour * 60 + localMinute;
		const endMinutes = endH * 60 + endM;

		// Determine if the end time is today or tomorrow in the user's timezone
		let dayOffset = 0;
		if (endMinutes <= localNowMinutes) {
			dayOffset = 1; // End time already passed today → tomorrow
		}

		// Construct a date in the user's timezone by iterating to find the right UTC time
		// Using a simpler approach: compute the local→UTC offset from the current time
		const utcNow = now.getTime();
		const localDate = new Date(localYear, localMonth - 1, localDay + dayOffset, endH, endM, 0, 0);
		const localTimestamp = localDate.getTime();
		const offset = utcNow - new Date(localYear, localMonth - 1, localDay, localHour, localMinute, 0, 0).getTime();

		return new Date(localTimestamp + offset).toISOString();
	} catch {
		// Fallback: 8 hours from now
		return new Date(Date.now() + 8 * 60 * 60_000).toISOString();
	}
}
