import type { HistoryItemV2 } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	composeHistoryItems,
	getDisplayTitle,
	getSourceClient,
	groupHistoryItems,
} from "./history-utils";

const item = (id: string, eventAt: string, extra: Partial<HistoryItemV2> = {}): HistoryItemV2 => ({
	id,
	instanceId: "instance-1",
	instanceName: "Indexer Host",
	providerEventId: Number(id.replace(/\D/g, "")) || 1,
	service: "sonarr",
	eventAt,
	eventType: "grabbed",
	title: "Private Title",
	...extra,
});

describe("History v2 composition", () => {
	it("flattens pages in order and de-duplicates by first local id", () => {
		const result = composeHistoryItems([
			{
				items: [item("a", "2026-09-02T00:00:00.000Z"), item("b", "2026-09-01T00:00:00.000Z")],
				sources: [{ instanceId: "old" } as never],
				pageInfo: { nextCursor: "x", hasNextPage: true, matchingObservedCount: 3 },
			},
			{
				items: [
					item("b", "2026-09-01T00:00:00.000Z", { title: "Same title" }),
					item("c", "2026-08-31T00:00:00.000Z", { title: "Same title" }),
				],
				sources: [{ instanceId: "latest" } as never],
				pageInfo: { nextCursor: "y", hasNextPage: true, matchingObservedCount: 999 },
			},
		]);
		expect(result.items.map(({ id }) => id)).toEqual(["a", "b", "c"]);
		expect(result.matchingObservedCount).toBe(3);
		expect(result.sources[0]?.instanceId).toBe("latest");
		expect(result.hasNextPage).toBe(true);
		expect(result.nextCursor).toBe("y");
	});

	it("uses only canonical fields and does not invent quality or inspect raw data", () => {
		const canonical = item("a", "2026-09-02T00:00:00.000Z", {
			title: undefined,
			sourceTitle: "Safe Source",
			qualityName: undefined,
			eventType: "downloaded",
		});
		expect(getDisplayTitle(canonical)).toBe("Safe Source");
		expect(getSourceClient(canonical)).toBe("");
	});

	it("groups only loaded observations by download id", () => {
		const groups = groupHistoryItems(
			[
				item("a", "2026-09-02T00:00:00.000Z", { downloadId: "d" }),
				item("b", "2026-09-01T00:00:00.000Z", { downloadId: "d" }),
			],
			true,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.items).toHaveLength(2);
	});

	it("keeps grouped and ungrouped events in newest-first order", () => {
		const groups = groupHistoryItems(
			[
				item("newest", "2026-09-02T12:00:00.000Z"),
				item("import", "2026-09-02T11:00:00.000Z", { downloadId: "download-a" }),
				item("middle", "2026-09-02T10:00:00.000Z", { downloadId: " " }),
				item("grab", "2026-09-02T09:00:00.000Z", { downloadId: "download-a" }),
				item("older", "2026-09-01T12:00:00.000Z", { downloadId: "download-b" }),
				item("oldest", "2026-09-01T11:00:00.000Z"),
			],
			true,
		);
		expect(groups.map((group) => group.items.map(({ id }) => id))).toEqual([
			["newest"],
			["import", "grab"],
			["middle"],
			["older"],
			["oldest"],
		]);
	});

	it("orders each group by its newest event without reordering the source", () => {
		const items = [
			item("grab", "2026-09-02T09:00:00.000Z", { downloadId: "download-a" }),
			item("middle", "2026-09-02T10:00:00.000Z"),
			item("import", "2026-09-02T11:00:00.000Z", { downloadId: "download-a" }),
		];
		expect(groupHistoryItems(items, true).map((group) => group.items.map(({ id }) => id))).toEqual([
			["import", "grab"],
			["middle"],
		]);
		expect(items.map(({ id }) => id)).toEqual(["grab", "middle", "import"]);
		expect(groupHistoryItems(items, false).map((group) => group.items[0]?.id)).toEqual([
			"grab",
			"middle",
			"import",
		]);
	});
});
