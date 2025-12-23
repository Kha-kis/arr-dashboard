/**
 * TRaSH Guides Sync Engine
 *
 * Orchestrates the synchronization of TRaSH configurations to Radarr/Sonarr instances
 */

import type { TemplateConfig } from "@arr/shared";
import type { PrismaClient } from "@prisma/client";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { SonarrClient, RadarrClient } from "arr-sdk";
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
	private arrClientFactory?: ArrClientFactory;

	constructor(
		prisma: PrismaClient,
		templateUpdater?: TemplateUpdater,
		deploymentExecutor?: DeploymentExecutorService,
		arrClientFactory?: ArrClientFactory,
	) {
		this.prisma = prisma;
		this.progressCallbacks = new Map();
		this.templateUpdater = templateUpdater;
		this.deploymentExecutor = deploymentExecutor;
		this.arrClientFactory = arrClientFactory;
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
	 * - Quality profile mapping existence and validity
	 * - User modification blocking for auto-sync
	 * - Custom format cache validation
	 * - Quality profile compatibility with instance
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
				`Template service type (${template.serviceType}) doesn't match instance type (${instance.service}). Please select an instance that matches the template's service type.`,
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
				"No quality profile mappings found. Please deploy this template to the instance first.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// Check if template has user modifications - BLOCKING error for auto-sync
		if (template.hasUserModifications && options.syncType === "SCHEDULED") {
			errors.push(
				"Auto-sync is blocked because this template has local modifications. " +
					"Templates with user modifications must be synced manually to prevent overwriting your changes. " +
					"To enable auto-sync, either reset the template to TRaSH defaults or create a fresh template.",
			);
			return { valid: false, conflicts, errors, warnings };
		}

		// For manual sync, warn about user modifications
		if (template.hasUserModifications && options.syncType === "MANUAL") {
			warnings.push(
				"This template has local modifications that differ from TRaSH Guides. " +
					"Syncing will preserve your modifications. If you want to reset to TRaSH defaults, " +
					"consider creating a fresh template.",
			);
		}

		// Check instance reachability and validate quality profiles
		let instanceVersion: string | undefined;
		let instanceQualityProfiles: Array<{ id: number; name: string }> = [];

		if (this.arrClientFactory) {
			try {
				const client = this.arrClientFactory.create(instance);
				const status = await client.system.getStatus();
				instanceVersion = status.version;

				// Add version info as a positive indicator
				if (status.version) {
					warnings.push(`Instance is reachable (${instance.service} v${status.version})`);
				}

				// Fetch quality profiles to validate mappings
				try {
					const profiles = await client.qualityProfile.getAll();
					instanceQualityProfiles = profiles.map((p) => ({ id: p.id ?? 0, name: p.name ?? "" }));
				} catch (profileError) {
					warnings.push(
						"Could not fetch quality profiles from instance. Profile validation will be skipped.",
					);
				}
			} catch (connectError) {
				const errorMessage =
					connectError instanceof Error ? connectError.message : String(connectError);
				errors.push(
					`Unable to connect to instance "${instance.label}" (${instance.baseUrl}). ` +
						`Please verify the instance is running and accessible. Error: ${errorMessage}`,
				);
				return { valid: false, conflicts, errors, warnings };
			}
		} else {
			// Client factory not available - can't test connection but continue with warning
			warnings.push(
				"Instance connectivity check skipped. Connection will be verified during sync.",
			);
		}

		// Validate that mapped quality profiles still exist in the instance
		if (instanceQualityProfiles.length > 0) {
			const instanceProfileIds = new Set(instanceQualityProfiles.map((p) => p.id));
			const deletedProfiles: string[] = [];

			for (const mapping of qualityProfileMappings) {
				if (!instanceProfileIds.has(mapping.qualityProfileId)) {
					// Find the profile name from the mapping or use a fallback
					deletedProfiles.push(`Profile ID ${mapping.qualityProfileId}`);
				}
			}

			if (deletedProfiles.length > 0) {
				warnings.push(
					`The following mapped quality profiles no longer exist in the instance: ${deletedProfiles.join(", ")}. These mappings will be skipped. Consider re-deploying the template to update the mappings.`,
				);
			}
		}

		// Check quality profile compatibility with instance API version
		if (instanceVersion) {
			const majorVersion = Number.parseInt(instanceVersion.split(".")[0] || "0", 10);
			// Radarr v4+ and Sonarr v4+ use the v3 API with full custom format support
			// Earlier versions may have limited or no custom format support
			if (majorVersion < 4) {
				warnings.push(
					`Instance is running an older version (v${instanceVersion}). Some custom format features may not be fully supported. Consider upgrading to v4+.`,
				);
			}
		}

		// Check if template config data is valid JSON and validate custom formats
		let configData: { customFormats?: Array<{ trashId?: string; name?: string }> };
		try {
			configData = JSON.parse(template.configData);
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

		// Validate custom formats exist in TRaSH Guides cache
		if (configData.customFormats && configData.customFormats.length > 0) {
			const trashIds = configData.customFormats
				.map((cf) => cf.trashId)
				.filter((id): id is string => !!id);

			if (trashIds.length > 0) {
				// Check if we have cached TRaSH data for these custom formats
				const serviceType = template.serviceType === "RADARR" ? "RADARR" : "SONARR";

				const cache = await this.prisma.trashCache.findFirst({
					where: {
						serviceType: serviceType,
						configType: "CUSTOM_FORMATS",
					},
				});

				if (!cache) {
					warnings.push(
						"TRaSH Guides cache is empty. Custom format definitions will be fetched during sync. " +
							"This may take longer than usual.",
					);
				} else {
					// Check cache freshness (warn if older than 7 days)
					const cacheAge = Date.now() - cache.updatedAt.getTime();
					const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
					if (cacheAge > sevenDaysMs) {
						const daysOld = Math.floor(cacheAge / (24 * 60 * 60 * 1000));
						warnings.push(
							`TRaSH Guides cache is ${daysOld} days old. Consider refreshing the cache to get the latest custom format definitions.`,
						);
					}

					// Validate that custom formats in template exist in cache
					try {
						const cachedFormats = JSON.parse(cache.data) as Array<{
							trash_id?: string;
							name?: string;
						}>;
						const cachedTrashIds = new Set(
							cachedFormats.map((cf) => cf.trash_id).filter((id): id is string => !!id),
						);

						const missingFormats: string[] = [];
						for (const cf of configData.customFormats) {
							if (cf.trashId && !cachedTrashIds.has(cf.trashId)) {
								missingFormats.push(cf.name || cf.trashId);
							}
						}

						if (missingFormats.length > 0) {
							warnings.push(
								`${missingFormats.length} custom format(s) in the template are not found in the TRaSH Guides cache: ${missingFormats.slice(0, 3).join(", ")}${missingFormats.length > 3 ? ` and ${missingFormats.length - 3} more` : ""}. These may have been removed from TRaSH Guides or the cache needs refreshing.`,
							);
						}
					} catch {
						// Cache data is invalid, will be refreshed during sync
						warnings.push(
							"TRaSH Guides cache data is corrupted. It will be refreshed during sync.",
						);
					}
				}
			}
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
	arrClientFactory?: ArrClientFactory,
): SyncEngine {
	return new SyncEngine(prisma, templateUpdater, deploymentExecutor, arrClientFactory);
}
