import { describe, expect, it } from "vitest";
import { composeHistoryItems } from "../lib/history-utils";

describe("useHistoryData v2 contract", () => {
	it("retains latest source catalog and exact first-page matching count", () => {
		const result = composeHistoryItems([
			{
				items: [],
				sources: [{ instanceId: "one" } as never],
				pageInfo: { nextCursor: "x", hasNextPage: true, matchingObservedCount: 4 },
			},
			{
				items: [],
				sources: [{ instanceId: "two" } as never],
				pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 4 },
			},
		]);
		expect(result.sources.map((source) => source.instanceId)).toEqual(["two"]);
		expect(result.matchingObservedCount).toBe(4);
	});
});
