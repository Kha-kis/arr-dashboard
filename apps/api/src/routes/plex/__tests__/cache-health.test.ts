/**
 * Cache Health Helper Tests
 *
 * Tests for the pure sanitizeErrorMessage and buildCacheHealthItems helpers
 * that build cache health response items from CacheRefreshStatus rows.
 *
 * Run with: npx vitest run cache-health.test.ts
 */

import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage, buildCacheHealthItems, type CacheRefreshStatusRow } from "../lib/cache-health-helpers.js";

describe("sanitizeErrorMessage", () => {
	it("returns null for null input", () => {
		expect(sanitizeErrorMessage(null)).toBeNull();
	});

	it("strips file paths from error messages", () => {
		const msg = "Error at /home/user/src/server.ts:42";
		expect(sanitizeErrorMessage(msg)).toBe("Error at [path]:42");
	});

	it("strips multiple file paths from a single message", () => {
		const msg = "Failed in /app/lib/cache.ts and /app/routes/plex.mjs";
		expect(sanitizeErrorMessage(msg)).toBe("Failed in [path] and [path]");
	});

	it("truncates long messages to 200 characters", () => {
		const msg = "A".repeat(300);
		const result = sanitizeErrorMessage(msg);
		expect(result).toHaveLength(200);
		expect(result).toBe("A".repeat(200));
	});

	it("passes through clean messages unchanged", () => {
		expect(sanitizeErrorMessage("Connection refused")).toBe("Connection refused");
	});
});

describe("buildCacheHealthItems", () => {
	const baseDate = new Date("2025-06-15T12:00:00Z");
	const baseDateMs = baseDate.getTime();

	function makeRow(overrides: Partial<CacheRefreshStatusRow> = {}): CacheRefreshStatusRow {
		return {
			instanceId: "inst-1",
			cacheType: "plex",
			lastRefreshedAt: baseDate,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 42,
			...overrides,
		};
	}

	const instanceNameMap = new Map([
		["inst-1", "My Plex Server"],
		["inst-2", "Tautulli"],
	]);

	it("maps status rows to CacheHealthItem shape", () => {
		const statuses = [makeRow()];
		const items = buildCacheHealthItems(statuses, instanceNameMap, baseDateMs);

		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			instanceId: "inst-1",
			instanceName: "My Plex Server",
			cacheType: "plex",
			lastRefreshedAt: "2025-06-15T12:00:00.000Z",
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 42,
			isStale: false,
		});
	});

	it("marks stale items when lastRefreshedAt > 12h ago", () => {
		const thirteenHoursMs = 13 * 60 * 60 * 1000;
		const statuses = [makeRow()];
		const items = buildCacheHealthItems(statuses, instanceNameMap, baseDateMs + thirteenHoursMs);

		expect(items[0]!.isStale).toBe(true);
	});

	it("marks fresh items when lastRefreshedAt < 12h ago", () => {
		const oneHourMs = 1 * 60 * 60 * 1000;
		const statuses = [makeRow()];
		const items = buildCacheHealthItems(statuses, instanceNameMap, baseDateMs + oneHourMs);

		expect(items[0]!.isStale).toBe(false);
	});

	it("uses 'Unknown' for unrecognized instance IDs", () => {
		const statuses = [makeRow({ instanceId: "unknown-id" })];
		const items = buildCacheHealthItems(statuses, instanceNameMap, baseDateMs);

		expect(items[0]!.instanceName).toBe("Unknown");
	});

	it("sanitizes error messages in output", () => {
		const statuses = [
			makeRow({
				lastResult: "error",
				lastErrorMessage: "Crash at /app/src/cache.ts:99",
			}),
		];
		const items = buildCacheHealthItems(statuses, instanceNameMap, baseDateMs);

		expect(items[0]!.lastErrorMessage).toBe("Crash at [path]:99");
	});
});
