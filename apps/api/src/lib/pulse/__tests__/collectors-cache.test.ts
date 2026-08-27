import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { collectCacheStaleness } from "../collectors.js";

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: () => log,
} as unknown as FastifyBaseLogger;

function appWithStatus(lastAttemptErrorMessage: string): FastifyInstance {
	return {
		prisma: {
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "status-1",
						instanceId: "tautulli-1",
						cacheType: "tautulli",
						lastResult: "success",
						lastRefreshedAt: new Date("2026-08-27T10:00:00.000Z"),
						lastAttemptAt: new Date("2026-08-27T10:01:00.000Z"),
						lastAttemptResult: "error",
						lastAttemptErrorMessage,
						lastErrorMessage: null,
						generationMetadata: null,
						instance: { label: "Tautulli", service: "TAUTULLI" },
					},
				]),
			},
		},
	} as unknown as FastifyInstance;
}

describe("collectCacheStaleness Tautulli privacy", () => {
	it("redacts legacy free-form errors instead of emitting provider identifiers", async () => {
		const sensitive = "metadata failed for rating_key=8675309 tmdb://12345 at https://private";
		const items = await collectCacheStaleness(appWithStatus(sensitive), "user-1", log);

		expect(items).toHaveLength(1);
		expect(items[0]?.detail).toBe("Tautulli refresh failed (legacy_error_redacted).");
		expect(JSON.stringify(items)).not.toContain("8675309");
		expect(JSON.stringify(items)).not.toContain("12345");
		expect(JSON.stringify(items)).not.toContain("private");
	});
});
