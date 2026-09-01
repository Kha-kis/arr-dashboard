import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiInstanceHistoryQuery } from "./useDashboard";

vi.mock("@tanstack/react-query", () => ({
	useQuery: vi.fn(),
}));

vi.mock("../../lib/api-client/dashboard", () => ({
	fetchDashboardStatistics: vi.fn(),
	fetchMultiInstanceCalendar: vi.fn(),
	fetchMultiInstanceHistory: vi.fn(),
	fetchMultiInstanceQueue: vi.fn(),
}));

describe("useMultiInstanceHistoryQuery containment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("isolates old cached History and does not retry or poll the disabled route", () => {
		useMultiInstanceHistoryQuery();

		expect(useQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["dashboard", "history", "containment", {}],
				retry: false,
				refetchInterval: false,
			}),
		);
	});
});
