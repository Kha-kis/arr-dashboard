import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { finalizeDeploymentHistory } from "../deployment-history-manager.js";

describe("finalizeDeploymentHistory", () => {
	it("persists structured rollback ownership for created and updated formats", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const deploymentUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			trashSyncHistory: { update: syncUpdate },
			templateDeploymentHistory: { update: deploymentUpdate },
		} as unknown as PrismaClient;

		await finalizeDeploymentHistory(
			prisma,
			"sync-1",
			"deployment-1",
			new Date(),
			{
				created: ["Created CF"],
				updated: ["Updated CF"],
				failed: [],
				orphaned: [],
			},
			{ created: 1, updated: 1, skipped: 0 },
			[],
		);

		const syncUpdateArgs = syncUpdate.mock.calls[0]?.[0];
		expect(syncUpdateArgs).toBeDefined();
		expect(JSON.parse(syncUpdateArgs!.data.appliedConfigs)).toEqual([
			{ name: "Created CF", action: "created" },
			{ name: "Updated CF", action: "updated" },
		]);
	});
});
