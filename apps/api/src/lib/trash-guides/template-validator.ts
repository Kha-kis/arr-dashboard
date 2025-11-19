/**
 * Template Validation Service
 *
 * Validates imported templates for compatibility and data integrity
 */

import type {
	TemplateExportFormat,
	TemplateImportValidation,
	ValidationError,
	ValidationWarning,
	TemplateConflict,
	TemplateCompatibility,
	CompatibilityIssue,
} from "@arr/shared";
import type { PrismaClient } from "@prisma/client";

export class TemplateValidator {
	constructor(private prisma: PrismaClient) {}

	/**
	 * Validate imported template
	 */
	async validateImport(
		importData: TemplateExportFormat,
		userId: string,
	): Promise<TemplateImportValidation> {
		const errors: ValidationError[] = [];
		const warnings: ValidationWarning[] = [];
		const conflicts: TemplateConflict[] = [];

		// Validate structure
		this.validateStructure(importData, errors);

		// Validate version compatibility
		this.validateVersion(importData, warnings);

		// Check for conflicts
		await this.checkConflicts(importData, userId, conflicts);

		// Validate custom formats
		this.validateCustomFormats(importData, errors, warnings);

		// Validate quality profile settings
		this.validateQualityProfile(importData, warnings);

		return {
			valid: errors.length === 0,
			errors,
			warnings,
			conflicts,
		};
	}

	/**
	 * Check template compatibility
	 */
	checkCompatibility(importData: TemplateExportFormat): TemplateCompatibility {
		const issues: CompatibilityIssue[] = [];

		// Check version compatibility
		const version = importData.version;
		if (version !== "1.0" && version !== "2.0") {
			issues.push({
				type: "version",
				severity: "warning",
				message: `Template was exported with version ${version}. This version supports 1.0 and 2.0.`,
			});
		}

		// Check service type
		const serviceType = importData.template.serviceType;
		if (serviceType !== "RADARR" && serviceType !== "SONARR") {
			issues.push({
				type: "service",
				severity: "error",
				message: `Unsupported service type: ${serviceType}`,
			});
		}

		// Check for required custom formats
		const config = importData.template.config;
		if (config?.customFormats && config.customFormats.length === 0) {
			issues.push({
				type: "customFormat",
				severity: "warning",
				message: "Template has no custom formats defined",
			});
		}

		// Check for advanced features
		if (config?.completeQualityProfile) {
			issues.push({
				type: "feature",
				severity: "info",
				message: "Template includes complete quality profile settings (advanced feature)",
				affectedFeatures: ["quality definitions", "cutoff settings", "upgrade behavior"],
			});
		}

		return {
			compatible: !issues.some((i) => i.severity === "error"),
			issues,
		};
	}

	/**
	 * Validate template structure
	 */
	private validateStructure(
		importData: TemplateExportFormat,
		errors: ValidationError[],
	): void {
		// Check required fields
		if (!importData.version) {
			errors.push({
				field: "version",
				message: "Missing version field",
				severity: "error",
			});
		}

		if (!importData.template) {
			errors.push({
				field: "template",
				message: "Missing template data",
				severity: "error",
			});
			return; // Can't continue without template data
		}

		if (!importData.template.name) {
			errors.push({
				field: "template.name",
				message: "Template name is required",
				severity: "error",
			});
		}

		if (!importData.template.serviceType) {
			errors.push({
				field: "template.serviceType",
				message: "Service type is required",
				severity: "error",
			});
		}

		if (!importData.template.config) {
			errors.push({
				field: "template.config",
				message: "Template configuration is required",
				severity: "error",
			});
		}
	}

	/**
	 * Validate version compatibility
	 */
	private validateVersion(
		importData: TemplateExportFormat,
		warnings: ValidationWarning[],
	): void {
		const version = importData.version;
		const currentVersion = "2.0";

		if (version < currentVersion) {
			warnings.push({
				field: "version",
				message: `Template was exported with older version ${version}. Some features may not be available.`,
				severity: "warning",
				suggestion: "Re-export from the source to get the latest format",
			});
		}

		if (version > currentVersion) {
			warnings.push({
				field: "version",
				message: `Template was exported with newer version ${version}. Some features may not import correctly.`,
				severity: "warning",
				suggestion: "Update your application to the latest version",
			});
		}
	}

	/**
	 * Check for naming and data conflicts
	 */
	private async checkConflicts(
		importData: TemplateExportFormat,
		userId: string,
		conflicts: TemplateConflict[],
	): Promise<void> {
		// Check for name conflicts
		const existingTemplate = await this.prisma.trashTemplate.findFirst({
			where: {
				userId,
				name: importData.template.name,
				serviceType: importData.template.serviceType,
				deletedAt: null,
			},
		});

		if (existingTemplate) {
			conflicts.push({
				type: "name",
				message: `A template named "${importData.template.name}" already exists`,
				existingValue: existingTemplate.name,
				incomingValue: importData.template.name,
				resolution: "rename",
			});
		}

		// Note: Custom formats are stored within templates as JSON in configData
		// No separate customFormat table exists, so no conflict check needed here
		// Custom format conflicts would be handled at the template level (name conflicts above)
	}

	/**
	 * Validate custom formats
	 */
	private validateCustomFormats(
		importData: TemplateExportFormat,
		errors: ValidationError[],
		warnings: ValidationWarning[],
	): void {
		const config = importData.template.config;

		if (!config?.customFormats) {
			warnings.push({
				field: "customFormats",
				message: "No custom formats defined in template",
				severity: "warning",
			});
			return;
		}

		// Validate each custom format
		config.customFormats.forEach((cf: any, index: number) => {
			if (!cf.trash_id) {
				errors.push({
					field: `customFormats[${index}].trash_id`,
					message: "Custom format is missing trash_id",
					severity: "error",
				});
			}

			if (cf.specifications && cf.specifications.length === 0) {
				warnings.push({
					field: `customFormats[${index}].specifications`,
					message: `Custom format "${cf.name || cf.trash_id}" has no specifications`,
					severity: "warning",
				});
			}
		});
	}

	/**
	 * Validate quality profile settings
	 */
	private validateQualityProfile(
		importData: TemplateExportFormat,
		warnings: ValidationWarning[],
	): void {
		const config = importData.template.config;

		if (config?.completeQualityProfile) {
			// Validate complete quality profile
			const profile = config.completeQualityProfile;

			if (!profile.cutoff) {
				warnings.push({
					field: "completeQualityProfile.cutoff",
					message: "Quality profile cutoff is not set",
					severity: "warning",
				});
			}

			if (!profile.items || profile.items.length === 0) {
				warnings.push({
					field: "completeQualityProfile.items",
					message: "Quality profile has no quality definitions",
					severity: "warning",
				});
			}
		} else if (config?.qualityProfile) {
			// Validate basic quality profile
			if (!config.qualityProfile.cutoff) {
				warnings.push({
					field: "qualityProfile.cutoff",
					message: "Quality cutoff is not set",
					severity: "warning",
				});
			}
		}
	}
}

export function createTemplateValidator(prisma: PrismaClient): TemplateValidator {
	return new TemplateValidator(prisma);
}
