/**
 * Unit tests for the console domain-tile derivation (pure logic).
 *
 * Pins the trust-relevant mappings:
 *   - status taxonomy precedence: disabled > failing (>=2 consecutive,
 *     mirroring the Pulse collector) > last-run-failed > never-ran > healthy
 *   - cadence renders ONLY when every member job declares an interval
 *     (config-driven schedules get no approximate claim)
 *   - service-gated domains are omitted entirely when no enabled backing
 *     service exists
 *   - session-cleanup is not part of any domain (internal hygiene)
 */

import { describe, expect, it } from "vitest";
import type { SystemJobStatus } from "../../../../lib/api-client/system";
import {
	buildDomainTiles,
	CONSOLE_DOMAINS,
	deriveDomainTile,
	formatCadence,
} from "../console-domains";

function makeJob(overrides: Partial<SystemJobStatus> & { id: string }): SystemJobStatus {
	return {
		label: overrides.id,
		description: "",
		concurrency: "singleton",
		state: "idle",
		lastStartedAt: "2026-06-11T12:00:00.000Z",
		lastFinishedAt: "2026-06-11T12:00:05.000Z",
		lastSuccessAt: "2026-06-11T12:00:05.000Z",
		lastFailureAt: null,
		lastDurationMs: 5000,
		lastError: null,
		consecutiveFailures: 0,
		totalRuns: 10,
		totalFailures: 0,
		disabled: false,
		disabledReason: null,
		...overrides,
	};
}

const HUNTING = CONSOLE_DOMAINS.find((d) => d.id === "hunting")!;
const LIBRARY = CONSOLE_DOMAINS.find((d) => d.id === "library")!;
const QUI = CONSOLE_DOMAINS.find((d) => d.id === "qui")!;

describe("deriveDomainTile — status precedence", () => {
	it("healthy when all members ran and none failed", () => {
		const tile = deriveDomainTile(HUNTING, [makeJob({ id: "hunting" })]);
		expect(tile?.status).toBe("healthy");
	});

	it("disabled wins over everything, carrying the reason", () => {
		const tile = deriveDomainTile(HUNTING, [
			makeJob({
				id: "hunting",
				disabled: true,
				disabledReason: "suspended after repeated failures",
				consecutiveFailures: 5,
			}),
		]);
		expect(tile?.status).toBe("disabled");
		expect(tile?.statusDetail).toContain("suspended after repeated failures");
	});

	it("degraded at >=2 consecutive failures (Pulse collector parity)", () => {
		const tile = deriveDomainTile(HUNTING, [makeJob({ id: "hunting", consecutiveFailures: 2 })]);
		expect(tile?.status).toBe("degraded");
		expect(tile?.statusDetail).toContain("2 consecutive failures");
	});

	it("stays healthy at exactly 1 consecutive failure when an earlier success is newer", () => {
		// One blip below the threshold AND the most recent run succeeded.
		const tile = deriveDomainTile(HUNTING, [
			makeJob({
				id: "hunting",
				consecutiveFailures: 0,
				lastFailureAt: "2026-06-11T10:00:00.000Z",
				lastSuccessAt: "2026-06-11T12:00:05.000Z",
			}),
		]);
		expect(tile?.status).toBe("healthy");
	});

	it("degraded when the most recent run failed (failure newer than success)", () => {
		const tile = deriveDomainTile(HUNTING, [
			makeJob({
				id: "hunting",
				consecutiveFailures: 1,
				lastFailureAt: "2026-06-11T13:00:00.000Z",
				lastSuccessAt: "2026-06-11T12:00:05.000Z",
			}),
		]);
		expect(tile?.status).toBe("degraded");
		expect(tile?.statusDetail).toContain("last run failed");
	});

	it("configured when registered but never ran", () => {
		const tile = deriveDomainTile(HUNTING, [
			makeJob({
				id: "hunting",
				totalRuns: 0,
				lastStartedAt: null,
				lastFinishedAt: null,
				lastSuccessAt: null,
			}),
		]);
		expect(tile?.status).toBe("configured");
		expect(tile?.lastActivityMs).toBeNull();
	});

	it("one unhealthy member degrades a multi-job domain", () => {
		const tile = deriveDomainTile(LIBRARY, [
			makeJob({ id: "library-sync" }),
			makeJob({ id: "library-cleanup", consecutiveFailures: 3 }),
			makeJob({ id: "insights-digest" }),
		]);
		expect(tile?.status).toBe("degraded");
	});

	it("returns null when no member job is registered", () => {
		expect(deriveDomainTile(HUNTING, [makeJob({ id: "backup" })])).toBeNull();
	});
});

describe("deriveDomainTile — facts, not predictions", () => {
	it("lastActivityMs is the newest member activity", () => {
		const tile = deriveDomainTile(LIBRARY, [
			makeJob({ id: "library-sync", lastFinishedAt: "2026-06-11T12:30:00.000Z" }),
			makeJob({ id: "library-cleanup", lastFinishedAt: "2026-06-11T11:00:00.000Z" }),
		]);
		expect(tile?.lastActivityMs).toBe(Date.parse("2026-06-11T12:30:00.000Z"));
	});

	it("declares cadence only when EVERY member declares an interval", () => {
		const allDeclared = deriveDomainTile(QUI, [
			makeJob({ id: "qui-torrent-state-sync", intervalMs: 10 * 60 * 1000 }),
			makeJob({ id: "infohash-backfill", intervalMs: 6 * 60 * 60 * 1000 }),
		]);
		expect(allDeclared?.cadence).toBe("every 10 min");

		// hunting's schedule is per-instance config — no declared interval, so
		// no cadence claim at all (never an approximation).
		const configDriven = deriveDomainTile(HUNTING, [makeJob({ id: "hunting" })]);
		expect(configDriven?.cadence).toBeNull();
	});

	it("flags isRunning while any member is mid-run", () => {
		const tile = deriveDomainTile(LIBRARY, [
			makeJob({ id: "library-sync", state: "running" }),
			makeJob({ id: "library-cleanup" }),
		]);
		expect(tile?.isRunning).toBe(true);
	});
});

describe("formatCadence", () => {
	it("renders minutes, single hour, and multi-hour", () => {
		expect(formatCadence(5 * 60 * 1000)).toBe("every 5 min");
		expect(formatCadence(60 * 60 * 1000)).toBe("every hour");
		expect(formatCadence(4 * 60 * 60 * 1000)).toBe("every 4 h");
	});
});

describe("buildDomainTiles — service gating by omission", () => {
	const ALL_JOBS = CONSOLE_DOMAINS.flatMap((d) => d.jobIds).map((id) => makeJob({ id }));

	it("omits qui/requests/media-caches tiles when their services are absent", () => {
		const tiles = buildDomainTiles(ALL_JOBS, []);
		const ids = tiles.map((t) => t.domain.id);
		expect(ids).not.toContain("qui");
		expect(ids).not.toContain("requests");
		expect(ids).not.toContain("media-caches");
		// Core domains always render.
		expect(ids).toEqual(
			expect.arrayContaining(["backup", "library", "hunting", "queue-cleaner", "trash-guides"]),
		);
	});

	it("includes a gated tile when an enabled backing service exists", () => {
		const tiles = buildDomainTiles(ALL_JOBS, [
			{ service: "qui", enabled: true },
			{ service: "plex", enabled: true },
		]);
		const ids = tiles.map((t) => t.domain.id);
		expect(ids).toContain("qui");
		expect(ids).toContain("media-caches");
		expect(ids).not.toContain("requests");
	});

	it("a DISABLED instance does not satisfy the gate", () => {
		const tiles = buildDomainTiles(ALL_JOBS, [{ service: "seerr", enabled: false }]);
		expect(tiles.map((t) => t.domain.id)).not.toContain("requests");
	});

	it("no domain claims session-cleanup (internal hygiene stays internal)", () => {
		for (const domain of CONSOLE_DOMAINS) {
			expect(domain.jobIds).not.toContain("session-cleanup");
		}
	});
});
