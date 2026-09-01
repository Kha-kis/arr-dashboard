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
			}),
		);

		expect(result.current.groupedItems).toEqual([]);
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
