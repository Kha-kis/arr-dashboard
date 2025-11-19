/**
 * TRaSH Guides Deployment Preview Service
 *
 * Generates deployment preview by comparing template configuration with
 * actual Custom Formats in Radarr/Sonarr instance, detecting conflicts.
 */

import { PrismaClient } from "@prisma/client";
import type {
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
} from "@arr/shared";
import { ArrApiClient, createArrApiClient } from "./arr-api-client.js";
import type { CustomFormat } from "./arr-api-client.js";

// ============================================================================
// Deployment Preview Service Class
// ============================================================================

export class DeploymentPreviewService {
	private prisma: PrismaClient;
	private encryptor: { decrypt: (payload: { value: string; iv: string }) => string };

	constructor(
		prisma: PrismaClient,
		encryptor: { decrypt: (payload: { value: string; iv: string }) => string },
	) {
		this.prisma = prisma;
		this.encryptor = encryptor;
	}

	/**
	 * Generate deployment preview for template → instance deployment
	 */
	async generatePreview(
		templateId: string,
		instanceId: string,
	): Promise<DeploymentPreview> {
		// Get template
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// Get instance
		const instance = await this.prisma.serviceInstance.findUnique({
			where: { id: instanceId },
		});

		if (!instance) {
			throw new Error("Instance not found");
		}

		// Validate service type match (case-insensitive)
		// Template stores uppercase "RADARR"/"SONARR", instance stores lowercase "radarr"/"sonarr"
		if (template.serviceType.toUpperCase() !== instance.service.toUpperCase()) {
			throw new Error(
				`Service type mismatch: template is ${template.serviceType}, instance is ${instance.service}`,
			);
		}

		// Create API client and test connection
		const apiClient = createArrApiClient(instance, this.encryptor);
		let instanceReachable = false;
		let instanceVersion: string | undefined;
		let instanceCustomFormats: CustomFormat[] = [];

		try {
			const status = await apiClient.getSystemStatus();
			instanceReachable = true;
			instanceVersion = status.version;
			instanceCustomFormats = await apiClient.getCustomFormats();
		} catch (error) {
			// Instance unreachable - will return preview with warning
			console.error("Failed to reach instance:", error);
		}

		// Parse template config
		const templateConfig = JSON.parse(template.configData);
		let templateCFs = (templateConfig.customFormats || []) as Array<{
			trashId: string;
			name: string;
			scoreOverride: number;
			originalConfig: any;
		}>;

		// Apply instance-specific overrides if they exist
		const instanceOverrides = template.instanceOverrides
			? JSON.parse(template.instanceOverrides)
			: {};
		const overridesForInstance = instanceOverrides[instanceId] || {};

		// Apply score overrides and CF selection overrides
		if (overridesForInstance.scoreOverrides || overridesForInstance.cfOverrides) {
			templateCFs = templateCFs.map((cf) => {
				const cfOverride = overridesForInstance.cfOverrides?.[cf.trashId];
				const scoreOverride = overridesForInstance.scoreOverrides?.[cf.trashId];

				// If CF is disabled for this instance, skip it
				if (cfOverride?.enabled === false) {
					return null;
				}

				// Apply score override if exists
				const finalScore =
					scoreOverride !== undefined ? scoreOverride : cf.scoreOverride;

				return {
					...cf,
					scoreOverride: finalScore,
				};
			}).filter((cf): cf is NonNullable<typeof cf> => cf !== null);
		}

		// Build instance CF map by trash_id (from originalConfig metadata)
		const instanceCFMap = new Map<string, CustomFormat>();
		for (const instanceCF of instanceCustomFormats) {
			// Try to extract trash_id from CF name or specifications
			// TRaSH Guides CFs typically have trash_id in their structure
			const trashId = this.extractTrashId(instanceCF);
			if (trashId) {
				instanceCFMap.set(trashId, instanceCF);
			}
		}

		// Compare and generate deployment items
		const deploymentItems: CustomFormatDeploymentItem[] = [];
		let newCount = 0;
		let updateCount = 0;
		let skipCount = 0;
		let totalConflicts = 0;
		let unresolvedConflicts = 0;

		for (const templateCF of templateCFs) {
			const instanceCF = instanceCFMap.get(templateCF.trashId);
			const conflicts: CustomFormatConflict[] = [];

			let action: DeploymentAction = "create";
			let hasConflicts = false;

			if (instanceCF) {
				// CF exists in instance - check for conflicts
				action = "update";

				// Check for specification differences
				const templateSpecs = templateCF.originalConfig?.specifications || [];
				const instanceSpecs = instanceCF.specifications || [];

				if (
					JSON.stringify(templateSpecs) !== JSON.stringify(instanceSpecs)
				) {
					conflicts.push({
						cfTrashId: templateCF.trashId,
						cfName: templateCF.name,
						conflictType: "specification_mismatch",
						templateValue: templateSpecs,
						instanceValue: instanceSpecs,
						suggestedResolution: "use_template", // Default to template specs
					});
					hasConflicts = true;
				}

				// Note: Score conflicts are handled at Quality Profile level, not CF level
				// CFs themselves don't have scores - scores are assigned in Quality Profiles

				if (hasConflicts) {
					totalConflicts += conflicts.length;
					unresolvedConflicts += conflicts.filter((c) => !c.resolution).length;
					updateCount++;
				} else {
					// No conflicts, safe to update
					updateCount++;
				}
			} else {
				// New CF to be created
				newCount++;
			}

			deploymentItems.push({
				trashId: templateCF.trashId,
				name: templateCF.name,
				action,
				templateData: templateCF.originalConfig,
				instanceData: instanceCF,
				conflicts,
				hasConflicts,
			});
		}

		// Check for CFs in instance but not in template (potential deletions)
		// For now, we'll skip deletion detection and only focus on create/update
		// This is safer and matches TRaSH Guides philosophy of additive changes

		const canDeploy =
			instanceReachable && (unresolvedConflicts === 0 || totalConflicts === 0);
		const requiresConflictResolution = unresolvedConflicts > 0;

		return {
			templateId,
			templateName: template.name,
			instanceId,
			instanceLabel: instance.label,
			instanceServiceType: instance.service as "RADARR" | "SONARR",

			summary: {
				totalItems: deploymentItems.length,
				newCustomFormats: newCount,
				updatedCustomFormats: updateCount,
				deletedCustomFormats: 0, // Not implementing deletion for safety
				skippedCustomFormats: skipCount,
				totalConflicts,
				unresolvedConflicts,
			},

			customFormats: deploymentItems,

			canDeploy,
			requiresConflictResolution,
			instanceReachable,
			instanceVersion,
		};
	}

	/**
	 * Extract trash_id from Custom Format
	 * TRaSH Guides CFs include trash_id in their metadata
	 */
	private extractTrashId(cf: CustomFormat): string | null {
		// Try to find trash_id in specifications or fields
		// This is implementation-specific to how TRaSH Guides stores trash_id
		// Common pattern: trash_id in a specific field or specification

		// For now, use CF name as identifier
		// In production, this would need to be enhanced to properly extract trash_id
		// from CF metadata or match against known TRaSH Guide patterns

		return cf.name; // Fallback: use name as identifier
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDeploymentPreviewService(
	prisma: PrismaClient,
	encryptor: { decrypt: (payload: { value: string; iv: string }) => string },
): DeploymentPreviewService {
	return new DeploymentPreviewService(prisma, encryptor);
}
