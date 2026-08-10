import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	execute: vi.fn(),
}));

vi.mock("../sync-engine.js", () => ({
	createSyncEngine: () => ({ validate: mocks.validate, execute: mocks.execute }),
}));

import { TrashSyncScheduler } from "../sync-scheduler.js";

describe("TrashSyncScheduler uncertain results", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validate.mockResolvedValue({ valid: true, errors: [] });
		mocks.execute.mockResolvedValue({
			syncId: "sync-1",
			success: false,
			status: "UNCERTAIN",
			errors: [{ error: "ARR write could not be verified" }],
		});
	});

	it("emits the logical uncertainty event with legacy sync-error fallback", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const prisma = {
			trashSettings: { findFirst: vi.fn().mockResolvedValue(null) },
			trashSyncSchedule: { update: vi.fn().mockResolvedValue({}) },
		};
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		};
		const scheduler = new TrashSyncScheduler(
			prisma as never,
			logger as never,
			{} as never,
			{} as never,
			notify,
		);
		const executeSchedule = (
			scheduler as unknown as {
				executeSchedule: (schedule: Record<string, unknown>) => Promise<void>;
			}
		).executeSchedule.bind(scheduler);

		await executeSchedule({
			id: "schedule-1",
			templateId: "template-1",
			instanceId: "instance-1",
			userId: "user-1",
			frequency: "DAILY",
			autoApply: true,
			notifyUser: true,
			template: { id: "template-1", name: "Any", serviceType: "RADARR" },
			instance: { id: "instance-1", label: "Radarr" },
		});

		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "TRASH_DEPLOY_UNCERTAIN",
				title: expect.stringContaining("needs review"),
				metadata: expect.objectContaining({ reason: "uncertain_result" }),
			}),
			{
				userId: "user-1",
				fallbackEventTypes: ["TRASH_SYNC_ERROR"],
			},
		);
	});
});
