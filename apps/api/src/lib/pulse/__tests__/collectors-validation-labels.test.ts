/**
 * Pins the validation-health pulse item action link + label.
 *
 * The collector routes the operator to Settings → System (where the
 * ValidationHealthSection lives) instead of the default Services tab.
 * Regressing the URL or label silently drops the operator on the wrong
 * screen, so these strings are part of the user contract.
 */

import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

vi.mock("../../validation/integration-health.js", () => ({
	integrationHealth: {
		getAll: vi.fn(),
	},
}));

import { integrationHealth } from "../../validation/integration-health.js";
import { pulseCollectors } from "../collectors.js";

const getAllMock = integrationHealth.getAll as unknown as ReturnType<typeof vi.fn>;

const noop = vi.fn();
const mockLog = {
	warn: noop,
	error: noop,
	info: noop,
	debug: noop,
	trace: noop,
	fatal: noop,
	child: () => mockLog,
} as unknown as FastifyBaseLogger;

// Find the validation-health collector by invoking each with an empty app
// and the mocked integrationHealth. The collector is export-private, so we
// drive it through the exported array.
const stats = { total: 0, successful: 0, failed: 0 };

function makeHealth(state: "failing" | "degraded") {
	return {
		integrations: {
			trash: {
				lastRefreshAt: null,
				lastSuccessAt: null,
				lastFailureAt: "2026-04-14T00:00:00Z",
				consecutiveFailures: state === "failing" ? 5 : 2,
				state,
				categories: {},
				totals: { total: 10, successful: 5, failed: 5 },
			},
		},
		overallTotals: stats,
		resetAt: null,
	};
}

function makeApp(): FastifyInstance {
	return {
		prisma: {
			// All the other collectors short-circuit on empty queries.
			serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
			huntConfig: { count: vi.fn().mockResolvedValue(0) },
			queueCleanerConfig: { count: vi.fn().mockResolvedValue(0) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			libraryCache: { count: vi.fn().mockResolvedValue(0) },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		},
		seerrCircuitBreaker: { getState: vi.fn().mockReturnValue("CLOSED") },
		schedulerRegistry: { list: vi.fn().mockReturnValue([]) },
		arrClientFactory: { create: vi.fn() },
	} as unknown as FastifyInstance;
}

async function runAll(app: FastifyInstance) {
	const results = await Promise.all(pulseCollectors.map((c) => c(app, "user-1", mockLog)));
	return results.flat();
}

describe("validation-health pulse items — action link + label", () => {
	it("emits /settings#system + 'View validation health' for failing state", async () => {
		getAllMock.mockReturnValue(makeHealth("failing"));

		const items = await runAll(makeApp());
		const item = items.find((i) => i.id === "validation-trash");

		expect(item).toBeDefined();
		expect(item?.severity).toBe("critical");
		expect(item?.actionUrl).toBe("/settings#system");
		expect(item?.actionLabel).toBe("View validation health");
	});

	it("emits /settings#system + 'View validation health' for degraded state", async () => {
		getAllMock.mockReturnValue(makeHealth("degraded"));

		const items = await runAll(makeApp());
		const item = items.find((i) => i.id === "validation-trash");

		expect(item).toBeDefined();
		expect(item?.severity).toBe("warning");
		expect(item?.actionUrl).toBe("/settings#system");
		expect(item?.actionLabel).toBe("View validation health");
	});
});
