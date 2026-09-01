import type { HistoryItem } from "@arr/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHistoryData } from "./use-history-data";

const item = (id: string, eventType: string, downloadId?: string): HistoryItem => ({
	id,
	eventType,
	downloadId,
	date: id === "grab" ? "2026-08-31T12:00:00.000Z" : "2026-08-31T11:00:00.000Z",
	instanceId: "sonarr-1",
	instanceName: "Sonarr",
	service: "sonarr",
});

const filters = {
	searchTerm: "",
	serviceFilter: "all",
	instanceFilter: "all",
	statusFilter: "all",
};

const itemKey = (entry: HistoryItem): string =>
	`${entry.service}:${entry.instanceId}:${String(entry.id)}`;

describe("useHistoryData cursor-page context", () => {
	it("keeps a download lifecycle grouped when it crosses an adjacent cursor page", () => {
		const downloadId = "download-id-longer-than-ten";
		const current = item("grab", "grabbed", downloadId);
		const adjacent = item("import", "downloadFolderImported", downloadId);

		const { result } = renderHook(() =>
			useHistoryData({ aggregated: [current], instances: [] }, filters, true, false, {
				nextItems: [adjacent],
			}),
		);

		expect(result.current.groupedItems).toHaveLength(1);
		expect(result.current.groupedItems[0]?.items.map((entry) => entry.id)).toEqual([
			"grab",
			"import",
		]);
	});

	it("renders a cross-page lifecycle only on the page containing its newest event", () => {
		const downloadId = "download-id-longer-than-ten";
		const newerAdjacent = item("grab", "grabbed", downloadId);
		const current = item("import", "downloadFolderImported", downloadId);

		const { result } = renderHook(() =>
			useHistoryData({ aggregated: [current], instances: [] }, filters, true, false, {
				previousItems: [newerAdjacent],
				previouslyRenderedItemKeys: [newerAdjacent, current].map(itemKey),
			}),
		);

		expect(result.current.groupedItems).toEqual([]);
	});

	it("uses page order to own a cross-page lifecycle when timestamps tie", () => {
		const downloadId = "download-id-longer-than-ten";
		const date = "2026-08-31T12:00:00.000Z";
		const previousPageItem = { ...item("grab", "grabbed", downloadId), date };
		const current = { ...item("import", "downloadFolderImported", downloadId), date };

		const { result } = renderHook(() =>
			useHistoryData({ aggregated: [current], instances: [] }, filters, true, false, {
				previousItems: [previousPageItem],
				previouslyRenderedItemKeys: [previousPageItem, current].map(itemKey),
			}),
		);

		expect(result.current.groupedItems).toEqual([]);
	});

	it("does not hide the unrendered tail of a lifecycle spanning three cursor pages", () => {
		const downloadId = "download-id-longer-than-ten";
		const page1Item = item("page-1", "grabbed", downloadId);
		const page2Item = {
			...item("page-2", "downloadFolderImported", downloadId),
			date: "2026-08-31T11:00:00.000Z",
		};
		const page3Item = {
			...item("page-3", "downloadFolderImported", downloadId),
			date: "2026-08-31T10:00:00.000Z",
		};

		const firstPage = renderHook(() =>
			useHistoryData({ aggregated: [page1Item], instances: [] }, filters, true, false, {
				nextItems: [page2Item],
			}),
		);
		const secondPage = renderHook(() =>
			useHistoryData({ aggregated: [page2Item], instances: [] }, filters, true, false, {
				previousItems: [page1Item],
				nextItems: [page3Item],
				previouslyRenderedItemKeys: firstPage.result.current.renderedItemKeys,
			}),
		);
		const thirdPage = renderHook(() =>
			useHistoryData({ aggregated: [page3Item], instances: [] }, filters, true, false, {
				previousItems: [page2Item],
				previouslyRenderedItemKeys: firstPage.result.current.renderedItemKeys,
			}),
		);

		expect(firstPage.result.current.groupedItems[0]?.items.map((entry) => entry.id)).toEqual([
			"page-1",
			"page-2",
		]);
		expect(secondPage.result.current.groupedItems).toEqual([]);
		expect(thirdPage.result.current.groupedItems[0]?.items.map((entry) => entry.id)).toEqual([
			"page-3",
		]);
	});

	it("offers stable server-filter values even when the current page has only grabs", () => {
		const { result } = renderHook(() =>
			useHistoryData(
				{ aggregated: [item("grab", "grabbed")], instances: [] },
				filters,
				true,
				false,
			),
		);

		expect(result.current.statusOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "downloadfolderimported" }),
				expect.objectContaining({ value: "downloadfailed" }),
			]),
		);
	});
});
