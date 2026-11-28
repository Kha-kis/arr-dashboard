import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDashboardStatistics } from "../dashboard";

describe("Dashboard statistics response contract", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("rejects the old bare-statistics shape instead of inventing availability", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ sonarr: { instances: [] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await expect(fetchDashboardStatistics()).rejects.toThrow(/statistics response was invalid/i);
	});
});
