import { ConflictError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";
import {
	createDeploymentConnectionBinding,
	normalizeDeploymentBaseUrl,
	type DeploymentConnectionBinding,
} from "./deployment-target.js";

interface LegacyDeploymentMapping {
	id: string;
	templateId: string;
	instanceId: string;
	qualityProfileId: number;
	qualityProfileName: string;
	connectionGeneration: number;
	connectionStateToken: string | null;
}

interface LegacyDeploymentOverride {
	id: string;
	userId: string;
	instanceId: string;
	qualityProfileId: number;
	customFormatId: number;
	score: number;
	status: string;
	intentOperation: string | null;
	intendedScore: number | null;
	connectionGeneration: number;
	connectionStateToken: string | null;
}

function mappingMatchesReview(
	live: LegacyDeploymentMapping | undefined,
	reviewed: LegacyDeploymentMapping,
): boolean {
	return Boolean(
		live &&
			live.id === reviewed.id &&
			live.templateId === reviewed.templateId &&
			live.instanceId === reviewed.instanceId &&
			live.qualityProfileId === reviewed.qualityProfileId &&
			live.qualityProfileName === reviewed.qualityProfileName &&
			live.connectionGeneration === reviewed.connectionGeneration &&
			live.connectionStateToken === reviewed.connectionStateToken,
	);
}

function overrideMatchesReview(
	live: LegacyDeploymentOverride | undefined,
	reviewed: LegacyDeploymentOverride,
): boolean {
	return Boolean(
		live &&
			live.id === reviewed.id &&
			live.userId === reviewed.userId &&
			live.instanceId === reviewed.instanceId &&
			live.qualityProfileId === reviewed.qualityProfileId &&
			live.customFormatId === reviewed.customFormatId &&
			live.score === reviewed.score &&
			live.status === reviewed.status &&
			live.intentOperation === reviewed.intentOperation &&
			live.intendedScore === reviewed.intendedScore &&
			live.connectionGeneration === reviewed.connectionGeneration &&
			live.connectionStateToken === reviewed.connectionStateToken,
	);
}

/**
 * Bind user-reviewed 2.x mappings and saved score intent to the exact current
 * connection. Ownership, connection identity, mappings, and overrides are all
 * re-read in one serializable transaction before compare-and-set writes.
 */
export async function rebindLegacyDeploymentConnectionState(
	prisma: PrismaClient,
	userId: string,
	mappings: LegacyDeploymentMapping[],
	qualityProfileId: number,
	overrides: LegacyDeploymentOverride[],
	connectionBindings: DeploymentConnectionBinding[],
): Promise<void> {
	const mappingIds = mappings.map((mapping) => mapping.id);
	const overrideIds = overrides.map((override) => override.id);
	const templateIds = [...new Set(mappings.map((mapping) => mapping.templateId))];
	const bindingByInstanceId = new Map(
		connectionBindings.map((binding) => [binding.instanceId, binding]),
	);
	if (
		new Set(mappingIds).size !== mappingIds.length ||
		new Set(overrideIds).size !== overrideIds.length ||
		bindingByInstanceId.size !== connectionBindings.length
	) {
		throw new ConflictError(
			"The reviewed legacy deployment identities are ambiguous. Refresh and review the deployment again.",
		);
	}

	await prisma.$transaction(
		async (tx) => {
			const [liveMappings, liveInstances, ownedTemplates] = await Promise.all([
				tx.templateQualityProfileMapping.findMany({
					where: { id: { in: mappingIds } },
					select: {
						id: true,
						templateId: true,
						instanceId: true,
						qualityProfileId: true,
						qualityProfileName: true,
						connectionGeneration: true,
						connectionStateToken: true,
					},
				}),
				tx.serviceInstance.findMany({
					where: { id: { in: [...bindingByInstanceId.keys()] }, userId },
					select: {
						id: true,
						service: true,
						baseUrl: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						connectionGeneration: true,
					},
				}),
				tx.trashTemplate.findMany({
					where: { id: { in: templateIds }, userId, deletedAt: null },
					select: { id: true },
				}),
			]);

			const ownedTemplateIds = new Set(ownedTemplates.map((template) => template.id));
			if (
				liveMappings.length !== mappings.length ||
				liveInstances.length !== bindingByInstanceId.size ||
				ownedTemplateIds.size !== templateIds.length ||
				mappings.some(
					(mapping) =>
						!ownedTemplateIds.has(mapping.templateId) ||
						!bindingByInstanceId.has(mapping.instanceId),
				)
			) {
				throw new ConflictError(
					"The reviewed legacy deployment mapping or ARR instance is no longer authorized for this user.",
				);
			}
			const services = new Set(liveInstances.map((instance) => instance.service.toUpperCase()));
			const baseUrls = new Set(
				liveInstances.map((instance) => normalizeDeploymentBaseUrl(instance.baseUrl)),
			);
			const reviewedCredentialIdentities = new Set(
				connectionBindings.map((binding) => binding.credentialIdentity).filter(Boolean),
			);
			if (
				services.size !== 1 ||
				baseUrls.size !== 1 ||
				(connectionBindings.length > 1 &&
					(reviewedCredentialIdentities.size !== 1 ||
						connectionBindings.some((binding) => !binding.credentialIdentity)))
			) {
				throw new ConflictError(
					"The reviewed legacy deployment cannot be proven to belong to one ARR endpoint. Refresh and review the deployment again.",
				);
			}

			const liveMappingById = new Map(liveMappings.map((mapping) => [mapping.id, mapping]));
			if (
				mappings.some(
					(mapping) =>
						mapping.qualityProfileId !== qualityProfileId ||
						mapping.connectionGeneration !== 0 ||
						mapping.connectionStateToken !== null ||
						!mappingMatchesReview(liveMappingById.get(mapping.id), mapping),
				)
			) {
				throw new ConflictError(
					"The legacy deployment mapping changed after preview. Refresh and review the deployment again.",
				);
			}

			for (const instance of liveInstances) {
				const reviewedBinding = bindingByInstanceId.get(instance.id)!;
				const liveBinding = createDeploymentConnectionBinding(instance);
				if (
					liveBinding.connectionGeneration !== reviewedBinding.connectionGeneration ||
					liveBinding.connectionStateToken !== reviewedBinding.connectionStateToken
				) {
					throw new ConflictError(
						"The ARR service connection changed after preview. Refresh and review the deployment again.",
					);
				}
			}

			const liveOverrides = await tx.instanceQualityProfileOverride.findMany({
				where: {
					userId,
					instanceId: { in: [...bindingByInstanceId.keys()] },
					qualityProfileId,
					connectionGeneration: 0,
					connectionStateToken: null,
				},
				select: {
					id: true,
					userId: true,
					instanceId: true,
					qualityProfileId: true,
					customFormatId: true,
					score: true,
					status: true,
					intentOperation: true,
					intendedScore: true,
					connectionGeneration: true,
					connectionStateToken: true,
				},
			});
			const liveOverrideById = new Map(liveOverrides.map((override) => [override.id, override]));
			if (
				liveOverrides.length !== overrides.length ||
				overrides.some(
					(override) =>
						override.userId !== userId ||
						override.qualityProfileId !== qualityProfileId ||
						!bindingByInstanceId.has(override.instanceId) ||
						override.connectionGeneration !== 0 ||
						override.connectionStateToken !== null ||
						!overrideMatchesReview(liveOverrideById.get(override.id), override),
				)
			) {
				throw new ConflictError(
					"The legacy score overrides changed after preview. Refresh and review the deployment again.",
				);
			}

			for (const mapping of mappings) {
				const binding = bindingByInstanceId.get(mapping.instanceId)!;
				const rebound = await tx.templateQualityProfileMapping.updateMany({
					where: {
						id: mapping.id,
						templateId: mapping.templateId,
						instanceId: mapping.instanceId,
						qualityProfileId: mapping.qualityProfileId,
						qualityProfileName: mapping.qualityProfileName,
						connectionGeneration: mapping.connectionGeneration,
						connectionStateToken: mapping.connectionStateToken,
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

			for (const override of overrides) {
				const binding = bindingByInstanceId.get(override.instanceId);
				if (!binding) {
					throw new ConflictError(
						"The legacy score overrides changed after preview. Refresh and review the deployment again.",
					);
				}
				const rebound = await tx.instanceQualityProfileOverride.updateMany({
					where: {
						id: override.id,
						userId: override.userId,
						instanceId: override.instanceId,
						qualityProfileId: override.qualityProfileId,
						customFormatId: override.customFormatId,
						score: override.score,
						status: override.status,
						intentOperation: override.intentOperation,
						intendedScore: override.intendedScore,
						connectionGeneration: override.connectionGeneration,
						connectionStateToken: override.connectionStateToken,
					},
					data: {
						connectionGeneration: binding.connectionGeneration,
						connectionStateToken: binding.connectionStateToken,
					},
				});
				if (rebound.count !== 1) {
					throw new ConflictError(
						"The legacy score overrides changed after preview. Refresh and review the deployment again.",
					);
				}
			}

			const remainingLegacyOverrides = await tx.instanceQualityProfileOverride.count({
				where: {
					userId,
					instanceId: { in: [...bindingByInstanceId.keys()] },
					qualityProfileId,
					connectionGeneration: 0,
					connectionStateToken: null,
				},
			});
			if (remainingLegacyOverrides !== 0) {
				throw new ConflictError(
					"The legacy score overrides changed while they were being rebound. Refresh and review the deployment again.",
				);
			}
		},
		{ isolationLevel: "Serializable" },
	);
}
