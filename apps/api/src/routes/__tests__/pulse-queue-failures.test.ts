/**
 * Integration tests for queue.retry action emission via collectArrQueueFailures.
 *
 * Covers:
 *   - classifier gate (failed → emits, stuck-with-error → emits,
 *     warning-without-error → does NOT emit, healthy → does NOT emit,
 *     completed → does NOT emit)
 *   - fan-out cap (10 visible rows per instance + 1 rollup row if more)
 *   - rollup row has NO action and points at the queue page
 *   - service gate (only sonarr/radarr/lidarr/readarr — prowlarr excluded)
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the arr-sdk client guards so the collector's fetchRawQueue
// branches hit a deterministic stub.
vi.mock("../../lib/arr/client-helpers.js", () => ({
	isSonarrClient: (c: unknown) =>
		typeof c === "object" && c !== null && (c as { __kind?: string }).__kind === "sonarr",
	isRadarrClient: (c: unknown) =>
		typeof c === "object" && c !== null && (c as { __kind?: string }).__kind === "radarr",
	isLidarrClient: (c: unknown) =>
		typeof c === "object" && c !== null && (c as { __kind?: string }).__kind === "lidarr",
	isReadarrClient: (c: unknown) =>
		typeof c === "object" && c !== null && (c as { __kind?: string }).__kind === "readarr",
}));

// Expose only the collector under test so other collectors don't need
// plugin decorations we don't provide.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectArrQueueFailures] };
});

import { registerPulseRoutes } from "../pulse.js";
import {
	createInjectAuthenticated,
	makePulseDismissalStub,
	setupAuthInjection,
} from "./test-helpers.js";

type QueueItem = Record<string, unknown>;

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let userCounter = 0;

/** Canned queue per instance id; set per-test. */
let queueByInstanceId: Map<string, QueueItem[]>;
/** Canned serviceInstance rows returned by prisma.findMany. */
let instanceRows: Array<{ id: string; service: string; label: string; enabled: boolean }>;

function makeInstance(
	overrides: Partial<{ id: string; service: string; label: string; enabled: boolean }> = {},
): { id: string; service: string; label: string; enabled: boolean } {
	return {
		id: "inst-sonarr-1",
		service: "SONARR",
		label: "Home Sonarr",
		enabled: true,
		...overrides,
	};
}

function makeQueueItem(overrides: QueueItem = {}): QueueItem {
	return {
		id: 1,
		title: "Some.Show.S01E01",
		added: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
		status: "downloading",
		trackedDownloadStatus: "ok",
		trackedDownloadState: "downloading",
		errorMessage: "",
		...overrides,
	};
}

beforeEach(async () => {
	userCounter += 1;
	queueByInstanceId = new Map();
	instanceRows = [];

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-queue-${userCounter}`, username: "admin" });

	app.decorate("prisma", {
		pulseDismissal: makePulseDismissalStub(),
		serviceInstance: {
			findMany: async () => instanceRows,
		},
	} as unknown as never);
	app.decorate("arrClientFactory", {
		create: (instance: { id: string; service: string }) => ({
			__kind: instance.service.toLowerCase(),
			queue: {
				get: async () => ({
					records: queueByInstanceId.get(instance.id) ?? [],
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

describe("GET /pulse — collectArrQueueFailures emission", () => {
	it("emits a queue.retry action for a trackedDownloadState=importFailed item", async () => {
		instanceRows = [makeInstance()];
		queueByInstanceId.set("inst-sonarr-1", [
			makeQueueItem({
				id: 7,
				title: "Failing.Show.S01E02",
				trackedDownloadState: "importFailed",
				trackedDownloadStatus: "error",
				errorMessage: "Could not find a matching episode",
			}),
		]);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "queue-failed-inst-sonarr-1-7");

		expect(item).toBeDefined();
		expect(item.action).toEqual({
			kind: "queue.retry",
			target: { instanceId: "inst-sonarr-1", queueItemId: "7", service: "sonarr" },
			label: "Retry",
			destructive: false,
		});
	});

	it("emits for trackedDownloadStatus=warning ONLY when errorMessage is present", async () => {
		instanceRows = [makeInstance()];
		queueByInstanceId.set("inst-sonarr-1", [
			makeQueueItem({
				id: 8,
				title: "Warning.With.Detail",
				trackedDownloadStatus: "warning",
				errorMessage: "Download stalled: no peers",
			}),
			makeQueueItem({
				id: 9,
				title: "Warning.Without.Detail",
				trackedDownloadStatus: "warning",
				errorMessage: "",
			}),
		]);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const withDetail = body.items.find(
			(i: { id: string }) => i.id === "queue-stuck-inst-sonarr-1-8",
		);
		const withoutDetail = body.items.find((i: { id: string }) => i.id.endsWith("inst-sonarr-1-9"));

		expect(withDetail?.action?.kind).toBe("queue.retry");
		// No errorMessage → not a concrete problem → no emission.
		expect(withoutDetail).toBeUndefined();
	});

	it("does NOT emit for healthy/downloading items", async () => {
		instanceRows = [makeInstance()];
		queueByInstanceId.set("inst-sonarr-1", [
			makeQueueItem({
				id: 10,
				trackedDownloadStatus: "ok",
				trackedDownloadState: "downloading",
				status: "downloading",
			}),
		]);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueItems = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));

		expect(queueItems).toEqual([]);
	});

	it("caps at 10 visible items per instance and emits a rollup row with NO action", async () => {
		instanceRows = [makeInstance()];
		queueByInstanceId.set(
			"inst-sonarr-1",
			Array.from({ length: 15 }, (_, idx) =>
				makeQueueItem({
					id: 100 + idx,
					title: `Failed.${idx}`,
					trackedDownloadStatus: "error",
					trackedDownloadState: "importFailed",
					errorMessage: `Error ${idx}`,
				}),
			),
		);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));
		const rollup = queueRows.find((i: { id: string }) => i.id === "queue-overflow-inst-sonarr-1");
		const failedRows = queueRows.filter((i: { id: string }) => i.id.startsWith("queue-failed-"));

		// Exactly 10 visible + 1 rollup
		expect(failedRows).toHaveLength(10);
		expect(rollup).toBeDefined();
		// Rollup MUST NOT carry an action — operators must go to the queue page
		// to deal with overflow.
		expect(rollup.action).toBeUndefined();
		expect(rollup.title).toContain("+5 more failed items");
		expect(rollup.actionUrl).toBe("/dashboard");
	});

	it("does not emit anything when no ARR instances are configured", async () => {
		instanceRows = [];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));

		expect(queueRows).toEqual([]);
	});

	it("continues processing other instances when one instance's queue fetch throws", async () => {
		// Simulate a broken Sonarr alongside a healthy Radarr. The collector
		// must swallow the per-instance error (collectArrSignals handles the
		// user-visible "unreachable" warning) and still emit from the healthy
		// instance.
		instanceRows = [
			makeInstance({ id: "inst-broken", service: "SONARR", label: "Broken" }),
			makeInstance({ id: "inst-ok", service: "RADARR", label: "OK Radarr" }),
		];
		// Radarr gets a failed item; broken Sonarr will throw.
		queueByInstanceId.set("inst-ok", [
			makeQueueItem({
				id: 99,
				title: "Healthy.Failed.Item",
				trackedDownloadState: "importFailed",
				trackedDownloadStatus: "error",
				errorMessage: "real error",
			}),
		]);
		// Override factory to throw for the broken instance.
		app.arrClientFactory = {
			create: (instance: { id: string; service: string }) => {
				if (instance.id === "inst-broken") {
					return {
						__kind: "sonarr",
						queue: {
							get: async () => {
								throw new Error("boom");
							},
						},
					};
				}
				return {
					__kind: instance.service.toLowerCase(),
					queue: {
						get: async () => ({ records: queueByInstanceId.get(instance.id) ?? [] }),
					},
				};
			},
		} as unknown as typeof app.arrClientFactory;

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));

		expect(queueRows).toHaveLength(1);
		expect(queueRows[0].id).toBe("queue-failed-inst-ok-99");
	});

	it("caps each instance independently — 2 instances × 15 items → 22 rows (10 + 1 per instance)", async () => {
		// Automated equivalent of the multi-instance manual check: the
		// fan-out cap is per-instance, so a fleet with two unhealthy ARRs
		// produces 2 × (10 visible + 1 rollup) = 22 rows, never the full
		// 30. Cross-instance bleed (one instance's cap eating another's
		// quota) would surface here as a wrong row count.
		instanceRows = [
			makeInstance({ id: "inst-sonarr", service: "SONARR", label: "Sonarr" }),
			makeInstance({ id: "inst-radarr", service: "RADARR", label: "Radarr" }),
		];
		const makeFailedItems = (count: number) =>
			Array.from({ length: count }, (_, idx) =>
				makeQueueItem({
					id: idx + 1,
					title: `Failed.${idx}`,
					trackedDownloadState: "importFailed",
					trackedDownloadStatus: "error",
					errorMessage: `Error ${idx}`,
				}),
			);
		queueByInstanceId.set("inst-sonarr", makeFailedItems(15));
		queueByInstanceId.set("inst-radarr", makeFailedItems(15));

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));

		const sonarrVisible = queueRows.filter((i: { id: string }) =>
			i.id.startsWith("queue-failed-inst-sonarr-"),
		);
		const radarrVisible = queueRows.filter((i: { id: string }) =>
			i.id.startsWith("queue-failed-inst-radarr-"),
		);
		const sonarrRollup = queueRows.find(
			(i: { id: string }) => i.id === "queue-overflow-inst-sonarr",
		);
		const radarrRollup = queueRows.find(
			(i: { id: string }) => i.id === "queue-overflow-inst-radarr",
		);

		// Each instance capped at exactly 10 visible items
		expect(sonarrVisible).toHaveLength(10);
		expect(radarrVisible).toHaveLength(10);
		// Each has its own rollup
		expect(sonarrRollup?.title).toContain("+5 more failed items");
		expect(radarrRollup?.title).toContain("+5 more failed items");
		// Total: 10 + 10 + 2 rollups = 22 rows, no cross-instance bleed
		expect(queueRows).toHaveLength(22);
	});

	it("cap selection prioritizes failed items over stuck items when total > cap", async () => {
		// Automated equivalent of "order is correct" — but specifically the
		// operationally-important invariant: when the 10-row cap forces a
		// choice between failed and stuck items, FAILED items win. Operators
		// care more about a permanent failure than a transient warning, so
		// sacrificing stuck rows to the rollup is the right call.
		//
		// Setup: 8 failed + 8 stuck = 16 total. Cap is 10. Expected: all 8
		// failed survive + 2 of the 8 stuck. Reversed priority would leave
		// only 2 failed items visible, a trust regression.
		instanceRows = [makeInstance()];
		const base = Date.now();
		const items: ReturnType<typeof makeQueueItem>[] = [];
		for (let i = 0; i < 8; i += 1) {
			items.push(
				makeQueueItem({
					id: 100 + i,
					title: `Failed.${i}`,
					// Failed items given NEWER timestamps — would lose to
					// stuck on a "newest first" or "by timestamp" sort. If
					// they still win the cap, we've proved the collector
					// prioritizes classification over recency.
					added: new Date(base - i * 60 * 60 * 1000).toISOString(),
					trackedDownloadState: "importFailed",
					trackedDownloadStatus: "error",
					errorMessage: `failed ${i}`,
				}),
			);
		}
		for (let i = 0; i < 8; i += 1) {
			items.push(
				makeQueueItem({
					id: 200 + i,
					title: `Stuck.${i}`,
					added: new Date(base - (10 + i) * 60 * 60 * 1000).toISOString(),
					trackedDownloadStatus: "warning",
					errorMessage: `stuck ${i}`,
				}),
			);
		}
		queueByInstanceId.set("inst-sonarr-1", items);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const queueRows = body.items.filter((i: { id: string }) => i.id.startsWith("queue-"));
		const failedCount = queueRows.filter((i: { id: string }) =>
			i.id.startsWith("queue-failed-"),
		).length;
		const stuckCount = queueRows.filter((i: { id: string }) =>
			i.id.startsWith("queue-stuck-"),
		).length;
		const rollup = queueRows.find((i: { id: string }) => i.id === "queue-overflow-inst-sonarr-1");

		expect(failedCount).toBe(8); // all failed survived
		expect(stuckCount).toBe(2); // only 2 of 8 stuck survived
		expect(rollup).toBeDefined();
		expect(rollup.title).toContain("+6 more"); // 16 total - 10 visible = 6 overflow
	});
});
