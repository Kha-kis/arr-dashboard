import { describe, expect, it, vi } from "vitest";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";

describe("recordCacheRefreshFailure", () => {
	it("preserves an existing successful generation pointer on an incomplete attempt", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const attemptedAt = new Date("2026-08-03T12:00:00.000Z");

		await recordCacheRefreshFailure(
			{ cacheRefreshStatus: { upsert } } as never,
			"plex-1",
			"plex_episode",
			"truncated pagination",
			attemptedAt,
		);

		expect(upsert).toHaveBeenCalledWith({
			where: {
				instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" },
			},
			create: {
				instanceId: "plex-1",
				cacheType: "plex_episode",
				lastRefreshedAt: attemptedAt,
				lastResult: "error",
				lastErrorMessage: "truncated pagination",
				itemCount: 0,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "truncated pagination",
			},
			update: {
				lastErrorMessage: "truncated pagination",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "truncated pagination",
			},
		});
	});
});
