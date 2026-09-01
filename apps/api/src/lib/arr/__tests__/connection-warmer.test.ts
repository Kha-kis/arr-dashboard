import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client-helpers.js", () => ({
	isSonarrClient: () => true,
	isRadarrClient: () => false,
	isProwlarrClient: () => false,
}));

import {
	withCleanupMaintenanceGuard,
	withIndependentCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { warmConnectionsForUser } from "../connection-warmer.js";

describe.sequential("connection warmer restore exclusion", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not detach an old-authority request at the legacy five-second boundary", async () => {
		vi.useFakeTimers();
		let releaseSystemGet: (() => void) | undefined;
		const systemGetBlocked = new Promise<void>((resolve) => {
			releaseSystemGet = resolve;
		});
		const systemGet = vi.fn(() => systemGetBlocked);
		const app = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([
						{
							id: "sonarr-1",
							userId: "user-1",
							service: "SONARR",
							enabled: true,
						},
					]),
				},
			},
			arrClientFactory: {
				create: vi.fn(() => ({ system: { get: systemGet } })),
			},
			log: {
				debug: vi.fn(),
				info: vi.fn(),
			},
		} as unknown as FastifyInstance;

		const warming = withIndependentCleanupOperationGuard(() =>
			warmConnectionsForUser(app, "user-1"),
		);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(systemGet).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(5001);
			const restoreWork = vi.fn();
			await expect(withCleanupMaintenanceGuard(restoreWork)).rejects.toMatchObject({
				statusCode: 409,
			});
			expect(restoreWork).not.toHaveBeenCalled();
		} finally {
			releaseSystemGet?.();
			await warming;
		}

		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});
});
