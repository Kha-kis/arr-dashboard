import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardStatisticsQuery, useMultiInstanceHistoryQuery } from "./useDashboard";

vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: vi.fn(),
	useQuery: vi.fn(),
}));

vi.mock("../../lib/api-client/dashboard", () => ({
	fetchDashboardStatistics: vi.fn(),
	fetchMultiInstanceCalendar: vi.fn(),
	fetchMultiInstanceHistory: vi.fn(),
	fetchMultiInstanceQueue: vi.fn(),
}));

describe("useMultiInstanceHistoryQuery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses an opaque null-starting infinite cursor chain without retry or polling", async () => {
		const params = {
			limit: 25,
			cursor: null,
			startDate: null,
			endDate: null,
			search: null,
			service: null,
			instanceId: null,
			eventType: null,
			hideProwlarrRss: true,
			chainRevision: 4,
		};
		useMultiInstanceHistoryQuery(params);

		expect(useInfiniteQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: expect.arrayContaining(["dashboard", "history"]),
				initialPageParam: null,
				retry: false,
				refetchInterval: false,
			}),
		);
		const options = vi.mocked(useInfiniteQuery).mock.calls[0]?.[0] as any;
		await options.queryFn({ pageParam: null });
		await options.queryFn({ pageParam: "opaque-returned-cursor" });
		const fetchHistory = await import("../../lib/api-client/dashboard").then(
			(module) => module.fetchMultiInstanceHistory,
		);
		const { chainRevision: _revision, cursor: _inputCursor, ...requestFields } = params;
		expect(vi.mocked(fetchHistory)).toHaveBeenNthCalledWith(1, { ...requestFields, cursor: null });
		expect(vi.mocked(fetchHistory)).toHaveBeenNthCalledWith(2, {
			...requestFields,
			cursor: "opaque-returned-cursor",
		});
		expect(
			options.getNextPageParam({ pageInfo: { hasNextPage: true, nextCursor: "opaque" } }),
		).toBe("opaque");
		expect(options.getNextPageParam({ pageInfo: { hasNextPage: true, nextCursor: null } })).toBe(
			undefined,
		);
		expect(
			options.getNextPageParam({ pageInfo: { hasNextPage: false, nextCursor: "ignored" } }),
		).toBe(undefined);
	});
});

describe("useDashboardStatisticsQuery", () => {
	it("polls collecting and unavailable states at ten seconds, current at two minutes", () => {
		useDashboardStatisticsQuery();
		const options = vi.mocked(useQuery).mock.calls.at(-1)?.[0] as unknown as {
			refetchInterval: (query: {
				state: { data?: { availability: string }; error?: Error | null };
			}) => number;
		};
		expect(options.refetchInterval({ state: { data: { availability: "collecting" } } })).toBe(
			10_000,
		);
		expect(options.refetchInterval({ state: { data: { availability: "unavailable" } } })).toBe(
			10_000,
		);
		expect(options.refetchInterval({ state: { data: { availability: "current" } } })).toBe(120_000);
	});
});
