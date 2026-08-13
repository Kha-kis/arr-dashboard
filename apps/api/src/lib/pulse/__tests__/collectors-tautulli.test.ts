import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { collectTautulliCacheHealth } from "../collectors.js";

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;

const HOUR = 60 * 60 * 1000;

function makeApp(statuses: unknown[]): FastifyInstance {
	return {
		prisma: {
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue(statuses) },
		},
	} as unknown as FastifyInstance;
}

function status(overrides: Record<string, unknown> = {}) {
	return {
		id: "status-row",
		instanceId: "tautulli-1",
		cacheType: "tautulli",
		lastRefreshedAt: new Date(Date.now() - HOUR),
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptAt: null,
		lastAttemptResult: null,
		lastAttemptErrorMessage: null,
		instance: { enabled: true, service: "TAUTULLI" },
		...overrides,
	};
}

describe("collectTautulliCacheHealth", () => {
	it("treats no configured Tautulli instance as healthy absence", async () => {
		const app = makeApp([]);

		expect(await collectTautulliCacheHealth(app, "user-1", log)).toEqual([]);
		expect(app.prisma.cacheRefreshStatus.findMany).toHaveBeenCalledWith({
			where: {
				cacheType: "tautulli",
				instance: { userId: "user-1", service: "TAUTULLI", enabled: true },
			},
			include: { instance: { select: { enabled: true, service: true } } },
		});
	});

	it("reports a newer failed attempt with a stable instance id without leaking upstream data", async () => {
		const app = makeApp([
			status({
				id: "different-status-row",
				lastAttemptAt: new Date(),
				lastAttemptResult: "error",
				lastAttemptErrorMessage:
					"https://secret.example user=alice title=Private Show apiKey=super-secret raw response",
			}),
		]);

		const [item] = await collectTautulliCacheHealth(app, "user-1", log);

		expect(item).toMatchObject({
			id: "tautulli-cache-failure-tautulli-1",
			severity: "warning",
			category: "health",
			title: "Tautulli cache refresh failed",
			actionUrl: "/settings",
			actionLabel: "Check Tautulli settings",
			source: "tautulli",
		});
		expect(item?.detail).toContain("last successful cache generation is still available");
		expect(item?.detail).not.toMatch(/secret|alice|Private Show|apiKey|raw response/i);
	});

	it("reports a failed attempt recorded at the same timestamp as its successful generation", async () => {
		const publishedAt = new Date();
		const app = makeApp([
			status({
				lastRefreshedAt: publishedAt,
				lastAttemptAt: publishedAt,
				lastAttemptResult: "error",
			}),
		]);

		const [item] = await collectTautulliCacheHealth(app, "user-1", log);

		expect(item).toMatchObject({
			id: "tautulli-cache-failure-tautulli-1",
			title: "Tautulli cache refresh failed",
		});
		expect(item?.detail).toContain("last successful cache generation is still available");
	});

	it("reports stale Tautulli data with an entity-keyed id and skips disabled instances", async () => {
		const stale = status({
			id: "old-status-row",
			lastRefreshedAt: new Date(Date.now() - 13 * HOUR),
		});
		const disabled = status({
			id: "disabled-status-row",
			instanceId: "tautulli-disabled",
			lastRefreshedAt: new Date(Date.now() - 13 * HOUR),
			instance: { enabled: false, service: "TAUTULLI" },
		});

		const items = await collectTautulliCacheHealth(makeApp([stale, disabled]), "user-1", log);

		expect(items).toEqual([
			expect.objectContaining({
				id: "tautulli-cache-stale-tautulli-1",
				title: "Tautulli cache is stale",
				actionUrl: "/settings",
			}),
		]);
	});
});
