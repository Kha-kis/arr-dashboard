import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLLING_STANDARD } from "../../../lib/polling-intervals";
import { useMultiInstanceHistoryQuery } from "../useDashboard";

vi.mock("@tanstack/react-query", () => ({
	useQuery: vi.fn(),
}));

describe("useMultiInstanceHistoryQuery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps polling on the live first page", () => {
		useMultiInstanceHistoryQuery({ pageSize: 25 });
		expect(useQuery).toHaveBeenCalledWith(
			expect.objectContaining({ refetchInterval: POLLING_STANDARD }),
		);
	});

	it("disables background polling for an anchored cursor page", () => {
		useMultiInstanceHistoryQuery({ cursor: "opaque", pageSize: 25 });
		expect(useQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: false }));
	});
});
