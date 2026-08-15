import { ConflictError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";
import {
	type DeploymentBackupState,
	parseDeploymentBackupState,
} from "./deployment-backup-state.js";
import {
	isLegacyTerminalSyncHistory,
	isManuallyResolvedSyncHistory,
} from "./deployment-recovery-state.js";
import {
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
} from "./deployment-target.js";

const ACTIVE_STATUSES = new Set([
	"SUCCESS",
	"PARTIAL_SUCCESS",
	"UNCERTAIN",
	"PARTIAL_UNDEPLOY",
	"IN_PROGRESS",
	"RUNNING",
]);

interface OwnershipCandidate {
	backupId: string;
	templateId: string;
	startedAt: Date;
	active: boolean;
	state: DeploymentBackupState | null;
}

export interface ActiveDeploymentOwnership {
	sharedCustomFormatIds: Set<number>;
	sharedQualityProfileIds: Set<number>;
	namingOwnedByAnotherDeployment: boolean;
	restorableSharedCustomFormatIds: Set<number>;
	restorableSharedQualityProfileIds: Set<number>;
	sharedNamingRestorationAllowed: boolean;
	sharedCustomFormatStateTokens: Map<number, Set<string>>;
	sharedQualityProfileStateTokens: Map<number, Set<string>>;
	sharedNamingStateTokens: Set<string>;
}

interface ResourceStateOwner {
	backupId: string;
	startedAt: Date;
	token: string;
}

function targetCanRestoreSharedResource(
	target: OwnershipCandidate,
	survivor: ResourceStateOwner | undefined,
	targetBeforeStateToken: string | undefined,
	resourceLabel: string,
): boolean {
	if (!survivor) return false;
	const timeDifference = target.startedAt.getTime() - survivor.startedAt.getTime();
	if (timeDifference === 0) {
		throw new ConflictError(
			`The target and a surviving deployment changed ${resourceLabel} at the same deployment time, so it was not changed.`,
		);
	}
	return timeDifference > 0 && targetBeforeStateToken === survivor.token;
}

/** Prevent an older deployment snapshot from overwriting a newer survivor. */
export function assertSharedDeploymentRestorationAllowed(
	isAllowed: boolean,
	resourceLabel: string,
): void {
	if (!isAllowed) {
		throw new ConflictError(
			`A newer surviving deployment changed ${resourceLabel}, so the older target cannot restore it safely.`,
		);
	}
}

function retainNewestResourceOwner<K>(
	owners: Map<K, ResourceStateOwner>,
	resourceId: K,
	candidate: OwnershipCandidate,
	token: string,
	resourceLabel: string,
): void {
	const existing = owners.get(resourceId);
	if (!existing) {
		owners.set(resourceId, {
			backupId: candidate.backupId,
			startedAt: candidate.startedAt,
			token,
		});
		return;
	}
	if (existing.backupId === candidate.backupId) {
		if (existing.token !== token) {
			throw new ConflictError(
				`One surviving deployment recorded conflicting states for ${resourceLabel}, so it was not changed.`,
			);
		}
		return;
	}
	const timeDifference = candidate.startedAt.getTime() - existing.startedAt.getTime();
	if (timeDifference === 0) {
		throw new ConflictError(
			`Multiple surviving deployments changed ${resourceLabel} at the same deployment time, so it was not changed.`,
		);
	}
	if (timeDifference > 0) {
		owners.set(resourceId, {
			backupId: candidate.backupId,
			startedAt: candidate.startedAt,
			token,
		});
	}
}

/** Prove that a skipped shared resource still matches every surviving owner. */
export function assertSharedDeploymentState(
	expectedStateTokens: ReadonlySet<string> | undefined,
	currentStateToken: string,
	resourceLabel: string,
): void {
	const expectedStateToken = getExpectedSharedDeploymentStateToken(
		expectedStateTokens,
		resourceLabel,
	);
	if (expectedStateToken !== currentStateToken) {
		throw new ConflictError(
			`The current ${resourceLabel} does not match the surviving deployment state, so it was not changed.`,
		);
	}
}

/** Resolve the one state all surviving owners agree must remain active. */
export function getExpectedSharedDeploymentStateToken(
	expectedStateTokens: ReadonlySet<string> | undefined,
	resourceLabel: string,
): string {
	if (!expectedStateTokens || expectedStateTokens.size === 0) {
		throw new ConflictError(
			`The surviving deployment state for ${resourceLabel} is unavailable, so it was not changed.`,
		);
	}
	if (expectedStateTokens.size !== 1) {
		throw new ConflictError(
			`Surviving deployments disagree about the expected state of ${resourceLabel}, so it was not changed.`,
		);
	}
	return expectedStateTokens.values().next().value!;
}

function ledgerHasMutation(state: DeploymentBackupState): boolean {
	return (
		state.customFormatDeployments.length > 0 ||
		state.qualityProfileDeployment.status !== "not_started" ||
		state.namingDeployment?.status !== "not_started" ||
		state.managedCustomFormatsCaptured
	);
}

/**
 * Resolve the latest active deployment per template on one physical ARR endpoint.
 * Any incomplete competing ledger blocks rollback/undeploy before an upstream write.
 */
export async function resolveActiveDeploymentOwnership(
	prisma: PrismaClient,
	userId: string,
	instanceIds: string[],
	target: { backupId: string; templateId: string },
): Promise<ActiveDeploymentOwnership> {
	const [deploymentRows, syncRows] = await Promise.all([
		prisma.templateDeploymentHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
			},
			select: {
				templateId: true,
				backupId: true,
				status: true,
				deployedAt: true,
				backup: { select: { backupData: true } },
			},
		}),
		prisma.trashSyncHistory.findMany({
			where: {
				userId,
				instanceId: { in: instanceIds },
				rolledBack: false,
			},
			select: {
				templateId: true,
				backupId: true,
				status: true,
				rolledBack: true,
				rollbackStatus: true,
				startedAt: true,
				backup: { select: { backupData: true } },
			},
		}),
	]);

	const byBackup = new Map<string, OwnershipCandidate>();
	for (const row of [
		...deploymentRows.map((item) => ({ ...item, startedAt: item.deployedAt })),
		...syncRows,
	]) {
		if (isManuallyResolvedSyncHistory(row)) continue;
		if (isLegacyTerminalSyncHistory(row)) continue;
		if (!row.backupId || !row.templateId || !row.backup) {
			throw new ConflictError(
				"An unrolled deployment ownership relation is missing, so this operation was stopped.",
			);
		}
		const existing = byBackup.get(row.backupId);
		if (existing && existing.templateId !== row.templateId) {
			throw new ConflictError(
				"Deployment ownership metadata is inconsistent across paired history records.",
			);
		}
		let state = existing?.state ?? null;
		if (!state) {
			try {
				state = parseDeploymentBackupState(row.backup.backupData);
			} catch {
				throw new ConflictError(
					"An unrolled deployment has legacy or invalid ownership metadata, so this operation was stopped.",
				);
			}
		}
		const active =
			Boolean(existing?.active) ||
			ACTIVE_STATUSES.has(row.status) ||
			Boolean(state && ledgerHasMutation(state)) ||
			row.backupId === target.backupId;
		byBackup.set(row.backupId, {
			backupId: row.backupId,
			templateId: row.templateId,
			startedAt:
				existing && existing.startedAt > row.startedAt ? existing.startedAt : row.startedAt,
			active,
			state,
		});
	}

	const latestByTemplate = new Map<string, OwnershipCandidate>();
	for (const candidate of byBackup.values()) {
		if (!candidate.active) continue;
		const previous = latestByTemplate.get(candidate.templateId);
		if (
			previous &&
			previous.backupId !== candidate.backupId &&
			previous.startedAt.getTime() === candidate.startedAt.getTime()
		) {
			throw new ConflictError(
				"Multiple active deployments of one template have the same deployment time, so ownership is ambiguous and nothing was changed.",
			);
		}
		if (!previous || candidate.startedAt > previous.startedAt) {
			latestByTemplate.set(candidate.templateId, candidate);
		}
	}
	const latestTarget = latestByTemplate.get(target.templateId);
	if (!latestTarget || latestTarget.backupId !== target.backupId) {
		throw new ConflictError(
			"A newer deployment of this template exists on the ARR endpoint. Roll back the latest deployment instead.",
		);
	}

	const sharedCustomFormatIds = new Set<number>();
	const sharedQualityProfileIds = new Set<number>();
	const customFormatOwners = new Map<number, ResourceStateOwner>();
	const qualityProfileOwners = new Map<number, ResourceStateOwner>();
	const namingOwners = new Map<"naming", ResourceStateOwner>();
	let namingOwnedByAnotherDeployment = false;
	for (const candidate of latestByTemplate.values()) {
		if (candidate.backupId === target.backupId) continue;
		if (!candidate.state) {
			throw new ConflictError(
				"Another active deployment has legacy or invalid ownership metadata, so this operation was stopped.",
			);
		}
		if (!candidate.state.managedCustomFormatsCaptured) {
			throw new ConflictError(
				"Another active deployment has incomplete Custom Format ownership metadata, so this operation was stopped.",
			);
		}
		for (const format of candidate.state.managedCustomFormats) {
			sharedCustomFormatIds.add(format.resourceId);
			retainNewestResourceOwner(
				customFormatOwners,
				format.resourceId,
				candidate,
				format.stateToken,
				`Custom Format ${format.resourceId}`,
			);
		}
		for (const mutation of candidate.state.customFormatDeployments) {
			if (mutation.resourceId === null) {
				throw new ConflictError(
					"Another active deployment may have created a Custom Format with an unknown identity, so this operation was stopped.",
				);
			}
			if (mutation.status !== "applied" || !mutation.postStateToken) {
				throw new ConflictError(
					"Another active deployment has no verified Custom Format state, so this operation was stopped.",
				);
			}
			sharedCustomFormatIds.add(mutation.resourceId);
			retainNewestResourceOwner(
				customFormatOwners,
				mutation.resourceId,
				candidate,
				mutation.postStateToken,
				`Custom Format ${mutation.resourceId}`,
			);
		}
		const profile = candidate.state.qualityProfileDeployment;
		if (profile.status !== "not_started") {
			if (profile.profileId === null) {
				throw new ConflictError(
					"Another active deployment may have created a quality profile with an unknown identity, so this operation was stopped.",
				);
			}
			if (profile.status !== "applied" || !profile.postStateToken) {
				throw new ConflictError(
					"Another active deployment has no verified quality-profile state, so this operation was stopped.",
				);
			}
			sharedQualityProfileIds.add(profile.profileId);
			retainNewestResourceOwner(
				qualityProfileOwners,
				profile.profileId,
				candidate,
				profile.postStateToken,
				`quality profile ${profile.profileId}`,
			);
		}
		if (
			candidate.state.namingDeployment &&
			candidate.state.namingDeployment.status !== "not_started"
		) {
			if (
				candidate.state.namingDeployment.status !== "applied" ||
				!candidate.state.namingDeployment.postStateToken
			) {
				throw new ConflictError(
					"Another active deployment has no verified naming state, so this operation was stopped.",
				);
			}
			namingOwnedByAnotherDeployment = true;
			retainNewestResourceOwner(
				namingOwners,
				"naming",
				candidate,
				candidate.state.namingDeployment.postStateToken,
				"naming configuration",
			);
		}
	}
	const sharedCustomFormatStateTokens = new Map(
		[...customFormatOwners].map(([resourceId, owner]) => [resourceId, new Set([owner.token])]),
	);
	const sharedQualityProfileStateTokens = new Map(
		[...qualityProfileOwners].map(([resourceId, owner]) => [resourceId, new Set([owner.token])]),
	);
	const sharedNamingStateTokens = new Set([...namingOwners.values()].map((owner) => owner.token));

	if (!latestTarget.state) {
		throw new ConflictError(
			"The target deployment has legacy or invalid ownership metadata, so this operation was stopped.",
		);
	}
	const targetCustomFormatIds = new Set([
		...latestTarget.state.managedCustomFormats.map((format) => format.resourceId),
		...latestTarget.state.customFormatDeployments.flatMap((mutation) =>
			mutation.resourceId === null ? [] : [mutation.resourceId],
		),
	]);
	const restorableSharedCustomFormatIds = new Set<number>();
	for (const resourceId of targetCustomFormatIds) {
		const targetMutation = latestTarget.state.customFormatDeployments.find(
			(mutation) => mutation.resourceId === resourceId,
		);
		const targetBeforeStateToken = targetMutation?.beforeFormat
			? createUpstreamResourceStateToken(targetMutation.beforeFormat)
			: undefined;
		if (
			targetCanRestoreSharedResource(
				latestTarget,
				customFormatOwners.get(resourceId),
				targetBeforeStateToken,
				`Custom Format ${resourceId}`,
			)
		) {
			restorableSharedCustomFormatIds.add(resourceId);
		}
	}
	const targetProfile = latestTarget.state.qualityProfileDeployment;
	const restorableSharedQualityProfileIds = new Set<number>();
	if (targetProfile.status !== "not_started" && targetProfile.profileId !== null) {
		const targetBeforeStateToken = targetProfile.beforeProfile
			? createQualityProfileStateToken(targetProfile.beforeProfile)
			: undefined;
		if (
			targetCanRestoreSharedResource(
				latestTarget,
				qualityProfileOwners.get(targetProfile.profileId),
				targetBeforeStateToken,
				`quality profile ${targetProfile.profileId}`,
			)
		) {
			restorableSharedQualityProfileIds.add(targetProfile.profileId);
		}
	}
	let sharedNamingRestorationAllowed = false;
	if (
		latestTarget.state.namingDeployment &&
		latestTarget.state.namingDeployment.status !== "not_started"
	) {
		const targetBeforeStateToken = createUpstreamResourceStateToken(
			latestTarget.state.namingDeployment.beforeConfig,
		);
		sharedNamingRestorationAllowed = targetCanRestoreSharedResource(
			latestTarget,
			namingOwners.get("naming"),
			targetBeforeStateToken,
			"naming configuration",
		);
	}

	return {
		sharedCustomFormatIds,
		sharedQualityProfileIds,
		namingOwnedByAnotherDeployment,
		restorableSharedCustomFormatIds,
		restorableSharedQualityProfileIds,
		sharedNamingRestorationAllowed,
		sharedCustomFormatStateTokens,
		sharedQualityProfileStateTokens,
		sharedNamingStateTokens,
	};
}
