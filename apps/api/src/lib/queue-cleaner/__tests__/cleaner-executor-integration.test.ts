/**
 * Queue Cleaner executor integration tests.
 *
 * These exercise the end-to-end executor contract — ARR client is mocked,
 * Prisma is mocked, but the real executeQueueCleaner function runs the full
 * fetch -> validate -> evaluate -> remove pipeline. Existing unit tests
 * cover rule evaluation and auto-import in isolation; this file covers:
 *
 *  - successful clean path: queue item matched by a rule -> client.queue.del
 *    actually called with the item id (side-effect verification)
 *  - silent-failure contract: ARR queue.get throws -> executor returns a
 *    status:"error" result object WITHOUT throwing, so the scheduler sees a
 *    structured failure instead of an unhandled promise rejection
 *  - defensive config parsing: invalid whitelist JSON aborts the clean
 *    instead of silently running with an empty whitelist
 *  - registry integration: wrapping the executor in registry.track() surfaces
 *    both the successful result AND the failure result correctly
 *    (track() only observes thrown errors, so a structured error result
 *    counts as a successful tick from the registry's perspective — verifying
 *    this documents the contract between the two layers)
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { QueueCleanerConfig, ServiceInstance } from "../../prisma.js";
import { JOB_ID } from "../../scheduler-registry/job-definitions.js";
import { SchedulerRegistry } from "../../scheduler-registry/scheduler-registry.js";
import { executeQueueCleaner } from "../cleaner-executor.js";

function makeInstance(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "SONARR",
		label: "Sonarr",
		baseUrl: "http://sonarr:8989",
		externalUrl: null,
		encryptedApiKey: "x",
		encryptionIv: "y",
		enabled: true,
		isDefault: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as ServiceInstance;
}

function makeConfig(overrides: Partial<QueueCleanerConfig> = {}): QueueCleanerConfig {
	// Conservative config: only the stalled rule, no strike system, live mode.
	// This keeps the executor path short and deterministic.
	return {
		id: "cfg-1",
		instanceId: "inst-1",
		enabled: true,
		dryRunMode: false,
		minQueueAgeMins: 0,
		maxRemovalsPerRun: 100,
		// Stalled rule: remove items stalled > 0 mins (so our old stalled item always matches)
		stalledEnabled: true,
		stalledThresholdMins: 0,
		// Other rules off
		slowEnabled: false,
		slowSpeedThreshold: 0,
		slowGracePeriodMins: 0,
		importPendingEnabled: false,
		importPendingMins: 0,
		importBlockEnabled: false,
		importBlockCleanupLevel: "item",
		importBlockPatternMode: "any",
		errorPatternsEnabled: false,
		errorPatterns: null,
		seedingTimeoutEnabled: false,
		seedingTimeoutHours: 0,
		estimatedEnabled: false,
		estimatedMultiplier: 2,
		skipFutureEpisodes: false,
		whitelistEnabled: false,
		whitelistPatterns: null,
		tagFilterMode: "all",
		tagFilterIds: null,
		profileFilterMode: "all",
		profileFilterIds: null,
		strikeSystemEnabled: false,
		maxStrikes: 3,
		strikeDecayHours: 24,
		autoImportEnabled: false,
		blocklistOnRemove: false,
		removeFromClient: true,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as QueueCleanerConfig;
}

/**
 * Build a mock FastifyInstance with just enough surface for executeQueueCleaner.
 * Accepts a queue-get behavior so we can inject success and failure.
 */
function makeApp(queueBehavior: {
	get: () => Promise<unknown>;
	del: ReturnType<typeof vi.fn>;
}): FastifyInstance {
	const app = {
		arrClientFactory: {
			create: () => ({
				queue: {
					get: queueBehavior.get,
					delete: queueBehavior.del,
				},
			}),
		},
		prisma: {
			$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			queueCleanerStrike: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn(),
				update: vi.fn(),
				deleteMany: vi.fn(),
			},
		},
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
	};
	return app as unknown as FastifyInstance;
}

describe("executeQueueCleaner — integration", () => {
	const STALLED_ITEM = {
		id: 42,
		title: "Stalled.Show.S01E01",
		added: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
		size: 1_000_000_000,
		sizeleft: 1_000_000_000,
		status: "warning",
		trackedDownloadStatus: "warning",
		trackedDownloadState: "stalled",
		statusMessages: [
			{ title: "Stalled", messages: ["The download is stalled with no connections"] },
		],
		downloadId: "dl-42",
		protocol: "torrent",
		indexer: "TestIndexer",
		errorMessage: "The download is stalled with no connections",
	};

	it("matches a stalled queue item and calls client.queue.del (side-effect verification)", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());

		// Structured result surfaces the matched item
		expect(result.status).toBe("completed");
		expect(result.isDryRun).toBe(false);
		expect(result.itemsCleaned).toBeGreaterThanOrEqual(1);
		expect(result.cleanedItems.some((i) => i.id === 42)).toBe(true);

		// Side effect: ARR client was actually asked to remove the item
		expect(del).toHaveBeenCalled();
		const delArgs = del.mock.calls[0];
		expect(delArgs?.[0]).toBe(42); // item id
	});

	it("dry-run mode returns the same matches WITHOUT calling client.queue.del", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(app, makeInstance(), makeConfig({ dryRunMode: true }));

		expect(result.isDryRun).toBe(true);
		expect(del).not.toHaveBeenCalled();
	});

	it("silent-failure contract: ARR queue.get throwing yields status:error, NOT an unhandled rejection", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => {
				throw new Error("Connection refused");
			},
			del,
		});

		// CRITICAL: must not throw. Silent rejection here would crash the scheduler tick
		// and leave the user with no structured error in queueCleanerLog.
		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());

		expect(result.status).toBe("error");
		expect(result.message).toContain("Failed to fetch queue");
		expect(result.message).toContain("Connection refused");
		expect(result.itemsCleaned).toBe(0);
		expect(del).not.toHaveBeenCalled();
	});

	it("invalid whitelist JSON aborts the clean for safety (defensive failure, not silent success)", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				whitelistEnabled: true,
				whitelistPatterns: "not-valid-json{{{",
			}),
		);

		expect(result.status).toBe("error");
		expect(result.message).toContain("Whitelist");
		expect(result.itemsCleaned).toBe(0);
		// Under no circumstances should a broken whitelist cause deletions
		expect(del).not.toHaveBeenCalled();
	});

	it("registry.track wrapping captures a structured-error result as a SUCCESSFUL tick (documents contract)", async () => {
		// The executor returns structured errors instead of throwing. This means
		// the registry — which observes thrown errors — will see the tick as
		// successful. This test documents that contract so future refactors that
		// change the error shape (e.g. to throwing) would need to update the
		// registry wiring to match.
		const app = makeApp({
			get: async () => {
				throw new Error("boom");
			},
			del: vi.fn(),
		});

		const registry = new SchedulerRegistry();
		registry.register({
			id: JOB_ID.queueCleaner,
			label: "Queue cleaner",
			description: "test",
			concurrency: "per-instance",
		});

		const result = await registry.track(JOB_ID.queueCleaner, () =>
			executeQueueCleaner(app, makeInstance(), makeConfig()),
		);

		// Structured error result is returned, not thrown
		expect(result.status).toBe("error");

		const status = registry.getStatus(JOB_ID.queueCleaner)!;
		// From the registry's perspective the tick completed successfully
		expect(status.totalRuns).toBe(1);
		expect(status.totalFailures).toBe(0);
		expect(status.lastSuccessAt).not.toBeNull();
		// The contract for surfacing structured errors to operators is queueCleanerLog,
		// not registry.lastError — this test locks that in.
	});

	it("registry.track wrapping surfaces a thrown error as a FAILED tick", async () => {
		// Mirror: if the delegate does throw (e.g. an unexpected bug escapes the
		// executor's try/catch), the registry counter MUST increment so ops sees it.
		const registry = new SchedulerRegistry();
		registry.register({
			id: JOB_ID.queueCleaner,
			label: "Queue cleaner",
			description: "test",
			concurrency: "per-instance",
		});

		await expect(
			registry.track(JOB_ID.queueCleaner, async () => {
				throw new Error("unexpected executor bug");
			}),
		).rejects.toThrow("unexpected executor bug");

		const status = registry.getStatus(JOB_ID.queueCleaner)!;
		expect(status.totalFailures).toBe(1);
		expect(status.consecutiveFailures).toBe(1);
		expect(status.lastError).toBe("unexpected executor bug");
	});
});
