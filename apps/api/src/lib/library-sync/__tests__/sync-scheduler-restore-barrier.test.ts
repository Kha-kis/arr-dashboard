import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";

const mocks = vi.hoisted(() => ({ syncInstance: vi.fn() }));

vi.mock("../sync-executor.js", () => ({
	syncInstance: mocks.syncInstance,
}));

import { LibrarySyncScheduler } from "../sync-scheduler.js";

describe("library sync background restore barrier", () => {
	it("holds an independent lease until a detached sync settles", async () => {
		let releaseSync!: (result: unknown) => void;
		mocks.syncInstance.mockReturnValue(
			new Promise((resolve) => {
				releaseSync = resolve;
			}),
		);
		const app = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			prisma: {},
			arrClientFactory: {},
			encryptor: {},
			notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
		} as unknown as FastifyInstance;
		const scheduler = new LibrarySyncScheduler();
		scheduler.initialize(app);
		const instance = {
			id: "sync-instance",
			userId: "user-1",
			label: "Radarr",
			service: "RADARR",
			baseUrl: "https://radarr.invalid",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		};
		const run = (
			scheduler as unknown as {
				runSync(value: typeof instance): Promise<unknown>;
			}
		).runSync(instance);
		await vi.waitFor(() => expect(mocks.syncInstance).toHaveBeenCalledTimes(1));

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});

		releaseSync({
			instanceId: instance.id,
			instanceName: instance.label,
			success: true,
			itemsProcessed: 0,
			itemsAdded: 0,
			itemsUpdated: 0,
			itemsRemoved: 0,
			newDownloads: [],
			durationMs: 1,
		});
		await run;
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});
});
