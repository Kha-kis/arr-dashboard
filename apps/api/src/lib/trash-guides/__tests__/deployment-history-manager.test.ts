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
});

describe("finalizeDeploymentHistoryWithPartialFailure", () => {
	it("records a quality-profile write when a later naming phase is blocked", async () => {
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
			new Error("Naming changed during deployment"),
			{ action: "updated", profileId: 4, profileName: "Any" },
		);

		expect(trashSyncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 1,
					appliedConfigs: JSON.stringify([
						{ name: "Any", action: "updated", type: "quality_profile", id: 4 },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					appliedCFs: 0,
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
						{ name: "Created CF", action: "created" },
						{ name: "Updated CF", action: "updated" },
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
