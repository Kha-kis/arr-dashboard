import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../errors.js";
import { SyncEngine, type SyncOptions } from "../sync-engine.js";

const createSyncOptions = (overrides: Partial<SyncOptions> = {}): SyncOptions => ({
	templateId: "template-123",
	instanceId: "instance-123",
	userId: "user-123",
	syncType: "MANUAL",
	...overrides,
});

describe("SyncEngine Task 4A partial result consumption", () => {
	it("propagates an unverified write as uncertain without counting it as failed", async () => {
		const historyUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: historyUpdate,
			},
		};
		const uncertain = Object.assign(new ConflictError("ARR write result is uncertain"), {
			deploymentResultUncertain: true,
			partialDeployment: {
				created: 1,
				updated: 0,
				skipped: 0,
				details: { created: ["Created CF"], updated: [], failed: [] },
			},
		});
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{ deploySingleInstance: vi.fn().mockRejectedValue(uncertain) } as never,
		);
		const progress = vi.fn();
		engine.onProgress("sync-1", progress);

		await expect(
			engine.execute(createSyncOptions(), undefined, "review-token"),
		).resolves.toMatchObject({
			success: false,
			status: "UNCERTAIN",
			configsApplied: 1,
			configsFailed: 0,
		});
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					configsFailed: 0,
				}),
			}),
		);
		expect(progress).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "UNCERTAIN", failedConfigs: 0 }),
		);
	});

	it("preserves an uncertain result when sync history finalization also fails", async () => {
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: vi.fn().mockRejectedValue(new Error("database unavailable")),
			},
		};
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{
				deploySingleInstance: vi.fn().mockResolvedValue({
					instanceId: "instance-123",
					instanceLabel: "Test Radarr",
					success: false,
					status: "UNCERTAIN",
					customFormatsCreated: 1,
					customFormatsUpdated: 0,
					customFormatsSkipped: 0,
					errors: ["ARR write result is uncertain"],
					details: { created: ["Created CF"], updated: [], failed: [] },
				}),
			} as never,
		);

		const result = await engine.execute(createSyncOptions(), undefined, "review-token");

		expect(result).toMatchObject({
			success: false,
			status: "UNCERTAIN",
			configsApplied: 1,
			configsFailed: 0,
		});
		expect(result.warnings).toContain(
			"ARR changes may be present, but the local audit record is incomplete.",
		);
	});

	it("records a durably created profile when a later reviewed recheck conflicts", async () => {
		const historyUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: historyUpdate,
			},
		};
		const partialConflict = Object.assign(
			new ConflictError("Saved score overrides changed during deployment"),
			{
				partialDeployment: {
					created: 0,
					updated: 0,
					skipped: 0,
					details: { created: [], updated: [], failed: [] },
					qualityProfile: {
						action: "created" as const,
						profileId: 9,
						profileName: "Any",
					},
				},
			},
		);
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{ deploySingleInstance: vi.fn().mockRejectedValue(partialConflict) } as never,
		);

		await expect(
			engine.execute(createSyncOptions(), undefined, "review-token"),
		).resolves.toMatchObject({
			success: false,
			status: "PARTIAL_SUCCESS",
			configsApplied: 1,
			errors: [
				expect.objectContaining({
					error: "Saved score overrides changed during deployment",
				}),
			],
		});
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 1,
					appliedConfigs: JSON.stringify([
						{ name: "Any", action: "created", type: "quality_profile", id: 9 },
					]),
				}),
			}),
		);
	});

	it("includes upstream CF writes when a later reviewed profile mutation is blocked", async () => {
		const historyUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: historyUpdate,
			},
		};
		const partialConflict = Object.assign(new ConflictError("Profile changed during deploy"), {
			partialDeployment: {
				created: 1,
				updated: 1,
				skipped: 2,
				details: { created: ["Created CF"], updated: ["Updated CF"] },
			},
		});
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{ deploySingleInstance: vi.fn().mockRejectedValue(partialConflict) } as never,
		);
		const progress = vi.fn();
		engine.onProgress("sync-1", progress);

		await expect(
			engine.execute(createSyncOptions(), undefined, "review-token"),
		).resolves.toMatchObject({
			success: false,
			status: "PARTIAL_SUCCESS",
			configsApplied: 2,
		});
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 2,
					configsFailed: 1,
					configsSkipped: 2,
					appliedConfigs: JSON.stringify([
						{ name: "Created CF", action: "created", type: "custom_format" },
						{ name: "Updated CF", action: "updated", type: "custom_format" },
					]),
				}),
			}),
		);
		expect(progress).toHaveBeenLastCalledWith(
			expect.objectContaining({
				totalConfigs: 5,
				appliedConfigs: 2,
				failedConfigs: 1,
			}),
		);
	});

	it("preserves the original partial-success conflict when history persistence fails", async () => {
		const historyUpdate = vi.fn().mockRejectedValue(new Error("database unavailable"));
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: historyUpdate,
			},
		};
		const conflict = Object.assign(new ConflictError("Profile changed during deployment"), {
			partialDeployment: {
				created: 1,
				updated: 0,
				skipped: 0,
				details: { created: ["Created CF"], updated: [] },
			},
			details: {
				partialDeployment: {
					created: 1,
					updated: 0,
					skipped: 0,
					details: { created: ["Created CF"], updated: [] },
				},
			},
		});
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{ deploySingleInstance: vi.fn().mockRejectedValue(conflict) } as never,
		);

		const result = await engine.execute(createSyncOptions(), undefined, "review-token");

		expect(result).toMatchObject({
			success: false,
			status: "PARTIAL_SUCCESS",
			configsApplied: 1,
			warnings: [expect.stringContaining("could not be written to sync history")],
		});
	});

	it("surfaces deployment audit warnings through manual sync", async () => {
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		const deploymentWarning =
			"Deployment completed, but its history record could not be finalized. Check the server logs.";
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{
				deploySingleInstance: vi.fn().mockResolvedValue({
					instanceId: "instance-123",
					instanceLabel: "Test Radarr",
					success: true,
					customFormatsCreated: 1,
					customFormatsUpdated: 0,
					customFormatsSkipped: 0,
					errors: [],
					warnings: [deploymentWarning],
					details: { created: ["Created CF"], updated: [], failed: [] },
				}),
			} as never,
		);
		const progress = vi.fn();
		engine.onProgress("sync-1", progress);

		const result = await engine.execute(createSyncOptions(), undefined, "review-token");

		expect(result).toMatchObject({
			success: true,
			status: "SUCCESS",
			warnings: [deploymentWarning],
		});
		expect(progress).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "COMPLETED",
				currentStep: "Sync completed with warnings",
			}),
		);
	});

	it("counts quality profile and naming mutations in completed sync history", async () => {
		const historyUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: historyUpdate,
			},
		};
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{
				deploySingleInstance: vi.fn().mockResolvedValue({
					instanceId: "instance-123",
					instanceLabel: "Test Radarr",
					success: true,
					customFormatsCreated: 1,
					customFormatsUpdated: 0,
					customFormatsSkipped: 1,
					errors: [],
					qualityProfileApplied: {
						profileId: 7,
						profileName: "HD-1080p",
						action: "updated",
					},
					namingFieldsApplied: 2,
					details: { created: ["Created CF"], updated: [], failed: [] },
				}),
			} as never,
		);

		const result = await engine.execute(createSyncOptions(), undefined, "review-token");

		expect(result).toMatchObject({
			success: true,
			status: "SUCCESS",
			configsApplied: 3,
			configsFailed: 0,
			configsSkipped: 1,
		});
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					configsApplied: 3,
					configsSkipped: 1,
					appliedConfigs: JSON.stringify([
						{ name: "Created CF", action: "created", type: "custom_format" },
						{
							name: "HD-1080p",
							action: "updated",
							type: "quality_profile",
							id: 7,
						},
						{ name: "Naming configuration", action: "updated", type: "naming", fields: 2 },
					]),
				}),
			}),
		);
	});

	it("preserves applied counts but reports non-success when sync history finalization fails", async () => {
		const deploySingleInstance = vi.fn().mockResolvedValue({
			instanceId: "instance-123",
			instanceLabel: "Test Radarr",
			success: true,
			customFormatsCreated: 1,
			customFormatsUpdated: 1,
			customFormatsSkipped: 0,
			errors: [],
			details: { created: ["Created CF"], updated: ["Updated CF"], failed: [] },
		});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: vi.fn().mockRejectedValue(new Error("database unavailable")),
			},
		};
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate: vi.fn().mockResolvedValue({ success: true, errors: [] }) } as never,
			{ deploySingleInstance } as never,
		);
		const progress = vi.fn();
		engine.onProgress("sync-1", progress);

		const result = await engine.execute(createSyncOptions(), undefined, "review-token");

		expect(result).toMatchObject({
			success: false,
			status: "PARTIAL_SUCCESS",
			configsApplied: 2,
			configsFailed: 1,
		});
		expect(result.warnings).toEqual([
			"ARR changes may be present, but the local audit record is incomplete.",
		]);
		expect(progress).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "FAILED",
				progress: 100,
				appliedConfigs: 2,
				failedConfigs: 1,
			}),
		);
		expect(prisma.trashSyncHistory.update).toHaveBeenCalledTimes(1);
		expect(deploySingleInstance).toHaveBeenCalledWith(
			"template-123",
			"instance-123",
			"user-123",
			undefined,
			undefined,
			"review-token",
			"sync-1",
		);
	});

	it("keeps scheduled refresh before automation deployment without a review token", async () => {
		const syncTemplate = vi.fn().mockResolvedValue({ success: true, errors: [] });
		const deploySingleInstanceFromAutomation = vi.fn().mockResolvedValue({
			instanceId: "instance-123",
			instanceLabel: "Test Radarr",
			success: true,
			status: "SUCCESS",
			customFormatsCreated: 1,
			customFormatsUpdated: 0,
			customFormatsSkipped: 0,
			errors: [],
			details: { created: ["Created CF"], updated: [], failed: [] },
		});
		const prisma = {
			trashSyncHistory: {
				create: vi.fn().mockResolvedValue({ id: "sync-1" }),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		const engine = new SyncEngine(
			prisma as never,
			{ syncTemplate } as never,
			{ deploySingleInstanceFromAutomation } as never,
		);

		const result = await engine.execute(createSyncOptions({ syncType: "SCHEDULED" }));

		expect(result).toMatchObject({ success: true, status: "SUCCESS", configsApplied: 1 });
		expect(syncTemplate).toHaveBeenCalledWith("template-123", undefined, "user-123");
		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledWith(
			"template-123",
			"instance-123",
			"user-123",
			undefined,
			"sync-1",
		);
		expect(syncTemplate.mock.invocationCallOrder[0]).toBeLessThan(
			deploySingleInstanceFromAutomation.mock.invocationCallOrder[0]!,
		);
	});
});
