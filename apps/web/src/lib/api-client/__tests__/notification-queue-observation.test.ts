import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationsApi } from "../notifications";

// Only transport is synthetic. The actual GET client and public projection run.
// History expectations are independent of queue counts and their different units.
const history = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 1, failed: 0, deadLetter: 0, unclassified: 0, total: 1, successRate: 100 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			sent: 1,
			failed: 0,
			unclassified: 0,
			successRate: 100,
		},
	],
	perEventType: [{ eventType: "HUNT_COMPLETED", count: 1 }],
	dailyTrend: [{ date: "2026-10-05", sent: 1, failed: 0, unclassified: 0 }],
};
const observed = {
	state: "observed",
	observedAt: "2026-10-06T12:01:00.000Z",
	events: { ready: 2, deferred: 3, aggregating: 4 },
	deliveries: { ready: 5, retryWaiting: 6, submitting: 7, uncertain: 8 },
	oldestDueAt: "2026-10-06T12:00:00.000Z",
};
const privateDetail = "synthetic-private-queue-detail";

async function read(queue: unknown, present = true) {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, options: RequestInit = {}) => {
		expect(String(input)).toBe("/api/notifications/statistics?days=30");
		expect(options.method).toBe("GET");
		expect(options.body).toBeUndefined();
		return new Response(JSON.stringify({ ...history, ...(present ? { queue } : {}) }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return notificationsApi.getStatistics(30);
}

afterEach(() => vi.unstubAllGlobals());

describe("notification queue public GET admission", () => {
	it("preserves measured event and recipient counts without changing History's denominator", async () => {
		const result = await read(observed);
		expect(result.queue).toEqual({
			state: "observed",
			observedAt: "2026-10-06T12:01:00.000Z",
			events: { ready: 2, deferred: 3, aggregating: 4 },
			deliveries: { ready: 5, retryWaiting: 6, submitting: 7, uncertain: 8 },
			oldestDueAt: "2026-10-06T12:00:00.000Z",
		});
		expect(result.totals).toEqual({
			sent: 1,
			failed: 0,
			deadLetter: 0,
			unclassified: 0,
			total: 1,
			successRate: 100,
		});
	});
	it("admits an actual complete zero observation rather than confusing it with absence", async () => {
		const result = await read({
			state: "observed",
			observedAt: "2026-10-06T12:01:00Z",
			events: { ready: 0, deferred: 0, aggregating: 0 },
			deliveries: { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 },
			oldestDueAt: null,
		});
		expect(result.queue).toEqual({
			state: "observed",
			observedAt: "2026-10-06T12:01:00Z",
			events: { ready: 0, deferred: 0, aggregating: 0 },
			deliveries: { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 },
			oldestDueAt: null,
		});
	});
	it.each(["storage-unavailable", "state-unavailable"])(
		"retains generic unavailable reason %s and usable History",
		async (reason) => {
			const result = await read({ state: "unavailable", reason });
			expect(result.queue).toEqual({ state: "unavailable", reason });
			expect(result.totals.total).toBe(1);
		},
	);
	it.each([
		["null", null],
		["unknown state", { ...observed, state: privateDetail }],
		["missing events", { ...observed, events: undefined }],
		[
			"missing recipient count",
			{ ...observed, deliveries: { ready: 5, retryWaiting: 6, submitting: 7 } },
		],
		["negative count", { ...observed, events: { ready: -1, deferred: 3, aggregating: 4 } }],
		[
			"fractional count",
			{ ...observed, deliveries: { ready: 5, retryWaiting: 0.5, submitting: 7, uncertain: 8 } },
		],
		[
			"unsafe count",
			{ ...observed, events: { ready: Number.MAX_SAFE_INTEGER + 1, deferred: 3, aggregating: 4 } },
		],
		["numeric string", { ...observed, events: { ready: "2", deferred: 3, aggregating: 4 } }],
		["invalid observation date", { ...observed, observedAt: "2026-02-30T12:00:00Z" }],
		["invalid due date", { ...observed, oldestDueAt: privateDetail }],
		["missing due evidence", { ...observed, oldestDueAt: undefined }],
		["private failure reason", { state: "unavailable", reason: privateDetail }],
	])("makes %s unavailable, never zero or a failure of valid History", async (_label, queue) => {
		const result = await read(queue);
		expect(result.queue).toEqual({ state: "unavailable", reason: "state-unavailable" });
		expect(result.totals.total).toBe(1);
		expect(result.totals.sent).toBe(1);
		expect(JSON.stringify(result)).not.toContain(privateDetail);
	});
	it("leaves legacy absence unobserved without adding invented zero counts", async () => {
		const result = await read(undefined, false);
		expect(result).toEqual(history);
		expect(result).not.toHaveProperty("queue");
	});
	it("drops private fields at every queue level before the cache can retain them", async () => {
		const result = await read({
			...observed,
			payload: privateDetail,
			events: { ...observed.events, owner: privateDetail },
			deliveries: { ...observed.deliveries, token: privateDetail },
		});
		expect(result.queue).toEqual({
			state: "observed",
			observedAt: "2026-10-06T12:01:00.000Z",
			events: { ready: 2, deferred: 3, aggregating: 4 },
			deliveries: { ready: 5, retryWaiting: 6, submitting: 7, uncertain: 8 },
			oldestDueAt: "2026-10-06T12:00:00.000Z",
		});
		expect(JSON.stringify(result)).not.toContain(privateDetail);
	});
});
