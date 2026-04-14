/**
 * Integration test for the Pulse collector-failure surface.
 *
 * Boots Fastify with the real `/pulse` route, swaps in a throwing collector,
 * and asserts the end-to-end operator-visible `detail` string — replaces the
 * manual "throw inside a collector and eyeball the UI" check from the PR
 * test plan with automated coverage.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Swap the collectors module BEFORE the route imports it. One collector
// throws (to force the failure branch), one succeeds (to confirm partial
// results still flow through).
vi.mock("../../lib/pulse/collectors.js", () => {
	async function collectArrSignals() {
		throw new Error("boom — simulated ARR fetch failure");
	}
	async function collectCacheStaleness() {
		return [];
	}
	return { pulseCollectors: [collectArrSignals, collectCacheStaleness] };
});

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	app = Fastify({ logger: false });
	setupAuthInjection(app);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — collector failure detail wording", () => {
	it("renders the operator-friendly label, not the raw function name", async () => {
		const res = await injectAuthenticated("GET", "/pulse");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const errorItem = body.items.find((i: { id: string }) =>
			i.id.startsWith("collector-error-"),
		);

		expect(errorItem).toBeDefined();

		// The id still keys off the function name — #330's stability contract.
		expect(errorItem.id).toBe("collector-error-collectArrSignals");

		// But the operator-visible copy must not leak the function name.
		expect(errorItem.detail).toBe(
			"The ARR health and disk space check encountered an error — results may be incomplete.",
		);
		expect(errorItem.detail).not.toContain("collectArrSignals");
		expect(errorItem.title).toBe("Could not check some signals");
		expect(errorItem.severity).toBe("warning");

		// Summary still counts it as a warning — partial-failure trust model.
		expect(body.summary.warning).toBeGreaterThanOrEqual(1);
	});
});
