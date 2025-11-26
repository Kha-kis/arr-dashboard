/**
 * TRaSH Guides Sync Engine
 *
 * Orchestrates the synchronization of TRaSH configurations to Radarr/Sonarr instances
 */

import { PrismaClient } from "@prisma/client";
import type { TemplateConfig } from "@arr/shared";
import type { TemplateUpdater } from "./template-updater.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";

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
	private progressCallbacks: Map<string, (progress: SyncProgress) => void>;
	private templateUpdater?: TemplateUpdater;
	private deploymentExecutor?: DeploymentExecutorService;

	constructor(
		prisma: PrismaClient,
		templateUpdater?: TemplateUpdater,
		deploymentExecutor?: DeploymentExecutorService,
	) {
		this.prisma = prisma;
		this.progressCallbacks = new Map();
		this.templateUpdater = templateUpdater;
		this.deploymentExecutor = deploymentExecutor;
	}

	/**
	 * Register progress callback for real-time updates
	 */
	onProgress(syncId: string, callback: (progress: SyncProgress) => void): void {
		this.progressCallbacks.set(syncId, callback);
	}

	/**
	 * Remove progress callback (for cleanup on client disconnect)
	 */
	removeProgressListener(syncId: string, _callback: (progress: SyncProgress) => void): void {
		this.progressCallbacks.delete(syncId);
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

		// Basic validation complete - deployment executor will do detailed validation during execution

		return {
			valid: errors.length === 0,
			conflicts,
			errors,
			warnings,
		};
	}

	/**
	 * Execute sync operation
	 * 1. Sync template with TRaSH Guides
	 * 2. Deploy to instance using deployment executor
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
				appliedConfigs: "[]",
				startedAt: new Date(),
			},
		});

		const syncId = syncHistory.id;

		try {
			// Step 1: Sync template with TRaSH Guides
			this.emitProgress({
				syncId,
				status: "INITIALIZING",
				currentStep: "Syncing template with TRaSH Guides",
				progress: 10,
				totalConfigs: 0,
				appliedConfigs: 0,
				failedConfigs: 0,
				errors: [],
			});

			if (this.templateUpdater) {
				const syncResult = await this.templateUpdater.syncTemplate(options.templateId);
				if (!syncResult.success) {
					throw new Error(
						`Template sync failed: ${syncResult.errors?.join(", ") || "Unknown error"}`,
					);
				}
			}

			// Step 2: Deploy to instance using deployment executor
			this.emitProgress({
				syncId,
				status: "APPLYING",
				currentStep: "Deploying to instance",
				progress: 50,
				totalConfigs: 0,
				appliedConfigs: 0,
				failedConfigs: 0,
				errors: [],
			});

			if (!this.deploymentExecutor) {
				throw new Error("Deployment executor not available");
			}

			const deployResult = await this.deploymentExecutor.deploySingleInstance(
				options.templateId,
				options.instanceId,
				options.userId,
			);

			// Calculate duration and status
			const duration = Math.floor((Date.now() - startTime) / 1000);
			const status = deployResult.success
				? "SUCCESS"
				: deployResult.customFormatsCreated > 0 || deployResult.customFormatsUpdated > 0
					? "PARTIAL_SUCCESS"
					: "FAILED";

			const errors: SyncError[] = deployResult.errors.map((err) => ({
				configName: err.split(":")[0] || "Unknown",
				error: err,
				retryable: false,
			}));

			// Update sync history
			await this.prisma.trashSyncHistory.update({
				where: { id: syncId },
				data: {
					status,
					completedAt: new Date(),
					duration,
					configsApplied: deployResult.customFormatsCreated + deployResult.customFormatsUpdated,
					configsFailed: deployResult.details?.failed.length || 0,
					configsSkipped: deployResult.customFormatsSkipped,
					appliedConfigs: JSON.stringify([
						...(deployResult.details?.created || []).map((name) => ({ name })),
						...(deployResult.details?.updated || []).map((name) => ({ name })),
					]),
					failedConfigs: errors.length > 0 ? JSON.stringify(errors) : null,
				},
			});

			// Emit completion
			this.emitProgress({
				syncId,
				status: "COMPLETED",
				currentStep: deployResult.success ? "Sync completed successfully" : "Sync completed with errors",
				progress: 100,
				totalConfigs:
					deployResult.customFormatsCreated +
					deployResult.customFormatsUpdated +
					deployResult.customFormatsSkipped,
				appliedConfigs: deployResult.customFormatsCreated + deployResult.customFormatsUpdated,
				failedConfigs: deployResult.details?.failed.length || 0,
				errors,
			});

			return {
				syncId,
				success: deployResult.success,
				status,
				duration,
				configsApplied: deployResult.customFormatsCreated + deployResult.customFormatsUpdated,
				configsFailed: deployResult.details?.failed.length || 0,
				configsSkipped: deployResult.customFormatsSkipped,
				errors,
			};
		} catch (error) {
			const duration = Math.floor((Date.now() - startTime) / 1000);

			let errorMessage = "Sync failed";
			if (error instanceof Error) {
				errorMessage = error.message;
			} else if (error && typeof error === 'object' && 'message' in error) {
				errorMessage = String(error.message);
			} else if (typeof error === 'string') {
				errorMessage = error;
			}

			// Update sync history with failure
			await this.prisma.trashSyncHistory.update({
				where: { id: syncId },
				data: {
					status: "FAILED",
					completedAt: new Date(),
					duration,
					configsApplied: 0,
					configsFailed: 0,
					configsSkipped: 0,
					errorLog: errorMessage,
				},
			});

			// Emit failure
			this.emitProgress({
				syncId,
				status: "FAILED",
				currentStep: errorMessage,
				progress: 0,
				totalConfigs: 0,
				appliedConfigs: 0,
				failedConfigs: 0,
				errors: [{ configName: "Sync", error: errorMessage, retryable: false }],
			});

			return {
				syncId,
				success: false,
				status: "FAILED",
				duration,
				configsApplied: 0,
				configsFailed: 0,
				configsSkipped: 0,
				errors: [{ configName: "Sync", error: errorMessage, retryable: false }],
			};
		} finally {
			// Clean up progress callback
			this.progressCallbacks.delete(syncId);
		}
	}

}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a sync engine instance
 */
export function createSyncEngine(
	prisma: PrismaClient,
	templateUpdater?: TemplateUpdater,
	deploymentExecutor?: DeploymentExecutorService,
): SyncEngine {
	return new SyncEngine(prisma, templateUpdater, deploymentExecutor);
}
