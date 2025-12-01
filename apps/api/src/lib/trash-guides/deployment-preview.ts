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
	UnmatchedCustomFormat,
} from "@arr/shared";
import { createArrApiClient } from "./arr-api-client.js";
import type { CustomFormat, CustomFormatSpecification } from "./arr-api-client.js";
import { deepEqual } from "../utils/deep-equal.js";

// ============================================================================
// Score Calculation Helper
// ============================================================================

/**
 * Calculates the expected score for a Custom Format using priority rules:
 * 1. Template-level override (user's wizard selection or instance-specific override)
 * 2. TRaSH Guides score from profile's score set
 * 3. TRaSH Guides default score
 * 4. Fallback to 0
 */
function calculateExpectedScore(
	templateCF: {
		scoreOverride?: number;
		originalConfig?: {
			trash_scores?: Record<string, number>;
		};
	},
	scoreSet: string | undefined | null,
): number {
	// Priority 1: User's score override from wizard/template
	if (templateCF.scoreOverride !== undefined && templateCF.scoreOverride !== null) {
		return templateCF.scoreOverride;
	}

	// Priority 2: TRaSH Guides score from profile's score set
	if (scoreSet && templateCF.originalConfig?.trash_scores?.[scoreSet] !== undefined) {
		return templateCF.originalConfig.trash_scores[scoreSet];
	}

	// Priority 3: TRaSH Guides default score
	if (templateCF.originalConfig?.trash_scores?.default !== undefined) {
		return templateCF.originalConfig.trash_scores.default;
	}

	// Priority 4: Fallback to 0
	return 0;
}

// ============================================================================
// Spec Normalization Utilities
// ============================================================================

/**
 * Normalized specification for comparison
 * Both TRaSH and Radarr formats are converted to this structure
 */
interface NormalizedSpec {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
}

/**
 * Normalize fields from either format to a consistent object format
 * TRaSH format: { value: 5 }
 * Radarr format: [{ name: "value", value: 5 }]
 * Output: { value: 5 }
 */
function normalizeFields(fields: unknown): Record<string, unknown> {
	if (!fields) {
		return {};
	}

	// If already an object (TRaSH format), return as-is
	if (!Array.isArray(fields) && typeof fields === 'object') {
		return fields as Record<string, unknown>;
	}

	// If array (Radarr format), convert to object
	if (Array.isArray(fields)) {
		const result: Record<string, unknown> = {};
		for (const field of fields) {
			if (field && typeof field === 'object' && 'name' in field && 'value' in field) {
				result[field.name as string] = field.value;
			}
		}
		return result;
	}

	return {};
}

/**
 * Normalize a specification to a consistent format for comparison
 */
function normalizeSpec(spec: any): NormalizedSpec {
	return {
		name: spec.name || '',
		implementation: spec.implementation || '',
		negate: Boolean(spec.negate),
		required: Boolean(spec.required),
		fields: normalizeFields(spec.fields),
	};
}

/**
 * Compare two normalized specs for equality
 * Note: Instance may have additional fields added by Radarr/Sonarr API (e.g., exceptLanguage)
 * We only check that template fields match their instance counterparts, allowing extra instance fields
 */
function specsAreEqual(spec1: NormalizedSpec, spec2: NormalizedSpec): boolean {
	if (spec1.name !== spec2.name) return false;
	if (spec1.implementation !== spec2.implementation) return false;
	if (spec1.negate !== spec2.negate) return false;
	if (spec1.required !== spec2.required) return false;

	// Compare fields - only check that all template fields exist and match in instance
	// Instance may have additional fields added by Radarr/Sonarr (e.g., exceptLanguage for LanguageSpecification)
	const templateKeys = Object.keys(spec1.fields);

	for (const key of templateKeys) {
		// Check if this template field exists in instance
		if (!(key in spec2.fields)) {
			return false;
		}
		// Check if values match (use deepEqual for deterministic comparison)
		const val1 = spec1.fields[key];
		const val2 = spec2.fields[key];
		if (!deepEqual(val1, val2)) {
			return false;
		}
	}

	return true;
}

/**
 * Compare two specification arrays for equality (order-independent)
 */
function specArraysAreEqual(templateSpecs: any[], instanceSpecs: CustomFormatSpecification[]): boolean {
	if (templateSpecs.length !== instanceSpecs.length) {
		return false;
	}

	const normalizedTemplate = templateSpecs.map(normalizeSpec);
	const normalizedInstance = instanceSpecs.map(normalizeSpec);

	// Sort by name+implementation for consistent comparison
	const sortKey = (s: NormalizedSpec) => `${s.name}:${s.implementation}`;
	normalizedTemplate.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
	normalizedInstance.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

	for (let i = 0; i < normalizedTemplate.length; i++) {
		if (!specsAreEqual(normalizedTemplate[i]!, normalizedInstance[i]!)) {
			return false;
		}
	}

	return true;
}

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
		let instanceQualityProfiles: Array<{
			id: number;
			name: string;
			formatItems: Array<{ format: number; score: number }>;
		}> = [];

		try {
			const status = await apiClient.getSystemStatus();
			instanceReachable = true;
			instanceVersion = status.version;
			instanceCustomFormats = await apiClient.getCustomFormats();
			instanceQualityProfiles = await apiClient.getQualityProfiles();
		} catch (error) {
			// Instance unreachable - will return preview with warning
			console.error("Failed to reach instance:", error);
		}

		// Parse template config - fail fast on corrupted data
		let templateConfig: {
			customFormats?: Array<any>;
			qualityProfile?: {
				trash_score_set?: string;
			};
		};
		try {
			templateConfig = JSON.parse(template.configData);
		} catch (parseError) {
			throw new Error(
				`Template ${template.id} has corrupted configData: ${parseError instanceof Error ? parseError.message : String(parseError)}`
			);
		}
		const scoreSet = templateConfig.qualityProfile?.trash_score_set;
		const rawTemplateCFs = (templateConfig.customFormats || []) as Array<{
			trashId: string;
			name: string;
			scoreOverride?: number;
			originalConfig: {
				trash_scores?: Record<string, number>;
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
				// Get the score using proper priority:
				// 1. User's score override from wizard/template
				// 2. TRaSH Guides score from profile's score set
				// 3. TRaSH Guides default score
				// 4. Fallback to 0
				const defaultScore = calculateExpectedScore(cf, scoreSet);
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

		// Build instance CF maps for matching
		// We need both trashId-based matching (ideal) and name-based matching (fallback)
		// since Radarr doesn't natively store trash_id
		const instanceCFByTrashId = new Map<string, CustomFormat>();
		const instanceCFByName = new Map<string, CustomFormat>();

		for (const instanceCF of instanceCustomFormats) {
			// Try to extract trash_id from specifications (rare - Radarr doesn't store this)
			const trashId = this.extractTrashIdFromSpecs(instanceCF);
			if (trashId) {
				instanceCFByTrashId.set(trashId, instanceCF);
			}
			// Always map by name for fallback matching
			instanceCFByName.set(instanceCF.name, instanceCF);
		}

		// Build map of CF scores from the target quality profile in the instance
		// This allows us to detect score conflicts (when instance score differs from template)
		const instanceCFScoreMap = new Map<number, number>(); // CF ID -> score
		const targetProfileName = template.name || "TRaSH Guides HD/UHD";
		const targetProfile = instanceQualityProfiles.find(p => p.name === targetProfileName);
		if (targetProfile) {
			for (const formatItem of targetProfile.formatItems || []) {
				instanceCFScoreMap.set(formatItem.format, formatItem.score);
			}
		}

		// Track which instance CFs are matched by template CFs
		const matchedInstanceCFIds = new Set<number>();

		// Compare and generate deployment items
		const deploymentItems: CustomFormatDeploymentItem[] = [];
		let newCount = 0;
		let updateCount = 0;
		let skipCount = 0;
		let totalConflicts = 0;
		let unresolvedConflicts = 0;

		for (const templateCF of templateCFs) {
			// Try to match by trashId first, then fall back to name matching
			// This is consistent with deployment-executor.ts behavior
			let instanceCF = instanceCFByTrashId.get(templateCF.trashId);
			if (!instanceCF) {
				instanceCF = instanceCFByName.get(templateCF.name);
			}

			const conflicts: CustomFormatConflict[] = [];
			let action: DeploymentAction = "create";
			let hasConflicts = false;

			if (instanceCF) {
				// CF exists in instance - check for specification differences
				action = "update";

				// Track that this instance CF is matched by a template CF
				if (instanceCF.id !== undefined) {
					matchedInstanceCFIds.add(instanceCF.id);
				}

				// Compare specifications using normalized comparison
				// This handles the format difference between TRaSH (object) and Radarr (array)
				const rawTemplateSpecs = templateCF.originalConfig?.specifications;
				const templateSpecs: any[] = Array.isArray(rawTemplateSpecs) ? rawTemplateSpecs : [];
				const instanceSpecs = instanceCF.specifications || [];

				if (!specArraysAreEqual(templateSpecs, instanceSpecs)) {
					conflicts.push({
						cfTrashId: templateCF.trashId,
						cfName: templateCF.name,
						conflictType: "specification_mismatch",
						templateValue: templateSpecs,
						instanceValue: instanceSpecs,
						suggestedResolution: "use_template",
					});
					hasConflicts = true;
					totalConflicts++;
					unresolvedConflicts++; // Unresolved until user chooses
				}

				// Check for score conflicts - when the instance's Quality Profile has a different
				// score for this CF than what the template expects
				if (instanceCF.id !== undefined && targetProfile) {
					const instanceScore = instanceCFScoreMap.get(instanceCF.id);
					const expectedScore = calculateExpectedScore(templateCF, scoreSet);

					// Only flag as conflict if instance has a score AND it differs from template
					// (instanceScore of 0 is valid and should be compared)
					if (instanceScore !== undefined && instanceScore !== expectedScore) {
						conflicts.push({
							cfTrashId: templateCF.trashId,
							cfName: templateCF.name,
							conflictType: "score_mismatch",
							templateValue: expectedScore,
							instanceValue: instanceScore,
							suggestedResolution: "use_template",
						});
						hasConflicts = true;
						totalConflicts++;
						unresolvedConflicts++;
					}
				}

				updateCount++;
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

		// Build list of unmatched CFs - instance CFs that weren't matched by any template CF
		// These are CFs in the instance that either:
		// 1. Were manually created (not from TRaSH Guides)
		// 2. Are from a different TRaSH template
		// 3. Have different names than the template expects
		const unmatchedCFs: UnmatchedCustomFormat[] = [];
		for (const instanceCF of instanceCustomFormats) {
			if (instanceCF.id !== undefined && !matchedInstanceCFIds.has(instanceCF.id)) {
				unmatchedCFs.push({
					instanceId: instanceCF.id,
					name: instanceCF.name,
					reason: "Not part of current template - may be from other templates or manually created",
				});
			}
		}

		// Allow deployment as long as instance is reachable
		// Users can choose to proceed with conflicts (template values will be used by default)
		const canDeploy = instanceReachable;
		// Indicate if there are conflicts that the user should review
		const requiresConflictResolution = unresolvedConflicts > 0;

		// Build warnings list
		const warnings: string[] = [];
		if (totalConflicts > 0) {
			warnings.push(
				`${totalConflicts} Custom Format${totalConflicts === 1 ? "" : "s"} differ${totalConflicts === 1 ? "s" : ""} between the template and instance. ` +
				`By default, deploying will update these to match the template. You can review and skip specific CFs if needed.`
			);
		}
		if (unmatchedCFs.length > 0) {
			warnings.push(
				`${unmatchedCFs.length} Custom Format${unmatchedCFs.length === 1 ? "" : "s"} in the instance ${unmatchedCFs.length === 1 ? "is" : "are"} not part of this template. ` +
				`These will not be modified by this deployment.`
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
	 * Extract trash_id from Custom Format specifications only
	 * Returns null if no trash_id found (Radarr doesn't natively store trash_id)
	 * Name-based matching is handled separately in generatePreview
	 */
	private extractTrashIdFromSpecs(cf: CustomFormat): string | null {
		// Strategy 1: Check specifications for trash_id in fields
		// TRaSH Guides may store metadata in specification fields (rare)
		for (const spec of cf.specifications || []) {
			if (spec.fields) {
				// Handle both array format (Radarr API) and object format
				if (Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find((f: { name: string; value: unknown }) => f.name === 'trash_id');
					if (trashIdField) {
						return String(trashIdField.value);
					}
				} else if (typeof spec.fields === 'object') {
					// Check common field patterns for trash_id
					const fields = spec.fields as Record<string, unknown>;
					const trashIdValue = fields["trash_id"] || fields["trashId"];
					if (typeof trashIdValue === "string" && trashIdValue.length > 0) {
						return trashIdValue;
					}
				}
			}
		}

		// Strategy 2: Check for TRaSH ID pattern in CF name
		// TRaSH Guides CFs may have format: "CF Name [trash_id]" or similar
		const trashIdMatch = cf.name.match(/\[([a-f0-9-]{36})\]$/i);
		if (trashIdMatch && trashIdMatch[1]) {
			return trashIdMatch[1];
		}

		// No trash_id found - name-based matching is handled separately
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
