/**
 * Enhanced Template Service
 *
 * Extended template export/import with metadata and validation
 */

import type {
	TemplateCompatibility,
	TemplateConfig,
	TemplateCustomFormat,
	TemplateExportFormat,
	TemplateExportOptions,
	TemplateImportOptions,
	TemplateImportValidation,
	TemplateMetadata,
} from "@arr/shared";
import type { PrismaClient, ServiceType, TrashTemplate } from "@prisma/client";
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
		let config: TemplateConfig;
		try {
			config = JSON.parse(template.configData) as TemplateConfig;
		} catch (parseError) {
			throw new Error(
				`Invalid template config data: ${parseError instanceof Error ? parseError.message : "Parse error"}`,
			);
		}
		if (!options.includeQualitySettings) {
			const { qualityProfile, completeQualityProfile, qualitySize, ...rest } = config;
			config = rest as TemplateConfig;
		}

		if (!options.includeCustomConditions) {
			// Remove custom specification modifications from originalConfig
			if (config.customFormats) {
				config.customFormats = config.customFormats.map((cf: TemplateCustomFormat) => {
					if (cf.originalConfig?.specifications) {
						const { specifications: _specifications, ...restOriginal } = cf.originalConfig;
						return { ...cf, originalConfig: restOriginal } as TemplateCustomFormat;
					}
					return cf;
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
		template?: TrashTemplate;
		validation?: TemplateImportValidation;
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
				}
				if (options.onNameConflict === "rename" || !options.onNameConflict) {
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
							throw new Error(
								`Failed to find unique name for template after ${MAX_RENAME_ATTEMPTS} attempts`,
							);
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
				// Remove custom specification modifications from originalConfig
				if (config.customFormats) {
					config.customFormats = config.customFormats.map((cf: TemplateCustomFormat) => {
						if (cf.originalConfig?.specifications) {
							const { specifications: _specifications, ...restOriginal } = cf.originalConfig;
							return { ...cf, originalConfig: restOriginal } as TemplateCustomFormat;
						}
						return cf;
					});
				}
			}

			// Create or update template using transaction to prevent race conditions
			const template = await this.createOrUpdateTemplateAtomic({
				userId,
				name,
				originalName: importData.template.name,
				description: importData.template.description,
				serviceType: importData.template.serviceType,
				configData: JSON.stringify(config),
				shouldReplace: options.onNameConflict === "replace" && !!nameConflict,
			});

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
	 * Atomically create or update a template using a transaction with retry logic
	 * to handle race conditions and unique constraint violations.
	 */
	private async createOrUpdateTemplateAtomic(params: {
		userId: string;
		name: string;
		originalName: string;
		description: string | null | undefined;
		serviceType: ServiceType;
		configData: string;
		shouldReplace: boolean;
	}): Promise<TrashTemplate> {
		const MAX_RETRIES = 3;
		const RETRY_DELAY_MS = 100;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.prisma.$transaction(
					async (tx) => {
						if (params.shouldReplace) {
							// Try to find and update existing template atomically
							const existing = await tx.trashTemplate.findFirst({
								where: {
									userId: params.userId,
									name: params.originalName,
									serviceType: params.serviceType,
									deletedAt: null,
								},
							});

							if (existing) {
								return await tx.trashTemplate.update({
									where: { id: existing.id },
									data: {
										description: params.description,
										configData: params.configData,
										updatedAt: new Date(),
									},
								});
							}
						}

						// Create new template
						return await tx.trashTemplate.create({
							data: {
								userId: params.userId,
								name: params.name,
								description: params.description,
								serviceType: params.serviceType,
								configData: params.configData,
							},
						});
					},
					{
						// Use serializable isolation to prevent race conditions
						// Note: SQLite uses serializable by default, but this ensures
						// consistency across different database backends
						isolationLevel: "Serializable",
						timeout: 10000, // 10 second timeout
					},
				);
			} catch (error) {
				// Check if this is a retryable error (unique constraint or transaction conflict)
				const isRetryable =
					error instanceof Error &&
					(error.message.includes("Unique constraint") ||
						error.message.includes("SQLITE_BUSY") ||
						error.message.includes("database is locked") ||
						error.message.includes("Transaction failed") ||
						error.message.includes("could not serialize"));

				if (isRetryable && attempt < MAX_RETRIES) {
					// Exponential backoff with jitter
					const delay = RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 50;
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}

				// Re-throw if not retryable or max retries exceeded
				throw error;
			}
		}

		// This should never be reached due to the throw in the catch block
		throw new Error("Failed to create or update template after maximum retries");
	}

	/**
	 * Validate template before import
	 */
	async validateTemplateImport(
		userId: string,
		jsonData: string,
	): Promise<{
		valid: boolean;
		validation: TemplateImportValidation;
		compatibility: TemplateCompatibility;
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

export function createEnhancedTemplateService(prisma: PrismaClient): EnhancedTemplateService {
	return new EnhancedTemplateService(prisma);
}
