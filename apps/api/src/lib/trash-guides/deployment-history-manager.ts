/**
 * Deployment history finalization helpers.
 *
 * Standalone functions for updating TrashSyncHistory and
 * TemplateDeploymentHistory records after deployment completes.
 */

import type { PrismaClient } from "../prisma.js";

interface DeploymentDetails {
	created: string[];
	updated: string[];
	failed: string[];
	orphaned: string[];
}

/**
 * Finalizes deployment history records with results.
 */
export async function finalizeDeploymentHistory(
	prisma: PrismaClient,
	historyId: string | null,
	deploymentHistoryId: string | null,
	startTime: Date,
	details: DeploymentDetails,
	counts: { created: number; updated: number; skipped: number },
	errors: string[],
): Promise<void> {
	const endTime = new Date();
	const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

	// Note: counts.skipped includes both intentional skips (keep_existing) and failures
	// We use details.failed.length for actual failures, and compute intentional skips
	const intentionalSkips = counts.skipped - details.failed.length;
	if (historyId) {
		await prisma.trashSyncHistory.update({
			where: { id: historyId },
			data: {
				status: details.failed.length === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
				completedAt: endTime,
				duration,
				configsApplied: counts.created + counts.updated,
				configsFailed: details.failed.length,
				configsSkipped: intentionalSkips,
				appliedConfigs: JSON.stringify([...details.created, ...details.updated]),
				failedConfigs: details.failed.length > 0 ? JSON.stringify(details.failed) : null,
				errorLog: errors.length > 0 ? errors.join("\n") : null,
			},
		});
	}

	if (deploymentHistoryId) {
		await prisma.templateDeploymentHistory.update({
			where: { id: deploymentHistoryId },
			data: {
				status: details.failed.length === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
				duration,
				appliedCFs: counts.created + counts.updated,
				failedCFs: details.failed.length,
				appliedConfigs: JSON.stringify(
					details.created
						.map((name) => ({ name, action: "created" }))
						.concat(details.updated.map((name) => ({ name, action: "updated" }))),
				),
				failedConfigs:
					details.failed.length > 0
						? JSON.stringify(details.failed.map((name) => ({ name, error: "Deployment failed" })))
						: null,
				errors: errors.length > 0 ? JSON.stringify(errors) : null,
			},
		});
	}
}

/**
 * Updates deployment history with failure status.
 */
export async function finalizeDeploymentHistoryWithFailure(
	prisma: PrismaClient,
	historyId: string | null,
	deploymentHistoryId: string | null,
	startTime: Date,
	error: Error | unknown,
): Promise<void> {
	const endTime = new Date();
	const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
	const errorMessage = error instanceof Error ? error.message : "Unknown error";

	if (historyId) {
		await prisma.trashSyncHistory.update({
			where: { id: historyId },
			data: {
				status: "FAILED",
				completedAt: endTime,
				duration,
				errorLog: errorMessage,
			},
		});
	}

	if (deploymentHistoryId) {
		await prisma.templateDeploymentHistory.update({
			where: { id: deploymentHistoryId },
			data: {
				status: "FAILED",
				duration,
				errors: JSON.stringify([errorMessage]),
			},
		});
	}
}
