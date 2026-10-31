import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../../hooks/api/useDashboard", () => ({
	useDashboardStatisticsQuery: mockQuery,
}));

import { useStatisticsData } from "../useStatisticsData";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-29T12:00:00.000Z"));
});
afterEach(() => vi.restoreAllMocks());

describe("useStatisticsData availability", () => {
	it("keeps healthy rows and identifies unavailable rows instead of counting their fallback zeros", () => {
		mockQuery.mockReturnValue({
			data: {
				availability: "partial",
				observedAt: "2026-09-29T11:44:00.000Z",
				data: {
					sonarr: {
						instances: [
							{
								instanceId: "healthy",
								instanceName: "Synthetic healthy",
								data: {
									totalSeries: 7,
									healthIssues: 1,
									healthIssuesList: [
										{
											type: "warning",
											message: "Synthetic health issue",
											instanceId: "healthy",
											instanceName: "Synthetic healthy",
											instanceBaseUrl: "https://synthetic.invalid",
											service: "sonarr",
										},
									],
								},
								error: false,
							},
							{
								instanceId: "unavailable",
								instanceName: "Synthetic unavailable",
								data: { totalSeries: 0, healthIssues: 0 },
								error: true,
							},
						],
					},
					radarr: { instances: [] },
					prowlarr: { instances: [] },
				},
			},
			isLoading: false,
			isFetching: false,
			error: null,
			refetch: vi.fn(),
		});

		const { result } = renderHook(() => useStatisticsData());
		expect(result.current.incompleteServices).toEqual(["sonarr"]);
		expect(result.current.sonarrRows).toEqual([
			expect.objectContaining({ instanceId: "healthy", totalSeries: 7 }),
		]);
		expect(result.current.sonarrTotals.totalSeries).toBe(7);
		expect(result.current.configuredInstanceCounts.sonarr).toBe(2);
		expect(result.current.allHealthIssues).toEqual([
			expect.objectContaining({ message: "Synthetic health issue" }),
		]);
		expect(result.current.availability).toBe("partial");
		expect(result.current.hasStatistics).toBe(true);
	});

	it("reports collecting without pretending the ARR aggregates are present", () => {
		mockQuery.mockReturnValue({
			data: { availability: "collecting", observedAt: null, data: null },
			isLoading: false,
			isFetching: false,
			error: null,
			refetch: vi.fn(),
		});
		const { result } = renderHook(() => useStatisticsData());
		expect(result.current.availability).toBe("collecting");
		expect(result.current.hasStatistics).toBe(false);
	});
});
