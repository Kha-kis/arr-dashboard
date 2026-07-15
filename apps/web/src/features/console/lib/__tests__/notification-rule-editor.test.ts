import { describe, expect, it } from "vitest";
import {
	buildNotificationDocument,
	decomposeNotificationDocument,
	toNotificationsV0Conditions,
	validateNotificationEditor,
} from "../notification-rule-editor";

describe("notification rule editor", () => {
	it("decomposes and round-trips a non-trivial implicit-AND document", () => {
		const document = {
			version: 1 as const,
			root: {
				all: [
					{
						kind: "field_match",
						params: {
							field: "eventType",
							operator: "in",
							value: ["HUNT_COMPLETED", "HUNT_FAILED"],
						},
					},
					{
						kind: "field_match",
						params: { field: "title", operator: "contains", value: "Radarr" },
					},
				],
			},
		};

		const state = decomposeNotificationDocument(document);
		expect(buildNotificationDocument(state)).toEqual(document);
		expect(toNotificationsV0Conditions(state)).toEqual({
			conditions: [
				{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED", "HUNT_FAILED"] },
				{ field: "title", operator: "contains", value: "Radarr" },
			],
		});
	});

	it("rejects empty conditions, unknown fields, and empty values", () => {
		expect(validateNotificationEditor({ conditions: [] })).toMatch(/at least one/i);
		expect(
			validateNotificationEditor({
				conditions: [{ id: "one", field: "instanceName", operator: "equals", value: "Sonarr" }],
			}),
		).toMatch(/eventType, title, body, or metadata/i);
		expect(
			validateNotificationEditor({
				conditions: [{ id: "one", field: "body", operator: "contains", value: "  " }],
			}),
		).toMatch(/enter a value/i);
	});

	it("preserves a lone predicate document when preparing edit state", () => {
		const state = decomposeNotificationDocument({
			version: 1,
			root: {
				kind: "field_match",
				params: { field: "body", operator: "greater_than", value: 12 },
			},
		});
		expect(state.conditions).toEqual([
			{ id: "condition-0", field: "body", operator: "greater_than", value: 12 },
		]);
	});
});
