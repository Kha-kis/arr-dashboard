import { describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../lib/prisma.js";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../lib/jellyfin/jellyfin-positive-watch-refresher.js", () => ({
	refreshOwnedJellyfinPositiveWatch: refresh,
}));

import { refreshScheduledJellyfinPositiveWatchInstances } from "../jellyfin-positive-watch-scheduler.js";

describe("Jellyfin positive watch scheduler", () => {
	it("does not start an instance after the owned shutdown signal aborts", async () => {
		refresh.mockReset();
		const controller = new AbortController();
		refresh.mockImplementationOnce(async () => {
			controller.abort();
			return { kind: "skipped", reason: "cancelled" };
		});
		const app = {
			prisma: {} as never,
			encryptor: {} as never,
			log: { info: vi.fn(), error: vi.fn() } as never,
		};
		await refreshScheduledJellyfinPositiveWatchInstances(
			app,
			[{ id: "synthetic-one" }, { id: "synthetic-two" }] as ServiceInstance[],
			() => false,
			controller.signal,
		);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh.mock.calls[0]![0].signal).toBe(controller.signal);
	});

	it("continues to a second instance when the first refresh rejects", async () => {
		refresh.mockReset();
		refresh.mockRejectedValueOnce(new Error("synthetic private detail"));
		refresh.mockResolvedValueOnce({
			kind: "published",
			itemCount: 1,
			scopeCount: 1,
			durationMs: 4,
		});
		const log = { info: vi.fn(), error: vi.fn() };
		const app = {
			prisma: {} as never,
			encryptor: {} as never,
			log: log as never,
		};
		const instances = [
			{ id: "synthetic-one" } as ServiceInstance,
			{ id: "synthetic-two" } as ServiceInstance,
		];
		await refreshScheduledJellyfinPositiveWatchInstances(app, instances);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(log.error).toHaveBeenCalledWith(
			{
				provider: "jellyfin",
				cacheType: "jellyfin_episode_positive",
				reasonCode: "instance_refresh_failed",
			},
			"Jellyfin positive watch instance refresh failed",
		);
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "published", itemCount: 1 }),
			"Jellyfin positive watch refresh completed",
		);
	});
});
