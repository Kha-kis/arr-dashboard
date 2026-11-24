/**
 * TRaSH Guides Custom Format API Routes
 *
 * Endpoints for deploying individual custom formats to instances
 * Deploys custom formats directly without affecting quality profiles
 */

import { DEFAULT_TRASH_REPO, type TrashRepoConfig } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireEnabledInstance } from "../../lib/arr/instance-helpers.js";
import { ConflictError } from "../../lib/errors.js";
import { withRenewableCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-executor.js";
import {
	buildCustomFormatIdentityIndex,
	extractTrashId,
} from "../../lib/trash-guides/cf-field-utils.js";
import {
	createIntendedCustomFormatPostStateToken,
	matchesIntendedCustomFormatPostStateToken,
} from "../../lib/trash-guides/deployment-custom-format-state.js";
import { assertNoPendingDeploymentOperation } from "../../lib/trash-guides/deployment-operation-gate.js";
import {
	createDeploymentConnectionStateToken,
	getEquivalentServiceInstanceIds,
} from "../../lib/trash-guides/deployment-target.js";
import { trashCustomFormatSchema } from "../../lib/trash-guides/github-schemas.js";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const deployMultipleSchema = z.object({
	trashIds: z.array(z.string().min(1).max(200)).min(1, "At least one trashId is required").max(500),
	instanceId: z.string().min(1, "instanceId is required"),
	serviceType: z.enum(["RADARR", "SONARR"]),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Transform specification fields from object format to array format
 * This matches the format expected by Radarr/Sonarr API
 */
function transformFieldsToArray(
	fields: Record<string, unknown> | Array<{ name: string; value: unknown }> | null | undefined,
): Array<{ name: string; value: unknown }> {
	// If fields is already an array, return it as-is
	if (Array.isArray(fields)) {
		return fields;
	}

	// If fields is undefined or null, return empty array
	if (!fields) {
		return [];
	}

	// Convert object format to array format
	const result = Object.entries(fields).map(([name, value]) => ({
		name,
		value,
	}));
	return result;
}

// ============================================================================
// Route Handlers
// ============================================================================

export async function registerCustomFormatRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/** Execution reads are ephemeral: a deployment never publishes the shared browsing cache. */
	async function readSource(repoConfig: TrashRepoConfig, serviceType: "RADARR" | "SONARR") {
		async function readRepository(config: TrashRepoConfig) {
			const fetcher = createTrashFetcher({
				repoConfig: config,
				logger: app.log,
				strictContent: true,
			});
			const { commitHash } = await createVersionTracker(config).getLatestCommit();
			const data = z
				.array(trashCustomFormatSchema)
				.parse(await fetcher.fetchConfigsAtCommit(serviceType, "CUSTOM_FORMATS", commitHash));
			if (new Set(data.map((cf) => cf.trash_id)).size !== data.length) {
				throw new ConflictError(
					"The source contains duplicate Custom Format IDs. No formats were deployed.",
				);
			}
			return {
				data,
				repository: `${config.owner}/${config.name}`.toLowerCase(),
				branch: config.branch,
				commitHash,
			};
		}
		const sources =
			repoConfig.mode === "supplementary"
				? await Promise.all([
						readRepository(DEFAULT_TRASH_REPO),
						readRepository({ ...repoConfig, mode: "fork" }),
					])
				: [await readRepository(repoConfig)];
		// A supplementary fork may intentionally override the official entry with the same ID.
		const byId = new Map(sources.flatMap((source) => source.data).map((cf) => [cf.trash_id, cf]));
		return {
			data: [...byId.values()],
			sources: sources.map(({ repository, branch, commitHash }) => ({
				repository,
				branch,
				commitHash,
			})),
			commitHash: JSON.stringify({
				version: 1,
				sources: sources.map(({ repository, branch, commitHash }) => ({
					repository,
					branch,
					commitHash,
				})),
			}),
		};
	}

	app.post<{ Body: z.infer<typeof deployMultipleSchema> }>(
		"/deploy-multiple",
		async (request, reply) => {
			const { trashIds, instanceId, serviceType } = validateRequest(
				deployMultipleSchema,
				request.body,
			);
			const userId = request.currentUser!.id;
			if (new Set(trashIds).size !== trashIds.length) {
				throw new ConflictError(
					"Each requested Custom Format ID must occur exactly once. No formats were deployed.",
				);
			}
			const initialInstance = await requireEnabledInstance(app, userId, instanceId);
			if (initialInstance.service.toUpperCase() !== serviceType) {
				return reply.status(400).send({
					error: "SERVICE_MISMATCH",
					message:
						"The instance service does not match the requested Custom Formats. No formats were deployed.",
				});
			}
			const connectionToken = createDeploymentConnectionStateToken(initialInstance);
			return withRenewableCleanupTopologyMutationLease(
				{ prisma: app.prisma, log: request.log },
				userId,
				(topologyLease) =>
					app.deploymentExecutor.runWithEndpointMutation(
						userId,
						initialInstance,
						"Standalone Custom Format deployment",
						async () => {
							const instance = await requireEnabledInstance(app, userId, instanceId);
							if (createDeploymentConnectionStateToken(instance) !== connectionToken) {
								throw new ConflictError(
									"The instance connection changed. Review the target before deploying again.",
								);
							}
							const aliases = await app.prisma.serviceInstance.findMany({
								where: { userId, service: instance.service },
							});
							const withIdentity = (value: typeof instance) => ({
								...value,
								credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(value),
							});
							const equivalentIds = getEquivalentServiceInstanceIds(
								aliases.map(withIdentity),
								withIdentity(instance),
							);
							if (!equivalentIds.includes(instanceId)) equivalentIds.push(instanceId);
							await assertNoPendingDeploymentOperation(app.prisma, userId, equivalentIds);
							const repoConfig = await getRepoConfig(app.prisma, userId);
							const source = await readSource(repoConfig, serviceType);
							const selected = trashIds.map((id) => source.data.find((cf) => cf.trash_id === id));
							if (
								selected.some((cf) => !cf) ||
								selected.some(
									(cf) =>
										source.data.filter((candidate) => candidate.name === cf!.name).length !== 1,
								)
							) {
								return reply.status(409).send({
									success: false,
									outcome: "rejected",
									message:
										"The complete selection could not be resolved uniquely in the current repository. Refresh and review the selection. No formats were deployed.",
									created: [],
									updated: [],
									failed: [],
									targets: trashIds.map((trashId) => ({ trashId, status: "rejected" })),
								});
							}
							const customFormats = selected.filter((cf) => cf !== undefined);
							const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;
							await topologyLease.assertOwnership();
							const existingFormats = await client.customFormat.getAll();
							const identities = buildCustomFormatIdentityIndex(existingFormats);
							if (
								identities.collisions.length ||
								new Set(existingFormats.map((cf) => cf.id)).size !== existingFormats.length ||
								existingFormats.some((cf) => !Number.isSafeInteger(cf.id) || cf.id! <= 0)
							) {
								throw new ConflictError(
									"The target has ambiguous Custom Format identities. No formats were deployed.",
								);
							}
							const seenResourceIds = new Set(existingFormats.map((format) => format.id));
							const plan = customFormats.map((cf) => {
								const byId = identities.byTrashId.get(cf.trash_id);
								const byName = identities.byName.get(cf.name);
								if (
									(byId && byName && byId.id !== byName.id) ||
									(byName && extractTrashId(byName) && extractTrashId(byName) !== cf.trash_id)
								) {
									throw new ConflictError(
										"The target Custom Format name and ID refer to different entries. No formats were deployed.",
									);
								}
								return { cf, existing: byId ?? byName };
							});
							const results = {
								success: false,
								outcome: "uncertain" as "complete" | "uncertain" | "partial" | "rejected",
								created: [] as string[],
								unchanged: [] as string[],
								updated: [] as string[],
								failed: [] as Array<{ name: string; error: string }>,
								targets: plan.map(({ cf }) => ({
									trashId: cf.trash_id,
									name: cf.name,
									status: "skipped" as
										| "created"
										| "updated"
										| "unchanged"
										| "uncertain"
										| "skipped",
									tracked: false,
								})),
							};
							async function assertCurrentAuthority() {
								await topologyLease.assertOwnership();
								const current = await requireEnabledInstance(app, userId, instanceId);
								if (
									createDeploymentConnectionStateToken(current) !== connectionToken ||
									JSON.stringify(await getRepoConfig(app.prisma, userId)) !==
										JSON.stringify(repoConfig)
								) {
									throw new ConflictError(
										"The source settings or instance connection changed. Review the selection before deploying again.",
									);
								}
							}
							await assertCurrentAuthority();
							// A pre-send uncertain hold survives a crash and is immediately reviewable.
							// Acknowledgement uses the same endpoint lock, so active work cannot be released.
							const history = await app.prisma.trashSyncHistory.create({
								data: {
									userId,
									instanceId,
									syncType: "MANUAL",
									status: "UNCERTAIN",
									appliedConfigs: "[]",
									failedConfigs: JSON.stringify(
										results.targets.map((target) => ({
											...target,
											error: "Deployment started; final outcome is unconfirmed.",
											sources: source.sources,
										})),
									),
									errorLog: JSON.stringify({
										type: "STANDALONE_CUSTOM_FORMATS",
										connectionStateToken: connectionToken,
										sources: source.sources,
										targets: results.targets,
									}),
								},
							});
							for (const [index, { cf, existing }] of plan.entries()) {
								let sending = false;
								try {
									await assertCurrentAuthority();
									const intended = {
										name: cf.name,
										includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
										specifications: cf.specifications.map((spec) => ({
											...spec,
											fields: transformFieldsToArray(spec.fields),
										})),
									};
									const intendedToken = createIntendedCustomFormatPostStateToken(
										intended,
										serviceType,
									);
									let resourceId: number;
									if (existing) {
										const current = await client.customFormat.getById(existing.id!);
										if (
											current.id !== existing.id ||
											current.name !== existing.name ||
											extractTrashId(current) !== extractTrashId(existing)
										) {
											throw new ConflictError(
												"The upstream Custom Format identity changed before deployment.",
											);
										}
										await assertCurrentAuthority();
										resourceId = existing.id!;
										if (matchesIntendedCustomFormatPostStateToken(current, intendedToken)) {
											results.unchanged.push(cf.name);
											results.targets[index]!.status = "unchanged";
										} else {
											sending = true;
											await client.customFormat.update(resourceId, {
												...current,
												...intended,
											} as unknown as Parameters<typeof client.customFormat.update>[1]);
										}
									} else {
										sending = true;
										const accepted = await client.customFormat.create(
											intended as unknown as Parameters<typeof client.customFormat.create>[0],
										);
										resourceId = accepted.id!;
										if (
											!Number.isSafeInteger(resourceId) ||
											resourceId <= 0 ||
											seenResourceIds.has(resourceId)
										)
											throw new Error("Created Custom Format identity could not be verified");
										seenResourceIds.add(resourceId);
									}
									if (sending) {
										await topologyLease.assertOwnership();
										const readback = await client.customFormat.getById(resourceId);
										if (
											readback.id !== resourceId ||
											!matchesIntendedCustomFormatPostStateToken(readback, intendedToken)
										)
											throw new Error(
												"Custom Format post-write readback did not match intended state",
											);
										if (existing) {
											results.updated.push(cf.name);
											results.targets[index]!.status = "updated";
										} else {
											results.created.push(cf.name);
											results.targets[index]!.status = "created";
										}
									}
									await assertCurrentAuthority();
									await app.prisma.standaloneCFDeployment.upsert({
										where: { instanceId_cfTrashId: { instanceId, cfTrashId: cf.trash_id } },
										update: {
											cfName: cf.name,
											commitHash: source.commitHash,
											deployedAt: new Date(),
										},
										create: {
											userId,
											instanceId,
											cfTrashId: cf.trash_id,
											cfName: cf.name,
											serviceType,
											commitHash: source.commitHash,
										},
									});
									results.targets[index]!.tracked = true;
								} catch (error) {
									if (sending && results.targets[index]!.status === "skipped")
										results.targets[index]!.status = "uncertain";
									results.failed.push({
										name: cf.name,
										error:
											"The deployment result or its tracking could not be confirmed. Inspect the instance and resolve the operation history before retrying.",
									});
									request.log.warn(
										{ err: error, historyId: history.id },
										"Standalone Custom Format deployment requires reconciliation",
									);
									break;
								}
							}
							results.success = results.failed.length === 0;
							results.outcome = results.success
								? "complete"
								: results.targets.some(
											(target) =>
												target.status === "uncertain" ||
												((target.status === "created" ||
													target.status === "updated" ||
													target.status === "unchanged") &&
													!target.tracked),
										)
									? "uncertain"
									: results.created.length + results.updated.length > 0
										? "partial"
										: "rejected";
							try {
								await topologyLease.assertOwnership();
								await app.prisma.trashSyncHistory
									.updateMany({
										where: { id: history.id, userId, instanceId, status: "UNCERTAIN" },
										data: {
											status: results.success
												? "SUCCESS"
												: results.outcome === "uncertain"
													? "UNCERTAIN"
													: "FAILED",
											completedAt: new Date(),
											configsApplied: results.created.length + results.updated.length,
											configsFailed: results.failed.length,
											configsSkipped: results.targets.filter(
												(target) => target.status === "skipped",
											).length,
											appliedConfigs: JSON.stringify(
												results.targets
													.filter(
														(target) => target.status === "created" || target.status === "updated",
													)
													.map((target) => ({
														name: target.name,
														trashId: target.trashId,
														type: "custom_format",
														action: target.status,
													})),
											),
											errorLog: JSON.stringify({
												type: "STANDALONE_CUSTOM_FORMATS",
												connectionStateToken: connectionToken,
												sources: source.sources,
												targets: results.targets,
											}),
											failedConfigs: JSON.stringify(results.failed),
										},
									})
									.then((updated) => {
										if (updated.count !== 1) throw new Error("Operation history ownership lost");
									});
							} catch (error) {
								results.success = false;
								results.outcome = "uncertain";
								request.log.warn(
									{ err: error, historyId: history.id },
									"Standalone Custom Format history could not be finalized",
								);
							}
							return reply.send({
								...results,
								historyId: history.id,
								message: results.success
									? "All selected Custom Formats were deployed."
									: "Some deployment results or tracking are unconfirmed. Inspect the instance and resolve operation history before retrying.",
							});
						},
					),
			);
		},
	);

	/**
	 * GET /api/trash-guides/custom-formats/standalone-updates
	 * Check for updates to standalone deployed custom formats
	 * Compares repository-bound deployed revisions against the current configured source.
	 * Legacy or incomparable source revisions remain explicitly unknown.
	 */
	app.get<{
		Querystring: {
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		};
	}>("/standalone-updates", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, serviceType } = request.query;

		// Build query filter
		const where: {
			userId: string;
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		} = { userId };

		if (instanceId) {
			where.instanceId = instanceId;
		}
		if (serviceType) {
			where.serviceType = serviceType;
		}

		// Get all standalone deployments for this user
		const deployments = await app.prisma.standaloneCFDeployment.findMany({
			where,
			include: {
				instance: {
					select: {
						label: true,
						service: true,
					},
				},
			},
		});

		if (deployments.length === 0) {
			return reply.send({
				success: true,
				hasUpdates: false,
				updates: [],
				message: "No standalone custom format deployments found",
			});
		}

		// Legacy raw hashes and shared cache hashes do not prove source compatibility.
		const repoConfig = await getRepoConfig(app.prisma, userId);
		const repositories =
			repoConfig.mode === "supplementary"
				? [DEFAULT_TRASH_REPO, { ...repoConfig, mode: "fork" as const }]
				: [repoConfig];
		let currentSources: Array<{ repository: string; branch: string; commitHash: string }> | null =
			null;
		try {
			currentSources = await Promise.all(
				repositories.map(async (config) => ({
					repository: `${config.owner}/${config.name}`.toLowerCase(),
					branch: config.branch,
					commitHash: (await createVersionTracker(config).getLatestCommit()).commitHash,
				})),
			);
			if (currentSources.some((source) => !/^[a-f0-9]{40}$/i.test(source.commitHash)))
				currentSources = null;
		} catch {
			currentSources = null;
		}
		const updates: Array<{
			cfTrashId: string;
			cfName: string;
			instanceId: string;
			instanceLabel: string;
			serviceType: string;
			deployedCommitHash: string;
			currentCommitHash: string;
		}> = [];
		const unknownDeployments: Array<{ cfTrashId: string; instanceId: string; reason: string }> = [];
		const revisionSchema = z.object({
			version: z.literal(1),
			sources: z
				.array(
					z.object({
						repository: z.string(),
						branch: z.string(),
						commitHash: z.string().regex(/^[a-f0-9]{40}$/i),
					}),
				)
				.min(1)
				.max(2),
		});
		for (const deployment of deployments) {
			let revision: z.infer<typeof revisionSchema> | null = null;
			try {
				revision = revisionSchema.parse(JSON.parse(deployment.commitHash));
			} catch {
				/* Legacy revisions remain unknown. */
			}
			const compatible =
				revision &&
				currentSources &&
				revision.sources.length === currentSources.length &&
				revision.sources.every(
					(source, index) =>
						source.repository === currentSources![index]!.repository &&
						source.branch === currentSources![index]!.branch,
				);
			if (!compatible) {
				unknownDeployments.push({
					cfTrashId: deployment.cfTrashId,
					instanceId: deployment.instanceId,
					reason: "SOURCE_REVISION_UNAVAILABLE_OR_CHANGED",
				});
			} else if (
				revision!.sources.some(
					(source, index) => source.commitHash !== currentSources![index]!.commitHash,
				)
			) {
				updates.push({
					cfTrashId: deployment.cfTrashId,
					cfName: deployment.cfName,
					instanceId: deployment.instanceId,
					instanceLabel: deployment.instance.label,
					serviceType: deployment.serviceType,
					deployedCommitHash: deployment.commitHash,
					currentCommitHash: JSON.stringify({ version: 1, sources: currentSources }),
				});
			}
		}

		return reply.send({
			success: true,
			hasUpdates: updates.length > 0,
			updates,
			unknownDeployments,
			totalDeployed: deployments.length,
			outdatedCount: updates.length,
		});
	});

	/**
	 * GET /api/trash-guides/custom-formats/standalone-deployments
	 * List all standalone CF deployments for the current user
	 */
	app.get<{
		Querystring: {
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		};
	}>("/standalone-deployments", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, serviceType } = request.query;

		const where: {
			userId: string;
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		} = { userId };

		if (instanceId) {
			where.instanceId = instanceId;
		}
		if (serviceType) {
			where.serviceType = serviceType;
		}

		const deployments = await app.prisma.standaloneCFDeployment.findMany({
			where,
			include: {
				instance: {
					select: {
						label: true,
						service: true,
					},
				},
			},
			orderBy: [{ instanceId: "asc" }, { cfName: "asc" }],
		});

		return reply.send({
			success: true,
			deployments: deployments.map((d) => ({
				id: d.id,
				cfTrashId: d.cfTrashId,
				cfName: d.cfName,
				instanceId: d.instanceId,
				instanceLabel: d.instance.label,
				serviceType: d.serviceType,
				commitHash: d.commitHash,
				deployedAt: d.deployedAt,
			})),
			count: deployments.length,
		});
	});

	/**
	 * DELETE /api/trash-guides/custom-formats/standalone-deployments/:id
	 * Remove tracking for a standalone CF deployment (does not remove CF from instance)
	 */
	app.delete<{
		Params: { id: string };
	}>("/standalone-deployments/:id", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { id } = request.params;

		// Verify ownership
		const deployment = await app.prisma.standaloneCFDeployment.findFirst({
			where: { id, userId },
		});

		if (!deployment) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "Deployment record not found",
			});
		}

		await app.prisma.standaloneCFDeployment.delete({
			where: { id },
		});

		return reply.send({
			success: true,
			message: `Stopped tracking updates for ${deployment.cfName}`,
		});
	});
}
