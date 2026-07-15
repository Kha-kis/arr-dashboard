import { describe, expect, it } from "vitest";
import {
	applySetupStartersRequestSchema,
	setupStarterPreviewResponseSchema,
} from "../setup-starters";

describe("Setup starter contracts", () => {
	it("accepts an explicit unique starter selection", () => {
		expect(
			applySetupStartersRequestSchema.parse({
				starterIds: ["notification-throttle", "auto-tag-recent"],
			}),
		).toEqual({ starterIds: ["notification-throttle", "auto-tag-recent"] });
	});

	it("rejects duplicate starter IDs", () => {
		expect(() =>
			applySetupStartersRequestSchema.parse({
				starterIds: ["notification-throttle", "notification-throttle"],
			}),
		).toThrow("Starter IDs must be unique");
	});

	it("pins service labels and availability in the preview shape", () => {
		const preview = setupStarterPreviewResponseSchema.parse({
			starters: [
				{
					id: "auto-tag-recent",
					kind: "auto-tag",
					title: "Tag recently added media",
					description: "Starter draft",
					effect: "Disabled until reviewed",
					available: true,
					unavailableReason: null,
					existing: false,
					source: { id: "sonarr-1", service: "sonarr", label: "Primary Sonarr" },
					destination: null,
				},
			],
		});

		expect(preview.starters[0]?.source?.service).toBe("sonarr");
	});
});
