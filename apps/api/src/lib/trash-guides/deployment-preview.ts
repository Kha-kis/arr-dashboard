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

		// Parse template config - fail fast on corrupted data
		let templateConfig: { customFormats?: Array<any> };
		try {
			templateConfig = JSON.parse(template.configData);
		} catch (parseError) {
			throw new Error(
				`Template ${template.id} has corrupted configData: ${parseError instanceof Error ? parseError.message : String(parseError)}`
			);
		}
		const rawTemplateCFs = (templateConfig.customFormats || []) as Array<{
			trashId: string;
			name: string;
			scoreOverride?: number;
			originalConfig: {
				trash_scores?: { default?: number };
				[key: string]: unknown;
			};
		}>;

		// Get instance-specific overrides if they exist
		let instanceOverrides: Record<string, any> = {};
		try {
			instanceOverrides = template.instanceOverrides
				? JSON.parse(template.instanceOverrides)
				: {};
		} catch (parseError) {
			console.warn(`Failed to parse instanceOverrides for template ${template.id}:`, parseError);
		}
		const overridesForInstance = instanceOverrides[instanceId] || {};
		const scoreOverridesMap = overridesForInstance.scoreOverrides || {};
		const cfOverridesMap = overridesForInstance.cfOverrides || {};

		// Build template CFs with both default and instance override scores
		const templateCFs = rawTemplateCFs
			.filter((cf) => {
				// Filter out CFs disabled for this instance
				const cfOverride = cfOverridesMap[cf.trashId];
				return cfOverride?.enabled !== false;
			})
			.map((cf) => {
				// Get the default score from template (TRaSH Guides default)
				const defaultScore = cf.scoreOverride ?? cf.originalConfig?.trash_scores?.default ?? 0;
				// Get the instance-specific override (if any)
				const instanceOverrideScore = scoreOverridesMap[cf.trashId] as number | undefined;
				// Calculate effective score
				const effectiveScore = instanceOverrideScore ?? defaultScore;

				return {
					...cf,
					defaultScore,
					instanceOverrideScore,
					scoreOverride: effectiveScore,
				};
			});

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
				defaultScore: templateCF.defaultScore,
				instanceOverrideScore: templateCF.instanceOverrideScore,
				scoreOverride: templateCF.scoreOverride ?? 0,
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
	 * TRaSH Guides CFs include trash_id in their metadata or specifications
	 */
	private extractTrashId(cf: CustomFormat): string | null {
		// Strategy 1: Check specifications for trash_id in fields
		// TRaSH Guides often stores metadata in specification fields
		for (const spec of cf.specifications || []) {
			if (spec.fields) {
				// Check common field patterns for trash_id
				const trashIdField = spec.fields["trash_id"] || spec.fields["trashId"];
				if (typeof trashIdField === "string" && trashIdField.length > 0) {
					return trashIdField;
				}
			}
		}

		// Strategy 2: Check for TRaSH ID pattern in CF name
		// TRaSH Guides CFs may have format: "CF Name [trash_id]" or similar
		const trashIdMatch = cf.name.match(/\[([a-f0-9-]{36})\]$/i);
		if (trashIdMatch && trashIdMatch[1]) {
			return trashIdMatch[1];
		}

		// Strategy 3: Fallback to CF name as identifier
		// This allows matching by name when trash_id is not explicitly stored
		// Note: This is less reliable but provides backward compatibility
		return cf.name;
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
