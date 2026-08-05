import { describe, expect, it, vi } from "vitest";
import { finalizeDeploymentHistoryWithPartialFailure } from "../deployment-history-manager.js";

describe("finalizeDeploymentHistoryWithPartialFailure", () => {
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
						{ name: "Quality profile", error: "Profile changed during deployment" },
					]),
				}),
			}),
		);
		expect(templateDeploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					appliedCFs: 2,
					failedCFs: 2,
					failedConfigs: JSON.stringify([
						{ name: "Failed CF", error: "Custom Format deployment failed" },
						{ name: "Quality profile", error: "Profile changed during deployment" },
					]),
				}),
			}),
		);
	});
});
