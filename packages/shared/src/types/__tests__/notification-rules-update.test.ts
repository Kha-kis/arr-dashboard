import { describe, expect, it } from "vitest";
import { createNotificationRuleSchema, updateNotificationRuleSchema } from "../notifications";

describe("notification rule update schema", () => {
	it("keeps creation defaults while leaving omitted update settings omitted", () => {
		expect(
			createNotificationRuleSchema.parse({
				name: "Synthetic rule",
				action: "suppress",
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			}),
		).toMatchObject({ enabled: true, priority: 0 });
		expect(updateNotificationRuleSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
		expect(updateNotificationRuleSchema.parse({})).toEqual({});
	});

	it("accepts explicit false and zero without supplying other fields", () => {
		expect(updateNotificationRuleSchema.parse({ enabled: false })).toEqual({ enabled: false });
		expect(updateNotificationRuleSchema.parse({ priority: 0 })).toEqual({ priority: 0 });
		expect(updateNotificationRuleSchema.parse({ enabled: false, priority: 0 })).toEqual({
			enabled: false,
			priority: 0,
		});
	});

	it.each([-1, 1001, 0.5])("rejects invalid update priority %s", (priority) => {
		expect(updateNotificationRuleSchema.safeParse({ priority }).success).toBe(false);
	});
});
