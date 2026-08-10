import { describe, expect, it, vi } from "vitest";
import {
	finalizeDeploymentHistory,
	finalizeDeploymentHistoryWithPartialFailure,
} from "../deployment-history-manager.js";

describe("finalizeDeploymentHistory", () => {
	it("records a profile or naming failure even when all Custom Formats succeeded", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};

		await finalizeDeploymentHistory(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: ["Created CF"], updated: [], failed: [], orphaned: [] },
			{ created: 1, updated: 0, skipped: 0 },
			["Naming deployment failed"],
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 1,
					configsFailed: 1,
					failedConfigs: JSON.stringify([
						{ name: "Deployment phase", error: "Naming deployment failed" },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "PARTIAL_SUCCESS", failedCFs: 0 }),
			}),
		);
	});

	it("finalizes deferred cleanup in the same database transaction as history", async () => {
		const transactionCleanup = vi.fn().mockResolvedValue({ count: 1 });
		const transactionMappingUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const transactionClient = {
			trashSyncHistory: { update: vi.fn().mockResolvedValue({}) },
			templateDeploymentHistory: { update: vi.fn().mockResolvedValue({}) },
			templateQualityProfileMapping: { updateMany: transactionMappingUpdate },
			instanceQualityProfileOverride: { deleteMany: transactionCleanup },
		};
		const prisma = {
			$transaction: vi.fn(async (work: (database: typeof transactionClient) => Promise<void>) =>
				work(transactionClient),
			),
		};

		await finalizeDeploymentHistory(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: [], updated: [], failed: [], orphaned: ["Removed CF"] },
			{ created: 0, updated: 0, skipped: 0 },
			[],
			undefined,
			0,
			async (database) => {
				await database.templateQualityProfileMapping.updateMany({
					where: { id: "mapping-1" },
					data: { managedCustomFormats: "[]" },
				});
				await database.instanceQualityProfileOverride.deleteMany({ where: { id: "override-1" } });
			},
		);

		expect(prisma.$transaction).toHaveBeenCalledOnce();
		expect(transactionMappingUpdate).toHaveBeenCalledWith({
			where: { id: "mapping-1" },
			data: { managedCustomFormats: "[]" },
		});
		expect(transactionCleanup).toHaveBeenCalledWith({ where: { id: "override-1" } });
	});

	it("propagates deferred-finalization failure so the deployment cannot report success", async () => {
		const transactionClient = {
			trashSyncHistory: { update: vi.fn().mockResolvedValue({}) },
			templateDeploymentHistory: { update: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (work: (database: typeof transactionClient) => Promise<void>) =>
				work(transactionClient),
			),
		};

		await expect(
			finalizeDeploymentHistory(
				prisma as never,
				"sync-1",
				"deployment-1",
				new Date(),
				{ created: [], updated: [], failed: [], orphaned: ["Removed CF"] },
				{ created: 0, updated: 0, skipped: 0 },
				[],
				undefined,
				0,
				async () => {
					throw new Error("managed finalization failed");
				},
			),
		).rejects.toThrow("managed finalization failed");
	});
});

describe("finalizeDeploymentHistoryWithPartialFailure", () => {
	it("preserves verified naming evidence in both partial histories", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const deploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: syncUpdate },
			templateDeploymentHistory: { update: deploymentUpdate },
			$transaction: vi.fn(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate },
					templateDeploymentHistory: { update: deploymentUpdate },
				}),
			),
		};
		const uncertain = Object.assign(new Error("ledger finalization failed"), {
			deploymentResultUncertain: true,
		});
		const namingConfig = {
			name: "Naming configuration",
			action: "updated",
			type: "naming",
			fields: 2,
		};

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: [], updated: [], failed: [], orphaned: [] },
			{ created: 0, updated: 0, skipped: 0 },
			uncertain,
			undefined,
			[],
			2,
		);

		expect(syncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					appliedConfigs: JSON.stringify([namingConfig]),
				}),
			}),
		);
		expect(deploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					appliedConfigs: JSON.stringify([namingConfig]),
				}),
			}),
		);
	});
	it("keeps an unverified first upstream mutation uncertain", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};
		const error = Object.assign(new Error("ARR write result could not be verified"), {
			deploymentResultUncertain: true,
		});

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: [], updated: [], failed: [], orphaned: [] },
			{ created: 0, updated: 0, skipped: 0 },
			error,
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "UNCERTAIN" }) }),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "UNCERTAIN" }) }),
		);
	});

	it("keeps an unverified upstream mutation uncertain while preserving proven writes", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};
		const error = Object.assign(new Error("ARR write result could not be verified"), {
			deploymentResultUncertain: true,
		});

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: ["Created CF"], updated: [], failed: [], orphaned: [] },
			{ created: 1, updated: 0, skipped: 0 },
			error,
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					appliedConfigs: JSON.stringify([
						{ name: "Created CF", action: "created", type: "custom_format" },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "UNCERTAIN", appliedCFs: 1 }),
			}),
		);
	});

	it("records a created quality profile in both histories when a later phase is blocked", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: [], updated: [], failed: [], orphaned: [] },
			{ created: 0, updated: 0, skipped: 0 },
			new Error("Saved score overrides changed during deployment"),
			{ action: "created", profileId: 4, profileName: "Any" },
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 1,
					appliedConfigs: JSON.stringify([
						{ name: "Any", action: "created", type: "quality_profile", id: 4 },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					appliedCFs: 0,
					appliedConfigs: JSON.stringify([
						{ name: "Any", action: "created", type: "quality_profile", id: 4 },
					]),
				}),
			}),
		);
	});

	it("records successful CF writes and the blocked quality-profile mutation", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{
				created: ["Created CF"],
				updated: ["Updated CF"],
				failed: ["Failed CF"],
				orphaned: [],
			},
			{ created: 1, updated: 1, skipped: 0 },
			new Error("Profile changed during deployment"),
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 2,
					configsFailed: 2,
					configsSkipped: 0,
					appliedConfigs: JSON.stringify([
						{ name: "Created CF", action: "created", type: "custom_format" },
						{ name: "Updated CF", action: "updated", type: "custom_format" },
					]),
					failedConfigs: JSON.stringify([
						{ name: "Failed CF", error: "Custom Format deployment failed" },
						{ name: "Deployment phase", error: "Profile changed during deployment" },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					appliedCFs: 2,
					failedCFs: 1,
					failedConfigs: JSON.stringify([
						{ name: "Failed CF", error: "Custom Format deployment failed" },
						{ name: "Deployment phase", error: "Profile changed during deployment" },
					]),
				}),
			}),
		);
	});

	it("records failed CFs and intentional skips when no CF write succeeded", async () => {
		const trashSyncUpdate = vi.fn().mockResolvedValue({});
		const templateDeploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: trashSyncUpdate },
			templateDeploymentHistory: { update: templateDeploymentUpdate },
		};
		const failedConfigs = JSON.stringify([
			{ name: "Failed CF", error: "Custom Format deployment failed" },
			{ name: "Deployment phase", error: "Profile changed during deployment" },
		]);

		await finalizeDeploymentHistoryWithPartialFailure(
			prisma as never,
			"sync-1",
			"deployment-1",
			new Date(),
			{ created: [], updated: [], failed: ["Failed CF"], orphaned: [] },
			{ created: 0, updated: 0, skipped: 2 },
			new Error("Profile changed during deployment"),
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					configsApplied: 0,
					configsFailed: 2,
					configsSkipped: 2,
					appliedConfigs: "[]",
					failedConfigs,
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					appliedCFs: 0,
					failedCFs: 1,
					appliedConfigs: "[]",
					failedConfigs,
				}),
			}),
		);
	});
});
