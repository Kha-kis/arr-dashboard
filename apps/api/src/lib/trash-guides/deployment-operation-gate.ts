import type { PrismaClient } from "../prisma.js";
import { AppValidationError, ConflictError } from "../errors.js";
import {
	type DeploymentBackupState,
	hasPendingDeploymentMutation,
	parseDeploymentBackupState,
} from "./deployment-backup-state.js";
import type { DeploymentConnectionBinding } from "./deployment-target.js";

export type ScoreIntentOperation = "SET_SCORE" | "RESET_SCORE";

export interface ScoreIntentRetry {
	qualityProfileId: number;
	operation: ScoreIntentOperation;
	scoreUpdates: Array<{ customFormatId: number; score: number }>;
	connectionBindings: DeploymentConnectionBinding[];
}

/** Block new writes while a previous upstream result remains uncertain. */
export async function assertNoPendingDeploymentOperation(
	prisma: PrismaClient,
	userId: string,
	instanceIds: string[],
	overrideRetry?: ScoreIntentRetry,
	excludedSyncHistoryId?: string,
): Promise<void> {
	const [syncRows, deploymentRows, uncertainOverrides] = await Promise.all([
		prisma.trashSyncHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
				...(excludedSyncHistoryId ? { id: { not: excludedSyncHistoryId } } : {}),
			},
			select: {
				status: true,
				rollbackStatus: true,
				backupId: true,
				backup: { select: { id: true, backupData: true } },
			},
		}),
		prisma.templateDeploymentHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
			},
			select: {
				status: true,
				undeployStatus: true,
				backupId: true,
				backup: { select: { id: true, backupData: true } },
			},
		}),
		typeof prisma.instanceQualityProfileOverride?.findMany === "function"
			? prisma.instanceQualityProfileOverride.findMany({
					where: {
						userId,
						instanceId: { in: instanceIds },
						status: { in: ["PENDING", "UNCERTAIN"] },
					},
					select: {
						instanceId: true,
						qualityProfileId: true,
						customFormatId: true,
						intentOperation: true,
						intendedScore: true,
						connectionGeneration: true,
						connectionStateToken: true,
					},
				})
			: [],
	]);
	const retryScores = new Map(
		overrideRetry?.scoreUpdates.map((update) => [update.customFormatId, update.score]) ?? [],
	);
	const retryBindingByInstanceId = new Map(
		overrideRetry?.connectionBindings.map((binding) => [binding.instanceId, binding]) ?? [],
	);
	const requestedInstanceIds = new Set(instanceIds);
	const isExactRetry = Boolean(
		overrideRetry &&
			uncertainOverrides.length > 0 &&
			retryScores.size === overrideRetry.scoreUpdates.length &&
			retryBindingByInstanceId.size === overrideRetry.connectionBindings.length &&
			retryBindingByInstanceId.size === requestedInstanceIds.size &&
			[...requestedInstanceIds].every((instanceId) => retryBindingByInstanceId.has(instanceId)) &&
			overrideRetry.scoreUpdates.every((update) =>
				uncertainOverrides.some(
					(override) =>
						override.qualityProfileId === overrideRetry.qualityProfileId &&
						override.customFormatId === update.customFormatId,
				),
			) &&
			uncertainOverrides.every(
				(override) =>
					override.qualityProfileId === overrideRetry.qualityProfileId &&
					override.intentOperation === overrideRetry.operation &&
					override.intendedScore !== null &&
					retryScores.get(override.customFormatId) === override.intendedScore &&
					retryBindingByInstanceId.get(override.instanceId)?.connectionGeneration ===
						override.connectionGeneration &&
					retryBindingByInstanceId.get(override.instanceId)?.connectionStateToken ===
						override.connectionStateToken,
			),
	);
	if (uncertainOverrides.length > 0 && !isExactRetry) {
		throw new AppValidationError(
			"A previous quality-profile score write has an uncertain upstream result. Retry that exact score update before changing this ARR endpoint.",
		);
	}
	if (
		syncRows.some((row) => row.rollbackStatus === "IN_PROGRESS" || row.rollbackStatus === "PARTIAL")
	) {
		throw new AppValidationError(
			"A previous TRaSH deployment has an unfinished rollback. Retry or resolve that rollback before changing this ARR endpoint.",
		);
	}
	if (
		deploymentRows.some(
			(row) =>
				row.undeployStatus === "IN_PROGRESS" ||
				row.undeployStatus === "PARTIAL" ||
				row.status === "PARTIAL_UNDEPLOY",
		)
	) {
		throw new AppValidationError(
			"A previous TRaSH deployment has an unfinished undeploy. Retry or resolve that undeploy before changing this ARR endpoint.",
		);
	}
	if (
		syncRows.some((row) => row.status === "UNCERTAIN") ||
		deploymentRows.some((row) => row.status === "UNCERTAIN")
	) {
		throw new AppValidationError(
			"A previous TRaSH deployment has an uncertain upstream result. Resolve that history before changing this ARR endpoint.",
		);
	}
	if (
		syncRows.some(
			(row) =>
				row.status === "IN_PROGRESS" ||
				row.status === "RUNNING" ||
				(!row.backup && row.status === "PARTIAL_SUCCESS"),
		) ||
		deploymentRows.some(
			(row) => row.status === "IN_PROGRESS" || (!row.backup && row.status === "PARTIAL_SUCCESS"),
		)
	) {
		throw new AppValidationError(
			"A previous TRaSH deployment has an uncertain upstream result and no verifiable deployment ledger. Resolve that history before changing this ARR endpoint.",
		);
	}
	const seen = new Set<string>();
	for (const row of [...syncRows, ...deploymentRows]) {
		if (!row.backup || seen.has(row.backup.id)) continue;
		seen.add(row.backup.id);
		let rawBackup: unknown;
		try {
			rawBackup = JSON.parse(row.backup.backupData);
		} catch {
			throw new AppValidationError(
				"A previous TRaSH deployment has an invalid deployment ledger. Resolve or remove that history before changing this ARR endpoint.",
			);
		}
		if (
			typeof rawBackup !== "object" ||
			rawBackup === null ||
			Array.isArray(rawBackup) ||
			!("schemaVersion" in rawBackup) ||
			rawBackup.schemaVersion !== 2
		) {
			// Legacy backups contain no pending ledger and do not block new work.
			continue;
		}
		let state: DeploymentBackupState;
		try {
			state = parseDeploymentBackupState(row.backup.backupData);
		} catch {
			throw new AppValidationError(
				"A previous TRaSH deployment has an invalid deployment ledger. Resolve or remove that history before changing this ARR endpoint.",
			);
		}
		if (hasPendingDeploymentMutation(state)) {
			throw new AppValidationError(
				"A previous TRaSH deployment has an uncertain upstream result. Resolve or roll back that operation before changing this ARR endpoint.",
			);
		}
	}
}

/** Block connection replacement while an exact rollback ledger still owns upstream state. */
export async function assertNoActiveDeploymentOwnership(
	prisma: PrismaClient,
	userId: string,
	instanceIds: string[],
): Promise<void> {
	const [syncRows, deploymentRows] = await Promise.all([
		prisma.trashSyncHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
			},
			select: {
				status: true,
				backupId: true,
				backup: { select: { id: true, backupData: true } },
			},
		}),
		prisma.templateDeploymentHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
			},
			select: {
				status: true,
				backupId: true,
				backup: { select: { id: true, backupData: true } },
			},
		}),
	]);
	const seen = new Set<string>();
	for (const row of [...syncRows, ...deploymentRows]) {
		if (!row.backup) {
			throw new ConflictError(
				"This ARR connection has active deployment ownership without verifiable rollback data. Resolve that history before changing the connection.",
			);
		}
		if (seen.has(row.backup.id)) continue;
		seen.add(row.backup.id);
		let state: DeploymentBackupState;
		try {
			state = parseDeploymentBackupState(row.backup.backupData);
		} catch {
			throw new ConflictError(
				"This ARR connection has active deployment ownership with legacy or invalid rollback data. Resolve that history before changing the connection.",
			);
		}
		if (
			state.customFormatDeployments.length > 0 ||
			state.qualityProfileDeployment.status !== "not_started" ||
			(state.namingDeployment && state.namingDeployment.status !== "not_started") ||
			state.managedCustomFormatsCaptured
		) {
			throw new ConflictError(
				"This ARR connection has active deployment ownership. Roll back or undeploy it before changing the connection.",
			);
		}
	}
}

/** Reclassify records left in a transient state by a previous process interruption. */
export async function reconcileInterruptedDeploymentHistories(
	prisma: PrismaClient,
): Promise<number> {
	if (typeof prisma.templateDeploymentHistory?.findMany !== "function") return 0;
	const interruptedDeployments = await prisma.templateDeploymentHistory.findMany({
		where: { OR: [{ status: "IN_PROGRESS" }, { undeployStatus: "IN_PROGRESS" }] },
		select: {
			id: true,
			backupId: true,
			status: true,
			undeployStatus: true,
			backup: { select: { backupData: true } },
		},
	});
	const interruptedSyncs =
		typeof prisma.trashSyncHistory?.findMany === "function"
			? await prisma.trashSyncHistory.findMany({
					where: {
						OR: [{ status: { in: ["IN_PROGRESS", "RUNNING"] } }, { rollbackStatus: "IN_PROGRESS" }],
					},
					select: {
						id: true,
						backupId: true,
						status: true,
						rollbackStatus: true,
						backup: { select: { backupData: true } },
					},
				})
			: [];

	type Reconciliation = {
		status: "FAILED" | "UNCERTAIN";
		message: string;
		appliedCFCount?: number;
		appliedConfigs?: Array<Record<string, unknown>>;
	};
	const classify = (backup: { backupData: string } | null): Reconciliation => {
		let pending = false;
		if (!backup) {
			return {
				status: "UNCERTAIN",
				message:
					"The application restarted before deployment history could be finalized, so the upstream result is uncertain. Resolve the upstream ARR state before retrying.",
			};
		}

		let state: DeploymentBackupState;
		try {
			state = parseDeploymentBackupState(backup.backupData);
			pending = hasPendingDeploymentMutation(state);
		} catch {
			return {
				status: "UNCERTAIN",
				message:
					"The application restarted with deployment history that could not be reconstructed exactly, so the upstream result is uncertain. Resolve the upstream ARR state before retrying.",
			};
		}

		const message = pending
			? "The application restarted while an upstream deployment result was uncertain. Rollback or manual resolution is required before another deployment."
			: "The application restarted before deployment history could be finalized. Review the upstream ARR state before retrying.";
		const appliedCustomFormats = state.customFormatDeployments.filter(
			(item) =>
				item.status === "applied" ||
				(item.status === "pending" &&
					item.action === "created" &&
					item.resourceId !== null &&
					item.postStateToken !== null),
		);
		const appliedConfigs: Array<Record<string, unknown>> = appliedCustomFormats.map((item) => ({
			name: item.name,
			action: item.action,
			type: "custom_format",
		}));
		const profile = state.qualityProfileDeployment;
		const hasDurablyProvenPendingProfile =
			profile.status === "pending" &&
			profile.profileId !== null &&
			profile.profileName !== null &&
			profile.postStateToken !== null;
		if (profile.status === "applied" || hasDurablyProvenPendingProfile) {
			if (profile.profileId === null || profile.profileName === null) {
				if (!pending) {
					return {
						status: "FAILED",
						message:
							"The application restarted with applied deployment details that could not be reconstructed exactly. Review the upstream ARR state before retrying.",
					};
				}
			} else {
				appliedConfigs.push({
					name: profile.profileName,
					action: profile.action,
					type: "quality_profile",
					id: profile.profileId,
				});
			}
		}
		if (state.namingDeployment?.status === "applied") {
			appliedConfigs.push({
				name: "Naming configuration",
				action: "updated",
				type: "naming",
			});
		}
		if (pending) {
			return {
				status: "UNCERTAIN",
				message,
				appliedCFCount: appliedCustomFormats.length,
				appliedConfigs,
			};
		}
		if (appliedConfigs.length === 0) {
			return { status: "FAILED", message };
		}
		return {
			status: "UNCERTAIN",
			message:
				"The application restarted after upstream changes were applied but before deployment authority could be finalized. Resolve or roll back this deployment before making further changes.",
			appliedCFCount: appliedCustomFormats.length,
			appliedConfigs,
		};
	};

	let reconciled = 0;
	const reconciledBackupIds = new Set<string>();
	for (const history of interruptedDeployments) {
		if (history.undeployStatus === "IN_PROGRESS") {
			const result = await prisma.templateDeploymentHistory.updateMany({
				where: { id: history.id, undeployStatus: "IN_PROGRESS" },
				data: { undeployStatus: "PARTIAL" },
			});
			if (result.count === 1) reconciled++;
			continue;
		}
		const reconciliation = classify(history.backup);
		const { status, message } = reconciliation;
		const appliedAudit = reconciliation.appliedConfigs
			? {
					appliedCFs: reconciliation.appliedCFCount ?? 0,
					appliedConfigs: JSON.stringify(reconciliation.appliedConfigs),
				}
			: {};
		const syncAppliedAudit = reconciliation.appliedConfigs
			? {
					configsApplied: reconciliation.appliedConfigs.length,
					configsFailed: status === "UNCERTAIN" ? 0 : 1,
					appliedConfigs: JSON.stringify(reconciliation.appliedConfigs),
				}
			: {};
		const primaryReconciled = await prisma.$transaction(async (tx) => {
			const primary = await tx.templateDeploymentHistory.updateMany({
				where: { id: history.id, status: "IN_PROGRESS" },
				data: { status, errors: JSON.stringify([message]), ...appliedAudit },
			});
			if (primary.count !== 1) return false;
			if (history.backupId) {
				await tx.trashSyncHistory.updateMany({
					where: {
						backupId: history.backupId,
						status: { in: ["IN_PROGRESS", "RUNNING"] },
					},
					data: {
						status,
						completedAt: new Date(),
						errorLog: message,
						...syncAppliedAudit,
					},
				});
			}
			return true;
		});
		if (history.backupId) reconciledBackupIds.add(history.backupId);
		if (primaryReconciled) {
			reconciled++;
		}
	}

	for (const history of interruptedSyncs) {
		if (history.backupId && reconciledBackupIds.has(history.backupId)) continue;
		if (history.rollbackStatus === "IN_PROGRESS") {
			const result = await prisma.trashSyncHistory.updateMany({
				where: { id: history.id, rollbackStatus: "IN_PROGRESS" },
				data: { rollbackStatus: "PARTIAL" },
			});
			if (result.count === 1) reconciled++;
			continue;
		}
		const reconciliation = classify(history.backup);
		const { status, message } = reconciliation;
		const appliedAudit = reconciliation.appliedConfigs
			? {
					configsApplied: reconciliation.appliedConfigs.length,
					configsFailed: status === "UNCERTAIN" ? 0 : 1,
					appliedConfigs: JSON.stringify(reconciliation.appliedConfigs),
				}
			: {};
		const result = await prisma.trashSyncHistory.updateMany({
			where: { id: history.id, status: { in: ["IN_PROGRESS", "RUNNING"] } },
			data: { status, completedAt: new Date(), errorLog: message, ...appliedAudit },
		});
		if (result.count === 1) reconciled++;
	}
	return reconciled;
}
