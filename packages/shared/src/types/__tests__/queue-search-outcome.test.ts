import { describe, expect, it } from "vitest";
import * as dashboard from "../dashboard";

describe("queue search submission acknowledgement", () => {
	it("validates independently acknowledged removal and search submission", () => {
		expect(dashboard).toHaveProperty("queueSearchOutcomeSchema");
		const schema = dashboard.queueSearchOutcomeSchema;
		expect(schema.parse({ removal: "completed", search: "submitted" })).toEqual({
			removal: "completed",
			search: "submitted",
		});
		expect(schema.parse({ removal: "completed", search: "unconfirmed" })).toEqual({
			removal: "completed",
			search: "unconfirmed",
		});
		for (const value of [
			{ removal: "failed", search: "submitted" },
			{ removal: "completed", search: "completed" },
			{},
		])
			expect(schema.safeParse(value).success).toBe(false);
	});
});
