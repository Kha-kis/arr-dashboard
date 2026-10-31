import { describe, expect, it, vi } from "vitest";
import { POLLING_STANDARD } from "../../../lib/polling-intervals";

const useQuery = vi.hoisted(() => vi.fn((_options: unknown) => ({})));
vi.mock("@tanstack/react-query", () => ({ useQuery }));

import { useLibrarySeedingSummary } from "../useQui";

describe("Library seeding-summary freshness", () => {
	it("rechecks an exact badge on a bounded cadence and whenever the page regains focus", () => {
		useLibrarySeedingSummary({
			items: [{ arrInstanceId: "synthetic-arr", itemId: 1, itemType: "series" }],
		});
		const options = useQuery.mock.calls[0]?.[0] as {
			staleTime: number;
			refetchOnWindowFocus: string;
			refetchInterval: (query: {
				state: { data?: { status: string }; status: string };
			}) => number | false;
		};
		expect(options.staleTime).toBe(POLLING_STANDARD);
		expect(options.refetchOnWindowFocus).toBe("always");
		expect(
			options.refetchInterval({ state: { data: { status: "available" }, status: "success" } }),
		).toBe(POLLING_STANDARD);
		expect(
			options.refetchInterval({ state: { data: { status: "partial" }, status: "success" } }),
		).toBe(30_000);
	});
});
