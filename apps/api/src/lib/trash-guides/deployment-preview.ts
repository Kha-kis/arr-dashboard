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
	UnmatchedCustomFormat,
} from "@arr/shared";
import { ArrApiClient, createArrApiClient } from "./arr-api-client.js";
import type { CustomFormat } from "./arr-api-client.js";
import { deepEqual } from "../utils/deep-equal.js";

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
	 * @param templateId - The template to preview
	 * @param instanceId - The target instance
	 * @param userId - The requesting user's ID (required for authorization)
	 */
	async generatePreview(
		templateId: string,
		instanceId: string,
		userId: string,
	): Promise<DeploymentPreview> {
		// Get template with ownership verification
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new Error("Template not found or access denied");
		}

		// Get instance with ownership verification
		const instance = await this.prisma.serviceInstance.findUnique({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			throw new Error("Instance not found or access denied");
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
		// Also collect CFs that couldn't be matched to a trash_id
		const instanceCFMap = new Map<string, CustomFormat>();
		const unmatchedCFs: UnmatchedCustomFormat[] = [];

		for (const instanceCF of instanceCustomFormats) {
			// Try to extract trash_id from CF name or specifications
			// TRaSH Guides CFs typically have trash_id in their structure
			const trashId = this.extractTrashId(instanceCF);
			if (trashId) {
				instanceCFMap.set(trashId, instanceCF);
			} else {
				// Could not extract trash_id - add to unmatched list
				unmatchedCFs.push({
					instanceId: instanceCF.id ?? 0, // Use 0 as fallback for CFs without an ID
					name: instanceCF.name,
					reason: "No trash_id found in specifications or name pattern",
				});
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

				// Check for specification differences using stable deep equality
				const templateSpecs = templateCF.originalConfig?.specifications || [];
				const instanceSpecs = instanceCF.specifications || [];

				if (!deepEqual(templateSpecs, instanceSpecs)) {
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

		// Build warnings list
		const warnings: string[] = [];
		if (unmatchedCFs.length > 0) {
			warnings.push(
				`${unmatchedCFs.length} Custom Format${unmatchedCFs.length === 1 ? "" : "s"} in the instance could not be matched to a TRaSH ID. ` +
				`These may be custom CFs not from TRaSH Guides, or CFs that were manually created/modified.`
			);
		}

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
				unmatchedCustomFormats: unmatchedCFs.length,
			},

			customFormats: deploymentItems,
			unmatchedCustomFormats: unmatchedCFs,

			canDeploy,
			requiresConflictResolution,
			instanceReachable,
			instanceVersion,
			warnings,
		};
	}

	/**
	 * Extract trash_id from Custom Format
	 * TRaSH Guides CFs include trash_id in their metadata or specifications
	 * Returns null if no trash_id can be reliably extracted
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

		// No reliable trash_id found - return null instead of falling back to name
		// This prevents unreliable name-based matching which can cause false positives
		return null;
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
