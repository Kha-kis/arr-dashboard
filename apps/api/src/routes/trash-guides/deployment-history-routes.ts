/**
 * TRaSH Guides Deployment History Routes
 *
 * API endpoints for retrieving deployment history.
 */

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyPluginAsync } from "fastify";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { isNonterminalUndeploy } from "../../lib/backup/backup-validation.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-executor.js";
import {
	assertSharedDeploymentRestorationAllowed,
	assertSharedDeploymentState,
	getExpectedSharedDeploymentStateToken,
	resolveActiveDeploymentOwnership,
} from "../../lib/trash-guides/deployment-active-ownership.js";
import {
	type DeploymentBackupState,
	parseDeploymentBackupState,
} from "../../lib/trash-guides/deployment-backup-state.js";
import { rollbackCustomFormatDeployment } from "../../lib/trash-guides/deployment-custom-format-state.js";
import { restoreNamingDeployment } from "../../lib/trash-guides/deployment-naming-state.js";
import { rollbackQualityProfileDeployment } from "../../lib/trash-guides/deployment-profile-state.js";
import {
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
	getEquivalentServiceInstanceIds,
	isDeploymentBackupEndpointIdentityCurrent,
} from "../../lib/trash-guides/deployment-target.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";

interface UndeployStep {
	key: string;
	kind: "quality_profile" | "custom_format" | "naming";
	name: string;
	outcome: "restored" | "deleted" | "already_reversed" | "skipped_shared" | "failed";
	error?: string;
}

function parseUndeployProgress(value: string | null): UndeployStep[] {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("Undeploy progress is not an array.");
	return parsed.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof Reflect.get(item, "key") !== "string" ||
			typeof Reflect.get(item, "kind") !== "string" ||
			typeof Reflect.get(item, "name") !== "string" ||
			typeof Reflect.get(item, "outcome") !== "string"
		) {
			throw new Error("Undeploy progress contains an invalid step.");
		}
		return item as UndeployStep;
	});
}

// ============================================================================
// Route Handlers
// ============================================================================

export const deploymentHistoryRoutes: FastifyPluginAsync = async (app) => {
	/**
	 * GET /api/trash-guides/deployment/history
	 * Get all deployment history (global view)
	 */
	app.get<{
		Querystring: { limit?: number; offset?: number };
	}>("/history", async (request, reply) => {
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		// Get all deployment history for templates belonging to the user
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				template: {
					userId: request.currentUser!.id, // preHandler guarantees authentication
				},
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
				template: {
					select: {
						id: true,
						name: true,
						serviceType: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: {
				template: {
					userId: request.currentUser!.id, // preHandler guarantees authentication
				},
			},
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/template/:templateId
	 * Get deployment history for a specific template
	 */
	app.get<{
		Params: { templateId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/template/:templateId", async (request, reply) => {
		const { templateId } = request.params;
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		// Verify template belongs to user
		const template = await app.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId: request.currentUser!.id, // preHandler guarantees authentication
			},
		});

		if (!template) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Template not found",
			});
		}

		// Get deployment history
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				templateId,
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: { templateId },
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/instance/:instanceId
	 * Get deployment history for a specific instance
	 */
	app.get<{
		Params: { instanceId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/instance/:instanceId", async (request, reply) => {
		const { instanceId } = request.params;
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		await requireInstance(app, request.currentUser!.id, instanceId);

		// Get deployment history
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				instanceId,
			},
			include: {
				template: {
					select: {
						id: true,
						name: true,
						serviceType: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: { instanceId },
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/:historyId
	 * Get detailed information for a specific deployment
	 */
	app.get<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		const { historyId } = request.params;
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history with all relations - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
				template: {
					select: {
						id: true,
						name: true,
						description: true,
						serviceType: true,
						userId: true,
					},
				},
				backup: {
					select: {
						id: true,
						createdAt: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		// Parse JSON fields for detailed information
		let appliedConfigs: unknown[] = [];
		let failedConfigs: unknown[] = [];
		let undeployProgress: UndeployStep[] | null = null;
		try {
			appliedConfigs = history.appliedConfigs ? JSON.parse(history.appliedConfigs) : [];
		} catch {
			app.log.warn({ historyId: history.id }, "Failed to parse appliedConfigs JSON");
		}
		try {
			failedConfigs = history.failedConfigs ? JSON.parse(history.failedConfigs) : [];
		} catch {
			app.log.warn({ historyId: history.id }, "Failed to parse failedConfigs JSON");
		}
		try {
			undeployProgress = history.undeployProgress
				? parseUndeployProgress(history.undeployProgress)
				: null;
		} catch {
			app.log.warn({ historyId: history.id }, "Failed to parse undeployProgress JSON");
		}

		return reply.send({
			success: true,
			data: {
				...history,
				appliedConfigs,
				failedConfigs,
				undeployProgress,
			},
		});
	});

	/**
	 * DELETE /api/trash-guides/deployment/history/:historyId
	 * Delete a deployment history entry
	 */
	app.delete<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		const { historyId } = request.params;

		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				template: {
					select: {
						userId: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		if (isNonterminalUndeploy(history)) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message:
					"Complete or explicitly resolve the undeploy before deleting its deployment history.",
			});
		}

		// Delete only if ownership and terminal undeploy state still match at mutation time.
		// Note: Associated backup will be cascade deleted if configured, otherwise it remains.
		const deletion = await app.prisma.templateDeploymentHistory.deleteMany({
			where: {
				id: historyId,
				userId,
				OR: [
					{ rolledBack: true },
					{ undeployStatus: "COMPLETED" },
					{
						undeployStatus: null,
						NOT: { status: "PARTIAL_UNDEPLOY" },
					},
				],
			},
		});

		if (deletion.count !== 1) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message:
					"Complete or explicitly resolve the undeploy before deleting its deployment history.",
			});
		}

		return reply.send({
			success: true,
			message: "Deployment history deleted successfully",
		});
	});

	/**
	 * POST /api/trash-guides/deployment/history/:historyId/undeploy
	 * Reverse the exact profile, Custom Format, and naming mutations made by this deployment.
	 * Shared resources are retained, and durable progress makes partial retries safe.
	 */
	app.post<{
		Params: { historyId: string };
	}>("/history/:historyId/undeploy", async (request, reply) => {
		const { historyId } = request.params;
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history with template config - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				instance: true,
				backup: true,
				template: {
					select: {
						id: true,
						name: true,
						userId: true,
						configData: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		// Check if already undeployed
		if (history.rolledBack) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "This deployment has already been undeployed",
			});
		}

		if (!history.backup) {
			return reply.status(409).send({
				success: false,
				message:
					"This legacy deployment has no identity-bound backup and cannot be undeployed safely.",
			});
		}

		const undeployAttemptedAt = new Date();
		const claim = await app.prisma.templateDeploymentHistory.updateMany({
			where: {
				id: historyId,
				userId,
				rolledBack: false,
				OR: [{ undeployStatus: null }, { undeployStatus: "PARTIAL" }],
			},
			data: {
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt,
			},
		});
		if (claim.count !== 1) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message: "An undeploy is already active or requires explicit recovery resolution.",
			});
		}

		const persistPartialUndeploy = async () => {
			const result = await app.prisma.templateDeploymentHistory.updateMany({
				where: {
					id: historyId,
					userId,
					rolledBack: false,
					undeployStatus: "IN_PROGRESS",
					undeployAttemptedAt,
				},
				data: {
					status: "PARTIAL_UNDEPLOY",
					undeployStatus: "PARTIAL",
				},
			});
			if (result.count !== 1) {
				throw new Error("Undeploy recovery state changed before progress could be persisted");
			}
		};
		const stopClaimedUndeploy = async (statusCode: number, payload: Record<string, unknown>) => {
			await persistPartialUndeploy();
			return reply.status(statusCode).send(payload);
		};
		let upstreamMutationAttempted = false;

		return withCleanupTopologyMutationLease({ prisma: app.prisma, log: request.log }, userId, () =>
			app.deploymentExecutor.runWithEndpointMutation(
				userId,
				history.instance,
				"Undeploy",
				async (endpointKey) => {
					const history = await app.prisma.templateDeploymentHistory.findFirst({
						where: { id: historyId, userId },
						include: {
							instance: true,
							backup: true,
							template: {
								select: {
									id: true,
									name: true,
									userId: true,
									configData: true,
								},
							},
						},
					});
					if (!history) {
						return reply.status(404).send({
							statusCode: 404,
							error: "NotFound",
							message: "Deployment history not found",
						});
					}
					if (history.rolledBack) {
						return reply.status(400).send({
							statusCode: 400,
							error: "BadRequest",
							message: "This deployment has already been undeployed",
						});
					}
					if (!history.backup) {
						return stopClaimedUndeploy(409, {
							success: false,
							message:
								"This legacy deployment has no identity-bound backup and cannot be undeployed safely.",
						});
					}
					const deploymentBackup = history.backup;
					const currentInstance = await app.prisma.serviceInstance.findFirst({
						where: { id: history.instanceId, userId },
					});
					const currentCredentialIdentity = currentInstance
						? app.arrClientFactory.createConnectionCredentialIdentity(currentInstance)
						: null;
					if (
						!currentInstance ||
						createDeploymentEndpointKey(userId, {
							service: currentInstance.service,
							baseUrl: currentInstance.baseUrl,
							credentialIdentity: currentCredentialIdentity!,
						}) !== endpointKey
					) {
						return stopClaimedUndeploy(409, {
							success: false,
							message: "The ARR service connection changed while undeploy was starting.",
						});
					}

					let backupState: DeploymentBackupState;
					try {
						backupState = parseDeploymentBackupState(deploymentBackup.backupData);
					} catch (error) {
						request.log.warn({ err: error, historyId }, "Unsafe undeploy backup rejected");
						return stopClaimedUndeploy(409, {
							success: false,
							message:
								"This deployment backup is legacy or incomplete and cannot be undeployed safely.",
						});
					}
					if (
						!isDeploymentBackupEndpointIdentityCurrent({
							userId,
							backupEndpointKey: backupState.endpointKey,
							backupConnectionStateToken: backupState.connectionStateToken,
							instance: currentInstance,
							credentialIdentity: currentCredentialIdentity!,
						})
					) {
						return stopClaimedUndeploy(409, {
							success: false,
							message: "The deployment backup is not bound to this ARR service connection.",
						});
					}

					const aliases = await app.prisma.serviceInstance.findMany({
						where: { userId, service: currentInstance.service },
					});
					const credentialIdentity =
						app.arrClientFactory.createConnectionCredentialIdentity(currentInstance);
					const equivalentInstanceIds = getEquivalentServiceInstanceIds(
						aliases.map((alias) => ({
							...alias,
							credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(alias),
						})),
						{ ...currentInstance, credentialIdentity },
					);
					const ownership = await resolveActiveDeploymentOwnership(
						app.prisma,
						userId,
						equivalentInstanceIds,
						{ backupId: deploymentBackup.id, templateId: history.templateId },
					);

					const client = app.arrClientFactory.create(currentInstance) as
						| SonarrClient
						| RadarrClient;
					await client.system.get();
					let existingProgress: UndeployStep[];
					try {
						existingProgress = parseUndeployProgress(history.undeployProgress);
					} catch (error) {
						request.log.warn({ err: error, historyId }, "Invalid undeploy progress rejected");
						return stopClaimedUndeploy(409, {
							success: false,
							message: "The saved undeploy progress is invalid, so no upstream changes were made.",
						});
					}
					const stepByKey = new Map(existingProgress.map((step) => [step.key, step]));
					const attemptedAt = undeployAttemptedAt;
					const setStep = (step: UndeployStep): void => {
						stepByKey.set(step.key, step);
					};
					const persistProgress = async (undeployStatus: "IN_PROGRESS" | "PARTIAL") => {
						const progress = [...stepByKey.values()];
						const progressJson = JSON.stringify(progress);
						await app.prisma.$transaction(async (tx) => {
							await tx.templateDeploymentHistory.update({
								where: { id: historyId },
								data: {
									undeployStatus,
									undeployAttemptedAt: attemptedAt,
									undeployProgress: progressJson,
								},
							});
							if (history.backupId) {
								await tx.trashSyncHistory.updateMany({
									where: { backupId: history.backupId, userId },
									data: {
										rollbackStatus: undeployStatus,
										rollbackAttemptedAt: attemptedAt,
										rollbackProgress: progressJson,
									},
								});
							}
						});
					};
					const isFinished = (key: string): boolean => {
						const outcome = stepByKey.get(key)?.outcome;
						return (
							outcome === "restored" ||
							outcome === "deleted" ||
							outcome === "already_reversed" ||
							outcome === "skipped_shared"
						);
					};

					// Write intent before the first upstream mutation. An interrupted attempt is
					// reconciled to PARTIAL on startup and blocks competing mutations.
					await persistProgress("IN_PROGRESS");
					let stopAfterProfileFailure = false;
					const profileState = backupState.qualityProfileDeployment;
					const profileStatus = profileState.status;
					if (profileStatus !== "not_started") {
						const key = `quality_profile:${profileState.profileId ?? profileState.profileName ?? "unknown"}`;
						if (!isFinished(key)) {
							if (
								profileState.profileId !== null &&
								ownership.sharedQualityProfileIds.has(profileState.profileId)
							) {
								try {
									const currentProfile = await client.qualityProfile.getById(
										profileState.profileId,
									);
									const resourceLabel = `quality profile "${profileState.profileName ?? profileState.profileId}"`;
									const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
										ownership.sharedQualityProfileStateTokens.get(profileState.profileId),
										resourceLabel,
									);
									if (createQualityProfileStateToken(currentProfile) === expectedSurvivorToken) {
										setStep({
											key,
											kind: "quality_profile",
											name: profileState.profileName ?? "Quality profile",
											outcome: "skipped_shared",
										});
									} else {
										assertSharedDeploymentRestorationAllowed(
											ownership.restorableSharedQualityProfileIds.has(profileState.profileId),
											resourceLabel,
										);
										if (profileState.action === "created") {
											throw new Error(
												`${resourceLabel} is shared, but this deployment has no prior state from which to restore the surviving deployment state.`,
											);
										}
										if (!profileState.beforeProfile) {
											throw new Error(`${resourceLabel} has no prior state to verify.`);
										}
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createQualityProfileStateToken(profileState.beforeProfile),
											resourceLabel,
										);
										upstreamMutationAttempted = true;
										await rollbackQualityProfileDeployment(client, {
											...profileState,
											status: profileStatus,
										});
										const restoredProfile = await client.qualityProfile.getById(
											profileState.profileId,
										);
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createQualityProfileStateToken(restoredProfile),
											resourceLabel,
										);
										setStep({
											key,
											kind: "quality_profile",
											name: profileState.profileName ?? "Quality profile",
											outcome: "restored",
										});
									}
								} catch (error) {
									const message = `Failed to verify shared quality profile: ${getErrorMessage(error)}`;
									setStep({
										key,
										kind: "quality_profile",
										name: profileState.profileName ?? "Quality profile",
										outcome: "failed",
										error: message,
									});
									stopAfterProfileFailure = true;
								}
							} else {
								try {
									upstreamMutationAttempted = true;
									await rollbackQualityProfileDeployment(client, {
										...profileState,
										status: profileStatus,
									});
									setStep({
										key,
										kind: "quality_profile",
										name: profileState.profileName ?? "Quality profile",
										outcome: "restored",
									});
								} catch (error) {
									const message = `Failed to restore quality profile: ${getErrorMessage(error)}`;
									setStep({
										key,
										kind: "quality_profile",
										name: profileState.profileName ?? "Quality profile",
										outcome: "failed",
										error: message,
									});
									stopAfterProfileFailure = true;
								}
							}
							await persistProgress("IN_PROGRESS");
						}
					}

					for (const state of stopAfterProfileFailure ? [] : backupState.customFormatDeployments) {
						const key = `custom_format:${state.resourceId ?? state.name}`;
						if (isFinished(key)) continue;
						if (
							state.resourceId !== null &&
							ownership.sharedCustomFormatIds.has(state.resourceId)
						) {
							try {
								const currentFormat = await client.customFormat.getById(state.resourceId);
								const resourceLabel = `Custom Format "${state.name}"`;
								const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
									ownership.sharedCustomFormatStateTokens.get(state.resourceId),
									resourceLabel,
								);
								if (createUpstreamResourceStateToken(currentFormat) === expectedSurvivorToken) {
									setStep({
										key,
										kind: "custom_format",
										name: state.name,
										outcome: "skipped_shared",
									});
								} else {
									assertSharedDeploymentRestorationAllowed(
										ownership.restorableSharedCustomFormatIds.has(state.resourceId),
										resourceLabel,
									);
									if (state.action === "created") {
										throw new Error(
											`${resourceLabel} is shared, but this deployment has no prior state from which to restore the surviving deployment state.`,
										);
									}
									if (!state.beforeFormat) {
										throw new Error(`${resourceLabel} has no prior state to verify.`);
									}
									assertSharedDeploymentState(
										new Set([expectedSurvivorToken]),
										createUpstreamResourceStateToken(state.beforeFormat),
										resourceLabel,
									);
									upstreamMutationAttempted = true;
									await rollbackCustomFormatDeployment(client, state);
									const restoredFormat = await client.customFormat.getById(state.resourceId);
									assertSharedDeploymentState(
										new Set([expectedSurvivorToken]),
										createUpstreamResourceStateToken(restoredFormat),
										resourceLabel,
									);
									setStep({
										key,
										kind: "custom_format",
										name: state.name,
										outcome: "restored",
									});
								}
							} catch (error) {
								const message = `Failed to verify shared Custom Format "${state.name}": ${getErrorMessage(error)}`;
								setStep({
									key,
									kind: "custom_format",
									name: state.name,
									outcome: "failed",
									error: message,
								});
							}
							await persistProgress("IN_PROGRESS");
							continue;
						}
						try {
							upstreamMutationAttempted = true;
							const result = await rollbackCustomFormatDeployment(client, state);
							setStep({
								key,
								kind: "custom_format",
								name: state.name,
								outcome: result === "noop" ? "already_reversed" : result,
							});
						} catch (error) {
							const message = `Failed to undeploy "${state.name}": ${getErrorMessage(error)}`;
							setStep({
								key,
								kind: "custom_format",
								name: state.name,
								outcome: "failed",
								error: message,
							});
						}
						await persistProgress("IN_PROGRESS");
					}

					const namingState = backupState.namingDeployment;
					if (namingState && namingState.status !== "not_started" && !stopAfterProfileFailure) {
						const key = "naming:configuration";
						const rollbackNamingStateToken =
							namingState.postStateToken ??
							(namingState.status === "pending" ? namingState.intendedPostStateToken : null);
						if (!isFinished(key)) {
							if (ownership.namingOwnedByAnotherDeployment) {
								try {
									const currentResponse = await app.arrClientFactory.rawRequest(
										currentInstance,
										"/api/v3/config/naming",
									);
									if (!currentResponse.ok) {
										throw new Error(`HTTP ${currentResponse.status}`);
									}
									const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
									const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
										ownership.sharedNamingStateTokens,
										"naming configuration",
									);
									if (createUpstreamResourceStateToken(currentConfig) === expectedSurvivorToken) {
										setStep({
											key,
											kind: "naming",
											name: "Naming configuration",
											outcome: "skipped_shared",
										});
									} else {
										assertSharedDeploymentRestorationAllowed(
											ownership.sharedNamingRestorationAllowed,
											"naming configuration",
										);
										if (!rollbackNamingStateToken) {
											throw new Error("The deployment has no verifiable naming post-state.");
										}
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createUpstreamResourceStateToken(namingState.beforeConfig),
											"naming configuration",
										);
										upstreamMutationAttempted = true;
										await restoreNamingDeployment(
											app.arrClientFactory,
											currentInstance,
											namingState.beforeConfig,
											rollbackNamingStateToken,
										);
										const restoredResponse = await app.arrClientFactory.rawRequest(
											currentInstance,
											"/api/v3/config/naming",
										);
										if (!restoredResponse.ok) {
											throw new Error(`HTTP ${restoredResponse.status}`);
										}
										const restoredConfig = (await restoredResponse.json()) as Record<
											string,
											unknown
										>;
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createUpstreamResourceStateToken(restoredConfig),
											"naming configuration",
										);
										setStep({
											key,
											kind: "naming",
											name: "Naming configuration",
											outcome: "restored",
										});
									}
								} catch (error) {
									const message = `Failed to verify shared naming configuration: ${getErrorMessage(error)}`;
									setStep({
										key,
										kind: "naming",
										name: "Naming configuration",
										outcome: "failed",
										error: message,
									});
								}
							} else if (!rollbackNamingStateToken) {
								const message =
									"Naming may have changed, but its post-deployment state was not verified.";
								setStep({
									key,
									kind: "naming",
									name: "Naming configuration",
									outcome: "failed",
									error: message,
								});
							} else {
								try {
									upstreamMutationAttempted = true;
									await restoreNamingDeployment(
										app.arrClientFactory,
										currentInstance,
										namingState.beforeConfig,
										rollbackNamingStateToken,
									);
									setStep({
										key,
										kind: "naming",
										name: "Naming configuration",
										outcome: "restored",
									});
								} catch (error) {
									const message = `Failed to restore naming configuration: ${getErrorMessage(error)}`;
									setStep({
										key,
										kind: "naming",
										name: "Naming configuration",
										outcome: "failed",
										error: message,
									});
								}
							}
							await persistProgress("IN_PROGRESS");
						}
					}

					const progress = [...stepByKey.values()];
					const errors = progress.flatMap((step) =>
						step.outcome === "failed" && step.error ? [step.error] : [],
					);
					const deletedCFs = progress
						.filter((step) => step.kind === "custom_format" && step.outcome === "deleted")
						.map((step) => step.name);
					const restoredCFs = progress
						.filter((step) => step.kind === "custom_format" && step.outcome === "restored")
						.map((step) => step.name);
					const skippedShared = progress
						.filter((step) => step.outcome === "skipped_shared")
						.map((step) => step.name);

					if (errors.length === 0) {
						const now = new Date();
						await app.prisma.$transaction(async (tx) => {
							await tx.templateDeploymentHistory.update({
								where: { id: historyId },
								data: {
									rolledBack: true,
									rolledBackAt: now,
									rolledBackBy: userId,
									undeployStatus: "COMPLETED",
									undeployAttemptedAt: attemptedAt,
									undeployProgress: JSON.stringify(progress),
								},
							});
							if (history.backupId) {
								await tx.trashSyncHistory.updateMany({
									where: { backupId: history.backupId, userId },
									data: {
										rolledBack: true,
										rolledBackAt: now,
										rollbackStatus: "COMPLETED",
										rollbackAttemptedAt: attemptedAt,
										rollbackProgress: JSON.stringify(progress),
									},
								});
							}
						});
					} else {
						await persistProgress("PARTIAL");
						if (history.backupId) {
							await app.prisma.trashSyncHistory.updateMany({
								where: { backupId: history.backupId, userId },
								data: {
									rollbackStatus: "PARTIAL",
									rollbackAttemptedAt: attemptedAt,
									rollbackProgress: JSON.stringify(progress),
								},
							});
						}
					}
					return reply.send({
						success: errors.length === 0,
						message:
							errors.length === 0
								? "Deployment changes were reversed using exact upstream identities."
								: "Undeploy completed with errors; it remains retryable.",
						data: {
							deleted: deletedCFs.length,
							deletedCFs,
							restoredCFs,
							skippedShared,
							errors,
						},
					});
				},
			),
		).catch(async (error) => {
			const message = getErrorMessage(error, "Undeploy failed");
			try {
				await persistPartialUndeploy();
			} catch (stateError) {
				request.log.error(
					{ err: stateError, historyId, undeployAttemptedAt },
					"Failed to persist undeploy failure state",
				);
			}
			request.log.error({ err: error, historyId }, "Deployment undeploy failed");
			const statusCode =
				error &&
				typeof error === "object" &&
				"statusCode" in error &&
				typeof error.statusCode === "number"
					? error.statusCode
					: 500;
			return reply.status(upstreamMutationAttempted ? 207 : statusCode).send({
				success: false,
				message: upstreamMutationAttempted
					? "ARR changes may have completed, but recovery state could not be finalized. The undeploy remains retryable."
					: message,
			});
		});
	});
};
