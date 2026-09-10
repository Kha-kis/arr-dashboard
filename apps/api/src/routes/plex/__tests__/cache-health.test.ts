/**
 * Cache Health Helper Tests
 *
 * Tests for the pure sanitizeErrorMessage and buildCacheHealthItems helpers
 * that build cache health response items from CacheRefreshStatus rows.
 *
 * Run with: npx vitest run cache-health.test.ts
 */

import type { PlexEvidenceSummary } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildCacheHealthItems,
	type CacheRefreshStatusRow,
	isSafeSanitizedEpisodeProgress,
	sanitizeErrorMessage,
} from "../lib/cache-health-helpers.js";

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

describe("isSafeSanitizedEpisodeProgress", () => {
	it("rejects progress whose completed counters exceed its public totals", () => {
		expect(
			isSafeSanitizedEpisodeProgress({
				completedUnits: 2,
				totalUnits: 1,
				completedWork: 50,
				totalWork: 49,
			}),
		).toBe(false);
	});

	it("accepts valid public counters from a persisted run shape without exposing its metadata", () => {
		expect(
			isSafeSanitizedEpisodeProgress({
				instanceId: "private-instance",
				state: "running",
				completedUnits: 7,
				totalUnits: 13,
				completedWork: 7,
				totalWork: 13,
			} as never),
		).toBe(true);
	});

	it.each([
		["negative", { completedUnits: -1, totalUnits: 1, completedWork: 0, totalWork: 1 }],
		["fractional", { completedUnits: 0.5, totalUnits: 1, completedWork: 0, totalWork: 1 }],
		[
			"unsafe",
			{
				completedUnits: Number.MAX_SAFE_INTEGER + 1,
				totalUnits: Number.MAX_SAFE_INTEGER + 1,
				completedWork: 0,
				totalWork: 1,
			},
		],
		["zero denominator", { completedUnits: 0, totalUnits: 0, completedWork: 0, totalWork: 1 }],
		["missing denominator", { completedUnits: 0, totalUnits: 1, completedWork: 0 }],
	] as const)("fails closed for %s progress", (_name, progress) => {
		expect(isSafeSanitizedEpisodeProgress(progress as never)).toBe(false);
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

	it("preserves partial refresh results in the public response", () => {
		const items = buildCacheHealthItems(
			[makeRow({ lastResult: "partial" })],
			instanceNameMap,
			baseDateMs,
		);

		expect(items[0]!.lastResult).toBe("partial");
	});

	it("reports a newer failed attempt as unavailable without replacing the historical timestamp", () => {
		const failedAt = new Date(baseDateMs + 60_000);
		const items = buildCacheHealthItems(
			[
				makeRow({
					lastAttemptAt: failedAt,
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "upstream pagination failed",
					lastErrorMessage: "upstream pagination failed",
				}),
			],
			instanceNameMap,
			failedAt.getTime(),
		);

		expect(items[0]).toMatchObject({
			lastRefreshedAt: baseDate.toISOString(),
			lastResult: "error",
			lastErrorMessage: "upstream pagination failed",
			itemCount: null,
		});
	});

	it("reports future positive-only Plex evidence as partial instead of successful", () => {
		const evidence = {
			publicationLevel: "positive-only",
			completeness: "partial",
			reasonCodes: [],
		} satisfies PlexEvidenceSummary;
		const items = buildCacheHealthItems(
			[makeRow()],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);

		expect(items[0]).toMatchObject({
			lastResult: "partial",
			uiCondition: "informational-gap",
			evidence,
		});
	});

	it("projects accepted partial Plex coverage as informational", () => {
		const evidence = {
			publicationLevel: "authoritative",
			completeness: "partial",
			reasonCodes: [],
		} satisfies PlexEvidenceSummary;
		const [item] = buildCacheHealthItems(
			[makeRow()],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);

		expect(item).toMatchObject({ lastResult: "partial", uiCondition: "informational-gap" });
	});

	it("names a V4 partial row count as observedItemCount, never an exact denominator", () => {
		const evidence = {
			publicationLevel: "positive-only",
			completeness: "partial",
			reasonCodes: [],
		} satisfies PlexEvidenceSummary;
		const [item] = buildCacheHealthItems(
			[makeRow({ itemCount: 7 })],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);
		expect(item).toMatchObject({ lastResult: "partial", itemCount: null, observedItemCount: 7 });
	});

	it("reports unavailable Plex evidence as an error instead of a successful empty cache", () => {
		const evidence = {
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["missing_metadata"],
		} satisfies PlexEvidenceSummary;
		const items = buildCacheHealthItems(
			[makeRow({ itemCount: 0 })],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);

		expect(items[0]).toMatchObject({
			lastResult: "error",
			lastErrorMessage: "Published Plex cache evidence is unavailable",
			itemCount: null,
			evidence,
		});
	});

	it("fails closed when a Plex status has no matching observation result", () => {
		const items = buildCacheHealthItems(
			[makeRow({ itemCount: 42 })],
			instanceNameMap,
			baseDateMs,
			new Map(),
		);

		expect(items[0]).toMatchObject({
			lastResult: "error",
			lastErrorMessage: "Published Plex cache evidence is unavailable",
			itemCount: null,
			evidence: {
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["query_failed"],
			},
		});
	});

	it("withholds exact counts from degraded Plex health observations", () => {
		const evidence = {
			availability: "last-known",
			authority: "unavailable",
			attemptState: "error",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["latest_attempt_failed"],
		} satisfies PlexEvidenceSummary;
		const items = buildCacheHealthItems(
			[makeRow({ itemCount: 42 })],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);

		expect(items[0]).toMatchObject({ lastResult: "error", itemCount: null, evidence });
	});

	it("normalizes an opaque active attempt as refreshing without exposing its token", () => {
		const token = "in_progress:do-not-expose";
		const evidence = {
			availability: "last-known",
			authority: "unavailable",
			attemptState: "in_progress",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["latest_attempt_in_progress"],
		} satisfies PlexEvidenceSummary;
		const items = buildCacheHealthItems(
			[makeRow({ lastAttemptResult: token, itemCount: 42 })],
			instanceNameMap,
			baseDateMs,
			new Map([["inst-1:plex", evidence]]),
		);

		expect(items[0]).toMatchObject({
			lastResult: "in_progress",
			lastErrorMessage: "Plex cache refresh is in progress; current values are unavailable",
			itemCount: null,
			evidence,
		});
		expect(JSON.stringify(items[0])).not.toContain(token);
	});

	it("projects a bounded active episode run as collecting without leaking work identity", () => {
		const [item] = buildCacheHealthItems(
			[makeRow({ cacheType: "plex_episode", lastAttemptResult: "in_progress" })],
			instanceNameMap,
			baseDateMs,
			undefined,
			new Map([
				[
					"inst-1:plex_episode",
					{
						state: "running",
						completedUnits: 7,
						totalUnits: 13,
						completedWork: 7,
						totalWork: 13,
					},
				],
			]),
		);

		expect(item).toMatchObject({
			lastResult: "in_progress",
			uiCondition: "collecting",
			progress: { completedUnits: 7, totalUnits: 13 },
		});
		expect(JSON.stringify(item?.progress)).not.toMatch(
			/run-|scope|provider-|title|label|user|https?:|error/i,
		);
	});

	it("keeps compatibility fields failed when persisted episode work failed", () => {
		const [item] = buildCacheHealthItems(
			[makeRow({ cacheType: "plex_episode" })],
			instanceNameMap,
			baseDateMs,
			undefined,
			new Map([
				[
					"inst-1:plex_episode",
					{
						state: "failed",
						completedUnits: 7,
						totalUnits: 13,
						completedWork: 7,
						totalWork: 13,
					},
				],
			]),
		);

		expect(item).toMatchObject({ lastResult: "error", uiCondition: "retryable-failure" });
	});
});
