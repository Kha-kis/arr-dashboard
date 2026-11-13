import { describe, expect, it } from "vitest";
import * as dashboard from "../dashboard.js";

describe("Dashboard statistics availability envelope", () => {
	it("accepts an unavailable response without invented totals", () => {
		const schema = Reflect.get(dashboard, "dashboardStatisticsEnvelopeSchema") as
			| { safeParse: (value: unknown) => { success: boolean } }
			| undefined;
		expect(
			schema?.safeParse({ availability: "unavailable", observedAt: null, data: null }).success,
		).toBe(true);
	});

	it("rejects a current response without a snapshot", () => {
		const schema = Reflect.get(dashboard, "dashboardStatisticsEnvelopeSchema") as
			| { safeParse: (value: unknown) => { success: boolean } }
			| undefined;
		expect(
			schema?.safeParse({ availability: "current", observedAt: null, data: null }).success,
		).toBe(false);
	});

	it("rejects a partial response without its observation time", () => {
		const schema = Reflect.get(dashboard, "dashboardStatisticsEnvelopeSchema") as
			| { safeParse: (value: unknown) => { success: boolean } }
			| undefined;
		expect(
			schema?.safeParse({
				availability: "partial",
				observedAt: null,
				data: {
					sonarr: { instances: [] },
					radarr: { instances: [] },
					prowlarr: { instances: [] },
					lidarr: { instances: [] },
					readarr: { instances: [] },
				},
			}).success,
		).toBe(false);
	});
});
