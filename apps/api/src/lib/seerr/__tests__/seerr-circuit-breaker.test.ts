/**
 * Unit tests for SeerrCircuitBreaker.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CircuitBreakerOpenError,
	SeerrCircuitBreaker,
} from "../seerr-circuit-breaker.js";

let breaker: SeerrCircuitBreaker;

describe("SeerrCircuitBreaker", () => {
	afterEach(() => {
		breaker.destroy();
		vi.restoreAllMocks();
	});

	it("allows requests when circuit is CLOSED", () => {
		breaker = new SeerrCircuitBreaker();
		expect(() => breaker.check("inst-1")).not.toThrow();
	});

	it("transitions CLOSED → OPEN after threshold consecutive failures", () => {
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 3,
			failureWindowMs: 60_000,
			cooldownMs: 30_000,
		});

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		expect(() => breaker.check("inst-1")).not.toThrow(); // Not yet

		breaker.reportFailure("inst-1");
		expect(() => breaker.check("inst-1")).toThrow(CircuitBreakerOpenError);
	});

	it("transitions OPEN → HALF_OPEN after cooldown", () => {
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 2,
			cooldownMs: 1_000,
		});

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		expect(() => breaker.check("inst-1")).toThrow(CircuitBreakerOpenError);

		// Simulate cooldown elapsed
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_500);
		expect(() => breaker.check("inst-1")).not.toThrow(); // HALF_OPEN allows probe
	});

	it("transitions HALF_OPEN → CLOSED on probe success", () => {
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 2,
			cooldownMs: 100,
		});

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
		breaker.check("inst-1"); // Transitions to HALF_OPEN

		breaker.reportSuccess("inst-1"); // Probe success → CLOSED
		expect(breaker.getState("inst-1")).toBe("CLOSED");
		expect(() => breaker.check("inst-1")).not.toThrow();
	});

	it("transitions HALF_OPEN → OPEN on probe failure", () => {
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 2,
			cooldownMs: 100,
		});

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
		breaker.check("inst-1"); // → HALF_OPEN

		breaker.reportFailure("inst-1"); // Probe failed → OPEN
		expect(breaker.getState("inst-1")).toBe("OPEN");
	});

	it("isolates circuits per instance", () => {
		breaker = new SeerrCircuitBreaker({ failureThreshold: 2 });

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		expect(() => breaker.check("inst-1")).toThrow(CircuitBreakerOpenError);
		expect(() => breaker.check("inst-2")).not.toThrow(); // Different instance
	});

	it("resets failures on success", () => {
		breaker = new SeerrCircuitBreaker({ failureThreshold: 3 });

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		breaker.reportSuccess("inst-1"); // Reset

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		expect(() => breaker.check("inst-1")).not.toThrow(); // Only 2 after reset
	});

	it("prunes failures outside the window", () => {
		const now = Date.now();
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 3,
			failureWindowMs: 1_000,
		});

		vi.spyOn(Date, "now").mockReturnValue(now);
		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");

		// Jump past the window
		vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
		breaker.reportFailure("inst-1"); // Old 2 pruned, only 1 in window

		expect(() => breaker.check("inst-1")).not.toThrow();
	});

	it("destroy() clears all state", () => {
		breaker = new SeerrCircuitBreaker({ failureThreshold: 2 });
		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");

		breaker.destroy();
		// After destroy, a new check should not throw (state cleared)
		breaker = new SeerrCircuitBreaker({ failureThreshold: 2 });
		expect(() => breaker.check("inst-1")).not.toThrow();
	});

	it("getState() reports correct state", () => {
		breaker = new SeerrCircuitBreaker({
			failureThreshold: 2,
			cooldownMs: 100,
		});

		expect(breaker.getState("inst-1")).toBe("CLOSED");

		breaker.reportFailure("inst-1");
		breaker.reportFailure("inst-1");
		expect(breaker.getState("inst-1")).toBe("OPEN");

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
		expect(breaker.getState("inst-1")).toBe("HALF_OPEN");
	});

	it("CircuitBreakerOpenError has correct properties", () => {
		breaker = new SeerrCircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000 });
		breaker.reportFailure("inst-1");

		try {
			breaker.check("inst-1");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CircuitBreakerOpenError);
			const cbErr = err as CircuitBreakerOpenError;
			expect(cbErr.statusCode).toBe(503);
			expect(cbErr.retryAfterMs).toBeGreaterThan(0);
			expect(cbErr.retryAfterMs).toBeLessThanOrEqual(5_000);
		}
	});
});
