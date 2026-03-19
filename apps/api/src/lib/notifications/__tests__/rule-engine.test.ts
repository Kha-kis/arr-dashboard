/**
 * Unit tests for the RuleEngine.
 *
 * Validates condition matching, priority ordering, action types,
 * and metadata field resolution.
 */

import { describe, it, expect } from "vitest";
import { RuleEngine } from "../rule-engine.js";
import type { NotificationRule } from "../rule-engine.js";
import type { NotificationPayload } from "../types.js";

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Test notification",
		body: "Test body",
		...overrides,
	};
}

function makeRule(overrides?: Partial<NotificationRule>): NotificationRule {
	return {
		id: "rule-1",
		enabled: true,
		priority: 10,
		action: "suppress",
		conditions: [],
		targetChannelIds: null,
		throttleMinutes: null,
		...overrides,
	};
}

describe("RuleEngine", () => {
	const engine = new RuleEngine();

	it("returns null when no rules match", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "eventType", operator: "equals", value: "BACKUP_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).toBeNull();
	});

	it("matches equals condition on eventType", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-1");
		expect(result!.action).toBe("suppress");
	});

	it("matches contains condition on title", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "title", operator: "contains", value: "found" }],
			}),
		];
		const result = engine.evaluate(
			makePayload({ title: "Hunt found 3 items" }),
			rules,
		);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-1");
	});

	it("matches not_equals condition", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "eventType", operator: "not_equals", value: "BACKUP_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload({ eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"] }), rules);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-1");
	});

	it("matches greater_than condition on metadata field", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "metadata.count", operator: "greater_than", value: 5 }],
			}),
		];
		const result = engine.evaluate(
			makePayload({ metadata: { count: 10 } }),
			rules,
		);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-1");
	});

	it("matches in condition", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [
					{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED", "HUNT_FAILED"] },
				],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-1");
	});

	it("requires ALL conditions to match (AND logic)", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [
					{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
					{ field: "title", operator: "contains", value: "nonexistent" },
				],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).toBeNull();
	});

	it("evaluates rules in priority order (lower = higher priority)", () => {
		const rules: NotificationRule[] = [
			makeRule({
				id: "rule-high-number",
				priority: 100,
				action: "route",
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
				targetChannelIds: ["ch-99"],
			}),
			makeRule({
				id: "rule-low-number",
				priority: 1,
				action: "suppress",
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("rule-low-number");
		expect(result!.action).toBe("suppress");
	});

	it("skips disabled rules", () => {
		const rules: NotificationRule[] = [
			makeRule({
				id: "disabled-rule",
				enabled: false,
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).toBeNull();
	});

	it("suppress action returns correct result", () => {
		const rules: NotificationRule[] = [
			makeRule({
				id: "suppress-rule",
				action: "suppress",
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).toEqual({
			action: "suppress",
			ruleId: "suppress-rule",
			targetChannelIds: undefined,
			throttleMinutes: undefined,
		});
	});

	it("throttle action includes throttleMinutes", () => {
		const rules: NotificationRule[] = [
			makeRule({
				id: "throttle-rule",
				action: "throttle",
				throttleMinutes: 15,
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).not.toBeNull();
		expect(result!.action).toBe("throttle");
		expect(result!.throttleMinutes).toBe(15);
		expect(result!.ruleId).toBe("throttle-rule");
	});

	it("route action includes targetChannelIds", () => {
		const rules: NotificationRule[] = [
			makeRule({
				id: "route-rule",
				action: "route",
				targetChannelIds: ["ch-1", "ch-2"],
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		];
		const result = engine.evaluate(makePayload(), rules);
		expect(result).not.toBeNull();
		expect(result!.action).toBe("route");
		expect(result!.targetChannelIds).toEqual(["ch-1", "ch-2"]);
		expect(result!.ruleId).toBe("route-rule");
	});

	it("returns undefined for metadata field when metadata is not present", () => {
		const rules: NotificationRule[] = [
			makeRule({
				conditions: [{ field: "metadata.count", operator: "greater_than", value: 5 }],
			}),
		];
		const result = engine.evaluate(
			makePayload({ metadata: undefined }),
			rules,
		);
		// metadata.count resolves to undefined, condition returns false
		expect(result).toBeNull();
	});
});
