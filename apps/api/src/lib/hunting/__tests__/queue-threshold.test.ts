/**
 * Tests for queue threshold check in executeHuntWithSdk.
 *
 * Regression coverage for issue #438:
 *  - Sonarr hunts were being skipped because the queue threshold counted ALL
 *    queue records (stuck/failed/completed-waiting items). The fix filters to
 *    "active" statuses only.
 *
 * Also pins the post-review distinction between two skip paths:
 *  - threshold-exceeded → status "skipped" (operator's queue is busy, healthy throttle).
 *  - check-failed (connectivity, malformed response) → status "error" (actionable).
 */

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeHuntWithSdk } from "../hunt-executor.js";

const ACTIVE_STATUSES = ["queued", "downloading", "paused", "delay"];

/**
 * Build an empty JSON-array Response for the streaming-fetch path
 * (lib/arr/library-stream.ts). The hunt-executor uses factory.rawRequest
 * to stream the bulk-list endpoint, so these tests need a Response that
 * parses to zero items. This is the moral equivalent of mocking
 * `client.series.getAll()` to resolve `[]`.
 */
function emptyStreamResponse(): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("[]"));
				controller.close();
			},
		}),
	);
}

function makeMockApp(client: unknown): Partial<FastifyInstance> {
	const log = {
		child: vi.fn().mockReturnValue({
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		}),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	};
	return {
		log: log as unknown as FastifyInstance["log"],
		arrClientFactory: {
			create: vi.fn().mockReturnValue(client),
			// rawRequest is hit by the streaming bulk-fetch path. Default to an
			// empty array so the queue-threshold tests don't need to wire
			// per-test streaming bodies — they care about queue gating, not
			// what the catalog contains.
			rawRequest: vi.fn().mockImplementation(async () => emptyStreamResponse()),
		} as unknown as FastifyInstance["arrClientFactory"],
		prisma: {
			huntSearchHistory: {
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				create: vi.fn().mockResolvedValue({}),
				createMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		} as unknown as FastifyInstance["prisma"],
	};
}

const sonarrInstance = {
	id: "instance-1",
	service: "SONARR",
	label: "Test Sonarr",
};

const readarrInstance = {
	id: "instance-2",
	service: "READARR",
	label: "Test Readarr",
};

const baseConfig = {
	id: "config-1",
	queueThreshold: 25,
	missingBatchSize: 10,
	upgradeBatchSize: 10,
	researchAfterDays: 7,
	preferSeasonPacks: false,
	upgradeSearchAll: false,
};

const callExecute = (
	app: Partial<FastifyInstance>,
	type: "missing" | "upgrade",
	overrides: Partial<typeof baseConfig> = {},
	instance: typeof sonarrInstance = sonarrInstance,
) =>
	executeHuntWithSdk(
		app as FastifyInstance,
		instance as unknown as Parameters<typeof executeHuntWithSdk>[1],
		{ ...baseConfig, ...overrides } as unknown as Parameters<typeof executeHuntWithSdk>[2],
		type,
	);

describe("executeHuntWithSdk — queue threshold (issue #438)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes ACTIVE_QUEUE_STATUSES filter to queue.get so stuck/failed/completed items don't gate the hunt", async () => {
		const queueGet = vi.fn().mockResolvedValue({ totalRecords: 5 });
		const seriesGetAll = vi.fn().mockResolvedValue([]);
		const wantedMissing = vi.fn().mockResolvedValue({ records: [], totalRecords: 0 });

		const client = {
			queue: { get: queueGet },
			series: { getAll: seriesGetAll },
			wanted: { missing: wantedMissing, cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		await callExecute(app, "missing");

		expect(queueGet).toHaveBeenCalledTimes(1);
		const callArgs = queueGet.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(callArgs.pageSize).toBe(1);
		expect(callArgs.status).toEqual(ACTIVE_STATUSES);
	});

	it("does NOT skip when active queue is below threshold even if many stuck items would have totaled higher", async () => {
		const queueGet = vi.fn().mockResolvedValue({ totalRecords: 5 });
		const wantedMissing = vi.fn().mockResolvedValue({ records: [], totalRecords: 0 });

		const client = {
			queue: { get: queueGet },
			// series.getAll is unused now — the bulk catalog comes through the
			// streaming `rawRequest` path on the factory (issue #427). Kept as
			// a no-op so the SDK fallback in hunt-executor doesn't see undefined
			// if streaming somehow fails.
			series: { getAll: vi.fn().mockResolvedValue([]) },
			wanted: { missing: wantedMissing, cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		const result = await callExecute(app, "missing");

		expect(result.status).not.toBe("skipped");
		// We proceeded past the queue check and hit the catalog fetch — proof
		// it didn't short-circuit at the threshold.
		expect(app.arrClientFactory!.rawRequest).toHaveBeenCalled();
	});

	it("skips with active-queue message when active queue exceeds threshold", async () => {
		const queueGet = vi.fn().mockResolvedValue({ totalRecords: 30 });
		const client = {
			queue: { get: queueGet },
			series: { getAll: vi.fn() },
			wanted: { missing: vi.fn(), cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		const result = await callExecute(app, "missing");

		expect(result.status).toBe("skipped");
		expect(result.message).toMatch(/Active queue \(30\) exceeds threshold \(25\)/);
		expect(result.apiCallsMade).toBe(1);
	});

	it("disabled threshold (0) skips queue.get entirely", async () => {
		const queueGet = vi.fn();
		const seriesGetAll = vi.fn().mockResolvedValue([]);
		const wantedMissing = vi.fn().mockResolvedValue({ records: [], totalRecords: 0 });

		const client = {
			queue: { get: queueGet },
			series: { getAll: seriesGetAll },
			wanted: { missing: wantedMissing, cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		await callExecute(app, "missing", { queueThreshold: 0 });

		expect(queueGet).not.toHaveBeenCalled();
	});

	it("queue.get throwing yields status:error (not skipped) so connectivity failures are actionable", async () => {
		const queueGet = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const seriesGetAll = vi.fn();

		const client = {
			queue: { get: queueGet },
			series: { getAll: seriesGetAll },
			wanted: { missing: vi.fn(), cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		const result = await callExecute(app, "missing");

		expect(result.status).toBe("error");
		expect(result.message).toMatch(/Queue check failed/);
		expect(seriesGetAll).not.toHaveBeenCalled();
	});

	it("malformed response (missing totalRecords) yields status:error to fail safe", async () => {
		// Reverse-proxy returning HTML, future SDK field rename, etc. — the
		// queue-check should refuse to interpret a missing field as "empty queue".
		const queueGet = vi.fn().mockResolvedValue({ records: [] });
		const seriesGetAll = vi.fn();

		const client = {
			queue: { get: queueGet },
			series: { getAll: seriesGetAll },
			wanted: { missing: vi.fn(), cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		const result = await callExecute(app, "missing");

		expect(result.status).toBe("error");
		expect(result.message).toMatch(/unexpected response shape/);
		expect(seriesGetAll).not.toHaveBeenCalled();
	});

	it("Readarr does NOT receive the status filter (SDK enumerates fields and would drop it)", async () => {
		// Readarr's arr-sdk QueueResource.get only forwards a known set of fields
		// — `status` is not among them. Sending it would be a silent no-op, so
		// we suppress it here and use the unfiltered count, with the message
		// reflecting that ("Queue" not "Active queue"). Pre-fix behavior is
		// preserved on Readarr.
		const queueGet = vi.fn().mockResolvedValue({ totalRecords: 30 });
		const client = {
			queue: { get: queueGet },
			author: { getAll: vi.fn().mockResolvedValue([]) },
			wanted: { missing: vi.fn(), cutoff: vi.fn() },
		};
		const app = makeMockApp(client);

		const result = await callExecute(app, "missing", {}, readarrInstance);

		const callArgs = queueGet.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(callArgs).not.toHaveProperty("status");
		expect(callArgs.pageSize).toBe(1);
		expect(result.status).toBe("skipped");
		expect(result.message).toMatch(/^Queue \(30\) exceeds threshold \(25\)$/);
	});
});
