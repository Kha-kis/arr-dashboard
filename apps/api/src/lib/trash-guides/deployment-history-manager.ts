/**
 * Deployment history finalization helpers.
 *
 * Standalone functions for updating TrashSyncHistory and
 * TemplateDeploymentHistory records after deployment completes.
 */

import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";

interface DeploymentDetails {
	created: string[];
	updated: string[];
	failed: string[];
	orphaned: string[];
}

interface QualityProfileMutation {
	action: "created" | "updated";
	profileId: number;
	profileName: string;
}

async function withHistoryTransaction(
	prisma: PrismaClient,
	action: (database: PrismaClient) => Promise<void>,
): Promise<void> {
	if (typeof prisma.$transaction !== "function") return action(prisma);
	await prisma.$transaction(async (transaction) => action(transaction as PrismaClient));
}

function getAppliedConfigs(
	details: DeploymentDetails,
	qualityProfile?: QualityProfileMutation,
): Array<Record<string, unknown>> {
	return [
		...details.created.map((name) => ({ name, action: "created", type: "custom_format" })),
		...details.updated.map((name) => ({ name, action: "updated", type: "custom_format" })),
		...(qualityProfile
			? [
					{
						name: qualityProfile.profileName,
						action: qualityProfile.action,
						type: "quality_profile",
						id: qualityProfile.profileId,
					},
				]
			: []),
	];
}

export function isDeploymentResultUncertain(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		Reflect.get(error, "deploymentResultUncertain") === true
	);
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
	qualityProfile?: QualityProfileMutation,
	namingFieldsApplied = 0,
	onFinalize?: (database: PrismaClient) => Promise<void>,
): Promise<void> {
	if (!historyId && !deploymentHistoryId && !onFinalize) return;
	const endTime = new Date();
	const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

	const intentionalSkips = counts.skipped;
	const appliedCFCount = counts.created + counts.updated;
	const appliedCount =
		appliedCFCount + (qualityProfile ? 1 : 0) + (namingFieldsApplied > 0 ? 1 : 0);
	const failureCount = errors.length;
	const status = failureCount === 0 ? "SUCCESS" : appliedCount > 0 ? "PARTIAL_SUCCESS" : "FAILED";
	const phaseErrors = errors.slice(details.failed.length);
	const failedConfigs = [
		...details.failed.map((name) => ({ name, error: "Custom Format deployment failed" })),
		...phaseErrors.map((error) => ({ name: "Deployment phase", error })),
	];
	await withHistoryTransaction(prisma, async (database) => {
		if (historyId) {
			await database.trashSyncHistory.update({
				where: { id: historyId },
				data: {
					status,
					completedAt: endTime,
					duration,
					configsApplied: appliedCount,
					configsFailed: failureCount,
					configsSkipped: intentionalSkips,
					appliedConfigs: JSON.stringify([
						...getAppliedConfigs(details, qualityProfile),
						...(namingFieldsApplied > 0
							? [
									{
										name: "Naming configuration",
										action: "updated",
										type: "naming",
										fields: namingFieldsApplied,
									},
								]
							: []),
					]),
					failedConfigs: failureCount > 0 ? JSON.stringify(failedConfigs) : null,
					errorLog: errors.length > 0 ? errors.join("\n") : null,
				},
			});
		}

		if (deploymentHistoryId) {
			await database.templateDeploymentHistory.update({
				where: { id: deploymentHistoryId },
				data: {
					status,
					duration,
					appliedCFs: appliedCFCount,
					failedCFs: details.failed.length,
					appliedConfigs: JSON.stringify([
						...getAppliedConfigs(details, qualityProfile),
						...(namingFieldsApplied > 0
							? [
									{
										name: "Naming configuration",
										action: "updated",
										type: "naming",
										fields: namingFieldsApplied,
									},
								]
							: []),
					]),
					failedConfigs: failureCount > 0 ? JSON.stringify(failedConfigs) : null,
					errors: errors.length > 0 ? JSON.stringify(errors) : null,
				},
			});
		}
		await onFinalize?.(database);
	});
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
	if (!historyId && !deploymentHistoryId) return;
	const endTime = new Date();
	const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
	const errorMessage = getErrorMessage(error, "Unknown error");
	const status = isDeploymentResultUncertain(error) ? "UNCERTAIN" : "FAILED";

	await withHistoryTransaction(prisma, async (database) => {
		if (historyId) {
			await database.trashSyncHistory.update({
				where: { id: historyId },
				data: {
					status,
					completedAt: endTime,
					duration,
					errorLog: errorMessage,
				},
			});
		}

		if (deploymentHistoryId) {
			await database.templateDeploymentHistory.update({
				where: { id: deploymentHistoryId },
				data: {
					status,
					duration,
					errors: JSON.stringify([errorMessage]),
				},
			});
		}
	});
}

/** Finalize a deployment where CF work completed before a later mutation was blocked. */
export async function finalizeDeploymentHistoryWithPartialFailure(
	prisma: PrismaClient,
	historyId: string | null,
	deploymentHistoryId: string | null,
	startTime: Date,
	details: DeploymentDetails,
	counts: { created: number; updated: number; skipped: number },
	error: unknown,
	qualityProfile?: QualityProfileMutation,
	priorErrors: string[] = [],
): Promise<void> {
	if (!historyId && !deploymentHistoryId) return;
	const endTime = new Date();
	const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
	const errorMessage = getErrorMessage(error, "Unknown error");
	const appliedCFCount = counts.created + counts.updated;
	const appliedCount = appliedCFCount + (qualityProfile ? 1 : 0);
	const uncertain = isDeploymentResultUncertain(error);
	const status = uncertain ? "UNCERTAIN" : appliedCount > 0 ? "PARTIAL_SUCCESS" : "FAILED";
	const failedConfigs = [
		...details.failed.map((name, index) => ({
			name,
			error: priorErrors[index] ?? "Custom Format deployment failed",
		})),
		...(uncertain ? [] : [{ name: "Deployment phase", error: errorMessage }]),
	];
	await withHistoryTransaction(prisma, async (database) => {
		if (historyId) {
			await database.trashSyncHistory.update({
				where: { id: historyId },
				data: {
					status,
					completedAt: endTime,
					duration,
					configsApplied: appliedCount,
					configsFailed: details.failed.length + (uncertain ? 0 : 1),
					configsSkipped: counts.skipped,
					appliedConfigs: JSON.stringify(getAppliedConfigs(details, qualityProfile)),
					failedConfigs: JSON.stringify(failedConfigs),
					errorLog: [...priorErrors, errorMessage].join("\n"),
				},
			});
		}

		if (deploymentHistoryId) {
			await database.templateDeploymentHistory.update({
				where: { id: deploymentHistoryId },
				data: {
					status,
					duration,
					appliedCFs: appliedCFCount,
					failedCFs: details.failed.length,
					appliedConfigs: JSON.stringify(getAppliedConfigs(details, qualityProfile)),
					failedConfigs: JSON.stringify(failedConfigs),
					errors: JSON.stringify([errorMessage]),
				},
			});
		}
	});
}
