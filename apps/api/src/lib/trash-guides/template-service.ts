/**
 * TRaSH Guides Template Service
 *
 * Manages template CRUD operations, validation, and metadata tracking
 */

import type {
	CreateTemplateRequest,
	TemplateConfig,
	TrashTemplate,
	UpdateTemplateRequest,
} from "@arr/shared";
import type { Prisma, PrismaClient, TrashTemplate as PrismaTrashTemplate } from "@prisma/client";
import { z } from "zod";
import { safeJsonParse } from "./utils.js";

/**
 * Zod schema for template import validation
 * Validates the essential structure of imported template JSON.
 * Uses loose validation (.passthrough()) for nested config to allow
 * all valid TRaSH Guides formats while still catching malformed imports.
 */
const templateImportSchema = z.object({
	template: z.object({
		name: z.string().min(1, "Template name is required").max(100, "Template name too long"),
		serviceType: z.enum(["RADARR", "SONARR"]),
		config: z
			.object({
				customFormats: z.array(z.record(z.unknown())), // Validate it's an array of objects
				customFormatGroups: z.array(z.record(z.unknown())),
			})
			.passthrough(), // Allow qualitySize, naming, qualityProfile, etc.
		description: z.string().max(500).optional(),
		sourceQualityProfileTrashId: z.string().optional(),
		sourceQualityProfileName: z.string().optional(),
	}),
	version: z.string().optional(),
	exportedAt: z.string().optional(),
});

/**
 * Expected structure for template import JSON
 */
interface TemplateImportData {
	template: {
		name: string;
		serviceType: "RADARR" | "SONARR";
		config: TemplateConfig;
		description?: string;
		sourceQualityProfileTrashId?: string;
		sourceQualityProfileName?: string;
	};
	version?: string;
	exportedAt?: string;
}

// ============================================================================
// Types
// ============================================================================

export interface TemplateInstanceInfo {
	instanceId: string;
	instanceName: string;
	instanceType: "RADARR" | "SONARR";
	lastAppliedAt?: Date;
	hasActiveSchedule: boolean;
	syncStrategy: "auto" | "manual" | "notify";
	/** Whether this instance has an active deployment mapping (can change sync strategy) */
	hasMapping: boolean;
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
	search?: string; // Search by name or description
	sortBy?: "name" | "createdAt" | "updatedAt" | "usageCount";
	sortOrder?: "asc" | "desc";
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
	async createTemplate(userId: string, request: CreateTemplateRequest): Promise<TrashTemplate> {
		// Validate name uniqueness for user and service type
		const existing = await this.prisma.trashTemplate.findFirst({
			where: {
				userId,
				name: request.name,
				serviceType: request.serviceType,
				deletedAt: null,
			},
		});

		if (existing) {
			throw new Error(
				`Template with name "${request.name}" already exists for ${request.serviceType}`,
			);
		}

		// Create template with Phase 3 metadata
		const now = new Date();
		const template = await this.prisma.trashTemplate.create({
			data: {
				userId,
				name: request.name,
				description: request.description || null,
				serviceType: request.serviceType,
				configData: JSON.stringify(request.config),
				// Source Quality Profile Information
				sourceQualityProfileTrashId: request.sourceQualityProfileTrashId || null,
				sourceQualityProfileName: request.sourceQualityProfileName || null,
				// Phase 3: Initialize metadata with version tracking
				trashGuidesCommitHash: request.trashGuidesCommitHash || null,
				importedAt: now,
				lastSyncedAt: request.trashGuidesCommitHash ? now : null, // Mark as synced if we have a commit hash
				hasUserModifications: false,
				changeLog: JSON.stringify([
					{
						timestamp: now.toISOString(),
						userId,
						changeType: "import",
						description: "Template created from TRaSH Guides quality profile",
						commitHash: request.trashGuidesCommitHash || undefined,
					},
				]),
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
	 * List templates with filtering, searching, and sorting
	 */
	async listTemplates(options: TemplateListOptions = {}): Promise<TrashTemplate[]> {
		// Build where clause with search
		const whereClause: Prisma.TrashTemplateWhereInput = {
			...(options.userId && { userId: options.userId }),
			...(options.serviceType && { serviceType: options.serviceType }),
			...(options.includeDeleted ? {} : { deletedAt: null }),
		};

		// Add search filter for name and description
		// SQLite doesn't support mode: "insensitive", but LIKE is case-insensitive by default in SQLite
		if (options.search) {
			whereClause.OR = [
				{ name: { contains: options.search } },
				{ description: { contains: options.search } },
			];
		}

		// Determine if we need to include schedules (for active filter or sorting by usage)
		const includeSchedules = options.active !== undefined;
		const includeSyncHistory = options.sortBy === "usageCount";

		// Build orderBy clause
		let orderBy: Prisma.TrashTemplateOrderByWithRelationInput = { updatedAt: "desc" }; // Default sort
		if (options.sortBy) {
			const sortOrder = options.sortOrder || "desc";
			switch (options.sortBy) {
				case "name":
					orderBy = { name: sortOrder };
					break;
				case "createdAt":
					orderBy = { createdAt: sortOrder };
					break;
				case "updatedAt":
					orderBy = { updatedAt: sortOrder };
					break;
				// usageCount will be handled separately after fetching
			}
		}

		// Build include clause based on what we need
		const includeClause: Prisma.TrashTemplateInclude = {};
		if (includeSchedules) {
			includeClause.schedules = {
				select: {
					enabled: true,
				},
				where: {
					enabled: true,
				},
			};
		}
		if (includeSyncHistory) {
			includeClause._count = {
				select: {
					syncHistory: true,
				},
			};
		}

		const templates = await this.prisma.trashTemplate.findMany({
			where: whereClause,
			...(includeSchedules || includeSyncHistory ? { include: includeClause } : {}),
			orderBy,
		});

		// Filter by active status if specified
		let filteredTemplates = templates;
		if (options.active !== undefined) {
			filteredTemplates = templates.filter((t) => {
				const hasActiveSchedule =
					"schedules" in t && Array.isArray(t.schedules) && t.schedules.length > 0;
				return options.active ? hasActiveSchedule : !hasActiveSchedule;
			});
		}

		// Sort by usage count if requested
		if (options.sortBy === "usageCount") {
			const sortOrder = options.sortOrder || "desc";
			filteredTemplates.sort((a, b) => {
				const countA = "_count" in a ? (a._count as { syncHistory: number }).syncHistory : 0;
				const countB = "_count" in b ? (b._count as { syncHistory: number }).syncHistory : 0;
				return sortOrder === "asc" ? countA - countB : countB - countA;
			});
		}

		// Apply pagination after filtering and sorting
		const start = options.offset || 0;
		const length = options.limit ?? filteredTemplates.length;
		const paginatedTemplates = filteredTemplates.slice(start, start + length);

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
					serviceType: existing.serviceType,
					deletedAt: null,
					id: { not: templateId },
				},
			});

			if (nameConflict) {
				throw new Error(
					`Template with name "${request.name}" already exists for ${existing.serviceType}`,
				);
			}
		}

		// Update template with Phase 3 metadata
		const now = new Date();

		// Build update data with Phase 3 metadata
		const updateData: Prisma.TrashTemplateUpdateInput = {
			...(request.name && { name: request.name }),
			...(request.description !== undefined && { description: request.description || null }),
			...(request.config && { configData: JSON.stringify(request.config) }),
		};

		// If config changed, track user modifications
		if (request.config) {
			// Safely parse existing changeLog with error handling
			let existingChangeLog: unknown[] = [];
			if (existing.changeLog) {
				try {
					const parsed = JSON.parse(existing.changeLog);
					existingChangeLog = Array.isArray(parsed) ? parsed : [];
				} catch (parseError) {
					console.warn(
						`Failed to parse changeLog for template ${templateId}: ${parseError instanceof Error ? parseError.message : String(parseError)}. Resetting to empty array.`,
					);
					existingChangeLog = [];
				}
			}

			const newChangeLogEntry = {
				timestamp: now.toISOString(),
				userId,
				changeType: "manual_edit",
				description: "Template updated via wizard",
			};

			updateData.hasUserModifications = true;
			updateData.lastModifiedAt = now;
			updateData.lastModifiedBy = userId;
			updateData.changeLog = JSON.stringify([...existingChangeLog, newChangeLogEntry]);
		}

		const updated = await this.prisma.trashTemplate.update({
			where: { id: templateId },
			data: updateData,
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
		// Parse JSON
		let rawData: unknown;
		try {
			rawData = JSON.parse(jsonData);
		} catch (parseError) {
			throw new Error(
				`Invalid JSON format: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
			);
		}

		// Validate with Zod schema
		const parseResult = templateImportSchema.safeParse(rawData);
		if (!parseResult.success) {
			const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
			throw new Error(`Invalid template import format: ${errors.join("; ")}`);
		}
		// Cast to TemplateImportData - Zod validated the structure, TypeScript interface provides proper typing
		const data = parseResult.data as unknown as TemplateImportData;

		// Check for name conflicts and auto-rename if needed
		const MAX_RENAME_ATTEMPTS = 100;
		let name = data.template.name;
		let counter = 1;
		while (
			await this.prisma.trashTemplate.findFirst({
				where: {
					userId,
					name,
					serviceType: data.template.serviceType,
					deletedAt: null,
				},
			})
		) {
			if (counter > MAX_RENAME_ATTEMPTS) {
				throw new Error(
					`Failed to find unique name for template after ${MAX_RENAME_ATTEMPTS} attempts`,
				);
			}
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
				// Include quality profile mappings to determine which instances are actively managed
				qualityProfileMappings: {
					select: {
						instanceId: true,
						syncStrategy: true,
						instance: {
							select: {
								id: true,
								label: true,
								service: true,
							},
						},
					},
				},
			},
		});

		if (!template) {
			return null;
		}

		// Parse config to get counts with fallback to empty config on failure
		const config = safeJsonParse<TemplateConfig>(template.configData, {
			source: "TemplateService",
			identifier: template.id,
			field: "configData",
		}) ?? {
			customFormats: [],
			customFormatGroups: [],
		};
		const formatCount = config.customFormats.length;
		const groupCount = config.customFormatGroups.length;

		// Get unique instances from mappings (actively managed instances)
		const mappedInstanceIds = new Set(template.qualityProfileMappings.map((m) => m.instanceId));

		// Get unique instances and their info
		const instanceMap = new Map<string, TemplateInstanceInfo>();

		// First, add all mapped instances (these are the ones we actively manage)
		// syncStrategy is now per-instance-deployment, not per-template
		for (const mapping of template.qualityProfileMappings) {
			if (!instanceMap.has(mapping.instanceId)) {
				// Find last sync time from history
				const lastSync = template.syncHistory.find((h) => h.instanceId === mapping.instanceId);
				const strategy = (mapping.syncStrategy as "auto" | "manual" | "notify") || "notify";
				instanceMap.set(mapping.instanceId, {
					instanceId: mapping.instanceId,
					instanceName: mapping.instance.label,
					instanceType: mapping.instance.service as "RADARR" | "SONARR",
					lastAppliedAt: lastSync?.completedAt || undefined,
					// Instance has "active schedule" if this deployment is set to auto-sync
					hasActiveSchedule: strategy === "auto",
					syncStrategy: strategy,
					// Has mapping = can change sync strategy
					hasMapping: true,
				});
			}
		}

		// Also add instances from sync history that may not have mappings anymore
		for (const history of template.syncHistory) {
			if (!instanceMap.has(history.instanceId)) {
				instanceMap.set(history.instanceId, {
					instanceId: history.instanceId,
					instanceName: history.instance.label,
					instanceType: history.instance.service as "RADARR" | "SONARR",
					lastAppliedAt: history.completedAt || undefined,
					// No active schedule if not mapped
					hasActiveSchedule: false,
					syncStrategy: "notify", // Default for unmapped instances
					// No mapping = cannot change sync strategy (needs re-deployment)
					hasMapping: false,
				});
			}
		}

		const instances = Array.from(instanceMap.values());
		// Active instance count = instances with auto-sync enabled in their deployment mapping
		const activeInstanceCount = instances.filter((i) => i.hasActiveSchedule).length;
		// Template is "Active" when it has at least one instance with auto-sync enabled
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
	private mapToTemplate(prismaTemplate: PrismaTrashTemplate): TrashTemplate {
		const templateId = prismaTemplate.id;

		// Parse configData with fallback to empty config on failure
		const config = safeJsonParse<TemplateConfig>(prismaTemplate.configData, {
			source: "TemplateService",
			identifier: templateId,
			field: "configData",
		}) ?? {
			customFormats: [],
			customFormatGroups: [],
		};

		return {
			id: templateId,
			userId: prismaTemplate.userId,
			name: prismaTemplate.name,
			description: prismaTemplate.description || undefined,
			// Cast to narrower type - templates only support RADARR | SONARR (not PROWLARR)
			serviceType: prismaTemplate.serviceType as "RADARR" | "SONARR",
			config,
			createdAt: prismaTemplate.createdAt.toISOString(),
			updatedAt: prismaTemplate.updatedAt.toISOString(),
			deletedAt: prismaTemplate.deletedAt?.toISOString(),
			// Source Quality Profile Information
			sourceQualityProfileTrashId: prismaTemplate.sourceQualityProfileTrashId || undefined,
			sourceQualityProfileName: prismaTemplate.sourceQualityProfileName || undefined,
			// Phase 3: Versioning & Metadata
			trashGuidesCommitHash: prismaTemplate.trashGuidesCommitHash || undefined,
			trashGuidesVersion: prismaTemplate.trashGuidesVersion || undefined,
			importedAt:
				prismaTemplate.importedAt?.toISOString() || prismaTemplate.createdAt.toISOString(),
			lastSyncedAt: prismaTemplate.lastSyncedAt?.toISOString(),
			// Phase 3: Customization Tracking
			hasUserModifications: prismaTemplate.hasUserModifications ?? false,
			modifiedFields: safeJsonParse<string[]>(prismaTemplate.modifiedFields, {
				source: "TemplateService",
				identifier: templateId,
				field: "modifiedFields",
			}),
			lastModifiedAt: prismaTemplate.lastModifiedAt?.toISOString(),
			lastModifiedBy: prismaTemplate.lastModifiedBy || undefined,
			// Phase 3: Change Log
			changeLog: safeJsonParse<TrashTemplate["changeLog"]>(prismaTemplate.changeLog, {
				source: "TemplateService",
				identifier: templateId,
				field: "changeLog",
			}),
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
