/**
 * TRaSH Guides Sync Engine
 *
 * Orchestrates the synchronization of TRaSH configurations to Radarr/Sonarr instances
 */

import type { TemplateConfig } from "@arr/shared";
import type { PrismaClient } from "@prisma/client";
import { createArrApiClient } from "./arr-api-client.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import type { TemplateUpdater } from "./template-updater.js";

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
	private encryptor?: { decrypt: (payload: { value: string; iv: string }) => string };

	constructor(
		prisma: PrismaClient,
		templateUpdater?: TemplateUpdater,
		deploymentExecutor?: DeploymentExecutorService,
		encryptor?: { decrypt: (payload: { value: string; iv: string }) => string },
	) {
		this.prisma = prisma;
		this.progressCallbacks = new Map();
		this.templateUpdater = templateUpdater;
		this.deploymentExecutor = deploymentExecutor;
		this.encryptor = encryptor;
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
	 * Performs comprehensive validation including:
	 * - Template existence and ownership
	 * - Instance existence, ownership, and reachability
	 * - Service type compatibility
	 * - Quality profile mapping existence
	 * - User modification warnings for auto-sync
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
			errors.push(
				"Template not found or access denied. Please verify the template exists and you have permission to access it.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Get instance - verify ownership by including userId in query
		const instance = await this.prisma.serviceInstance.findFirst({
			where: {
				id: options.instanceId,
				userId: options.userId,
			},
		});

		if (!instance) {
			errors.push(
				"Instance not found or access denied. Please verify the instance exists and you have permission to access it.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Check service type compatibility (case-insensitive)
		// Template stores uppercase "RADARR"/"SONARR", instance may store different case
		if (template.serviceType.toUpperCase() !== instance.service.toUpperCase()) {
			errors.push(
				`Template service type (${template.serviceType}) doesn't match instance type (${instance.service}). ` +
					`Please select an instance that matches the template's service type.`,
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Check for quality profile mappings
		const qualityProfileMappings = await this.prisma.templateQualityProfileMapping.findMany({
			where: {
				templateId: options.templateId,
				instanceId: options.instanceId,
			},
		});

		if (qualityProfileMappings.length === 0) {
			errors.push(
				"No quality profile mappings found for this template and instance. " +
					"Please deploy this template first to create the necessary mappings, or map a quality profile in the template settings.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Check if template has user modifications (warning for auto-sync scenarios)
		if (template.hasUserModifications) {
			warnings.push(
				"This template has local modifications that differ from TRaSH Guides. " +
					"Syncing will preserve your modifications. If you want to reset to TRaSH defaults, " +
					"consider creating a fresh template.",
			);
		}

		// Check instance reachability
		if (this.encryptor && instance.encryptedApiKey && instance.encryptionIv) {
			try {
				const apiClient = createArrApiClient(instance, this.encryptor);
				const status = await apiClient.getSystemStatus();

				// Add version info as a positive indicator
				if (status.version) {
					warnings.push(`Instance is reachable (${instance.service} v${status.version})`);
				}
			} catch (connectError) {
				const errorMessage =
					connectError instanceof Error ? connectError.message : String(connectError);
				errors.push(
					`Unable to connect to instance "${instance.label}". ` +
						`Please verify the instance is running and accessible. Error: ${errorMessage}`,
				);
				return { valid: false, conflicts, errors, warnings };
			}
		} else if (!this.encryptor) {
			// Encryptor not available - can't test connection but continue with warning
			warnings.push(
				"Instance connectivity check skipped. Connection will be verified during sync.",
			);
		}

		// Check if template config data is valid JSON
		try {
			const configData = JSON.parse(template.configData);
			if (!configData.customFormats || !Array.isArray(configData.customFormats)) {
				errors.push(
					"Template configuration is missing custom formats. " +
						"The template may be corrupted or incomplete. Please recreate the template.",
				);
				return { valid: false, conflicts, errors, warnings };
			}

			if (configData.customFormats.length === 0) {
				warnings.push(
					"Template has no custom formats configured. " +
						"The sync will only update quality profile settings.",
				);
			}
		} catch (parseError) {
			errors.push(
				"Template configuration data is corrupted and cannot be parsed. " +
					"Please recreate the template from TRaSH Guides.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Log validation result for debugging
		if (errors.length === 0) {
			console.log(
				`[SyncEngine] Validation passed for template ${options.templateId} → instance ${options.instanceId}`,
			);
		} else {
			console.warn(
				`[SyncEngine] Validation failed for template ${options.templateId} → instance ${options.instanceId}:`,
				errors,
			);
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

			if (!this.templateUpdater) {
				throw new Error(
					"Template sync cannot proceed: templateUpdater dependency is not configured. " +
						"Ensure SyncEngine is instantiated with a TemplateUpdater instance.",
				);
			}

			const syncResult = await this.templateUpdater.syncTemplate(options.templateId);
			if (!syncResult.success) {
				throw new Error(
					`Template sync failed: ${syncResult.errors?.join(", ") || "Unknown error"}`,
				);
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

			// Convert conflict resolutions from Map format to Record format expected by deployment executor
			// Map "REPLACE" → "use_template" and "SKIP" → "keep_existing"
			const deploymentConflictResolutions:
				| Record<string, "use_template" | "keep_existing">
				| undefined = conflictResolutions
				? Object.fromEntries(
						Array.from(conflictResolutions.entries()).map(([key, value]) => [
							key,
							value === "REPLACE" ? "use_template" : "keep_existing",
						]),
					)
				: undefined;

			const deployResult = await this.deploymentExecutor.deploySingleInstance(
				options.templateId,
				options.instanceId,
				options.userId,
				undefined, // syncStrategy - not used in sync engine
				deploymentConflictResolutions,
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
					configsFailed: deployResult.details?.failed?.length ?? 0,
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
				currentStep: deployResult.success
					? "Sync completed successfully"
					: "Sync completed with errors",
				progress: 100,
				totalConfigs:
					deployResult.customFormatsCreated +
					deployResult.customFormatsUpdated +
					deployResult.customFormatsSkipped,
				appliedConfigs: deployResult.customFormatsCreated + deployResult.customFormatsUpdated,
				failedConfigs: deployResult.details?.failed?.length ?? 0,
				errors,
			});

			return {
				syncId,
				success: deployResult.success,
				status,
				duration,
				configsApplied: deployResult.customFormatsCreated + deployResult.customFormatsUpdated,
				configsFailed: deployResult.details?.failed?.length ?? 0,
				configsSkipped: deployResult.customFormatsSkipped,
				errors,
			};
		} catch (error) {
			const duration = Math.floor((Date.now() - startTime) / 1000);

			let errorMessage = "Sync failed";
			if (error instanceof Error) {
				errorMessage = error.message;
			} else if (error && typeof error === "object" && "message" in error) {
				errorMessage = String(error.message);
			} else if (typeof error === "string") {
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
	encryptor?: { decrypt: (payload: { value: string; iv: string }) => string },
): SyncEngine {
	return new SyncEngine(prisma, templateUpdater, deploymentExecutor, encryptor);
}
