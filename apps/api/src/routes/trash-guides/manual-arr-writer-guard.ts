import type { FastifyInstance } from "fastify";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { AppValidationError, ConflictError } from "../../lib/errors.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-executor.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { assertNoPendingDeploymentOperation } from "../../lib/trash-guides/deployment-operation-gate.js";
import {
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	getEquivalentServiceInstanceIds,
} from "../../lib/trash-guides/deployment-target.js";

/** Serialize a direct ARR writer and reject it while recovery owns the endpoint. */
export async function runWithManualArrWriterGuard<T>(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	operation: string,
	action: (instance: ServiceInstance) => Promise<T>,
	options: { excludedNamingHistoryId?: string } = {},
): Promise<T> {
	const initialInstance = await requireInstance(app, userId, instanceId);
	if (initialInstance.service !== "RADARR" && initialInstance.service !== "SONARR") {
		throw new AppValidationError(`${operation} requires a Radarr or Sonarr instance.`);
	}

	return withCleanupTopologyMutationLease({ prisma: app.prisma, log: app.log }, userId, () =>
		app.deploymentExecutor.runWithEndpointMutation(
			userId,
			initialInstance,
			operation,
			async (endpointKey) => {
				const aliases = await app.prisma.serviceInstance.findMany({
					where: { userId, service: initialInstance.service },
				});
				const currentInstance = aliases.find((instance) => instance.id === instanceId);
				if (!currentInstance) {
					throw new ConflictError(`${operation} target was removed before execution.`);
				}
				const aliasesWithIdentity = aliases.map((instance) => ({
					...instance,
					credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(instance),
				}));
				const target = aliasesWithIdentity.find((instance) => instance.id === instanceId);
				if (
					!target ||
					createDeploymentEndpointKey(userId, target) !== endpointKey ||
					createDeploymentConnectionStateToken(currentInstance) !==
						createDeploymentConnectionStateToken(initialInstance)
				) {
					throw new ConflictError(
						`${operation} target connection changed before execution. Review it and try again.`,
					);
				}
				const endpointInstanceIds = getEquivalentServiceInstanceIds(aliasesWithIdentity, target);
				if (!endpointInstanceIds.includes(instanceId)) endpointInstanceIds.push(instanceId);
				if (options.excludedNamingHistoryId) {
					await assertNoPendingDeploymentOperation(
						app.prisma,
						userId,
						endpointInstanceIds,
						undefined,
						undefined,
						options.excludedNamingHistoryId,
					);
				} else {
					await assertNoPendingDeploymentOperation(app.prisma, userId, endpointInstanceIds);
				}
				return action(currentInstance);
			},
		),
	);
}
