import { describe, expect, it } from "vitest";
import { quiAttentionResponseSchema } from "../qui";

const coverage = {
	status: "current" as const,
	currentInstances: 1,
	lastKnownInstances: 0,
	unavailableInstances: 0,
	incompleteInstances: 0,
	oldestFetchedAt: "2026-09-30T03:40:00.000Z",
};

describe("qUI attention file coverage contract", () => {
	it("retains a separate file-coverage status so an empty feed is not an unverified all-clear", () => {
		const parsed = quiAttentionResponseSchema.parse({
			items: [],
			totalCount: 0,
			inventoryCoverage: coverage,
			trackerCoverage: "current",
			fileCoverage: {
				status: "unavailable",
				issueCount: 0,
				oldestBuiltAt: null,
			},
		});
		expect(parsed.fileCoverage).toEqual({
			status: "unavailable",
			issueCount: 0,
			oldestBuiltAt: null,
		});
	});

	it("keeps the owning qUI connection distinct when two connections report the same hash", () => {
		const parsed = quiAttentionResponseSchema.parse({
			items: [
				{
					quiInstanceId: "qui-one",
					hash: "a".repeat(40),
					name: "synthetic",
					state: "seeding",
					ratio: 1,
					size: 100,
					qbitInstanceId: 7,
					qbitInstanceName: null,
					severity: "warning",
					reason: "File size mismatch",
					libraryContext: null,
				},
			],
			totalCount: 1,
			inventoryCoverage: coverage,
			trackerCoverage: "current",
			fileCoverage: {
				status: "partial",
				issueCount: 1,
				oldestBuiltAt: "2026-09-30T03:40:00.000Z",
			},
		});
		expect(parsed.items[0]?.quiInstanceId).toBe("qui-one");
		expect(parsed.items[0]?.state).toBe("seeding");
	});
});
