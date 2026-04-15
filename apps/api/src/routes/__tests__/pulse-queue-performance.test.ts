/**
 * Performance sanity test for collectArrQueueFailures.
 *
 * Automated equivalent of the "performance sanity — hit /pulse, confirm
 * response time isn't degraded noticeably" manual check from the V1.1
 * test plan. The absolute threshold here is deliberately loose (well
 * within what CI and slow dev machines tolerate) — the point isn't to
 * measure absolute speed, it's to catch an accidental O(n²) or a runaway
 * per-item operation that slips in as the collector grows.
 *
 * A realistic worst case today: an operator with 5 ARR instances, each
 * queue averaging ~200 items. We simulate that and assert the collector
 * completes under 500ms. A future regression that makes the collector
 * scale badly (e.g. re-fetching metadata per item) trips this bound.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/arr/client-helpers.js", () => ({
	isSonarrClient: (c: unknown) =>
		typeof c === "object" && c !== null && (c as { __kind?: string }).__kind === "sonarr",
	isRadarrClient: () => false,
	isLidarrClient: () => false,
	isReadarrClient: () => false,
}));

vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectArrQueueFailures] };
});

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let userCounter = 0;

const PERFORMANCE_BOUND_MS = 500;
const INSTANCE_COUNT = 5;
const ITEMS_PER_INSTANCE = 200;

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-perf-${userCounter}`, username: "admin" });

	const instances = Array.from({ length: INSTANCE_COUNT }, (_, idx) => ({
		id: `inst-perf-${idx}`,
		service: "SONARR",
		label: `Sonarr ${idx}`,
		enabled: true,
	}));

	app.decorate("prisma", {
		serviceInstance: {
			findMany: async () => instances,
		},
	} as unknown as never);
	app.decorate("arrClientFactory", {
		create: (instance: { id: string }) => ({
			__kind: "sonarr",
			queue: {
				get: async () => ({
					records: Array.from({ length: ITEMS_PER_INSTANCE }, (_, idx) => ({
						// Mix of failed, stuck, and healthy — realistic distribution
						id: idx,
						title: `Item.${instance.id}.${idx}`,
						added: new Date(Date.now() - idx * 60 * 1000).toISOString(),
						trackedDownloadState:
							idx % 10 === 0 ? "importFailed" : idx % 7 === 0 ? "downloading" : "ok",
						trackedDownloadStatus: idx % 10 === 0 ? "error" : idx % 5 === 0 ? "warning" : "ok",
						errorMessage: idx % 5 === 0 ? "some error" : "",
						status: "downloading",
					})),
				}),
			},
		}),
	} as unknown as never);

	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — performance sanity under realistic load", () => {
	it(`completes under ${PERFORMANCE_BOUND_MS}ms with ${INSTANCE_COUNT} instances × ${ITEMS_PER_INSTANCE} items`, async () => {
		const start = performance.now();
		const res = await injectAuthenticated("GET", "/pulse");
		const elapsed = performance.now() - start;

		expect(res.statusCode).toBe(200);
		// Sanity: the fan-out cap + rollup keeps row count bounded regardless
		// of input size. 5 instances × (10 visible + 1 rollup) = 55 rows max.
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));
		expect(queueRows.length).toBeLessThanOrEqual(INSTANCE_COUNT * 11);

		// Loose wall-clock bound. If this trips, a regression introduced an
		// unbounded per-item cost (e.g., re-fetching data, N² sort, sync
		// serial loop where parallel was intended).
		expect(elapsed).toBeLessThan(PERFORMANCE_BOUND_MS);
	});
});
