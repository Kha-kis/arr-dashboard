/**
 * End-to-end integration test for the queue.retry action path.
 *
 * Companion to pulse-action-e2e.test.ts (scheduler.enable) and
 * pulse-action-e2e-cache.test.ts (cache.refresh). Proves the same
 * contract across the queue.retry dispatcher branch:
 *
 *   1. A failed queue item surfaces with a queue.retry envelope.
 *   2. POSTing the envelope invokes client.queue.delete with the exact
 *      retry options the /dashboard/queue/action route uses and 200s.
 *   3. The next GET /pulse naturally drops the row — queue state isn't
 *      stored in our DB, so the stub simulates "item gone from ARR queue"
 *      by clearing its records after retry. If the per-user Pulse cache
 *      had survived, we'd still see the stale item; this step proves
 *      server-side cache invalidation fires.
 *
 * Stubbing notes: the arr-sdk client guards are mocked so
 * `isSonarrClient(client)` returns true for our canned client. The
 * client's `queue.delete` is a spy we assert on, and `queue.get` serves
 * a per-test-controlled array.
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
import { registerTestErrorHandler } from "./test-helpers.js";

type QueueItem = Record<string, unknown>;
let queueRecords: QueueItem[];
let deleteSpy: (id: number, opts: unknown) => Promise<void>;
let deleteCalls: Array<{ id: number; opts: unknown }>;

let app: ReturnType<typeof Fastify>;
let userCounter = 0;
const AUTH_HEADER = "x-test-auth";

function setupAuthGate(app: ReturnType<typeof Fastify>, userId: string) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = { id: userId, username: "admin" };
			req.sessionToken = "mock-session-token";
		}
	});
}

async function injectGet(url: string) {
	return app.inject({ method: "GET", url, headers: { [AUTH_HEADER]: "1" } });
}

async function injectPost(url: string, body: unknown) {
	return app.inject({
		method: "POST",
		url,
		headers: { [AUTH_HEADER]: "1", "content-type": "application/json" },
		payload: JSON.stringify(body),
	});
}

beforeEach(async () => {
	userCounter += 1;
	queueRecords = [];
	deleteCalls = [];
	deleteSpy = async (id, opts) => {
		// Live stub: on successful retry, the ARR queue would no longer list
		// the item. Clearing the records here models that — the next
		// GET /pulse (after server-side cache invalidation) will see an
		// empty queue and emit no rows.
		deleteCalls.push({ id, opts });
		queueRecords = [];
	};

	app = Fastify({ logger: false });
	setupAuthGate(app, `e2e-queue-user-${userCounter}`);
	registerTestErrorHandler(app);

	const instance = {
		id: "inst-sonarr-1",
		service: "SONARR",
		label: "Home Sonarr",
		enabled: true,
	};

	app.decorate("prisma", {
		serviceInstance: {
			findMany: async () => [instance],
			findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
				where.id === instance.id ? instance : null,
		},
	} as unknown as never);
	app.decorate("arrClientFactory", {
		create: () => ({
			__kind: "sonarr",
			queue: {
				get: async () => ({ records: queueRecords }),
				delete: (id: number, opts: unknown) => deleteSpy(id, opts),
			},
		}),
	} as unknown as never);

	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("Pulse actionability — queue.retry end-to-end", () => {
	it("failed queue item → action item → POST 200 with correct SDK call → row drops on next poll", async () => {
		queueRecords = [
			{
				id: 42,
				title: "Failing.Show.S01E02",
				added: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
				trackedDownloadState: "importFailed",
				trackedDownloadStatus: "error",
				errorMessage: "Could not find matching episode",
				status: "failed",
			},
		];

		// 1. Collector surfaces the item.
		const first = await injectGet("/pulse");
		const firstBody = JSON.parse(first.payload);
		const failedItem = firstBody.items.find(
			(i: { id: string }) => i.id === "queue-failed-inst-sonarr-1-42",
		);
		expect(failedItem).toBeDefined();
		expect(failedItem.action).toEqual({
			kind: "queue.retry",
			target: {
				instanceId: "inst-sonarr-1",
				queueItemId: "42",
				service: "sonarr",
			},
			label: "Retry",
			destructive: false,
		});

		// 2. POST the envelope verbatim — mirrors what <PulseActionButton />
		//    does on click.
		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(failedItem.id)}/action`,
			failedItem.action,
		);
		expect(actionRes.statusCode).toBe(200);
		expect(JSON.parse(actionRes.payload)).toEqual({ status: "ok" });

		// The SDK call must use the exact retry options the dashboard route
		// uses — no silent drift to a destructive variant.
		expect(deleteCalls).toEqual([
			{
				id: 42,
				opts: {
					removeFromClient: true,
					blocklist: false,
					changeCategory: false,
				},
			},
		]);

		// 3. Next GET /pulse — the server-side cache was invalidated on
		//    successful dispatch, and the stub's delete callback cleared
		//    queueRecords, so collectArrQueueFailures finds nothing.
		const second = await injectGet("/pulse");
		const secondBody = JSON.parse(second.payload);
		const stillFailed = secondBody.items.find(
			(i: { id: string }) => i.id === "queue-failed-inst-sonarr-1-42",
		);
		expect(stillFailed).toBeUndefined();
	});

	it("ownership failure → 404 (InstanceNotFoundError convention)", async () => {
		// Make the instance-lookup findFirst return null to simulate an
		// instance the current user does not own. The collector-side
		// findMany still returns the instance (so the item surfaces on
		// /pulse), but the dispatcher's ownership check rejects.
		queueRecords = [
			{
				id: 42,
				title: "Failing.Show",
				trackedDownloadState: "importFailed",
				trackedDownloadStatus: "error",
				errorMessage: "nope",
			},
		];
		(app.prisma.serviceInstance as unknown as { findFirst: () => Promise<null> }).findFirst =
			async () => null;

		const first = await injectGet("/pulse");
		const failedItem = JSON.parse(first.payload).items.find(
			(i: { id: string }) => i.id === "queue-failed-inst-sonarr-1-42",
		);

		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(failedItem.id)}/action`,
			failedItem.action,
		);
		expect(actionRes.statusCode).toBe(404);
		expect(JSON.parse(actionRes.payload).error).toBe("InstanceNotFoundError");
		expect(deleteCalls).toEqual([]);
	});
});
