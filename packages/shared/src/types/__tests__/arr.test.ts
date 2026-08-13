import { describe, expect, it } from "vitest";
import { ALL_SERVICES, arrServiceTypeSchema, multiInstanceConfigSchema } from "../arr.js";

describe("service type taxonomy", () => {
	it("accepts both analytics providers as supported integrations", () => {
		expect(ALL_SERVICES).toContain("tracearr");
		expect(ALL_SERVICES).toContain("tautulli");
		expect(arrServiceTypeSchema.parse("tracearr")).toBe("tracearr");
		expect(arrServiceTypeSchema.parse("tautulli")).toBe("tautulli");
	});

	it("initializes multi-instance collections for both analytics providers", () => {
		const config = multiInstanceConfigSchema.parse({});

		expect(config.tracearr).toEqual([]);
		expect(config.tautulli).toEqual([]);
	});
});
