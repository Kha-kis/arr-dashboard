import { describe, expect, it, vi } from "vitest";
import { UpdateScheduler } from "../update-scheduler.js";

describe("TRaSH update scheduler uncertain automation", () => {
	it("counts and notifies an uncertain deployment without treating it as failed", async () => {
		const uncertainOutcome = {
			endpointKey: "user-1:RADARR:credential-1",
			instanceId: "instance-1",
			instanceLabel: "Radarr",
			status: "UNCERTAIN" as const,
			success: false,
			errors: ["ARR write could not be verified"],
		};
		const templateUpdater = {
			refreshAllCaches: vi.fn().mockResolvedValue({ refreshed: 0, failed: 0, errors: [] }),
			checkForUpdates: vi.fn().mockResolvedValue({
				totalTemplates: 1,
				outdatedTemplates: 1,
				templatesWithUpdates: [],
			}),
			processAutoUpdates: vi.fn().mockResolvedValue({
				processed: 1,
				successful: 0,
				failed: 0,
				uncertain: 1,
				skippedForApproval: 0,
				templatesWithScoreConflicts: 0,
				uncertainDeployments: [uncertainOutcome],
				results: [
					{
						templateId: "template-1",
						success: false,
						errors: uncertainOutcome.errors,
					},
				],
			}),
			getTemplatesNeedingAttention: vi.fn().mockResolvedValue([]),
		};
		const prisma = {
			trashTemplate: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([{ userId: "user-1" }]),
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
				getLatestCommit: vi.fn().mockResolvedValue({ commitHash: "new", commitDate: "today" }),
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

		await scheduler.triggerCheck();

		expect(scheduler.getStats().lastCheckResult).toMatchObject({
			templatesAutoSynced: 0,
			templatesWithUncertainDeployments: 1,
			errors: [],
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "TRASH_DEPLOY_UNCERTAIN",
				title: expect.stringContaining("needs review"),
				metadata: expect.objectContaining({ reason: "uncertain_result" }),
			}),
			{ userId: "user-1", fallbackEventTypes: ["TRASH_SYNC_ERROR"] },
		);
	});
});
