import { describe, expect, it } from "vitest";
import {
	analyticsProviderSchema,
	analyticsProviderSelectionSchema,
	analyticsProviderSourceSchema,
} from "../analytics-provider.js";

describe("analytics provider shared contract", () => {
	it("accepts the two provider families and their persisted sources", () => {
		expect(analyticsProviderSchema.parse("tracearr")).toBe("tracearr");
		expect(analyticsProviderSchema.parse("tautulli")).toBe("tautulli");
		expect(analyticsProviderSourceSchema.parse("explicit")).toBe("explicit");
		expect(analyticsProviderSourceSchema.parse("migration-default")).toBe("migration-default");
	});

	it("returns count-only family state", () => {
		const selection = analyticsProviderSelectionSchema.parse({
			selected: "tracearr",
			source: "migration-default",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 2, enabledCount: 0 },
			},
			status: "configured",
		});

		expect(selection).toEqual({
			selected: "tracearr",
			source: "migration-default",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 2, enabledCount: 0 },
			},
			status: "configured",
		});
		expect(() =>
			analyticsProviderSelectionSchema.parse({
				...selection,
				families: {
					...selection.families,
					tracearr: { ...selection.families.tracearr, url: "https://private.example" },
				},
			}),
		).toThrow();
	});
});
