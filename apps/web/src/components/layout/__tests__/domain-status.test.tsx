import { describe, expect, it, vi } from "vitest";

// The DomainStatusBadge wraps StatusBadge, which pulls in useThemeGradient.
// We don't render here (we only exercise the pure derivation helpers), but the
// import graph still loads premium-data-display, so stub the hook to be safe.
vi.mock("../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#7c3aed",
			to: "#a855f7",
			glow: "rgba(124,58,237,0.4)",
			fromLight: "rgba(124,58,237,0.15)",
			fromMuted: "rgba(124,58,237,0.3)",
		},
	}),
}));

import {
	deriveNotificationChannelStatus,
	deriveServiceInstanceStatus,
	getDomainStatusMeta,
} from "../domain-status";

describe("deriveServiceInstanceStatus", () => {
	it("returns disabled when the instance is turned off regardless of test state", () => {
		expect(
			deriveServiceInstanceStatus({
				enabled: false,
				hasApiKey: true,
				testResult: { success: true },
			}),
		).toBe("disabled");
	});

	it("returns configured when no api key is present", () => {
		expect(deriveServiceInstanceStatus({ enabled: true, hasApiKey: false, testResult: null })).toBe(
			"configured",
		);
	});

	it("returns configured when enabled + api key but no round-trip has happened", () => {
		expect(deriveServiceInstanceStatus({ enabled: true, hasApiKey: true, testResult: null })).toBe(
			"configured",
		);
	});

	it("returns healthy when the most recent test succeeded", () => {
		expect(
			deriveServiceInstanceStatus({
				enabled: true,
				hasApiKey: true,
				testResult: { success: true },
			}),
		).toBe("healthy");
	});

	it("returns offline when the most recent test failed", () => {
		expect(
			deriveServiceInstanceStatus({
				enabled: true,
				hasApiKey: true,
				testResult: { success: false },
			}),
		).toBe("offline");
	});
});

describe("deriveNotificationChannelStatus", () => {
	it("returns disabled when the channel is turned off", () => {
		expect(
			deriveNotificationChannelStatus({
				enabled: false,
				lastTestedAt: "2026-04-10T00:00:00Z",
				lastTestResult: "success",
			}),
		).toBe("disabled");
	});

	it("returns configured when no test has been run yet", () => {
		expect(
			deriveNotificationChannelStatus({
				enabled: true,
				lastTestedAt: null,
				lastTestResult: null,
			}),
		).toBe("configured");
	});

	it("returns healthy on last-success", () => {
		expect(
			deriveNotificationChannelStatus({
				enabled: true,
				lastTestedAt: "2026-04-10T00:00:00Z",
				lastTestResult: "success",
			}),
		).toBe("healthy");
	});

	it("returns offline when the last test failed — does NOT overclaim health just because the channel is enabled", () => {
		expect(
			deriveNotificationChannelStatus({
				enabled: true,
				lastTestedAt: "2026-04-10T00:00:00Z",
				lastTestResult: "failure",
			}),
		).toBe("offline");
	});
});

describe("getDomainStatusMeta", () => {
	it("maps each domain status to a stable semantic badge + label", () => {
		expect(getDomainStatusMeta("healthy").badge).toBe("success");
		expect(getDomainStatusMeta("degraded").badge).toBe("warning");
		expect(getDomainStatusMeta("offline").badge).toBe("error");
		expect(getDomainStatusMeta("configured").badge).toBe("info");
		expect(getDomainStatusMeta("disabled").badge).toBe("default");
	});

	it("frames problem-state descriptions as snapshots and defers live status to Pulse", () => {
		// Regression guard against diagnostic language creeping back in.
		// The badge reflects the last check only; Pulse is the canonical
		// live-health surface. Callers should not read a cached "Offline"
		// as a live reachability claim.
		const offline = getDomainStatusMeta("offline").description;
		expect(offline).toMatch(/last check/i);
		expect(offline).toMatch(/See Pulse/);
		// Must NOT claim the service IS unreachable — that's Pulse's job.
		expect(offline).not.toMatch(/is unreachable/i);
		expect(offline).not.toMatch(/may be unreachable/i);

		const degraded = getDomainStatusMeta("degraded").description;
		expect(degraded).toMatch(/last check/i);
		expect(degraded).toMatch(/See Pulse/);
	});

	it("leaves benign states (healthy/configured/disabled) without a Pulse CTA", () => {
		// Adding "See Pulse" to every tooltip would be noise. The CTA
		// belongs only where the badge could otherwise be mistaken for a
		// live diagnosis.
		expect(getDomainStatusMeta("healthy").description).not.toMatch(/See Pulse/);
		expect(getDomainStatusMeta("configured").description).not.toMatch(/See Pulse/);
		expect(getDomainStatusMeta("disabled").description).not.toMatch(/See Pulse/);
	});
});
