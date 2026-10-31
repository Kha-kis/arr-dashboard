import { describe, expect, it, vi } from "vitest";
import { POLLING_BACKGROUND } from "../../../lib/polling-intervals";

const useQuery = vi.hoisted(() =>
	vi.fn((_options: { queryKey: unknown; queryFn: () => Promise<unknown> }) => ({})),
);
const apiRequest = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ status: "unavailable", reason: "no-publication" }),
);
vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("../../../lib/api-client/base", () => ({ apiRequest }));

import { useProviderNativeInventory } from "../useProviderNativeInventory";

describe("native episode inventory cursor polling", () => {
	it("refreshes the active episode cursor page on the background cadence", () => {
		useProviderNativeInventory({
			instanceId: "synthetic-instance",
			domain: "episode",
			afterNativeId: "synthetic-cursor",
			expectedGenerationId: "synthetic-generation",
		});
		expect(useQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				refetchInterval: POLLING_BACKGROUND,
				staleTime: POLLING_BACKGROUND,
			}),
		);
	});

	it("does not poll a cursor page without episode watch badges", () => {
		useProviderNativeInventory({
			instanceId: "synthetic-instance",
			domain: "library",
			afterNativeId: "synthetic-cursor",
		});
		expect(useQuery).toHaveBeenLastCalledWith(
			expect.objectContaining({ refetchInterval: false, staleTime: Infinity }),
		);
	});
	it("separates missing-metadata pages from ordinary inventory and sends the filter", async () => {
		useProviderNativeInventory({ instanceId: "synthetic-instance", domain: "library" });
		const ordinary = useQuery.mock.lastCall?.[0];
		useProviderNativeInventory({
			instanceId: "synthetic-instance",
			domain: "library",
			metadataFilter: "missing-tmdb",
		});
		const filtered = useQuery.mock.lastCall?.[0];
		if (!ordinary || !filtered) throw new Error("Inventory query options were not captured");
		expect(filtered.queryKey).not.toEqual(ordinary.queryKey);
		await filtered.queryFn();
		expect(apiRequest).toHaveBeenCalledWith(
			"/api/library/provider-inventory?instanceId=synthetic-instance&domain=library&limit=100&metadataFilter=missing-tmdb",
		);
	});
});
