import type { DashboardStatisticsEnvelope } from "@arr/shared";
import { describe, expect, it } from "vitest";
import * as state from "../dashboard-statistics-state";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const DATA = {
	sonarr: { instances: [] },
	radarr: { instances: [] },
	prowlarr: { instances: [] },
	lidarr: { instances: [] },
	readarr: { instances: [] },
};

function view(envelope: DashboardStatisticsEnvelope | undefined, error: unknown = null) {
	const resolve = Reflect.get(state, "resolveDashboardStatisticsState") as
		| ((...args: unknown[]) => DashboardStatisticsEnvelope)
		| undefined;
	return resolve?.(envelope, error, NOW);
}

describe("Dashboard statistics browser freshness", () => {
	it("keeps absent data as collecting without turning it into zero totals", () => {
		expect(view(undefined)).toEqual({ availability: "collecting", observedAt: null, data: null });
	});

	it("turns a retained collecting response into unavailable after a failed poll", () => {
		expect(
			view({ availability: "collecting", observedAt: null, data: null }, new Error("offline")),
		).toEqual({ availability: "unavailable", observedAt: null, data: null });
	});

	it("downgrades a cached current result after fifteen minutes or a network error", () => {
		const current: DashboardStatisticsEnvelope = {
			availability: "current",
			observedAt: "2026-09-29T11:44:00.000Z",
			data: DATA,
		};
		expect(view(current)?.availability).toBe("last-known");
		expect(
			view({ ...current, observedAt: "2026-09-29T11:59:00.000Z" }, new Error("offline"))
				?.availability,
		).toBe("last-known");
	});

	it("expires a cached response after 24 hours even if the network is offline", () => {
		const old: DashboardStatisticsEnvelope = {
			availability: "last-known",
			observedAt: "2026-09-28T11:59:00.000Z",
			data: DATA,
		};
		expect(view(old, new Error("offline"))).toEqual({
			availability: "unavailable",
			observedAt: null,
			data: null,
		});
	});
});
