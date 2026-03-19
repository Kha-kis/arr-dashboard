import { beforeEach, describe, expect, it, vi } from "vitest";
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
		integrationHealth.record("plex", "/identity", { total: 1, validated: 1, rejected: 0 });

		const health = integrationHealth.getByIntegration("plex");
		expect(health!.totals.validated).toBe(1);
		expect(health!.totals.rejected).toBe(0);
	});

	it("records failure pattern (validated: 0, rejected: 1)", () => {
		integrationHealth.record("plex", "/identity", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex");
		expect(health!.totals.validated).toBe(0);
		expect(health!.totals.rejected).toBe(1);
	});
});

describe("Health state tracking", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	it("starts as healthy with zero consecutive failures", () => {
		integrationHealth.record("plex", "sessions", { total: 1, validated: 1, rejected: 0 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("healthy");
		expect(health.consecutiveFailures).toBe(0);
		expect(health.lastSuccessAt).toBeDefined();
		expect(health.lastFailureAt).toBeNull();
	});

	it("transitions to degraded after 1 consecutive failure", () => {
		integrationHealth.record("plex", "sessions", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("degraded");
		expect(health.consecutiveFailures).toBe(1);
		expect(health.lastFailureAt).toBeDefined();
	});

	it("stays degraded at 2 consecutive failures", () => {
		integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		integrationHealth.record("plex", "b", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("degraded");
		expect(health.consecutiveFailures).toBe(2);
	});

	it("transitions to failing after 3+ consecutive failures", () => {
		integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		integrationHealth.record("plex", "b", { total: 1, validated: 0, rejected: 1 });
		integrationHealth.record("plex", "c", { total: 1, validated: 0, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("failing");
		expect(health.consecutiveFailures).toBe(3);
	});

	it("resets to healthy on success after failures", () => {
		integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		integrationHealth.record("plex", "b", { total: 1, validated: 0, rejected: 1 });
		integrationHealth.record("plex", "c", { total: 1, validated: 0, rejected: 1 });
		expect(integrationHealth.getByIntegration("plex")!.state).toBe("failing");

		integrationHealth.record("plex", "d", { total: 1, validated: 1, rejected: 0 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("healthy");
		expect(health.consecutiveFailures).toBe(0);
		expect(health.lastSuccessAt).toBeDefined();
	});

	it("does not count mixed results as failure", () => {
		// rejected > 0 but validated > 0 too — this is a partial success, not all-rejection
		integrationHealth.record("plex", "a", { total: 2, validated: 1, rejected: 1 });

		const health = integrationHealth.getByIntegration("plex")!;
		expect(health.state).toBe("healthy");
		expect(health.consecutiveFailures).toBe(0);
	});
});

describe("Health degradation notifications", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	it("fires notification on healthy → degraded transition", () => {
		const notifyFn = vi.fn();
		integrationHealth.setNotifyFn(notifyFn);

		integrationHealth.record("plex", "sessions", { total: 1, validated: 0, rejected: 1 });

		expect(notifyFn).toHaveBeenCalledOnce();
		expect(notifyFn).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "VALIDATION_HEALTH_DEGRADED",
				title: expect.stringContaining("plex"),
				metadata: expect.objectContaining({
					integration: "plex",
					failureCount: "1",
				}),
			}),
		);
	});

	it("does NOT fire on degraded → degraded (no re-fire)", () => {
		const notifyFn = vi.fn();
		integrationHealth.setNotifyFn(notifyFn);

		integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		expect(notifyFn).toHaveBeenCalledOnce();

		integrationHealth.record("plex", "b", { total: 1, validated: 0, rejected: 1 });
		// Should not fire again — only fires on healthy → degraded/failing
		expect(notifyFn).toHaveBeenCalledOnce();
	});

	it("throttles: second degradation within 1 hour is suppressed", () => {
		const notifyFn = vi.fn();
		integrationHealth.setNotifyFn(notifyFn);

		// First degradation
		integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		expect(notifyFn).toHaveBeenCalledOnce();

		// Recovery
		integrationHealth.record("plex", "b", { total: 1, validated: 1, rejected: 0 });

		// Second degradation within same hour — should be throttled
		integrationHealth.record("plex", "c", { total: 1, validated: 0, rejected: 1 });
		expect(notifyFn).toHaveBeenCalledOnce(); // Still only 1
	});

	it("does not fire when notifyFn is not set", () => {
		// No setNotifyFn called — should not throw
		expect(() => {
			integrationHealth.record("plex", "a", { total: 1, validated: 0, rejected: 1 });
		}).not.toThrow();
	});

	it("includes affected categories in metadata", () => {
		const notifyFn = vi.fn();
		integrationHealth.setNotifyFn(notifyFn);

		integrationHealth.record("plex", "sessions", { total: 1, validated: 0, rejected: 1 });

		const call = notifyFn.mock.calls[0]![0];
		expect(call.metadata.affectedCategories).toContain("sessions");
	});
});
