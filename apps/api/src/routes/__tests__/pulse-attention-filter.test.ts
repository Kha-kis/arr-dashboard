/**
 * Route-level tests for the `attentionOnly` query-param filter on GET /pulse.
 *
 * Contract under test:
 *   - Default GET /pulse is unchanged (returns every item the collectors produce).
 *   - GET /pulse?attentionOnly=true returns only items that are
 *     (severity: critical | warning) AND have a non-empty actionUrl.
 *   - Summary counts reflect the filtered items. `info` is always 0 in the
 *     attention view; items without an actionUrl are excluded regardless of
 *     severity.
 *   - Response shape is unchanged (same PulseResponse fields).
 *
 * We stub `pulseCollectors` with a single fixed collector so the test is a
 * pure assertion on the route's filter, not on real-world collector output.
 */

import type { PulseItem } from "@arr/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let items: PulseItem[] = [];

// Replace the real collectors with a single collector that returns the
// per-test `items` fixture. This keeps the route running end-to-end while
// letting us drive the exact set of items being filtered.
vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [async () => items],
}));

import { registerPulseRoutes } from "../pulse.js";
import {
	createInjectAuthenticated,
	makePulseDismissalStub,
	setupAuthInjection,
} from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

// The /pulse route caches responses per-userId for 60s at module scope.
// Use a unique user per test so no result is served from a prior test's cache.
let userCounter = 0;

function makeItem(overrides: Partial<PulseItem> = {}): PulseItem {
	return {
		id: "item-1",
		severity: "warning",
		category: "health",
		title: "Example",
		detail: "Example detail",
		actionUrl: "/settings",
		source: "system",
		timestamp: "2026-04-14T09:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-attn-${userCounter}`, username: "admin" });
	app.decorate("prisma", { pulseDismissal: makePulseDismissalStub() } as unknown as never);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — attentionOnly filter", () => {
	it("returns every item by default (filter absent)", async () => {
		items = [
			makeItem({ id: "critical-actionable", severity: "critical", actionUrl: "/queue" }),
			makeItem({ id: "warning-actionable", severity: "warning", actionUrl: "/settings" }),
			makeItem({ id: "warning-no-action", severity: "warning", actionUrl: undefined }),
			makeItem({ id: "info-actionable", severity: "info", actionUrl: "/library" }),
			makeItem({ id: "info-no-action", severity: "info", actionUrl: undefined }),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const ids = body.items.map((i: PulseItem) => i.id).sort();

		expect(ids).toEqual([
			"critical-actionable",
			"info-actionable",
			"info-no-action",
			"warning-actionable",
			"warning-no-action",
		]);
		expect(body.summary).toEqual({ critical: 1, warning: 2, info: 2 });
	});

	it("returns only actionable critical/warning items when attentionOnly=true", async () => {
		items = [
			makeItem({ id: "critical-actionable", severity: "critical", actionUrl: "/queue" }),
			makeItem({ id: "warning-actionable", severity: "warning", actionUrl: "/settings" }),
			// Excluded: severity matches but no actionUrl
			makeItem({ id: "warning-no-action", severity: "warning", actionUrl: undefined }),
			// Excluded: severity matches but empty actionUrl
			makeItem({ id: "critical-empty-action", severity: "critical", actionUrl: "" }),
			// Excluded: info is never attention-worthy, even with actionUrl
			makeItem({ id: "info-actionable", severity: "info", actionUrl: "/library" }),
			makeItem({ id: "info-no-action", severity: "info", actionUrl: undefined }),
		];

		const res = await injectAuthenticated("GET", "/pulse?attentionOnly=true");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const ids = body.items.map((i: PulseItem) => i.id).sort();

		expect(ids).toEqual(["critical-actionable", "warning-actionable"]);

		// Summary reflects only the filtered items — info always 0 in this view.
		expect(body.summary).toEqual({ critical: 1, warning: 1, info: 0 });

		// Shape unchanged: same top-level keys (dismissedCount carried through
		// from the full feed — curated surfaces just don't render it).
		expect(Object.keys(body).sort()).toEqual(["dismissedCount", "generatedAt", "items", "summary"]);
	});

	it("returns an empty feed when no item is both severe and actionable", async () => {
		items = [
			makeItem({ id: "info-actionable", severity: "info", actionUrl: "/library" }),
			makeItem({ id: "warning-no-action", severity: "warning", actionUrl: undefined }),
		];

		const res = await injectAuthenticated("GET", "/pulse?attentionOnly=true");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		expect(body.items).toEqual([]);
		expect(body.summary).toEqual({ critical: 0, warning: 0, info: 0 });
	});

	it("ignores unrecognized values of attentionOnly (only 'true' opts in)", async () => {
		items = [
			makeItem({ id: "warning-actionable", severity: "warning", actionUrl: "/settings" }),
			makeItem({ id: "info-no-action", severity: "info", actionUrl: undefined }),
		];

		const res = await injectAuthenticated("GET", "/pulse?attentionOnly=1");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const ids = body.items.map((i: PulseItem) => i.id).sort();

		// `=1` is not `=true`, so the default (unfiltered) response is returned.
		expect(ids).toEqual(["info-no-action", "warning-actionable"]);
	});
});
