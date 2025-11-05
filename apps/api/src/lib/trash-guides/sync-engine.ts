/**
 * TRaSH Guides Sync Engine
 *
 * Orchestrates the synchronization of TRaSH configurations to Radarr/Sonarr instances
 */

import { PrismaClient } from "@prisma/client";
import type { TemplateConfig } from "@arr/shared";
import { createArrApiClient } from "./arr-api-client.js";
import type { ArrApiClient, CustomFormat } from "./arr-api-client.js";
import { createBackupManager } from "./backup-manager.js";
import type { BackupManager } from "./backup-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
	templateId: string;
	instanceId: string;
	userId: string;
	syncType: "MANUAL" | "SCHEDULED";
}

export interface SyncProgress {
	syncId: string;
	status: "INITIALIZING" | "VALIDATING" | "BACKING_UP" | "APPLYING" | "COMPLETED" | "FAILED";
	currentStep: string;
	progress: number; // 0-100
	totalConfigs: number;
	appliedConfigs: number;
	failedConfigs: number;
	errors: SyncError[];
}

export interface SyncError {
	configName: string;
	error: string;
	retryable: boolean;
}

export interface SyncResult {
	syncId: string;
	success: boolean;
	status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
	duration: number;
	configsApplied: number;
	configsFailed: number;
	configsSkipped: number;
	errors: SyncError[];
	backupId?: string;
}

export interface ConflictInfo {
	configName: string;
	existingId: number;
	action: "REPLACE" | "SKIP" | "KEEP_EXISTING";
	reason: string;
}

export interface ValidationResult {
	valid: boolean;
	conflicts: ConflictInfo[];
	errors: string[];
	warnings: string[];
}

// ============================================================================
// Sync Engine Class
// ============================================================================

export class SyncEngine {
	private prisma: PrismaClient;
	private backupManager: BackupManager;
	private progressCallbacks: Map<string, (progress: SyncProgress) => void>;

	constructor(prisma: PrismaClient) {
		this.prisma = prisma;
		this.backupManager = createBackupManager(prisma);
		this.progressCallbacks = new Map();
	}

	/**
	 * Register progress callback for real-time updates
	 */
	onProgress(syncId: string, callback: (progress: SyncProgress) => void): void {
		this.progressCallbacks.set(syncId, callback);
	}

	/**
	 * Emit progress update
	 */
	private emitProgress(progress: SyncProgress): void {
		const callback = this.progressCallbacks.get(progress.syncId);
		if (callback) {
			callback(progress);
		}
	}

	/**
	 * Validate sync before execution
	 */
	async validate(options: SyncOptions): Promise<ValidationResult> {
		const errors: string[] = [];
		const warnings: string[] = [];
		const conflicts: ConflictInfo[] = [];

		// Get template
		const template = await this.prisma.trashTemplate.findFirst({
			where: {
				id: options.templateId,
				userId: options.userId,
				deletedAt: null,
			},
		});

		if (!template) {
			errors.push("Template not found");
			return { valid: false, conflicts, errors, warnings };
		}

		// Get instance
		const instance = await this.prisma.serviceInstance.findUnique({
			where: { id: options.instanceId },
		});

		if (!instance) {
			errors.push("Instance not found");
			return { valid: false, conflicts, errors, warnings };
		}

		// Check service type compatibility
		if (template.serviceType !== instance.service) {
			errors.push(
				`Template service type (${template.serviceType}) doesn't match instance (${instance.service})`,
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Parse template config
		const config = JSON.parse(template.configData) as TemplateConfig;

		// Create API client
		const apiClient = createArrApiClient(instance);

		try {
			// Test connection
			const canConnect = await apiClient.testConnection();
			if (!canConnect) {
				errors.push("Cannot connect to instance API");
				return { valid: false, conflicts, errors, warnings };
			}

			// Get existing Custom Formats
			const existingFormats = await apiClient.getCustomFormats();

			// Check for conflicts
			for (const templateFormat of config.customFormats) {
				const existing = existingFormats.find((f) => f.name === templateFormat.name);
				if (existing && existing.id) {
					conflicts.push({
						configName: templateFormat.name,
						existingId: existing.id,
						action: "REPLACE", // Default action
						reason: "Custom Format with same name already exists",
					});
				}
			}

			// Warnings for disabled conditions
			const formatsWithDisabledConditions = config.customFormats.filter(
				(f) => Object.values(f.conditionsEnabled).some((enabled) => !enabled),
			);

			if (formatsWithDisabledConditions.length > 0) {
				warnings.push(
					`${formatsWithDisabledConditions.length} formats have disabled conditions`,
				);
			}
		} catch (error) {
			errors.push(
				error instanceof Error ? error.message : "Failed to validate with instance",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		return {
			valid: errors.length === 0,
			conflicts,
			errors,
			warnings,
		};
	}

	/**
	 * Execute sync operation
	 */
	async execute(
		options: SyncOptions,
		conflictResolutions?: Map<string, "REPLACE" | "SKIP">,
	): Promise<SyncResult> {
		const startTime = Date.now();

		// Create sync history record
		const syncHistory = await this.prisma.trashSyncHistory.create({
			data: {
				instanceId: options.instanceId,
				templateId: options.templateId,
				userId: options.userId,
				syncType: options.syncType,
				status: "RUNNING",
				appliedConfigs: "[]", // Initialize as empty JSON array
				startedAt: new Date(),
			},
		});

		const syncId = syncHistory.id;
		const errors: SyncError[] = [];
		let configsApplied = 0;
		let configsFailed = 0;
		let configsSkipped = 0;
		let backupId: string | undefined;

		try {
			// Emit initial progress
			this.emitProgress({
				syncId,
				status: "INITIALIZING",
				currentStep: "Loading configuration",
				progress: 0,
				totalConfigs: 0,
				appliedConfigs: 0,
				failedConfigs: 0,
				errors: [],
			});

			// Get template and instance
			const template = await this.prisma.trashTemplate.findUnique({
				where: { id: options.templateId },
			});

			const instance = await this.prisma.serviceInstance.findUnique({
				where: { id: options.instanceId },
			});

			if (!template || !instance) {
				throw new Error("Template or instance not found");
			}

			const config = JSON.parse(template.configData) as TemplateConfig;
			const totalConfigs = config.customFormats.length;

			// Create API client
			const apiClient = createArrApiClient(instance);

			// Update progress: Validating
			this.emitProgress({
				syncId,
				status: "VALIDATING",
				currentStep: "Validating instance connection",
				progress: 10,
				totalConfigs,
				appliedConfigs: configsApplied,
				failedConfigs: configsFailed,
				errors,
			});

			// Test connection
			const canConnect = await apiClient.testConnection();
			if (!canConnect) {
				throw new Error("Cannot connect to instance");
			}

			// Update progress: Backing up
			this.emitProgress({
				syncId,
				status: "BACKING_UP",
				currentStep: "Creating backup snapshot",
				progress: 20,
				totalConfigs,
				appliedConfigs: configsApplied,
				failedConfigs: configsFailed,
				errors,
			});

			// Create backup
			const existingFormats = await apiClient.getCustomFormats();
			const qualityProfiles = await apiClient.getQualityProfiles();
			const systemStatus = await apiClient.getSystemStatus();

			backupId = await this.backupManager.createBackup(
				options.instanceId,
				options.userId,
				{
					customFormats: existingFormats,
					qualityProfiles,
					version: systemStatus.version,
				},
				`Pre-sync backup for template: ${template.name}`,
			);

			// Update progress: Applying
			this.emitProgress({
				syncId,
				status: "APPLYING",
				currentStep: "Applying Custom Formats",
				progress: 30,
				totalConfigs,
				appliedConfigs: configsApplied,
				failedConfigs: configsFailed,
				errors,
			});

			// Apply each Custom Format
			for (let i = 0; i < config.customFormats.length; i++) {
				const templateFormat = config.customFormats[i];
				if (!templateFormat) continue;

				const progressPercent = 30 + ((i + 1) / totalConfigs) * 60;

				try {
					await this.applyCustomFormat(
						apiClient,
						templateFormat,
						existingFormats,
						conflictResolutions,
					);

					configsApplied++;

					this.emitProgress({
						syncId,
						status: "APPLYING",
						currentStep: `Applied: ${templateFormat.name}`,
						progress: progressPercent,
						totalConfigs,
						appliedConfigs: configsApplied,
						failedConfigs: configsFailed,
						errors,
					});
				} catch (error) {
					configsFailed++;
					const errorMessage = error instanceof Error ? error.message : "Unknown error";

					errors.push({
						configName: templateFormat.name,
						error: errorMessage,
						retryable: this.isRetryableError(errorMessage),
					});

					this.emitProgress({
						syncId,
						status: "APPLYING",
						currentStep: `Failed: ${templateFormat.name}`,
						progress: progressPercent,
						totalConfigs,
						appliedConfigs: configsApplied,
						failedConfigs: configsFailed,
						errors,
					});
				}
			}

			// Enforce backup retention
			await this.backupManager.enforceRetentionLimit(options.instanceId, 10);

			// Calculate final status
			const duration = Math.floor((Date.now() - startTime) / 1000);
			let status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

			if (configsFailed === 0) {
				status = "SUCCESS";
			} else if (configsApplied > 0) {
				status = "PARTIAL_SUCCESS";
			} else {
				status = "FAILED";
			}

			// Update sync history
			await this.prisma.trashSyncHistory.update({
				where: { id: syncId },
				data: {
					status,
					completedAt: new Date(),
					duration,
					configsApplied,
					configsFailed,
					configsSkipped,
					appliedConfigs: JSON.stringify(
						config.customFormats
							.slice(0, configsApplied)
							.map((f) => ({ name: f.name, trashId: f.trashId })),
					),
					failedConfigs: errors.length > 0 ? JSON.stringify(errors) : null,
					backupId,
				},
			});

			// Emit completion
			this.emitProgress({
				syncId,
				status: "COMPLETED",
				currentStep: "Sync completed",
				progress: 100,
				totalConfigs,
				appliedConfigs: configsApplied,
				failedConfigs: configsFailed,
				errors,
			});

			return {
				syncId,
				success: status === "SUCCESS",
				status,
				duration,
				configsApplied,
				configsFailed,
				configsSkipped,
				errors,
				backupId,
			};
		} catch (error) {
			const duration = Math.floor((Date.now() - startTime) / 1000);
			const errorMessage = error instanceof Error ? error.message : "Sync failed";

			// Update sync history with failure
			await this.prisma.trashSyncHistory.update({
				where: { id: syncId },
				data: {
					status: "FAILED",
					completedAt: new Date(),
					duration,
					configsApplied,
					configsFailed,
					configsSkipped,
					errorLog: errorMessage,
					backupId,
				},
			});

			// Emit failure
			this.emitProgress({
				syncId,
				status: "FAILED",
				currentStep: errorMessage,
				progress: 0,
				totalConfigs: 0,
				appliedConfigs: configsApplied,
				failedConfigs: configsFailed,
				errors,
			});

			return {
				syncId,
				success: false,
				status: "FAILED",
				duration,
				configsApplied,
				configsFailed,
				configsSkipped,
				errors: [{ configName: "Sync", error: errorMessage, retryable: false }],
				backupId,
			};
		} finally {
			// Clean up progress callback
			this.progressCallbacks.delete(syncId);
		}
	}

	/**
	 * Apply a single Custom Format
	 */
	private async applyCustomFormat(
		apiClient: ArrApiClient,
		templateFormat: TemplateConfig["customFormats"][0],
		existingFormats: CustomFormat[],
		conflictResolutions?: Map<string, "REPLACE" | "SKIP">,
	): Promise<void> {
		// Check for existing format with same name
		const existing = existingFormats.find((f) => f.name === templateFormat.name);

		// Handle conflict resolution
		if (existing && existing.id) {
			const resolution = conflictResolutions?.get(templateFormat.name) || "REPLACE";

			if (resolution === "SKIP") {
				return; // Skip this format
			}

			// REPLACE: update existing format
			const updatedFormat = this.buildCustomFormat(templateFormat);
			await apiClient.updateCustomFormat(existing.id, {
				...updatedFormat,
				id: existing.id,
			});
		} else {
			// Create new format
			const newFormat = this.buildCustomFormat(templateFormat);
			await apiClient.createCustomFormat(newFormat);
		}
	}

	/**
	 * Build Custom Format object from template configuration
	 */
	private buildCustomFormat(
		templateFormat: TemplateConfig["customFormats"][0],
	): CustomFormat {
		const originalConfig = templateFormat.originalConfig as CustomFormat;

		// Filter specifications based on enabled conditions
		const enabledSpecs = originalConfig.specifications.filter((spec) => {
			return templateFormat.conditionsEnabled[spec.name] !== false;
		});

		return {
			name: templateFormat.name,
			includeCustomFormatWhenRenaming: originalConfig.includeCustomFormatWhenRenaming,
			specifications: enabledSpecs,
		};
	}

	/**
	 * Check if error is retryable
	 */
	private isRetryableError(error: string): boolean {
		const retryablePatterns = [
			/timeout/i,
			/network/i,
			/503/,
			/429/,
			/connection/i,
			/unavailable/i,
		];

		return retryablePatterns.some((pattern) => pattern.test(error));
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a sync engine instance
 */
export function createSyncEngine(prisma: PrismaClient): SyncEngine {
	return new SyncEngine(prisma);
}
