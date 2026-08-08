import type { PrismaClient } from "../prisma.js";
import { ConflictError } from "../errors.js";
import type { DeploymentConnectionBinding } from "./deployment-target.js";

interface LegacyDeploymentMapping {
	id: string;
	instanceId: string;
	qualityProfileId: number;
}

/**
 * Bind a user-reviewed 2.x mapping and its saved score intent to the exact
 * current connection. Every mapping update is compare-and-set so a stale
 * preview cannot silently re-authorize changed ownership.
 */
export async function rebindLegacyDeploymentConnectionState(
	prisma: PrismaClient,
	userId: string,
	mappings: LegacyDeploymentMapping[],
	qualityProfileId: number,
	connectionBindings: DeploymentConnectionBinding[],
): Promise<void> {
	const bindingByInstanceId = new Map(
		connectionBindings.map((binding) => [binding.instanceId, binding]),
	);

	await prisma.$transaction(async (tx) => {
		for (const mapping of mappings) {
			const binding = bindingByInstanceId.get(mapping.instanceId);
			if (!binding) {
				throw new ConflictError(
					"The legacy deployment mapping no longer belongs to this ARR endpoint. Unlink it before continuing.",
				);
			}
			const rebound = await tx.templateQualityProfileMapping.updateMany({
				where: {
					id: mapping.id,
					connectionGeneration: 0,
					connectionStateToken: null,
				},
				data: {
					connectionGeneration: binding.connectionGeneration,
					connectionStateToken: binding.connectionStateToken,
					updatedAt: new Date(),
				},
			});
			if (rebound.count !== 1) {
				throw new ConflictError(
					"The legacy deployment mapping changed after preview. Refresh and review the deployment again.",
				);
			}
		}

		for (const binding of connectionBindings) {
			await tx.instanceQualityProfileOverride.updateMany({
				where: {
					userId,
					instanceId: binding.instanceId,
					qualityProfileId,
					connectionGeneration: 0,
					connectionStateToken: null,
				},
				data: {
					connectionGeneration: binding.connectionGeneration,
					connectionStateToken: binding.connectionStateToken,
				},
			});
		}
	});
}
