/**
 * qui Pulse collector — rollup behaviour tests (Phase 2.1b)
 *
 * Verifies the collector emits ONE rollup attention row per qui instance
 * (not N per qBit) using the 5-state domain taxonomy:
 *   - healthy → emit nothing (Pulse is attention-only)
 *   - degraded (some qBit disconnected, qui reachable) → one warning rollup
 *   - offline (qui unreachable entirely) → one critical rollup
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListQuiInstances, mockCreateQuiClient } = vi.hoisted(() => ({
	mockListQuiInstances: vi.fn(),
	mockCreateQuiClient: vi.fn(),
}));

vi.mock("../../qui/instance-helpers.js", () => ({
	listQuiInstances: mockListQuiInstances,
}));
vi.mock("../../qui/client-factory.js", () => ({
	createQuiClient: mockCreateQuiClient,
}));

import { collectQuiSignals } from "../collectors.js";

const silentLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => silentLog),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("collectQuiSignals — rollup attention items (Phase 2.1b)", () => {
	it("emits NOTHING when no qui instances are configured", async () => {
		mockListQuiInstances.mockResolvedValue([]);
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toEqual([]);
	});

	it("emits NOTHING when all qBit instances behind qui are connected (healthy)", async () => {
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listInstances: vi.fn().mockResolvedValue([
				{ id: 1, name: "qbit-a", connected: true },
				{ id: 2, name: "qbit-b", connected: true },
			]),
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toEqual([]);
	});

	it("emits ONE rollup warning when SOME qBit instances are disconnected (degraded)", async () => {
		// Pre-2.1b this would have emitted 2 separate "X is disconnected" rows.
		// Post-2.1b: one rollup describing the count.
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listInstances: vi.fn().mockResolvedValue([
				{ id: 1, name: "qbit-a", connected: true },
				{ id: 2, name: "qbit-b", connected: false },
				{ id: 3, name: "qbit-c", connected: false },
			]),
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ severity: "warning", source: "qui" });
		expect(items[0]?.title).toMatch(/2 of 3 qBittorrent instances disconnected/);
		// Detail should name the disconnected qBit instances for operator triage.
		expect(items[0]?.detail).toMatch(/qbit-b/);
		expect(items[0]?.detail).toMatch(/qbit-c/);
		// Action link uses the deep anchor (not bare /settings).
		expect(items[0]?.actionUrl).toBe("/settings#services");
	});

	it("changes detail copy when ALL qBit instances are disconnected", async () => {
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listInstances: vi.fn().mockResolvedValue([{ id: 1, name: "qbit-only", connected: false }]),
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(1);
		expect(items[0]?.detail).toMatch(/All qBittorrent instances behind this qui are offline/);
	});

	it("emits ONE critical rollup when qui itself is unreachable (offline)", async () => {
		// Use the actual transport-class error the qui client throws on real
		// network failures — generic `Error` would now hit the config-error
		// branch, which is the deliberate distinction the fix introduces.
		const { QuiInstanceUnreachableError } = await import("../../errors.js");
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listInstances: vi
				.fn()
				.mockRejectedValue(new QuiInstanceUnreachableError("qui-1", { reason: "ECONNREFUSED" })),
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ severity: "critical", source: "qui" });
		expect(items[0]?.title).toMatch(/main qui is unreachable/);
		expect(items[0]?.id).toMatch(/^qui-offline-/);
	});

	it("emits a CONFIG-ERROR rollup (not 'unreachable') when the encryptor / local config fails", async () => {
		// Pre-fix: the broad catch turned every error into a "qui unreachable"
		// critical row. That misled operators chasing networking when the real
		// fix was a stale ENCRYPTION_KEY or corrupted ciphertext. Now we
		// distinguish QuiInstanceUnreachableError / QuiApiError (real network
		// issues) from anything else (local-config). Ungeneric Error stands in
		// for what `app.encryptor.decrypt()` would throw on key mismatch.
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockImplementation(() => {
			// Synchronously throw — emulates app.encryptor.decrypt() failing
			// inside createQuiClient before any qui HTTP call happens.
			throw new Error("Failed to decrypt API key");
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ severity: "critical", source: "qui" });
		expect(items[0]?.id).toMatch(/^qui-config-error-/);
		expect(items[0]?.title).toMatch(/configuration error/i);
		// Detail must NOT claim qui is unreachable — that would mislead.
		expect(items[0]?.detail).not.toMatch(/unreachable|connect to qui/i);
	});

	it("emits an UNREACHABLE rollup when qui throws a transport-class error (real network issue)", async () => {
		// QuiInstanceUnreachableError is the documented transport contract;
		// keep this branch distinct from the config-error one above so operators
		// can act on each appropriately.
		const { QuiInstanceUnreachableError } = await import("../../errors.js");
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "u", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listInstances: vi
				.fn()
				.mockRejectedValue(new QuiInstanceUnreachableError("qui-1", { reason: "timeout" })),
		});
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toMatch(/^qui-offline-/);
		expect(items[0]?.title).toMatch(/main qui is unreachable/);
	});

	it("isolates per-instance failures across multiple qui instances", async () => {
		// One qui is degraded, another is fully offline. Should produce two
		// independent rollup items, not collapse them.
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-good", userId: "u", label: "good qui", baseUrl: "http://good" },
			{ id: "qui-bad", userId: "u", label: "bad qui", baseUrl: "http://bad" },
		]);
		mockCreateQuiClient.mockImplementation((_app: unknown, instance: { id: string }) => ({
			listInstances:
				instance.id === "qui-bad"
					? vi.fn().mockRejectedValue(new Error("nope"))
					: vi.fn().mockResolvedValue([{ id: 1, name: "qb", connected: false }]),
		}));
		const items = await collectQuiSignals({} as never, "u", silentLog);
		expect(items).toHaveLength(2);
		const severities = items.map((i) => i.severity).sort();
		expect(severities).toEqual(["critical", "warning"]);
	});
});
