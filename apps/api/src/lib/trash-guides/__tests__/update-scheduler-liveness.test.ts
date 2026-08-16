import { describe, expect, it, vi } from "vitest";
import { UpdateScheduler } from "../update-scheduler.js";

describe("TRaSH update scheduler liveness", () => {
	it("releases the in-progress latch when scheduler preflight fails", async () => {
		const templateUpdater = {
			refreshAllCaches: vi.fn().mockResolvedValue({ refreshed: 0, failed: 0, errors: [] }),
			checkForUpdates: vi.fn().mockResolvedValue({
				totalTemplates: 0,
				outdatedTemplates: 0,
				templatesWithUpdates: [],
			}),
		};
		const prisma = {
			trashTemplate: {
				count: vi
					.fn()
					.mockRejectedValueOnce(new Error("transient strategy count failure"))
					.mockResolvedValue(0),
				findMany: vi.fn().mockResolvedValue([]),
			},
		};
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		};
		const notify = vi.fn().mockResolvedValue(undefined);
		const scheduler = new UpdateScheduler(
			{ enabled: true, intervalHours: 12 },
			templateUpdater as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({
					commitHash: "latest",
					commitDate: "today",
				}),
			} as never,
			prisma as never,
			logger,
			undefined,
			{ notifyFn: notify },
		);
		const privateScheduler = scheduler as unknown as {
			processQualitySizeSync: () => Promise<unknown>;
			processNamingSync: () => Promise<unknown>;
		};
		vi.spyOn(privateScheduler, "processQualitySizeSync").mockResolvedValue({
			autoSynced: 0,
			updatesPending: 0,
			errors: [],
		});
		vi.spyOn(privateScheduler, "processNamingSync").mockResolvedValue({
			autoSynced: 0,
			updatesPending: 0,
			errors: [],
		});

		await expect(scheduler.triggerCheck()).rejects.toThrow("transient strategy count failure");
		expect(scheduler.getStats().lastCheckResult).toMatchObject({
			templatesChecked: 0,
			templatesOutdated: 0,
			errors: ["transient strategy count failure"],
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "TRASH_SYNC_ERROR",
				body: "transient strategy count failure",
			}),
		);
		await scheduler.triggerCheck();

		expect(templateUpdater.refreshAllCaches).toHaveBeenCalledTimes(2);
		expect(prisma.trashTemplate.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					deletedAt: null,
					OR: [
						{ trashGuidesCommitHash: { not: null } },
						{ qualityProfileMappings: { some: { syncStrategy: "auto" } } },
					],
				},
			}),
		);
		expect(scheduler.getStats().lastCheckResult).toMatchObject({
			templatesChecked: 0,
			templatesOutdated: 0,
			errors: [],
		});
		expect(logger.warn).not.toHaveBeenCalledWith("Update check already in progress, skipping");
	});
});
