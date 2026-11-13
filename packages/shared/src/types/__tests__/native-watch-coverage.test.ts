import { describe, expect, it } from "vitest";
import { providerNativeWatchCoverageSchema } from "../native-watch-coverage";
import { providerNativeInventoryResponseSchema } from "../provider-native-inventory";
const recorded = {
	status: "available",
	observedAt: "2026-10-19T12:00:00.000Z",
	expectedScopes: 8,
	verifiedScopes: 7,
	incompleteScopes: 1,
	diagnosticStatus: "recorded",
	reasonCodes: ["changed-observations"],
	refreshPhase: "idle",
};
describe("recorded watch coverage public contract", () => {
	it("allows recorded summary without freshness or identifiers", () => {
		expect(providerNativeWatchCoverageSchema.parse(recorded)).toEqual(recorded);
		expect(
			providerNativeWatchCoverageSchema.safeParse({ ...recorded, freshness: "current" }).success,
		).toBe(false);
		expect(
			providerNativeWatchCoverageSchema.safeParse({ ...recorded, userId: "private" }).success,
		).toBe(false);
	});
	it("keeps legacy inventory responses valid", () => {
		const inventory = {
			status: "available",
			generationId: "fixture",
			observedAt: recorded.observedAt,
			itemCount: 0,
			scopeCount: 1,
			lastAttemptAt: null,
			lastAttemptResult: "success",
			lastAttemptReason: null,
			freshness: "current",
			complete: true,
			rows: [],
			nextNativeId: null,
		};
		expect(providerNativeInventoryResponseSchema.safeParse(inventory).success).toBe(true);
		expect(
			providerNativeInventoryResponseSchema.parse({ ...inventory, watchCoverage: recorded }),
		).toMatchObject({ watchCoverage: recorded });
	});
});
