import { describe, expect, it } from "vitest";
import { crossDomainRuleDraftSchema } from "../cross-domain-automation.js";

const base = {
	name: "Archive workflow",
	document: {
		version: 1,
		root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
	},
	scope: { serviceTypes: ["RADARR"], instanceIds: [] },
};

describe("crossDomainRuleDraftSchema", () => {
	it("requires actions from at least two domains", () => {
		const result = crossDomainRuleDraftSchema.safeParse({
			...base,
			actions: [{ type: "send_notification" }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects duplicate action types", () => {
		const result = crossDomainRuleDraftSchema.safeParse({
			...base,
			actions: [{ type: "send_notification" }, { type: "send_notification" }],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a multi-domain action fan-out", () => {
		const result = crossDomainRuleDraftSchema.safeParse({
			...base,
			actions: [{ type: "apply_tag", tagName: "archive" }, { type: "exempt_cleanup" }],
		});
		expect(result.success).toBe(true);
	});
});
