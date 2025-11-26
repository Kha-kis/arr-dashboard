/**
 * Enhanced Template Service
 *
 * Extended template export/import with metadata and validation
 */

import type { PrismaClient } from "@prisma/client";
import type {
	TemplateExportFormat,
	TemplateExportOptions,
	TemplateImportOptions,
	TemplateMetadata,
} from "@arr/shared";
import { createTemplateValidator } from "./template-validator.js";

export class EnhancedTemplateService {
	constructor(private prisma: PrismaClient) {}

	/**
	 * Export template with enhanced metadata
	 */
	async exportTemplateEnhanced(
		templateId: string,
		userId: string,
		options: TemplateExportOptions = {},
	): Promise<string> {
		const template = await this.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId,
				deletedAt: null,
			},
		});

		if (!template) {
			throw new Error("Template not found or access denied");
		}

		// Build metadata
		const metadata: TemplateMetadata = {
			author: options.author,
			tags: options.tags || [],
			category: options.category,
			notes: options.notes,
			lastUpdated: new Date().toISOString(),
			trashGuidesVersion: template.trashGuidesVersion || undefined,
			lastSync: template.lastSyncedAt?.toISOString(),
		};

		// Filter config based on options
		let config: any;
		try {
			config = JSON.parse(template.configData);
		} catch (parseError) {
			throw new Error(`Invalid template config data: ${parseError instanceof Error ? parseError.message : "Parse error"}`);
		}
		if (!options.includeQualitySettings) {
			const { qualityProfile, completeQualityProfile, qualitySize, ...rest } = config;
			config = rest;
		}

		if (!options.includeCustomConditions) {
			// Remove custom specification modifications
			if (config.customFormats) {
				config.customFormats = config.customFormats.map((cf: any) => {
					const { specifications, ...rest } = cf;
					return rest;
				});
			}
		}

		const exportData: TemplateExportFormat = {
			version: "2.0",
			exportedAt: new Date().toISOString(),
			exportedBy: userId,
			template: {
				name: template.name,
				description: template.description,
				serviceType: template.serviceType as "RADARR" | "SONARR",
				config,
				...(options.includeMetadata !== false && { metadata }),
			},
		};

		return JSON.stringify(exportData, null, 2);
	}

	/**
	 * Import template with validation and conflict resolution
	 */
	async importTemplateEnhanced(
		userId: string,
		jsonData: string,
		options: TemplateImportOptions = {},
	): Promise<{
		success: boolean;
		template?: any;
		validation?: any;
		error?: string;
	}> {
		try {
			// Parse JSON
			const importData: TemplateExportFormat = JSON.parse(jsonData);

			// Validate import
			const validator = createTemplateValidator(this.prisma);
			const validation = await validator.validateImport(importData, userId);

			// Check if strict validation is enabled
			if (options.strictValidation && !validation.valid) {
				return {
					success: false,
					validation,
					error: "Template validation failed",
				};
			}

			// Check compatibility
			const compatibility = validator.checkCompatibility(importData);
			if (!compatibility.compatible && !options.allowPartialImport) {
				return {
					success: false,
					validation,
					error: "Template is not compatible with this system",
				};
			}

			// Handle name conflicts
			let name = importData.template.name;
			const nameConflict = validation.conflicts.find((c) => c.type === "name");

			if (nameConflict) {
				if (options.onNameConflict === "cancel") {
					return {
						success: false,
						validation,
						error: "Template name already exists",
					};
				} else if (options.onNameConflict === "rename" || !options.onNameConflict) {
					// Auto-rename with upper bound to prevent infinite loop
					const MAX_RENAME_ATTEMPTS = 1000;
					const baseName = importData.template.name;
					let counter = 1;
					while (
						await this.prisma.trashTemplate.findFirst({
							where: {
								userId,
								name,
								serviceType: importData.template.serviceType,
								deletedAt: null,
							},
						})
					) {
						if (counter > MAX_RENAME_ATTEMPTS) {
							throw new Error(`Failed to find unique name for template after ${MAX_RENAME_ATTEMPTS} attempts`);
						}
						name = `${baseName} (${counter})`;
						counter++;
					}
				}
				// If "replace", we'll update the existing template
			}

			// Filter config based on options
			let config = importData.template.config;
			if (!options.includeQualitySettings) {
				const { qualityProfile, completeQualityProfile, qualitySize, ...rest } = config;
				config = rest;
			}

			if (!options.includeCustomConditions) {
				// Remove custom specification modifications
				if (config.customFormats) {
					config.customFormats = config.customFormats.map((cf: any) => {
						const { specifications, ...rest } = cf;
						return rest;
					});
				}
			}

			// Create or update template
			let template;
			if (options.onNameConflict === "replace" && nameConflict) {
				// Update existing template
				const existing = await this.prisma.trashTemplate.findFirst({
					where: {
						userId,
						name: importData.template.name,
						serviceType: importData.template.serviceType,
						deletedAt: null,
					},
				});

				if (existing) {
					template = await this.prisma.trashTemplate.update({
						where: { id: existing.id },
						data: {
							description: importData.template.description,
							configData: JSON.stringify(config),
							updatedAt: new Date(),
						},
					});
				}
			}

			if (!template) {
				// Create new template
				template = await this.prisma.trashTemplate.create({
					data: {
						userId,
						name,
						description: importData.template.description,
						serviceType: importData.template.serviceType,
						configData: JSON.stringify(config),
					},
				});
			}

			return {
				success: true,
				template,
				validation,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Failed to import template",
			};
		}
	}

	/**
	 * Validate template before import
	 */
	async validateTemplateImport(
		userId: string,
		jsonData: string,
	): Promise<{
		valid: boolean;
		validation: any;
		compatibility: any;
	}> {
		try {
			const importData: TemplateExportFormat = JSON.parse(jsonData);
			const validator = createTemplateValidator(this.prisma);

			const validation = await validator.validateImport(importData, userId);
			const compatibility = validator.checkCompatibility(importData);

			return {
				valid: validation.valid && compatibility.compatible,
				validation,
				compatibility,
			};
		} catch (error) {
			throw new Error(
				`Failed to validate template: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}
}

export function createEnhancedTemplateService(
	prisma: PrismaClient,
): EnhancedTemplateService {
	return new EnhancedTemplateService(prisma);
}
