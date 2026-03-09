import { beforeEach, describe, expect, it } from "vitest";
import { integrationHealth } from "../integration-health.js";

describe("IntegrationHealthRegistry", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	it("records stats for a new integration + category", () => {
		integrationHealth.record("plex", "/library/sections", { total: 1, validated: 1, rejected: 0 });

		const health = integrationHealth.getByIntegration("plex");
		expect(health).toBeDefined();
		expect(health!.categories["/library/sections"]).toEqual({ total: 1, validated: 1, rejected: 0 });
		expect(health!.totals).toEqual({ total: 1, validated: 1, rejected: 0 });
		expect(health!.lastRefreshAt).toBeDefined();
	});

	it("accumulates stats for repeated recordings to same category", () => {
		integrationHealth.record("seerr", "getRequests", { total: 1, validated: 1, rejected: 0 });
		integrationHealth.record("seerr", "getRequests", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("seerr");
		expect(health!.categories.getRequests).toEqual({ total: 2, validated: 1, rejected: 1 });
		expect(health!.totals).toEqual({ total: 2, validated: 1, rejected: 1 });
	});

	it("tracks multiple categories independently within same integration", () => {
		integrationHealth.record("tautulli", "get_history", { total: 5, validated: 5, rejected: 0 });
		integrationHealth.record("tautulli", "get_activity", { total: 3, validated: 2, rejected: 1 });

		const health = integrationHealth.getByIntegration("tautulli");
		expect(health!.categories.get_history).toEqual({ total: 5, validated: 5, rejected: 0 });
		expect(health!.categories.get_activity).toEqual({ total: 3, validated: 2, rejected: 1 });
		expect(health!.totals).toEqual({ total: 8, validated: 7, rejected: 1 });
	});

	it("getAll aggregates across all integrations", () => {
		integrationHealth.record("plex", "sessions", { total: 10, validated: 10, rejected: 0 });
		integrationHealth.record("seerr", "requests", { total: 5, validated: 4, rejected: 1 });
		integrationHealth.record("tautulli", "history", { total: 3, validated: 3, rejected: 0 });

		const all = integrationHealth.getAll();
		expect(Object.keys(all.integrations)).toHaveLength(3);
		expect(all.overallTotals).toEqual({ total: 18, validated: 17, rejected: 1 });
	});

	it("returns undefined for unknown integration", () => {
		expect(integrationHealth.getByIntegration("nonexistent")).toBeUndefined();
	});

	it("resetIntegration clears a single integration", () => {
		integrationHealth.record("plex", "sessions", { total: 1, validated: 1, rejected: 0 });
		integrationHealth.record("seerr", "requests", { total: 1, validated: 1, rejected: 0 });

		integrationHealth.resetIntegration("plex");

		expect(integrationHealth.getByIntegration("plex")).toBeUndefined();
		expect(integrationHealth.getByIntegration("seerr")).toBeDefined();
	});

	it("reset clears all integrations", () => {
		integrationHealth.record("plex", "a", { total: 1, validated: 1, rejected: 0 });
		integrationHealth.record("seerr", "b", { total: 1, validated: 1, rejected: 0 });

		integrationHealth.reset();

		const all = integrationHealth.getAll();
		expect(Object.keys(all.integrations)).toHaveLength(0);
		expect(all.overallTotals).toEqual({ total: 0, validated: 0, rejected: 0 });
	});

	it("records success pattern (validated: 1, rejected: 0)", () => {
		// Simulates what plex-client/tautulli-client/seerr-client do on parse success
		integrationHealth.record("plex", "/identity", { total: 1, validated: 1, rejected: 0 });

		const health = integrationHealth.getByIntegration("plex");
		expect(health!.totals.validated).toBe(1);
		expect(health!.totals.rejected).toBe(0);
	});

	it("records failure pattern (validated: 0, rejected: 1)", () => {
		// Simulates what plex-client/tautulli-client/seerr-client do on parse failure
		integrationHealth.record("plex", "/identity", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex");
		expect(health!.totals.validated).toBe(0);
		expect(health!.totals.rejected).toBe(1);
	});
});
