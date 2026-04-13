/**
 * Tests for collectArrSignals pulse collector
 *
 * Covers the fix for GitHub issue #300 where Lidarr was falsely reported
 * as unreachable because LidarrClient exposes .health.get() / .diskSpace.get()
 * while the collector was calling .getAll() (Sonarr's convention).
 */

import { describe, it, expect, vi } from "vitest";
import { LidarrClient, SonarrClient } from "arr-sdk";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { collectArrSignals } from "../collectors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeInstance(overrides: Partial<{
	id: string;
	label: string;
	service: string;
	baseUrl: string;
	storageGroupId: string | null;
}> = {}) {
	return {
		id: "inst-lidarr-1",
		label: "Lidarr",
		service: "LIDARR",
		baseUrl: "http://lidarr:8686",
		enabled: true,
		storageGroupId: null,
		userId: "user-1",
		...overrides,
	};
}

function makeMockApp(instance: ReturnType<typeof makeInstance>, client: unknown) {
	return {
		prisma: {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance]),
			},
		},
		arrClientFactory: {
			create: vi.fn().mockReturnValue(client),
		},
	} as unknown as FastifyInstance;
}

// ---------------------------------------------------------------------------
// Mock client builders
// ---------------------------------------------------------------------------

// Use Object.create(Cls.prototype) so instanceof checks pass in the collector.
// Plain object literals ({} as Cls) don't satisfy instanceof at runtime.
function makeLidarrClient(overrides: {
	healthResult?: Array<{ type: string; message: string; source?: string; wikiUrl?: string }>;
	healthError?: boolean;
	diskResult?: Array<{ totalSpace: number; freeSpace: number }>;
}): LidarrClient {
	const client = Object.create(LidarrClient.prototype) as LidarrClient;
	(client as unknown as Record<string, unknown>).health = {
		get: overrides.healthError
			? vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
			: vi.fn().mockResolvedValue(overrides.healthResult ?? []),
	};
	(client as unknown as Record<string, unknown>).diskSpace = {
		get: vi.fn().mockResolvedValue(overrides.diskResult ?? [
			{ totalSpace: 1_000_000_000_000, freeSpace: 500_000_000_000 },
		]),
	};
	return client;
}

function makeSonarrClient(overrides: {
	healthResult?: Array<{ type: string; message: string; source?: string }>;
	healthError?: boolean;
	diskResult?: Array<{ totalSpace: number; freeSpace: number }>;
} = {}): SonarrClient {
	const client = Object.create(SonarrClient.prototype) as SonarrClient;
	(client as unknown as Record<string, unknown>).health = {
		getAll: overrides.healthError
			? vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
			: vi.fn().mockResolvedValue(overrides.healthResult ?? []),
	};
	(client as unknown as Record<string, unknown>).diskSpace = {
		getAll: vi.fn().mockResolvedValue(overrides.diskResult ?? [
			{ totalSpace: 1_000_000_000_000, freeSpace: 500_000_000_000 },
		]),
	};
	return client;
}

// ---------------------------------------------------------------------------
// Tests — Lidarr (fix for #300)
// ---------------------------------------------------------------------------

describe("collectArrSignals — Lidarr", () => {
	it("does NOT emit unreachable signal when Lidarr is healthy", async () => {
		const client = makeLidarrClient({ healthResult: [] });
		const app = makeMockApp(makeInstance(), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const unreachable = items.find((i) => i.id.startsWith("arr-unreachable-"));
		expect(unreachable).toBeUndefined();
	});

	it("emits unreachable signal when Lidarr.health.get() throws", async () => {
		const client = makeLidarrClient({ healthError: true });
		const app = makeMockApp(makeInstance(), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const unreachable = items.find((i) => i.id === "arr-unreachable-inst-lidarr-1");
		expect(unreachable).toBeDefined();
		expect(unreachable?.severity).toBe("critical");
		expect(unreachable?.title).toBe("Lidarr is unreachable");
	});

	it("surfaces Lidarr health issues as pulse items", async () => {
		const client = makeLidarrClient({
			healthResult: [
				{ type: "error", message: "Indexer unavailable", source: "IndexerLongTermStatusCheck" },
				{ type: "warning", message: "No download client configured", source: "DownloadClientCheck" },
			],
		});
		const app = makeMockApp(makeInstance({ label: "My Lidarr" }), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const healthItems = items.filter((i) => i.category === "health" && !i.id.startsWith("arr-unreachable-"));
		expect(healthItems).toHaveLength(2);

		const errorItem = healthItems.find((i) => i.severity === "critical");
		expect(errorItem?.title).toBe("My Lidarr: Indexer unavailable");

		const warnItem = healthItems.find((i) => i.severity === "warning");
		expect(warnItem?.title).toBe("My Lidarr: No download client configured");
	});

	it("calls health.get() — not health.getAll() — on LidarrClient", async () => {
		const client = makeLidarrClient({ healthResult: [] });
		const app = makeMockApp(makeInstance(), client);

		await collectArrSignals(app, "user-1", mockLog);

		const healthGet = (client as unknown as { health: { get: ReturnType<typeof vi.fn> } }).health.get;
		expect(healthGet).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Tests — Sonarr (regression: ensure non-Lidarr services still work)
// ---------------------------------------------------------------------------

describe("collectArrSignals — Sonarr", () => {
	it("does NOT emit unreachable signal when Sonarr is healthy", async () => {
		const client = makeSonarrClient({ healthResult: [] });
		const app = makeMockApp(makeInstance({ id: "inst-sonarr-1", label: "Sonarr", service: "SONARR" }), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const unreachable = items.find((i) => i.id.startsWith("arr-unreachable-"));
		expect(unreachable).toBeUndefined();
	});

	it("emits unreachable signal when Sonarr health.getAll() throws", async () => {
		const client = makeSonarrClient({ healthError: true });
		const app = makeMockApp(makeInstance({ id: "inst-sonarr-1", label: "Sonarr Main", service: "SONARR" }), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const unreachable = items.find((i) => i.id === "arr-unreachable-inst-sonarr-1");
		expect(unreachable).toBeDefined();
		expect(unreachable?.severity).toBe("critical");
	});

	it("surfaces Sonarr health issues as pulse items", async () => {
		const client = makeSonarrClient({
			healthResult: [{ type: "error", message: "Root folder missing" }],
		});
		const app = makeMockApp(makeInstance({ id: "inst-sonarr-1", label: "Sonarr", service: "SONARR" }), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const healthItems = items.filter((i) => i.category === "health");
		expect(healthItems).toHaveLength(1);
		expect(healthItems[0]?.title).toBe("Sonarr: Root folder missing");
		expect(healthItems[0]?.severity).toBe("critical");
	});

	it("calls health.getAll() — not health.get() — on SonarrClient", async () => {
		const client = makeSonarrClient({ healthResult: [] });
		const app = makeMockApp(makeInstance({ id: "inst-sonarr-1", label: "Sonarr", service: "SONARR" }), client);

		await collectArrSignals(app, "user-1", mockLog);

		const healthGetAll = (client as unknown as { health: { getAll: ReturnType<typeof vi.fn> } }).health.getAll;
		expect(healthGetAll).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Tests — empty / no instances
// ---------------------------------------------------------------------------

describe("collectArrSignals — edge cases", () => {
	it("returns empty array when no ARR instances are configured", async () => {
		const app = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([]),
				},
			},
			arrClientFactory: { create: vi.fn() },
		} as unknown as FastifyInstance;

		const items = await collectArrSignals(app, "user-1", mockLog);
		expect(items).toEqual([]);
	});

	it("emits disk warning when Lidarr disk usage exceeds 80%", async () => {
		const client = makeLidarrClient({
			healthResult: [],
			diskResult: [{ totalSpace: 1_000_000_000_000, freeSpace: 100_000_000_000 }], // 90% full
		});
		const app = makeMockApp(makeInstance({ label: "Lidarr" }), client);

		const items = await collectArrSignals(app, "user-1", mockLog);

		const diskItem = items.find((i) => i.category === "storage");
		expect(diskItem).toBeDefined();
		expect(diskItem?.severity).toBe("critical");
		expect(diskItem?.title).toMatch(/90%/);
	});
});
