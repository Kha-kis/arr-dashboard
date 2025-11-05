/**
 * TRaSH Guides Template Service
 *
 * Manages template CRUD operations, validation, and metadata tracking
 */

import { PrismaClient } from "@prisma/client";
import type {
	TrashTemplate,
	CreateTemplateRequest,
	UpdateTemplateRequest,
	TemplateConfig,
} from "@arr/shared";

// ============================================================================
// Types
// ============================================================================

export interface TemplateInstanceInfo {
	instanceId: string;
	instanceName: string;
	instanceType: "RADARR" | "SONARR";
	lastAppliedAt?: Date;
	hasActiveSchedule: boolean;
}

export interface TemplateStats {
	templateId: string;
	usageCount: number;
	lastUsedAt?: Date;
	instances: TemplateInstanceInfo[];
	formatCount: number;
	groupCount: number;
	isActive: boolean;
	activeInstanceCount: number;
}

export interface TemplateListOptions {
	userId?: string;
	serviceType?: "RADARR" | "SONARR";
	includeDeleted?: boolean;
	active?: boolean; // Filter by active status
	limit?: number;
	offset?: number;
}

// ============================================================================
// Template Service Class
// ============================================================================

export class TemplateService {
	private prisma: PrismaClient;

	constructor(prisma: PrismaClient) {
		this.prisma = prisma;
	}

	/**
	 * Create a new template
	 */
	async createTemplate(
		userId: string,
		request: CreateTemplateRequest,
	): Promise<TrashTemplate> {
		// Validate name uniqueness for user
		const existing = await this.prisma.trashTemplate.findFirst({
			where: {
				userId,
				name: request.name,
				deletedAt: null,
			},
		});

		if (existing) {
			throw new Error(`Template with name "${request.name}" already exists`);
		}

		// Create template
		const template = await this.prisma.trashTemplate.create({
			data: {
				userId,
				name: request.name,
				description: request.description || null,
				serviceType: request.serviceType,
				configData: JSON.stringify(request.config),
			},
		});

		return this.mapToTemplate(template);
	}

	/**
	 * Get template by ID
	 */
	async getTemplate(templateId: string, userId: string): Promise<TrashTemplate | null> {
		const template = await this.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId,
				deletedAt: null,
			},
		});

		if (!template) {
			return null;
		}

		return this.mapToTemplate(template);
	}

	/**
	 * List templates with filtering
	 */
	async listTemplates(options: TemplateListOptions = {}): Promise<TrashTemplate[]> {
		// If filtering by active status, we need to include schedules
		const includeSchedules = options.active !== undefined;

		const templates = await this.prisma.trashTemplate.findMany({
			where: {
				...(options.userId && { userId: options.userId }),
				...(options.serviceType && { serviceType: options.serviceType }),
				...(options.includeDeleted ? {} : { deletedAt: null }),
			},
			...(includeSchedules && {
				include: {
					schedules: {
						select: {
							enabled: true,
						},
						where: {
							enabled: true,
						},
					},
				},
			}),
			orderBy: {
				updatedAt: "desc",
			},
		});

		// Filter by active status if specified
		let filteredTemplates = templates;
		if (options.active !== undefined) {
			filteredTemplates = templates.filter((t) => {
				const hasActiveSchedule = "schedules" in t && Array.isArray(t.schedules) && t.schedules.length > 0;
				return options.active ? hasActiveSchedule : !hasActiveSchedule;
			});
		}

		// Apply pagination after filtering
		const paginatedTemplates = filteredTemplates.slice(
			options.offset || 0,
			options.offset ? (options.offset + (options.limit || filteredTemplates.length)) : (options.limit || filteredTemplates.length)
		);

		return paginatedTemplates.map((t) => this.mapToTemplate(t));
	}

	/**
	 * Update template
	 */
	async updateTemplate(
		templateId: string,
		userId: string,
		request: UpdateTemplateRequest,
	): Promise<TrashTemplate> {
		// Check ownership
		const existing = await this.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId,
				deletedAt: null,
			},
		});

		if (!existing) {
			throw new Error("Template not found or access denied");
		}

		// Check name uniqueness if name is being updated
		if (request.name && request.name !== existing.name) {
			const nameConflict = await this.prisma.trashTemplate.findFirst({
				where: {
					userId,
					name: request.name,
					deletedAt: null,
					id: { not: templateId },
				},
			});

			if (nameConflict) {
				throw new Error(`Template with name "${request.name}" already exists`);
			}
		}

		// Update template
		const updated = await this.prisma.trashTemplate.update({
			where: { id: templateId },
			data: {
				...(request.name && { name: request.name }),
				...(request.description !== undefined && { description: request.description || null }),
				...(request.config && { configData: JSON.stringify(request.config) }),
			},
		});

		return this.mapToTemplate(updated);
	}

	/**
	 * Delete template (soft delete)
	 */
	async deleteTemplate(templateId: string, userId: string): Promise<boolean> {
		// Check ownership
		const existing = await this.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId,
				deletedAt: null,
			},
		});

		if (!existing) {
			return false;
		}

		// Soft delete
		await this.prisma.trashTemplate.update({
			where: { id: templateId },
			data: {
				deletedAt: new Date(),
			},
		});

		return true;
	}

	/**
	 * Duplicate template
	 */
	async duplicateTemplate(
		templateId: string,
		userId: string,
		newName: string,
	): Promise<TrashTemplate> {
		// Get source template
		const source = await this.getTemplate(templateId, userId);
		if (!source) {
			throw new Error("Template not found or access denied");
		}

		// Create duplicate
		return this.createTemplate(userId, {
			name: newName,
			description: source.description ? `Copy of ${source.description}` : undefined,
			serviceType: source.serviceType,
			config: source.config,
		});
	}

	/**
	 * Export template to JSON
	 */
	async exportTemplate(templateId: string, userId: string): Promise<string> {
		const template = await this.getTemplate(templateId, userId);
		if (!template) {
			throw new Error("Template not found or access denied");
		}

		const exportData = {
			version: "1.0",
			exported: new Date().toISOString(),
			template: {
				name: template.name,
				description: template.description,
				serviceType: template.serviceType,
				config: template.config,
			},
		};

		return JSON.stringify(exportData, null, 2);
	}

	/**
	 * Import template from JSON
	 */
	async importTemplate(userId: string, jsonData: string): Promise<TrashTemplate> {
		const data = JSON.parse(jsonData);

		// Validate import structure
		if (!data.template || !data.template.name || !data.template.serviceType || !data.template.config) {
			throw new Error("Invalid template import format");
		}

		// Check for name conflicts and auto-rename if needed
		let name = data.template.name;
		let counter = 1;
		while (
			await this.prisma.trashTemplate.findFirst({
				where: {
					userId,
					name,
					deletedAt: null,
				},
			})
		) {
			name = `${data.template.name} (${counter})`;
			counter++;
		}

		return this.createTemplate(userId, {
			name,
			description: data.template.description,
			serviceType: data.template.serviceType,
			config: data.template.config,
		});
	}

	/**
	 * Get template usage statistics with instance details
	 */
	async getTemplateStats(templateId: string, userId: string): Promise<TemplateStats | null> {
		const template = await this.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId,
				deletedAt: null,
			},
			include: {
				syncHistory: {
					select: {
						instanceId: true,
						completedAt: true,
						instance: {
							select: {
								id: true,
								label: true,
								service: true,
							},
						},
					},
					orderBy: {
						completedAt: "desc",
					},
				},
				schedules: {
					select: {
						instanceId: true,
						enabled: true,
					},
					where: {
						enabled: true,
					},
				},
			},
		});

		if (!template) {
			return null;
		}

		// Parse config to get counts
		const config = JSON.parse(template.configData) as TemplateConfig;
		const formatCount = config.customFormats.length;
		const groupCount = config.customFormatGroups.length;

		// Get unique instances and their info
		const instanceMap = new Map<string, TemplateInstanceInfo>();
		const activeScheduleIds = new Set(template.schedules.map((s) => s.instanceId).filter(Boolean));

		for (const history of template.syncHistory) {
			if (!instanceMap.has(history.instanceId)) {
				instanceMap.set(history.instanceId, {
					instanceId: history.instanceId,
					instanceName: history.instance.label,
					instanceType: history.instance.service as "RADARR" | "SONARR",
					lastAppliedAt: history.completedAt || undefined,
					hasActiveSchedule: activeScheduleIds.has(history.instanceId),
				});
			}
		}

		const instances = Array.from(instanceMap.values());
		const activeInstanceCount = instances.filter((i) => i.hasActiveSchedule).length;
		const isActive = activeInstanceCount > 0;
		const lastUsed = template.syncHistory[0]?.completedAt || undefined;

		return {
			templateId: template.id,
			usageCount: template.syncHistory.length,
			lastUsedAt: lastUsed,
			instances,
			formatCount,
			groupCount,
			isActive,
			activeInstanceCount,
		};
	}

	/**
	 * Validate template configuration
	 */
	validateTemplateConfig(config: TemplateConfig): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Validate custom formats
		if (!config.customFormats || !Array.isArray(config.customFormats)) {
			errors.push("customFormats must be an array");
		} else {
			for (const [index, cf] of config.customFormats.entries()) {
				if (!cf.trashId) {
					errors.push(`customFormats[${index}]: trashId is required`);
				}
				if (!cf.name) {
					errors.push(`customFormats[${index}]: name is required`);
				}
				if (!cf.conditionsEnabled || typeof cf.conditionsEnabled !== "object") {
					errors.push(`customFormats[${index}]: conditionsEnabled must be an object`);
				}
				if (!cf.originalConfig) {
					errors.push(`customFormats[${index}]: originalConfig is required`);
				}
			}
		}

		// Validate custom format groups
		if (config.customFormatGroups && !Array.isArray(config.customFormatGroups)) {
			errors.push("customFormatGroups must be an array");
		} else if (config.customFormatGroups) {
			for (const [index, cfg] of config.customFormatGroups.entries()) {
				if (!cfg.trashId) {
					errors.push(`customFormatGroups[${index}]: trashId is required`);
				}
				if (!cfg.name) {
					errors.push(`customFormatGroups[${index}]: name is required`);
				}
				if (typeof cfg.enabled !== "boolean") {
					errors.push(`customFormatGroups[${index}]: enabled must be a boolean`);
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Map Prisma model to TrashTemplate
	 */
	private mapToTemplate(prismaTemplate: any): TrashTemplate {
		return {
			id: prismaTemplate.id,
			userId: prismaTemplate.userId,
			name: prismaTemplate.name,
			description: prismaTemplate.description || undefined,
			serviceType: prismaTemplate.serviceType,
			config: JSON.parse(prismaTemplate.configData),
			createdAt: prismaTemplate.createdAt.toISOString(),
			updatedAt: prismaTemplate.updatedAt.toISOString(),
			deletedAt: prismaTemplate.deletedAt?.toISOString(),
		};
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a template service instance
 */
export function createTemplateService(prisma: PrismaClient): TemplateService {
	return new TemplateService(prisma);
}
